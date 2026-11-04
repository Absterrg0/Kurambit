// Kurambit's read-only window into a running Unity game, and the runner that
// lets the harness play a built player. Keep this file; extend GameState, not
// the probe, when a new run value should be observable.
//
// The probe installs itself after the first scene loads. SnapshotJson() is the
// snapshot: GameState's public primitive members, the world position of the
// GameObject tagged "Player", and the text visible UI shows.
//
// A player started with `-kurambitExplore <request.json>` is also Unity's
// runner of Kurambit's play-session protocol (packages/contracts
// gamePlaySession.ts): it connects out to the loopback port named in that
// file, says hello, and plays the steps Kurambit sends one act at a time with
// the game paused (Time.timeScale 0) between acts. After `realtime` the game
// runs at its own speed for good while held keys, taps and clicks stream in
// and one tick observation goes out every 100 ms, which is what a bot plays
// on; when asked, the screen as drawn goes out as frames for the run video,
// read back from the GPU without stalling the frame. Input is queued through the Input System on a virtual keyboard and
// mouse, so the game receives real device events. Without that argument
// nothing here runs. Kurambit owns this file and refreshes it at the start of
// a production run.
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.Rendering;
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
        private const float TickSeconds = 0.1f;
        private const int TickErrors = 10;
        private const int TickUi = 32;
        private const int MaxLandmarks = 16;
        private const float RoomDistance = 6f;
        private const float DropDistance = 4f;

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
        private bool realtime;
        private float realtimeStart;
        private float nextTickAt;
        private int ticks;
        private readonly HashSet<Key> streamHeld = new HashSet<Key>();
        private readonly Dictionary<Key, float> tapEnds = new Dictionary<Key, float>();
        // Readbacks finish a few frames after their request; a few may wait at
        // once so a game that draws slower than the asked rate still sends
        // every frame it draws.
        private const int MaxReadbacks = 3;
        private int readbacks;

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

        // The same targets every engine's runner takes: "game_state" writes public
        // GameState fields, "player" moves the Player-tagged object, and any other
        // target is the game's own state jump, GameState.StudioSetState(target, values).
        private static Dictionary<string, object> ApplySetState(object id, Dictionary<string, object> message)
        {
            Dictionary<string, object> Reply(bool ok, string error, List<object> applied) => ok
                ? new Dictionary<string, object> { ["op"] = "reply", ["id"] = id, ["ok"] = true, ["applied"] = applied }
                : new Dictionary<string, object> { ["op"] = "reply", ["id"] = id, ["ok"] = false, ["error"] = error };
            var target = message.TryGetValue("target", out var t) ? Convert.ToString(t) : "";
            var values = message.TryGetValue("values", out var v) ? v as Dictionary<string, object> : null;
            if (values == null) return Reply(false, "setState values must be an object.", null);
            var applied = new List<object>();
            var state = GameState.Instance;
            if (target == "game_state")
            {
                foreach (var pair in values)
                {
                    var field = typeof(GameState).GetField(pair.Key, BindingFlags.Public | BindingFlags.Instance);
                    if (field == null || pair.Value == null) continue;
                    try
                    {
                        field.SetValue(state, field.FieldType.IsEnum
                            ? Enum.Parse(field.FieldType, Convert.ToString(pair.Value), true)
                            : Convert.ChangeType(pair.Value, field.FieldType, System.Globalization.CultureInfo.InvariantCulture));
                        applied.Add(pair.Key);
                    }
                    catch (Exception) { }
                }
                return Reply(true, null, applied);
            }
            if (target == "player")
            {
                GameObject player = null;
                try { player = GameObject.FindWithTag("Player"); } catch (UnityException) { }
                if (player == null) return Reply(false, "No Player-tagged object.", null);
                if (values.TryGetValue("position", out var p) && p is List<object> xyz && xyz.Count == 3)
                {
                    player.transform.position = new Vector3(Convert.ToSingle(xyz[0]), Convert.ToSingle(xyz[1]), Convert.ToSingle(xyz[2]));
                    var body = player.GetComponent<Rigidbody>();
                    if (body != null) body.linearVelocity = Vector3.zero;
                    applied.Add("position");
                }
                return Reply(true, null, applied);
            }
            var hook = typeof(GameState).GetMethod("StudioSetState", BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
            if (hook == null) return Reply(false, $"Unknown setState target {target}: add it to GameState.StudioSetState(string target, Dictionary<string, object> values).", null);
            try
            {
                var ok = hook.Invoke(hook.IsStatic ? null : state, new object[] { target, values });
                return ok is bool yes && yes ? Reply(true, null, new List<object> { target }) : Reply(false, $"GameState.StudioSetState refused {target}.", null);
            }
            catch (Exception error)
            {
                return Reply(false, $"GameState.StudioSetState failed: {error.InnerException?.Message ?? error.Message}", null);
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
            // TextMesh Pro without a font asset draws nothing (the project ships none), so it is not on screen.
            foreach (var text in FindObjectsByType<TMPro.TMP_Text>())
                if (text.isActiveAndEnabled && text.font != null && !string.IsNullOrWhiteSpace(text.text))
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

        // --- play-session runner ---

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
            var offscreen = HasArgument("-kurambitOffscreen");
            if (offscreen) PlaceOffscreen();
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
            // A player on a private display never holds window focus, and by
            // default the Input System disables devices while unfocused.
            InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            keyboard = InputSystem.AddDevice<Keyboard>("KurambitKeyboard");
            mouse = InputSystem.AddDevice<Mouse>("KurambitMouse");
            keyboard.MakeCurrent();
            mouse.MakeCurrent();
            // Let the main scene run its first frames before the first observation.
            for (var i = 0; i < 5; i++) yield return null;
            // The player may place its window again while it starts up.
            if (offscreen) PlaceOffscreen();
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
            hello["op"] = "hello";
            hello["protocol"] = 2;
            hello["token"] = token;
            hello["engine"] = "unity";
            hello["capabilities"] = new List<object> { "realtime", "ui", "inspect", "setState", "frames" };
            hello["body"] = Body();
            Send(hello);
            Pause();
        }

#if UNITY_STANDALONE_WIN
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
#endif

        /// <summary>
        /// On a desktop the user works in (`-kurambitOffscreen`), the player's
        /// own window goes far off every monitor without being activated; it
        /// keeps drawing there, since it is not minimized.
        /// </summary>
        private static void PlaceOffscreen()
        {
#if UNITY_STANDALONE_WIN
            var self = GetCurrentProcessId();
            for (var window = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "UnityWndClass", null);
                 window != IntPtr.Zero;
                 window = FindWindowEx(IntPtr.Zero, window, "UnityWndClass", null))
            {
                GetWindowThreadProcessId(window, out var owner);
                // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                if (owner == self) SetWindowPos(window, IntPtr.Zero, -10000, -10000, 0, 0, 0x0001 | 0x0004 | 0x0010);
            }
#endif
        }

        private static bool HasArgument(string name) => Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;

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
            if (stream == null) return;
            if (realtime)
            {
                while (inbox.TryDequeue(out var streamed)) Handle(streamed);
                ReleaseEndedTaps();
                if (Time.unscaledTime >= nextTickAt)
                {
                    nextTickAt = Time.unscaledTime + TickSeconds;
                    Send(Tick());
                }
                return;
            }
            if (acting || !inbox.TryDequeue(out var line)) return;
            Handle(line);
        }

        private void Handle(string line)
        {
            if (!(Json.Parse(line) is Dictionary<string, object> message)) return;
            var op = message.TryGetValue("op", out var o) ? o as string : null;
            var id = message.TryGetValue("id", out var i) ? i : 0;
            switch (op)
            {
                case "quit":
                    Send(new Dictionary<string, object> { ["op"] = "reply", ["id"] = id, ["ok"] = true });
                    Application.Quit();
                    break;
                case "act" when !realtime:
                    StartCoroutine(Act(message));
                    break;
                case "realtime" when !realtime:
                    // The game gets its own time scale back for good: from here
                    // on its pause screens pause it, never the runner.
                    realtime = true;
                    Time.timeScale = gameTimeScale;
                    realtimeStart = Time.time;
                    nextTickAt = Time.unscaledTime + TickSeconds;
                    if (message.TryGetValue("frames", out var f) && f is Dictionary<string, object> frames)
                        StartCoroutine(StreamFrames(
                            frames.TryGetValue("fps", out var fps) ? Convert.ToSingle(fps, CultureInfo.InvariantCulture) : 12f,
                            frames.TryGetValue("width", out var width) ? Convert.ToInt32(width, CultureInfo.InvariantCulture) : 960));
                    break;
                case "still":
                    StartCoroutine(Still(id, message.TryGetValue("path", out var sp) ? sp as string : null));
                    break;
                case "input" when realtime:
                    StreamInput(message);
                    break;
                case "setState":
                    Send(ApplySetState(id, message));
                    break;
            }
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
            reply["op"] = "reply";
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

        // --- real-time play ---

        private void StreamInput(Dictionary<string, object> message)
        {
            streamHeld.Clear();
            if (message.GetValueOrDefault("held") is List<object> heldNames)
                foreach (var name in heldNames)
                    if (TryKey(name as string, out var key)) streamHeld.Add(key);
            if (message.GetValueOrDefault("taps") is List<object> tapNames)
                foreach (var name in tapNames)
                    if (TryKey(name as string, out var key)) tapEnds[key] = Time.unscaledTime + PressSeconds;
            QueueStreamKeys();
            if (!(message.GetValueOrDefault("clicks") is List<object> clicks)) return;
            foreach (var raw in clicks)
            {
                if (!(raw is Dictionary<string, object> click)) continue;
                if (click.GetValueOrDefault("id") is string controlId && controlId != "")
                {
                    var target = FindControl(controlId);
                    if (target == null) continue;
                    var rect = ScreenRect((RectTransform)target.transform);
                    StartCoroutine(Click(new Vector2(Number(rect["x"]) + Number(rect["width"]) / 2f, Number(rect["y"]) + Number(rect["height"]) / 2f), "left"));
                }
                else if (click.ContainsKey("x") && click.ContainsKey("y"))
                    StartCoroutine(Click(new Vector2(Number(click["x"]), Number(click["y"])), "left"));
            }
        }

        private void ReleaseEndedTaps()
        {
            if (tapEnds.Count == 0) return;
            var ended = new List<Key>();
            foreach (var entry in tapEnds)
                if (Time.unscaledTime >= entry.Value) ended.Add(entry.Key);
            if (ended.Count == 0) return;
            foreach (var key in ended) tapEnds.Remove(key);
            QueueStreamKeys();
        }

        private void QueueStreamKeys()
        {
            var down = new HashSet<Key>(streamHeld);
            foreach (var key in tapEnds.Keys) down.Add(key);
            var array = new Key[down.Count];
            down.CopyTo(array);
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(array));
        }

        private Dictionary<string, object> Tick()
        {
            ticks++;
            List<object> drained;
            lock (errors)
            {
                drained = new List<object>(errors.GetRange(0, Math.Min(errors.Count, TickErrors)));
                errors.Clear();
            }
            var player = FindPlayer();
            return new Dictionary<string, object>
            {
                ["op"] = "tick",
                ["tick"] = ticks,
                ["t"] = Time.time - realtimeStart,
                ["probe"] = Snapshot(),
                ["body"] = Body(),
                ["visible"] = Visible(player),
                ["room"] = Room(player),
                ["errors"] = drained,
                ["sweep"] = null,
                ["perf"] = null,
            };
        }

        private static GameObject FindPlayer()
        {
            try { return GameObject.FindWithTag("Player"); } catch (UnityException) { return null; }
        }

        private static Dictionary<string, object> Body()
        {
            var player = FindPlayer();
            if (player == null) return new Dictionary<string, object> { ["present"] = false };
            var body = new Dictionary<string, object> { ["present"] = true, ["dim"] = "3d", ["onGround"] = null, ["touching"] = 0 };
            var velocity = Vector3.zero;
            if (player.TryGetComponent<CharacterController>(out var controller))
            {
                body["onGround"] = controller.isGrounded;
                velocity = controller.velocity;
            }
            else if (player.TryGetComponent<Rigidbody>(out var rigid)) velocity = rigid.linearVelocity;
            else if (player.TryGetComponent<Rigidbody2D>(out var rigid2D))
            {
                body["dim"] = "2d";
                body["vx"] = rigid2D.linearVelocity.x;
                body["vy"] = rigid2D.linearVelocity.y;
                return body;
            }
            body["vx"] = velocity.x;
            body["vy"] = velocity.y;
            body["vz"] = velocity.z;
            return body;
        }

        // The nearest named objects around a 3D player, with distance and the
        // bearing from the camera's flat forward, as the bot kit reads them.
        private static List<object> Visible(GameObject player)
        {
            var visible = new List<object>();
            foreach (var selectable in Selectable.allSelectablesArray)
            {
                if (visible.Count >= TickUi) break;
                if (selectable == null || !selectable.isActiveAndEnabled) continue;
                var label = selectable.GetComponentInChildren<TMPro.TMP_Text>()?.text ?? selectable.GetComponentInChildren<Text>()?.text ?? "";
                visible.Add(new Dictionary<string, object> { ["kind"] = selectable.GetType().Name, ["label"] = Clip(label.Trim(), 80) });
            }
            if (player == null || player.GetComponent<Rigidbody2D>() != null) return visible;
            var at = player.transform.position;
            var camera = Camera.main;
            var forward = camera != null ? camera.transform.forward : Vector3.forward;
            forward.y = 0f;
            if (forward.sqrMagnitude < 0.0001f) forward = Vector3.forward;
            forward.Normalize();
            var found = new List<Dictionary<string, object>>();
            var pending = new Stack<Transform>();
            foreach (var top in player.scene.GetRootGameObjects()) pending.Push(top.transform);
            var visited = 0;
            while (pending.Count > 0 && visited < 300)
            {
                var node = pending.Pop();
                visited++;
                if (!node.gameObject.activeInHierarchy) continue;
                foreach (Transform child in node) pending.Push(child);
                if (node == player.transform || node.IsChildOf(player.transform)) continue;
                var position = node.position;
                var offset = new Vector2(position.x - at.x, position.z - at.z);
                var cross = forward.x * offset.y - forward.z * offset.x;
                var dot = forward.x * offset.x + forward.z * offset.y;
                var inView = true;
                if (camera != null)
                {
                    var viewport = camera.WorldToViewportPoint(position);
                    inView = viewport.z > 0f && viewport.x >= 0f && viewport.x <= 1f && viewport.y >= 0f && viewport.y <= 1f;
                }
                found.Add(new Dictionary<string, object>
                {
                    ["label"] = Clip(node.name, 40),
                    ["dist"] = Mathf.Round(offset.magnitude * 10f) / 10f,
                    ["bearing"] = Mathf.Round(Mathf.Atan2(cross, dot) * Mathf.Rad2Deg),
                    ["dy"] = Mathf.Round((position.y - at.y) * 10f) / 10f,
                    ["inView"] = inView,
                });
            }
            found.Sort((a, b) => ((float)a["dist"]).CompareTo((float)b["dist"]));
            for (var i = 0; i < found.Count && i < MaxLandmarks; i++) visible.Add(found[i]);
            return visible;
        }

        // Clearance rays along the world axes (forward = -Z) and the floor
        // depth 1.2 m ahead each way, skipping the player's own colliders.
        private static object Room(GameObject player)
        {
            if (player == null || player.GetComponentInChildren<Collider>() == null) return null;
            var from = player.transform.position + Vector3.up * 0.5f;
            var room = new Dictionary<string, object>();
            var directions = new (string, Vector3)[] { ("forward", Vector3.back), ("back", Vector3.forward), ("left", Vector3.left), ("right", Vector3.right) };
            foreach (var (name, direction) in directions)
            {
                room[name] = Mathf.Round(Clearance(player, from, direction, RoomDistance) * 10f) / 10f;
                room["drop_" + name] = Mathf.Round(Clearance(player, from + direction * 1.2f, Vector3.down, DropDistance) * 10f) / 10f;
            }
            return room;
        }

        private static float Clearance(GameObject player, Vector3 from, Vector3 direction, float range)
        {
            var nearest = range;
            foreach (var hit in Physics.RaycastAll(from, direction, range, ~0, QueryTriggerInteraction.Ignore))
                if (!hit.transform.IsChildOf(player.transform) && hit.distance < nearest) nearest = hit.distance;
            return nearest;
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

        private IEnumerator Still(object id, string path)
        {
            yield return new WaitForEndOfFrame();
            var written = path != null && Capture(path);
            Send(new Dictionary<string, object> { ["op"] = "reply", ["id"] = id, ["ok"] = true, ["screenshot"] = written });
        }

        /// <summary>
        /// The screen after each frame's draw, downscaled on the GPU and read
        /// back asynchronously, at about `fps` on wall time.
        /// </summary>
        private IEnumerator StreamFrames(float fps, int maxWidth)
        {
            var endOfFrame = new WaitForEndOfFrame();
            var interval = 1f / Mathf.Max(1f, fps);
            var next = 0f;
            RenderTexture small = null;
            try
            {
                while (stream != null)
                {
                    yield return endOfFrame;
                    if (readbacks >= MaxReadbacks || Time.unscaledTime < next || Screen.width <= 0 || Screen.height <= 0) continue;
                    next = Mathf.Max(next + interval, Time.unscaledTime);
                    var width = Mathf.Max(16, Mathf.Min(maxWidth, Screen.width));
                    var height = Mathf.Max(1, Mathf.RoundToInt(Screen.height * (float)width / Screen.width));
                    if (small == null || small.width != width || small.height != height)
                    {
                        if (small != null) small.Release();
                        small = new RenderTexture(width, height, 0, RenderTextureFormat.ARGB32);
                    }
                    var full = RenderTexture.GetTemporary(Screen.width, Screen.height, 0, RenderTextureFormat.ARGB32);
                    // Blit leaves its target active, and the game's next frame
                    // would then draw into the downscaled size: put it back.
                    var active = RenderTexture.active;
                    ScreenCapture.CaptureScreenshotIntoRenderTexture(full);
                    // Where texture rows start at the top, the readback would
                    // come out upside down for the encoder, which reads rows
                    // bottom first like a Texture2D.
                    if (SystemInfo.graphicsUVStartsAtTop) Graphics.Blit(full, small, new Vector2(1f, -1f), new Vector2(0f, 1f));
                    else Graphics.Blit(full, small);
                    RenderTexture.active = active;
                    RenderTexture.ReleaseTemporary(full);
                    var counter = Time.frameCount;
                    var t = Time.time - realtimeStart;
                    if (SystemInfo.supportsAsyncGPUReadback)
                    {
                        readbacks++;
                        AsyncGPUReadback.Request(small, 0, TextureFormat.RGBA32, request =>
                        {
                            readbacks--;
                            if (request.hasError || stream == null) return;
                            using (var jpeg = ImageConversion.EncodeNativeArrayToJPG(request.GetData<byte>(), GraphicsFormat.R8G8B8A8_UNorm, (uint)width, (uint)height, 0, 75))
                                SendFrame(jpeg.ToArray(), counter, t, width, height);
                        });
                    }
                    else
                    {
                        var previous = RenderTexture.active;
                        RenderTexture.active = small;
                        var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                        texture.ReadPixels(new Rect(0, 0, width, height), 0, 0, false);
                        RenderTexture.active = previous;
                        SendFrame(texture.EncodeToJPG(75), counter, t, width, height);
                        Destroy(texture);
                    }
                }
            }
            finally
            {
                if (small != null) small.Release();
            }
        }

        private void SendFrame(byte[] jpeg, int counter, float t, int width, int height)
        {
            // "op" goes first: the harness tells a frame from every other line by its start.
            Send(new Dictionary<string, object>
            {
                ["op"] = "frame",
                ["frame"] = counter,
                ["t"] = t,
                ["width"] = width,
                ["height"] = height,
                ["jpeg"] = Convert.ToBase64String(jpeg),
            });
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
