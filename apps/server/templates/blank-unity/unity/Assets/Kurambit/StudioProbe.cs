// Kurambit's read-only window into a running Unity game, and the runner that
// lets the harness play a built player. Keep this file; extend GameState, not
// the probe, when a new run value should be observable.
//
// The probe installs itself after the first scene loads. SnapshotJson() is the
// snapshot: GameState's public primitive members, the world position of the
// GameObject tagged "Player", and the text visible UI shows.
//
// A player started with `-kurambitExplore <request.json>` also connects out to
// the loopback port named in that file and plays the steps Kurambit sends, one
// act at a time, with the game paused (Time.timeScale 0) between acts. Input is
// queued through the Input System on a virtual keyboard and mouse, so the game
// receives real device events. Without that argument nothing here runs.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.UI;
using UnityEngine.UIElements;

namespace Kurambit
{
    public sealed class StudioProbe : MonoBehaviour
    {
        // Hard bounds so a runaway GameState or UI cannot make a reply expensive.
        private const int MaxKeys = 40;
        private const int MaxStringChars = 80;
        private const int MaxHudChars = 2000;
        private const int MaxUi = 64;
        private const int MaxText = 128;
        private const int MaxErrors = 20;
        private const float PressSeconds = 0.17f;

        private static StudioProbe instance;
        private readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        private readonly List<Dictionary<string, object>> errors = new List<Dictionary<string, object>>();
        private TcpClient client;
        private NetworkStream stream;
        private string token = "";
        private bool acting;
        private float gameTimeScale = 1f;
        private Keyboard keyboard;
        private Mouse mouse;
        private readonly HashSet<Key> held = new HashSet<Key>();
        private Vector2 pointer;
        private bool pointerSet;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Install()
        {
            if (instance != null) return;
            var host = new GameObject("StudioProbe") { hideFlags = HideFlags.HideInHierarchy };
            DontDestroyOnLoad(host);
            instance = host.AddComponent<StudioProbe>();
        }

        /// <summary>The probe snapshot as JSON; the live editor reads it in play mode.</summary>
        public static string SnapshotJson() => Json.Write(Snapshot());

        public static Dictionary<string, object> Snapshot() => new Dictionary<string, object>
        {
            ["gameState"] = GameStateValues(),
            ["player"] = PlayerPosition(),
            ["hudText"] = HudText(),
        };

        private static Dictionary<string, object> GameStateValues()
        {
            var values = new Dictionary<string, object>();
            var state = GameState.Instance;
            if (state == null) return values;
            var type = state.GetType();
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly;
            foreach (var field in type.GetFields(flags))
            {
                if (values.Count >= MaxKeys) break;
                if (field.Name.StartsWith("_")) continue;
                AddPrimitive(values, field.Name, field.GetValue(state));
            }
            foreach (var property in type.GetProperties(flags))
            {
                if (values.Count >= MaxKeys) break;
                if (property.Name.StartsWith("_") || !property.CanRead || property.GetIndexParameters().Length > 0) continue;
                object value;
                try { value = property.GetValue(state); } catch { continue; }
                AddPrimitive(values, property.Name, value);
            }
            return values;
        }

        private static void AddPrimitive(Dictionary<string, object> values, string key, object value)
        {
            switch (value)
            {
                case bool b: values[key] = b; break;
                case int i: values[key] = i; break;
                case long l: values[key] = l; break;
                case float f: values[key] = f; break;
                case double d: values[key] = d; break;
                case string s: values[key] = s.Length > MaxStringChars ? s.Substring(0, MaxStringChars) : s; break;
                case Enum e: values[key] = e.ToString(); break;
            }
        }

        private static object PlayerPosition()
        {
            GameObject player = null;
            try { player = GameObject.FindWithTag("Player"); } catch (UnityException) { }
            if (player == null) return null;
            var at = player.transform.position;
            return new Dictionary<string, object> { ["x"] = at.x, ["y"] = at.y, ["z"] = at.z };
        }

        private static string HudText()
        {
            var lines = new List<string>();
            var used = 0;
            foreach (var entry in VisibleText())
            {
                if (used >= MaxHudChars) break;
                var text = entry.Value.Length > MaxHudChars - used ? entry.Value.Substring(0, MaxHudChars - used) : entry.Value;
                lines.Add(text);
                used += text.Length + 1;
            }
            return string.Join("\n", lines);
        }

        /// <summary>Visible text keyed by the owning GameObject's hierarchy path.</summary>
        private static List<KeyValuePair<string, string>> VisibleText()
        {
            var found = new List<KeyValuePair<string, string>>();
            foreach (var text in FindObjectsByType<Text>())
                if (text.isActiveAndEnabled && !string.IsNullOrWhiteSpace(text.text))
                    found.Add(new KeyValuePair<string, string>(PathOf(text.transform), text.text.Trim()));
            foreach (var text in FindObjectsByType<TMPro.TMP_Text>())
                if (text.isActiveAndEnabled && !string.IsNullOrWhiteSpace(text.text))
                    found.Add(new KeyValuePair<string, string>(PathOf(text.transform), text.text.Trim()));
            foreach (var document in FindObjectsByType<UIDocument>())
            {
                if (!document.isActiveAndEnabled || document.rootVisualElement == null) continue;
                var index = 0;
                document.rootVisualElement.Query<TextElement>().ForEach(label =>
                {
                    if (label.resolvedStyle.display == DisplayStyle.None || string.IsNullOrWhiteSpace(label.text)) return;
                    var name = string.IsNullOrEmpty(label.name) ? $"#{index}" : label.name;
                    found.Add(new KeyValuePair<string, string>($"{PathOf(document.transform)}/{name}", label.text.Trim()));
                    index++;
                });
            }
            return found;
        }

        private static string PathOf(Transform transform)
        {
            var parts = new List<string>();
            for (var at = transform; at != null; at = at.parent) parts.Add(at.name);
            parts.Reverse();
            return string.Join("/", parts);
        }

        // --- explore runner ---

        private void Awake()
        {
            Application.logMessageReceivedThreaded += OnLog;
        }

        private void OnDestroy()
        {
            Application.logMessageReceivedThreaded -= OnLog;
            try { client?.Close(); } catch { }
        }

        private void OnLog(string message, string stackTrace, LogType type)
        {
            if (type != LogType.Error && type != LogType.Exception && type != LogType.Assert) return;
            lock (errors)
            {
                if (errors.Count >= MaxErrors) return;
                errors.Add(new Dictionary<string, object>
                {
                    ["message"] = Clip(message, 500),
                    ["where"] = Clip(FirstGameFrame(stackTrace), 300),
                });
            }
        }

        private static string FirstGameFrame(string stackTrace)
        {
            if (string.IsNullOrEmpty(stackTrace)) return "";
            foreach (var line in stackTrace.Split('\n'))
            {
                var at = line.IndexOf("(at ", StringComparison.Ordinal);
                if (at >= 0 && line.IndexOf("Assets/", at, StringComparison.Ordinal) >= 0)
                    return line.Substring(at + 4).TrimEnd(')', ' ', '\r');
            }
            return stackTrace.Split('\n')[0].Trim();
        }

        private IEnumerator Start()
        {
            var request = RequestPath();
            if (request == null) yield break;
            Dictionary<string, object> config;
            try
            {
                config = Json.Parse(File.ReadAllText(request)) as Dictionary<string, object>;
            }
            catch (Exception error)
            {
                Debug.LogError($"Kurambit explore request unreadable: {error.Message}");
                yield break;
            }
            var port = config != null && config.TryGetValue("port", out var p) ? Convert.ToInt32(p, CultureInfo.InvariantCulture) : 0;
            token = config != null && config.TryGetValue("token", out var t) ? t as string ?? "" : "";
            if (port <= 0 || token == "") yield break;
            keyboard = InputSystem.AddDevice<Keyboard>("KurambitKeyboard");
            mouse = InputSystem.AddDevice<Mouse>("KurambitMouse");
            keyboard.MakeCurrent();
            mouse.MakeCurrent();
            // Let the main scene run its first frames before the first observation.
            for (var i = 0; i < 5; i++) yield return null;
            try
            {
                client = new TcpClient();
                client.Connect("127.0.0.1", port);
                client.NoDelay = true;
                stream = client.GetStream();
            }
            catch (Exception error)
            {
                Debug.LogError($"Kurambit explore could not connect: {error.Message}");
                yield break;
            }
            var reader = new Thread(ReadLoop) { IsBackground = true, Name = "Kurambit explore" };
            reader.Start();
            yield return new WaitForEndOfFrame();
            var hello = Observation();
            hello["token"] = token;
            hello["screenshot"] = false;
            Send(hello);
            Pause();
        }

        private static string RequestPath()
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
                if (args[i] == "-kurambitExplore") return args[i + 1];
            return null;
        }

        private void ReadLoop()
        {
            try
            {
                using (var lines = new StreamReader(stream, new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = lines.ReadLine()) != null) inbox.Enqueue(line);
                }
            }
            catch { }
            inbox.Enqueue("{\"op\":\"quit\"}");
        }

        private void Update()
        {
            if (acting || stream == null) return;
            if (!inbox.TryDequeue(out var line)) return;
            if (!(Json.Parse(line) is Dictionary<string, object> message)) return;
            var op = message.TryGetValue("op", out var o) ? o as string : null;
            if (op == "quit")
            {
                Application.Quit();
                return;
            }
            if (op == "act") StartCoroutine(Act(message));
        }

        private void Pause()
        {
            gameTimeScale = Time.timeScale;
            Time.timeScale = 0f;
        }

        private IEnumerator Act(Dictionary<string, object> message)
        {
            acting = true;
            var id = message.TryGetValue("id", out var i) ? i : 0;
            var steps = message.TryGetValue("steps", out var s) ? s as List<object> : null;
            var shotPath = message.TryGetValue("screenshotPath", out var sp) ? sp as string : null;
            Time.timeScale = gameTimeScale;
            var executed = 0;
            var uiResults = new List<object>();
            var inspections = new List<object>();
            string failure = null;
            foreach (var raw in steps ?? new List<object>())
            {
                if (!(raw is Dictionary<string, object> step))
                {
                    failure = "A step is not an object.";
                    break;
                }
                var outcome = new StepOutcome();
                yield return RunStep(step, uiResults, inspections, outcome);
                if (outcome.Error != null)
                {
                    failure = outcome.Error;
                    break;
                }
                if (!step.ContainsKey("waitMs") && !step.ContainsKey("screenshot") && !step.ContainsKey("inspect")) executed++;
            }
            ReleaseAll();
            yield return null;
            yield return new WaitForEndOfFrame();
            Dictionary<string, object> reply;
            if (failure != null)
                reply = new Dictionary<string, object> { ["ok"] = false, ["error"] = failure };
            else
            {
                reply = Observation();
                reply["ok"] = true;
                reply["executedInputSteps"] = executed;
                reply["uiResults"] = uiResults;
                reply["inspections"] = inspections;
                reply["screenshot"] = shotPath != null && Capture(shotPath);
            }
            reply["id"] = id;
            Pause();
            Send(reply);
            acting = false;
        }

        private sealed class StepOutcome
        {
            public string Error;
        }

        private IEnumerator RunStep(Dictionary<string, object> step, List<object> uiResults, List<object> inspections, StepOutcome outcome)
        {
            if (step.TryGetValue("press", out var press))
            {
                if (!TryKey(press as string, out var key)) { outcome.Error = $"Unknown key \"{press}\"."; yield break; }
                SetKeys(new[] { key });
                yield return new WaitForSecondsRealtime(PressSeconds);
                ReleaseAll();
                yield return null;
                yield break;
            }
            if (step.ContainsKey("hold") || step.ContainsKey("key") || step.ContainsKey("keys"))
            {
                var names = new List<string>();
                if (step.TryGetValue("keys", out var many) && many is List<object> list)
                    foreach (var name in list) names.Add(name as string);
                else if (step.TryGetValue("key", out var one)) names.Add(one as string);
                else names.Add(step["hold"] as string);
                var keys = new List<Key>();
                foreach (var name in names)
                {
                    if (!TryKey(name, out var key)) { outcome.Error = $"Unknown key \"{name}\"."; yield break; }
                    keys.Add(key);
                }
                SetKeys(keys);
                yield return new WaitForSecondsRealtime(Millis(step, "holdMs", 50));
                ReleaseAll();
                yield return null;
                yield break;
            }
            if (step.ContainsKey("waitMs"))
            {
                ReleaseAll();
                yield return new WaitForSecondsRealtime(Millis(step, "waitMs", 0));
                yield break;
            }
            if (step.ContainsKey("screenshot")) yield break;
            if (step.TryGetValue("click", out var button))
            {
                var at = step.ContainsKey("x") && step.ContainsKey("y")
                    ? new Vector2(Number(step["x"]), Number(step["y"]))
                    : new Vector2(Screen.width / 2f, Screen.height / 2f);
                yield return Click(at, button as string ?? "left");
                yield break;
            }
            if (step.TryGetValue("mouseMove", out var moveRaw) && moveRaw is Dictionary<string, object> move)
            {
                EnsurePointer();
                var delta = new Vector2(Number(move.GetValueOrDefault("dx")), Number(move.GetValueOrDefault("dy")));
                pointer += delta;
                QueueMouse(pointer, new Vector2(delta.x, -delta.y), 0);
                yield return null;
                yield break;
            }
            if (step.TryGetValue("drag", out var dragRaw) && dragRaw is Dictionary<string, object> drag)
            {
                yield return Drag(PointOf(drag.GetValueOrDefault("from")), PointOf(drag.GetValueOrDefault("to")), Millis(step, "holdMs", 300));
                yield break;
            }
            if (step.TryGetValue("ui", out var uiRaw) && uiRaw is Dictionary<string, object> ui)
            {
                yield return Ui(ui, uiResults);
                yield break;
            }
            if (step.TryGetValue("inspect", out var inspectRaw) && inspectRaw is Dictionary<string, object> inspect)
            {
                inspections.Add(Inspect(inspect));
                yield break;
            }
            outcome.Error = "Unknown step kind.";
        }

        private static float Millis(Dictionary<string, object> step, string key, int fallback) =>
            Mathf.Max(0f, step.TryGetValue(key, out var value) ? Number(value) : fallback) / 1000f;

        private static float Number(object value) =>
            value == null ? 0f : Convert.ToSingle(value, CultureInfo.InvariantCulture);

        private static Vector2 PointOf(object raw) =>
            raw is Dictionary<string, object> point
                ? new Vector2(Number(point.GetValueOrDefault("x")), Number(point.GetValueOrDefault("y")))
                : Vector2.zero;

        private void EnsurePointer()
        {
            if (pointerSet) return;
            pointer = new Vector2(Screen.width / 2f, Screen.height / 2f);
            pointerSet = true;
        }

        // Kurambit speaks top-left pixel coordinates like a browser; Unity's screen origin is bottom-left.
        private static Vector2 ToScreen(Vector2 topLeft) => new Vector2(topLeft.x, Screen.height - topLeft.y);

        private void QueueMouse(Vector2 topLeft, Vector2 delta, int buttons)
        {
            var state = new MouseState { position = ToScreen(topLeft), delta = delta, buttons = (ushort)buttons };
            InputSystem.QueueStateEvent(mouse, state);
        }

        private static int ButtonMask(string name) =>
            name == "right" ? 1 << (int)UnityEngine.InputSystem.LowLevel.MouseButton.Right : name == "middle" ? 1 << (int)UnityEngine.InputSystem.LowLevel.MouseButton.Middle : 1 << (int)UnityEngine.InputSystem.LowLevel.MouseButton.Left;

        private IEnumerator Click(Vector2 at, string button)
        {
            pointer = at;
            pointerSet = true;
            QueueMouse(at, Vector2.zero, 0);
            yield return null;
            QueueMouse(at, Vector2.zero, ButtonMask(button));
            yield return new WaitForSecondsRealtime(0.1f);
            QueueMouse(at, Vector2.zero, 0);
            yield return null;
        }

        private IEnumerator Drag(Vector2 from, Vector2 to, float seconds)
        {
            pointer = from;
            pointerSet = true;
            QueueMouse(from, Vector2.zero, 0);
            yield return null;
            QueueMouse(from, Vector2.zero, ButtonMask("left"));
            var steps = Mathf.Max(2, Mathf.RoundToInt(seconds * 60f));
            var last = from;
            for (var i = 1; i <= steps; i++)
            {
                var at = Vector2.Lerp(from, to, i / (float)steps);
                QueueMouse(at, new Vector2(at.x - last.x, last.y - at.y), ButtonMask("left"));
                last = at;
                yield return new WaitForSecondsRealtime(seconds / steps);
            }
            QueueMouse(to, Vector2.zero, 0);
            pointer = to;
            yield return null;
        }

        private void SetKeys(IEnumerable<Key> keys)
        {
            foreach (var key in keys) held.Add(key);
            var array = new Key[held.Count];
            held.CopyTo(array);
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(array));
        }

        private void ReleaseAll()
        {
            if (keyboard == null) return;
            held.Clear();
            InputSystem.QueueStateEvent(keyboard, new KeyboardState());
        }

        private static readonly Dictionary<string, Key> NamedKeys = new Dictionary<string, Key>
        {
            ["ArrowUp"] = Key.UpArrow, ["ArrowDown"] = Key.DownArrow, ["ArrowLeft"] = Key.LeftArrow, ["ArrowRight"] = Key.RightArrow,
            ["Space"] = Key.Space, [" "] = Key.Space, ["Enter"] = Key.Enter, ["Tab"] = Key.Tab, ["Backspace"] = Key.Backspace,
            ["Escape"] = Key.Escape, ["Shift"] = Key.LeftShift, ["Control"] = Key.LeftCtrl, ["Alt"] = Key.LeftAlt,
            ["Home"] = Key.Home, ["End"] = Key.End, ["PageUp"] = Key.PageUp, ["PageDown"] = Key.PageDown,
            ["Insert"] = Key.Insert, ["Delete"] = Key.Delete, [","] = Key.Comma, ["."] = Key.Period, ["/"] = Key.Slash,
            [";"] = Key.Semicolon, ["'"] = Key.Quote, ["["] = Key.LeftBracket, ["]"] = Key.RightBracket, ["-"] = Key.Minus,
            ["="] = Key.Equals, ["`"] = Key.Backquote, ["\\"] = Key.Backslash,
        };

        private static bool TryKey(string name, out Key key)
        {
            key = Key.None;
            if (string.IsNullOrEmpty(name)) return false;
            if (NamedKeys.TryGetValue(name, out key)) return true;
            if (name.Length == 1 && char.IsLetter(name[0]))
                return Enum.TryParse(char.ToUpperInvariant(name[0]).ToString(), out key);
            if (name.Length == 1 && char.IsDigit(name[0]))
                return Enum.TryParse("Digit" + name, out key);
            if (name.Length >= 2 && name[0] == 'F' && int.TryParse(name.Substring(1), out var f) && f >= 1 && f <= 12)
                return Enum.TryParse(name, out key);
            return false;
        }

        // --- observation ---

        private Dictionary<string, object> Observation()
        {
            var screenText = new Dictionary<string, object>();
            foreach (var entry in VisibleText())
            {
                if (screenText.Count >= MaxText) break;
                screenText[Clip(entry.Key, 200)] = Clip(entry.Value, 200);
            }
            List<object> drained;
            lock (errors)
            {
                drained = new List<object>(errors);
                errors.Clear();
            }
            return new Dictionary<string, object>
            {
                ["probe"] = Snapshot(),
                ["screenText"] = screenText,
                ["ui"] = ListUi(),
                ["errors"] = drained,
            };
        }

        private static List<object> ListUi()
        {
            var controls = new List<object>();
            foreach (var selectable in Selectable.allSelectablesArray)
            {
                if (controls.Count >= MaxUi) break;
                if (selectable == null || !selectable.isActiveAndEnabled) continue;
                if (!(selectable.transform is RectTransform rect)) continue;
                var label = selectable.GetComponentInChildren<TMPro.TMP_Text>()?.text ?? selectable.GetComponentInChildren<Text>()?.text ?? "";
                controls.Add(new Dictionary<string, object>
                {
                    ["id"] = PathOf(selectable.transform),
                    ["kind"] = selectable.GetType().Name,
                    ["label"] = Clip(label.Trim(), 200),
                    ["enabled"] = selectable.IsInteractable(),
                    ["rect"] = ScreenRect(rect),
                });
            }
            return controls;
        }

        private static Dictionary<string, object> ScreenRect(RectTransform rect)
        {
            var corners = new Vector3[4];
            rect.GetWorldCorners(corners);
            var canvas = rect.GetComponentInParent<Canvas>();
            var camera = canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay ? canvas.worldCamera : null;
            var min = RectTransformUtility.WorldToScreenPoint(camera, corners[0]);
            var max = RectTransformUtility.WorldToScreenPoint(camera, corners[2]);
            return new Dictionary<string, object>
            {
                ["x"] = min.x,
                ["y"] = Screen.height - max.y,
                ["width"] = max.x - min.x,
                ["height"] = max.y - min.y,
            };
        }

        private IEnumerator Ui(Dictionary<string, object> ui, List<object> results)
        {
            var id = ui.GetValueOrDefault("id") as string ?? "";
            var action = ui.GetValueOrDefault("action") as string ?? "click";
            var target = FindControl(id);
            if (target == null)
            {
                results.Add(UiResult(id, action, false, "No visible control has that id; use an id from the ui list."));
                yield break;
            }
            var rect = ScreenRect((RectTransform)target.transform);
            var center = new Vector2(Number(rect["x"]) + Number(rect["width"]) / 2f, Number(rect["y"]) + Number(rect["height"]) / 2f);
            if (action == "drag")
            {
                var to = FindControl(ui.GetValueOrDefault("to") as string ?? "");
                if (to == null)
                {
                    results.Add(UiResult(id, action, false, "The drag target is not a visible control."));
                    yield break;
                }
                var toRect = ScreenRect((RectTransform)to.transform);
                yield return Drag(center, new Vector2(Number(toRect["x"]) + Number(toRect["width"]) / 2f, Number(toRect["y"]) + Number(toRect["height"]) / 2f), 0.3f);
            }
            else yield return Click(center, "left");
            var receiver = EventSystem.current != null;
            results.Add(UiResult(id, action, receiver, receiver ? "Real mouse input sent at the control's centre." : "No EventSystem in the scene, so UI cannot receive the click."));
        }

        private static Selectable FindControl(string id)
        {
            foreach (var selectable in Selectable.allSelectablesArray)
                if (selectable != null && selectable.isActiveAndEnabled && PathOf(selectable.transform) == id) return selectable;
            return null;
        }

        private static Dictionary<string, object> UiResult(string id, string action, bool received, string detail) =>
            new Dictionary<string, object> { ["id"] = id, ["action"] = action, ["received"] = received, ["detail"] = detail };

        private static Dictionary<string, object> Inspect(Dictionary<string, object> inspect)
        {
            var path = inspect.GetValueOrDefault("path") as string ?? "";
            var values = new Dictionary<string, object>();
            var result = new Dictionary<string, object> { ["path"] = path, ["values"] = values };
            var target = GameObject.Find(path.StartsWith("/") ? path : "/" + path) ?? GameObject.Find(path);
            if (target == null)
            {
                result["error"] = "No active GameObject at that path.";
                return result;
            }
            var at = target.transform.position;
            values["position"] = new List<object> { at.x, at.y, at.z };
            values["activeInHierarchy"] = target.activeInHierarchy;
            if (inspect.GetValueOrDefault("properties") is List<object> wanted)
                foreach (var raw in wanted)
                {
                    if (!(raw is string name)) continue;
                    values[name] = ReadMember(target, name);
                }
            return result;
        }

        private static object ReadMember(GameObject target, string name)
        {
            foreach (var component in target.GetComponents<Component>())
            {
                if (component == null) continue;
                var type = component.GetType();
                object value = null;
                var found = false;
                var field = type.GetField(name, BindingFlags.Instance | BindingFlags.Public);
                if (field != null) { value = field.GetValue(component); found = true; }
                else
                {
                    var property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                    if (property != null && property.CanRead && property.GetIndexParameters().Length == 0)
                    {
                        try { value = property.GetValue(component); found = true; } catch { }
                    }
                }
                if (!found) continue;
                switch (value)
                {
                    case null: return null;
                    case bool b: return b;
                    case int i: return i;
                    case float f: return f;
                    case double d: return d;
                    case string s: return Clip(s, 256);
                    case Enum e: return e.ToString();
                    case Vector2 v2: return new List<object> { v2.x, v2.y };
                    case Vector3 v3: return new List<object> { v3.x, v3.y, v3.z };
                    default: return Clip(value.ToString(), 256);
                }
            }
            return null;
        }

        private static bool Capture(string path)
        {
            Texture2D shot = null;
            try
            {
                shot = ScreenCapture.CaptureScreenshotAsTexture();
                File.WriteAllBytes(path, shot.EncodeToPNG());
                return true;
            }
            catch (Exception error)
            {
                Debug.LogWarning($"Kurambit screenshot failed: {error.Message}");
                return false;
            }
            finally
            {
                if (shot != null) Destroy(shot);
            }
        }

        private void Send(Dictionary<string, object> message)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(Json.Write(message) + "\n");
                stream.Write(bytes, 0, bytes.Length);
            }
            catch (Exception error)
            {
                Debug.LogWarning($"Kurambit explore send failed: {error.Message}");
            }
        }

        private static string Clip(string text, int max) =>
            text == null ? "" : text.Length > max ? text.Substring(0, max) : text;
    }

    /// <summary>Just enough JSON for the explore protocol, so players need no JSON package.</summary>
    internal static class Json
    {
        public static string Write(object value)
        {
            var output = new StringBuilder();
            WriteValue(output, value);
            return output.ToString();
        }

        private static void WriteValue(StringBuilder output, object value)
        {
            switch (value)
            {
                case null: output.Append("null"); break;
                case string s: WriteString(output, s); break;
                case bool b: output.Append(b ? "true" : "false"); break;
                case float f: output.Append(float.IsFinite(f) ? f.ToString("R", CultureInfo.InvariantCulture) : "null"); break;
                case double d: output.Append(double.IsFinite(d) ? d.ToString("R", CultureInfo.InvariantCulture) : "null"); break;
                case int i: output.Append(i.ToString(CultureInfo.InvariantCulture)); break;
                case long l: output.Append(l.ToString(CultureInfo.InvariantCulture)); break;
                case IDictionary<string, object> map:
                    output.Append('{');
                    var first = true;
                    foreach (var entry in map)
                    {
                        if (!first) output.Append(',');
                        first = false;
                        WriteString(output, entry.Key);
                        output.Append(':');
                        WriteValue(output, entry.Value);
                    }
                    output.Append('}');
                    break;
                case IEnumerable<object> list:
                    output.Append('[');
                    var head = true;
                    foreach (var item in list)
                    {
                        if (!head) output.Append(',');
                        head = false;
                        WriteValue(output, item);
                    }
                    output.Append(']');
                    break;
                default: WriteString(output, value.ToString()); break;
            }
        }

        private static void WriteString(StringBuilder output, string text)
        {
            output.Append('"');
            foreach (var c in text)
            {
                switch (c)
                {
                    case '"': output.Append("\\\""); break;
                    case '\\': output.Append("\\\\"); break;
                    case '\n': output.Append("\\n"); break;
                    case '\r': output.Append("\\r"); break;
                    case '\t': output.Append("\\t"); break;
                    default:
                        if (c < ' ') output.Append("\\u").Append(((int)c).ToString("x4"));
                        else output.Append(c);
                        break;
                }
            }
            output.Append('"');
        }

        public static object Parse(string text)
        {
            var at = 0;
            try
            {
                return ParseValue(text, ref at);
            }
            catch
            {
                return null;
            }
        }

        private static void Skip(string text, ref int at)
        {
            while (at < text.Length && char.IsWhiteSpace(text[at])) at++;
        }

        private static object ParseValue(string text, ref int at)
        {
            Skip(text, ref at);
            var c = text[at];
            if (c == '{')
            {
                var map = new Dictionary<string, object>();
                at++;
                Skip(text, ref at);
                if (text[at] == '}') { at++; return map; }
                while (true)
                {
                    Skip(text, ref at);
                    var key = ParseString(text, ref at);
                    Skip(text, ref at);
                    at++; // ':'
                    map[key] = ParseValue(text, ref at);
                    Skip(text, ref at);
                    if (text[at++] == '}') return map;
                }
            }
            if (c == '[')
            {
                var list = new List<object>();
                at++;
                Skip(text, ref at);
                if (text[at] == ']') { at++; return list; }
                while (true)
                {
                    list.Add(ParseValue(text, ref at));
                    Skip(text, ref at);
                    if (text[at++] == ']') return list;
                }
            }
            if (c == '"') return ParseString(text, ref at);
            if (text.Substring(at).StartsWith("true")) { at += 4; return true; }
            if (text.Substring(at).StartsWith("false")) { at += 5; return false; }
            if (text.Substring(at).StartsWith("null")) { at += 4; return null; }
            var start = at;
            while (at < text.Length && "+-0123456789.eE".IndexOf(text[at]) >= 0) at++;
            return double.Parse(text.Substring(start, at - start), CultureInfo.InvariantCulture);
        }

        private static string ParseString(string text, ref int at)
        {
            var output = new StringBuilder();
            at++; // opening quote
            while (text[at] != '"')
            {
                var c = text[at++];
                if (c != '\\') { output.Append(c); continue; }
                var e = text[at++];
                switch (e)
                {
                    case 'n': output.Append('\n'); break;
                    case 'r': output.Append('\r'); break;
                    case 't': output.Append('\t'); break;
                    case 'b': output.Append('\b'); break;
                    case 'f': output.Append('\f'); break;
                    case 'u': output.Append((char)Convert.ToInt32(text.Substring(at, 4), 16)); at += 4; break;
                    default: output.Append(e); break;
                }
            }
            at++;
            return output.ToString();
        }
    }
}
