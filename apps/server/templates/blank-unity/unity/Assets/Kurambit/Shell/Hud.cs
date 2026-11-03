using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// The HUD kit. Every widget is found by its name, so call these every frame
/// from Update; text is written only when it changes. The shell clears the HUD
/// on every Play, Retry and Main menu, and its timers run on game time, so it
/// freezes with the game. Its labels are what the StudioProbe reads: the same
/// HUD the player sees. Do not build other HUD text beside it.
///
///   Hud.Counter("Gems", gems, 5);              // "Gems 3 / 5", pops when it changes
///   Hud.Counter("Score", score);               // "Score 1200"
///   Hud.Bar("Health", hp, 3);                  // hearts up to 10, a bar above that
///   Hud.Timer("Time", secondsLeft);            // "Time 1:05"
///   Hud.Objective("Light all five shrines");   // top centre; "" hides it
///   Hud.Toast("Gate opened!");                 // on the event: centre, queued, ~2 s each
///   Hud.Hint("Press {jump} to jump", () => jumped);   // {action} becomes its key
///
/// A hint shows once per launch, until its condition is true or `seconds` pass
/// (default 6). A toast repeated within a few seconds of showing is dropped,
/// and at most three wait at once.
/// </summary>
public static class Hud
{
    private const float ToastSeconds = 1.8f;
    private const float FadeSeconds = 0.25f;
    private const float ToastAgainSeconds = 4f;
    private const int MaxToasts = 3;
    private const float PopGapSeconds = 0.3f;

    private sealed class Widget
    {
        public string kind;
        public RectTransform row;
        public Text label;
        public object value;
        public float poppedAt = -999f;
        public readonly List<Image> pips = new List<Image>();
        public RectTransform fill;
    }

    private sealed class Pending
    {
        public string text;
        public float seconds;
        public Func<bool> until;
    }

    private static RectTransform root;
    private static RectTransform stats;
    private static Text objective;
    private static Text toast;
    private static Text hint;
    private static Sprite heart;
    private static readonly Dictionary<string, Widget> widgets = new Dictionary<string, Widget>();
    private static readonly Queue<Pending> toasts = new Queue<Pending>();
    private static readonly Dictionary<string, float> recent = new Dictionary<string, float>();
    private static readonly List<Pending> hints = new List<Pending>();
    private static readonly HashSet<string> shownHints = new HashSet<string>();
    private static Pending toastNow;
    private static Pending hintNow;
    private static float now;

    private static RectTransform Root
    {
        get
        {
            if (root != null) return root;
            var canvasObject = new GameObject("Hud", typeof(RectTransform));
            UnityEngine.Object.DontDestroyOnLoad(canvasObject);
            var canvas = canvasObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = 10;
            var scaler = canvasObject.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280, 720);
            scaler.matchWidthOrHeight = 0.5f;
            canvasObject.AddComponent<HudRunner>();
            root = (RectTransform)canvasObject.transform;
            stats = Ui.Rect("Stats", root);
            stats.anchorMin = stats.anchorMax = stats.pivot = new Vector2(0f, 1f);
            stats.anchoredPosition = new Vector2(18f, -14f);
            stats.sizeDelta = new Vector2(420f, 400f);
            var column = Ui.Column(stats, 4f, TextAnchor.UpperLeft);
            column.childControlWidth = false;
            objective = Panel("Objective", new Vector2(0.5f, 1f), new Vector2(0f, -14f));
            toast = Ui.OutlinedLabel(root, "Toast", ShellTheme.ToastSize, TextAnchor.MiddleCenter);
            toast.rectTransform.anchorMin = toast.rectTransform.anchorMax = new Vector2(0.5f, 0.74f);
            toast.rectTransform.sizeDelta = new Vector2(1000f, 60f);
            hint = Panel("Hint", new Vector2(0.5f, 0f), new Vector2(0f, 56f));
            Clear();
            return root;
        }
    }

    private static Text Panel(string name, Vector2 anchor, Vector2 offset)
    {
        var panel = Ui.Image(root, name, ShellTheme.Panel);
        var rect = panel.rectTransform;
        rect.anchorMin = rect.anchorMax = rect.pivot = anchor;
        rect.anchoredPosition = offset;
        var fitter = panel.gameObject.AddComponent<ContentSizeFitter>();
        fitter.horizontalFit = ContentSizeFitter.FitMode.PreferredSize;
        fitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
        var layout = panel.gameObject.AddComponent<HorizontalLayoutGroup>();
        layout.padding = new RectOffset(16, 16, 6, 6);
        layout.childControlWidth = true;
        layout.childControlHeight = true;
        var label = Ui.Label(rect, "Text", "", ShellTheme.HudSize);
        label.horizontalOverflow = HorizontalWrapMode.Overflow;
        return label;
    }

    /// <summary>The shell's: empties the HUD for a new run or the title.</summary>
    public static void Clear()
    {
        if (root == null) return;
        foreach (var widget in widgets.Values) UnityEngine.Object.Destroy(widget.row.gameObject);
        widgets.Clear();
        toasts.Clear();
        recent.Clear();
        hints.Clear();
        toastNow = null;
        hintNow = null;
        objective.transform.parent.gameObject.SetActive(false);
        toast.gameObject.SetActive(false);
        hint.transform.parent.gameObject.SetActive(false);
    }

    /// <summary>The shell's, as the end screen opens: a toast still queued would sit frozen behind it.</summary>
    internal static void DropToasts()
    {
        if (root == null) return;
        toasts.Clear();
        toastNow = null;
        toast.gameObject.SetActive(false);
    }

    // A gameplay scene still unloading after Main menu would otherwise refill
    // the HUD behind the title, and the probe would report text nobody sees.
    private static bool Closed => GameState.Instance != null && GameState.Instance.state == "title";

    public static void Counter(string name, object value, object max = null)
    {
        if (Closed) return;
        var widget = Get(name, "counter");
        var text = max == null ? $"{name} {value}" : $"{name} {value} / {max}";
        if (widget.value != null && !widget.value.Equals(value)) Pop(widget, 0.18f);
        widget.value = value;
        Write(widget.label, text);
    }

    public static void Bar(string name, float value, float max)
    {
        if (Closed) return;
        var hearts = max <= 10f;
        var widget = Get(name, hearts ? "hearts" : "bar");
        var clamped = Mathf.Clamp(value, 0f, Mathf.Max(max, 0f));
        Write(widget.label, $"{name} {Mathf.RoundToInt(clamped)} / {Mathf.RoundToInt(max)}");
        if (hearts)
        {
            var total = Mathf.RoundToInt(max);
            while (widget.pips.Count < total)
            {
                var pip = Ui.Image(widget.row, "Heart", Color.white);
                pip.sprite = HeartSprite();
                Ui.Size(pip, 24f, 22f);
                widget.pips.Add(pip);
            }
            var full = Mathf.RoundToInt(clamped);
            for (var i = 0; i < widget.pips.Count; i++)
            {
                var pip = widget.pips[i];
                var shown = i < total;
                if (pip.gameObject.activeSelf != shown) pip.gameObject.SetActive(shown);
                var colour = i < full ? ShellTheme.Heart : new Color(1f, 1f, 1f, 0.28f);
                if (pip.color != colour) pip.color = colour;
            }
        }
        else
        {
            var ratio = max > 0f ? clamped / max : 0f;
            if (!Mathf.Approximately(widget.fill.anchorMax.x, ratio)) widget.fill.anchorMax = new Vector2(ratio, 1f);
        }
        if (widget.value is float before && clamped < before) Pop(widget, 0.15f);
        widget.value = clamped;
    }

    public static void Timer(string name, float seconds)
    {
        if (Closed) return;
        var widget = Get(name, "timer");
        var whole = Mathf.Max(0, Mathf.CeilToInt(seconds));
        Write(widget.label, $"{name} {whole / 60}:{whole % 60:00}");
    }

    public static void Objective(string text)
    {
        if (Closed) return;
        _ = Root;
        Write(objective, text ?? "");
        var panel = objective.transform.parent.gameObject;
        var shown = !string.IsNullOrEmpty(text);
        if (panel.activeSelf != shown) panel.SetActive(shown);
    }

    public static void Toast(string text, float seconds = ToastSeconds)
    {
        if (Closed) return;
        _ = Root;
        // Called from a condition every frame, the same text would show
        // forever: it waits while it shows or queues, and a call within a few
        // seconds of it ending restarts that wait.
        if (recent.ContainsKey(text))
        {
            recent[text] = ToastAgainSeconds;
            return;
        }
        if (toastNow != null && toastNow.text == text) return;
        foreach (var queued in toasts)
            if (queued.text == text) return;
        // Text that changes every frame would queue without end: keep the newest few.
        if (toasts.Count >= MaxToasts) toasts.Dequeue();
        toasts.Enqueue(new Pending { text = text, seconds = seconds });
    }

    public static void Hint(string text, Func<bool> until = null, float seconds = 6f)
    {
        if (Closed) return;
        _ = Root;
        if (shownHints.Contains(text) || (hintNow != null && hintNow.text == text)) return;
        foreach (var queued in hints)
            if (queued.text == text) return;
        hints.Add(new Pending { text = text, until = until, seconds = seconds });
    }

    internal static void Tick(float delta)
    {
        now += delta;
        if (recent.Count > 0)
            foreach (var text in new List<string>(recent.Keys))
            {
                recent[text] -= delta;
                if (recent[text] <= 0f) recent.Remove(text);
            }
        if (toastNow == null && toasts.Count > 0)
        {
            toastNow = toasts.Dequeue();
            Write(toast, toastNow.text);
            toast.color = ShellTheme.Text;
            toast.gameObject.SetActive(true);
        }
        else if (toastNow != null)
        {
            toastNow.seconds -= delta;
            SetAlpha(toast, Mathf.Clamp01(1f + toastNow.seconds / FadeSeconds));
            if (toastNow.seconds <= -FadeSeconds)
            {
                // Hidden, not only transparent: the probe reads active text.
                toast.gameObject.SetActive(false);
                recent[toastNow.text] = ToastAgainSeconds;
                toastNow = null;
            }
        }
        if (hintNow == null && hints.Count > 0)
        {
            hintNow = hints[0];
            hints.RemoveAt(0);
            // Shown counts from here: a hint queued when the run ended comes back next run.
            shownHints.Add(hintNow.text);
            Write(hint, Labelled(hintNow.text));
            SetAlpha(hint, 1f);
            hint.transform.parent.gameObject.SetActive(true);
        }
        else if (hintNow != null)
        {
            hintNow.seconds -= delta;
            if (hintNow.seconds > 0f && hintNow.until != null && SafeUntil(hintNow.until)) hintNow.seconds = 0f;
            SetAlpha(hint, Mathf.Clamp01(1f + hintNow.seconds / FadeSeconds));
            if (hintNow.seconds <= -FadeSeconds)
            {
                hint.transform.parent.gameObject.SetActive(false);
                hintNow = null;
            }
        }
        foreach (var widget in widgets.Values)
        {
            var age = now - widget.poppedAt;
            var scale = age < 0.2f ? 1f + Mathf.Sin(age / 0.2f * Mathf.PI) * 0.12f : 1f;
            if (widget.row.localScale.x != scale) widget.row.localScale = new Vector3(scale, scale, 1f);
        }
    }

    private static bool SafeUntil(Func<bool> until)
    {
        try { return until(); }
        catch (Exception error)
        {
            Debug.LogException(error);
            return true;
        }
    }

    private static readonly Regex Placeholder = new Regex(@"\{([a-z_0-9]+)\}");

    private static string Labelled(string text) => Placeholder.Replace(text, match => Controls.KeyLabel(match.Groups[1].Value));

    private static Widget Get(string name, string kind)
    {
        _ = Root;
        if (widgets.TryGetValue(name, out var found) && found.kind == kind) return found;
        if (found != null) UnityEngine.Object.Destroy(found.row.gameObject);
        var row = Ui.Rect(name, stats);
        var layout = row.gameObject.AddComponent<HorizontalLayoutGroup>();
        layout.spacing = 8f;
        layout.childAlignment = TextAnchor.MiddleLeft;
        layout.childControlWidth = false;
        layout.childControlHeight = false;
        layout.childForceExpandWidth = false;
        Ui.Size(row, 420f, 30f);
        row.pivot = new Vector2(0f, 0.5f);
        var widget = new Widget { kind = kind, row = row, label = Ui.OutlinedLabel(row, "Text", ShellTheme.HudSize, TextAnchor.MiddleLeft) };
        widget.label.horizontalOverflow = HorizontalWrapMode.Overflow;
        var fitter = widget.label.gameObject.AddComponent<ContentSizeFitter>();
        fitter.horizontalFit = ContentSizeFitter.FitMode.PreferredSize;
        widget.label.rectTransform.sizeDelta = new Vector2(0f, 30f);
        if (kind == "bar")
        {
            var track = Ui.Image(row, "Track", new Color(1f, 1f, 1f, 0.14f));
            Ui.Size(track, 150f, 10f);
            var fill = Ui.Image(track.rectTransform, "Fill", ShellTheme.Accent);
            widget.fill = Ui.Fill(fill.rectTransform);
        }
        widgets[name] = widget;
        return widget;
    }

    private static void Pop(Widget widget, float amount)
    {
        if (now - widget.poppedAt < PopGapSeconds) return;
        widget.poppedAt = now;
    }

    private static void Write(Text label, string text)
    {
        if (label.text != text) label.text = text;
    }

    private static void SetAlpha(Graphic graphic, float alpha)
    {
        var panel = graphic.transform.parent.GetComponent<Image>();
        var colour = graphic.color;
        if (Mathf.Approximately(colour.a, alpha)) return;
        colour.a = alpha;
        graphic.color = colour;
        if (panel != null)
        {
            var back = ShellTheme.Panel;
            back.a *= alpha;
            panel.color = back;
        }
    }

    private static Sprite HeartSprite()
    {
        if (heart != null) return heart;
        const int size = 48;
        var texture = new Texture2D(size, size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
        var pixels = new Color32[size * size];
        for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
            {
                // The classic implicit heart curve, (x²+y²-1)³ - x²y³ <= 0, scaled into the square.
                var u = (x + 0.5f) / size * 2.6f - 1.3f;
                var v = (y + 0.5f) / size * 2.6f - 1.25f;
                var a = u * u + v * v - 1f;
                var inside = a * a * a - u * u * v * v * v <= 0f;
                pixels[y * size + x] = inside ? new Color32(255, 255, 255, 255) : new Color32(255, 255, 255, 0);
            }
        texture.SetPixels32(pixels);
        texture.Apply();
        heart = Sprite.Create(texture, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f));
        return heart;
    }
}

/// <summary>Advances the HUD on game time, after gameplay's Update wrote this frame's values.</summary>
[DefaultExecutionOrder(1000)]
internal sealed class HudRunner : MonoBehaviour
{
    private void LateUpdate() => Hud.Tick(Time.deltaTime);
}
