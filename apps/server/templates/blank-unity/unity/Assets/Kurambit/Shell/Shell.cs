using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using UnityEngine.InputSystem.Utilities;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

// The demo shell around the gameplay scene: title, pause, settings, controls,
// credits and end screens, built in code so they always exist and always
// render. The game plugs in at Assets/Scenes/Game.unity, which the shell loads
// (additively, as the active scene) on Play and on Retry, a fresh copy each
// run, and unloads on Main menu. The game ends a run with GameState.Win(...)
// or GameState.Lose(...) and never builds these screens itself.
//
// Pause (Esc, P or gamepad Start) sets Time.timeScale to 0 and pauses audio:
// gameplay reads Time.deltaTime and Controls, so it freezes; menus keep
// working. A run's end plays out in slow motion for a moment, then freezes
// and the end screen opens. Settings (volumes, fullscreen, rebound keys) are
// saved in settings.json under Application.persistentDataPath.
//
// Playing Game.unity on its own (the editor, game_check) boots straight into
// a run around it. Restyle the screens in ShellTheme.cs.
[DefaultExecutionOrder(-100)]
public sealed class Shell : MonoBehaviour
{
    /// <summary>The gameplay scene, by name; it must be in the build list.</summary>
    public const string GameScene = "Game";
    /// <summary>true boots straight into play, skipping the title (handy while building). Ship it false.</summary>
    public static bool BootIntoPlay = false;
    private const float EndBeatSeconds = 0.6f;
    private const float EndBeatScale = 0.3f;
    // The end screen ignores input this long, so a button mashed as the run ends cannot skip it.
    private const float EndGuardSeconds = 0.4f;
    private const string SettingsFile = "settings.json";

    public static Shell Instance { get; private set; }

    private RectTransform canvas;
    private RawImage backdrop;
    private RectTransform title, pause, settings, controls, credits, end;
    private RectTransform[] screens;
    private RectTransform current;
    private RectTransform settingsFrom;
    private Text endHeading, creditsText, controlsNote;
    private RectTransform endStats, controlsList;
    private Button retry, endMenu, resetProgress, fullscreen;
    private Slider master, music, sfx;
    private readonly Dictionary<string, Button> keyButtons = new Dictionary<string, Button>();
    private readonly Dictionary<string, Text> padLabels = new Dictionary<string, Text>();
    private Camera shellCamera;
    private int serial;
    private bool loading;
    private CursorLockMode playCursor = CursorLockMode.None;
    private string rebinding;
    private IDisposable rebindListener;
    private int rebindEndedFrame = -1;
    private SettingsData saved = new SettingsData();

    private sealed class SettingsData
    {
        public float master = 1f, music = 1f, sfx = 1f;
        public bool fullscreen;
        public Dictionary<string, object> bindings = new Dictionary<string, object>();
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Install()
    {
        if (Instance != null) return;
        var host = new GameObject("Shell", typeof(RectTransform));
        DontDestroyOnLoad(host);
        host.AddComponent<Shell>();
    }

    private static GameState Run => GameState.Instance;

    private void Awake()
    {
        Instance = this;
        if (EventSystem.current == null && FindAnyObjectByType<EventSystem>() == null)
        {
            var events = new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
            DontDestroyOnLoad(events);
        }
        var camera = new GameObject("ShellCamera");
        DontDestroyOnLoad(camera);
        shellCamera = camera.AddComponent<Camera>();
        shellCamera.clearFlags = CameraClearFlags.SolidColor;
        shellCamera.backgroundColor = ShellTheme.Backdrop;
        shellCamera.cullingMask = 0;
        shellCamera.depth = -100;
        BuildScreens();
        LoadSettings();
        Run.LoadProgress();
        GameState.Ended += OnEnded;
        // Game.unity played on its own (the editor, game_check): a run around it,
        // started before any of its Start methods run.
        if (SceneManager.GetSceneByName(GameScene).isLoaded)
        {
            Begin();
            Run.state = "playing";
            SceneManager.SetActiveScene(SceneManager.GetSceneByName(GameScene));
        }
        else if (BootIntoPlay) StartRun();
        else ShowTitle();
    }

    private void OnDestroy()
    {
        GameState.Ended -= OnEnded;
        rebindListener?.Dispose();
    }

    // --- flow ---

    public void StartRun()
    {
        if (loading) return;
        StartCoroutine(LoadRun());
    }

    private void Begin()
    {
        serial++;
        Hud.Clear();
        Run.NewRun();
        Time.timeScale = 1f;
        AudioListener.pause = false;
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;
        Show(null);
    }

    private IEnumerator LoadRun()
    {
        loading = true;
        Begin();
        var old = SceneManager.GetSceneByName(GameScene);
        if (old.isLoaded) yield return SceneManager.UnloadSceneAsync(old);
        Run.state = "playing";
        var load = SceneManager.LoadSceneAsync(GameScene, LoadSceneMode.Additive);
        if (load == null)
        {
            Debug.LogError($"Shell: the gameplay scene \"{GameScene}\" is not in the build list.");
            loading = false;
            ShowTitle();
            yield break;
        }
        yield return load;
        SceneManager.SetActiveScene(SceneManager.GetSceneByName(GameScene));
        loading = false;
    }

    public void Pause()
    {
        if (Run.state != "playing" || loading) return;
        playCursor = Cursor.lockState;
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;
        Run.state = "paused";
        Time.timeScale = 0f;
        AudioListener.pause = true;
        Show(pause);
    }

    public void Resume()
    {
        if (Run.state != "paused") return;
        Show(null);
        Time.timeScale = 1f;
        AudioListener.pause = false;
        Run.state = "playing";
        Cursor.lockState = playCursor;
        Cursor.visible = playCursor == CursorLockMode.None;
    }

    public void ShowTitle()
    {
        serial++;
        StopAllCoroutines();
        loading = false;
        Hud.Clear();
        var game = SceneManager.GetSceneByName(GameScene);
        if (game.isLoaded && SceneManager.sceneCount > 1) SceneManager.UnloadSceneAsync(game);
        Time.timeScale = 1f;
        AudioListener.pause = false;
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;
        Run.result = "";
        Run.resultText = "";
        Run.state = "title";
        Show(title);
    }

    private void OnEnded(bool won, string text, IReadOnlyList<KeyValuePair<string, string>> stats) =>
        StartCoroutine(EndRoutine(won, text, stats));

    private IEnumerator EndRoutine(bool won, string text, IReadOnlyList<KeyValuePair<string, string>> stats)
    {
        var mine = ++serial;
        Time.timeScale = EndBeatScale;
        // Counts only running time: the explore runner holding the game between
        // acts must not let the beat finish underneath it.
        for (var left = EndBeatSeconds; left > 0f;)
        {
            yield return null;
            if (serial != mine) yield break;
            if (Time.timeScale > 0f) left -= Time.unscaledDeltaTime;
        }
        Time.timeScale = 0f;
        AudioListener.pause = true;
        Cursor.lockState = CursorLockMode.None;
        Cursor.visible = true;
        Hud.DropToasts();
        endHeading.text = text;
        endHeading.color = won ? ShellTheme.Win : ShellTheme.Lose;
        foreach (Transform child in endStats) Destroy(child.gameObject);
        foreach (var stat in stats) StatRow(endStats, stat.Key, stat.Value);
        endStats.gameObject.SetActive(stats.Count > 0);
        Ui.Size(endStats, 460f, Mathf.Max(1, stats.Count) * 32f);
        retry.interactable = false;
        endMenu.interactable = false;
        Show(end);
        yield return new WaitForSecondsRealtime(EndGuardSeconds);
        if (serial != mine || current != end) yield break;
        retry.interactable = true;
        endMenu.interactable = true;
        Select(end);
    }

    private void Update()
    {
        var others = Camera.allCamerasCount - (shellCamera.enabled ? 1 : 0);
        if (shellCamera.enabled != (others == 0)) shellCamera.enabled = others == 0;
        if (current != null)
        {
            var selected = EventSystem.current != null ? EventSystem.current.currentSelectedGameObject : null;
            if (selected == null || !selected.activeInHierarchy) Select(current);
        }
        if (rebinding != null || Time.frameCount == rebindEndedFrame) return;
        var pausePressed = Controls.PausePressed();
        var back = pausePressed || (Gamepad.current != null && Gamepad.current.buttonEast.wasPressedThisFrame);
        if (!back) return;
        if (current == controls) Show(settings);
        else if (current == settings) CloseSettings();
        else if (current == credits) Show(title);
        else if (Run.state == "playing" && pausePressed) Pause();
        else if (Run.state == "paused") Resume();
    }

    // --- screens ---

    private void Show(RectTransform screen)
    {
        if (screen != controls) StopRebind(null);
        current = screen;
        foreach (var each in screens) each.gameObject.SetActive(each == screen);
        // Settings and credits opened from the title keep its backdrop behind them.
        backdrop.gameObject.SetActive(Run.state == "title" && screen != null);
        if (screen == null) EventSystem.current?.SetSelectedGameObject(null);
        else Select(screen);
    }

    private static void Select(RectTransform screen)
    {
        var first = screen.GetComponentsInChildren<Selectable>().FirstOrDefault(each => each.interactable && each.gameObject.activeInHierarchy);
        if (first != null && EventSystem.current != null) EventSystem.current.SetSelectedGameObject(first.gameObject);
    }

    private void BuildScreens()
    {
        canvas = (RectTransform)transform;
        var surface = gameObject.AddComponent<Canvas>();
        surface.renderMode = RenderMode.ScreenSpaceOverlay;
        surface.sortingOrder = 100;
        var scaler = gameObject.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1280, 720);
        scaler.matchWidthOrHeight = 0.5f;
        gameObject.AddComponent<GraphicRaycaster>();

        backdrop = Ui.Rect("Backdrop", canvas).gameObject.AddComponent<RawImage>();
        Ui.Fill(backdrop.rectTransform);
        backdrop.raycastTarget = false;
        var art = ShellAssets.Load();
        if (art != null && art.titleArt != null)
        {
            backdrop.texture = art.titleArt;
            backdrop.color = ShellTheme.TitleArtTint;
            var fit = backdrop.gameObject.AddComponent<AspectRatioFitter>();
            fit.aspectMode = AspectRatioFitter.AspectMode.EnvelopeParent;
            fit.aspectRatio = art.titleArt.width / (float)Mathf.Max(1, art.titleArt.height);
        }
        else backdrop.texture = Gradient();

        title = Ui.Screen(canvas, "Title", new Color(0f, 0f, 0f, 0f));
        Ui.Size(Ui.Label(title, "Name", Application.productName, ShellTheme.TitleSize), 1100f, 120f);
        Spacer(title, 24f);
        Ui.Button(title, "Play", "Play", StartRun);
        Ui.Button(title, "Settings", "Settings", () => OpenSettings(title));
        Ui.Button(title, "Credits", "Credits", OpenCredits);
        Ui.Button(title, "Quit", "Quit", Application.Quit);
        Ui.Pinned(title, "Hint", "Arrows and Enter, a gamepad, or the mouse", 18, new Vector2(0.5f, 0f), new Vector2(0f, 24f));

        pause = Ui.Screen(canvas, "Pause", ShellTheme.Dim);
        Heading(pause, "Paused");
        Ui.Button(pause, "Resume", "Resume", Resume);
        Ui.Button(pause, "Settings", "Settings", () => OpenSettings(pause));
        Ui.Button(pause, "MainMenu", "Main menu", ShowTitle);

        settings = Ui.Screen(canvas, "Settings", ShellTheme.Dim);
        Heading(settings, "Settings");
        master = SliderRow(settings, "Master", "Master volume", value => SetVolume(ref saved.master, value));
        music = SliderRow(settings, "Music", "Music", value => SetVolume(ref saved.music, value));
        sfx = SliderRow(settings, "Sfx", "Sound effects", value => SetVolume(ref saved.sfx, value));
        fullscreen = Ui.Button(settings, "Fullscreen", "Fullscreen: Off", ToggleFullscreen);
        Ui.Button(settings, "Controls", "Controls", OpenControls);
        resetProgress = Ui.Button(settings, "ResetProgress", "Reset progress", ResetProgress);
        Ui.Button(settings, "Back", "Back", CloseSettings);

        controls = Ui.Screen(canvas, "Controls", ShellTheme.Dim);
        ((VerticalLayoutGroup)controls.GetComponent<LayoutGroup>()).spacing = 6f;
        Heading(controls, "Controls");
        controlsList = Ui.Rect("List", controls);
        var list = Ui.Column(controlsList, 4f, TextAnchor.UpperCenter);
        list.childControlHeight = false;
        controlsNote = Ui.Label(controls, "Note", "", ShellTheme.BodySize - 2, TextAnchor.MiddleCenter, ShellTheme.MutedText);
        Ui.Size(controlsNote, 900f, 28f);
        var buttons = Ui.Rect("Buttons", controls);
        var row = buttons.gameObject.AddComponent<HorizontalLayoutGroup>();
        row.spacing = 16f;
        row.childControlWidth = false;
        row.childControlHeight = false;
        row.childAlignment = TextAnchor.MiddleCenter;
        Ui.Size(buttons, 700f, 48f);
        Ui.Button(buttons, "Reset", "Reset to defaults", ResetControls);
        Ui.Button(buttons, "Back", "Back", () => Show(settings));

        credits = Ui.Screen(canvas, "Credits", ShellTheme.Dim);
        Heading(credits, "Credits");
        creditsText = Ui.Label(credits, "Text", "", ShellTheme.BodySize, TextAnchor.UpperCenter);
        Ui.Size(creditsText, 900f, 360f);
        Ui.Button(credits, "Back", "Back", () => Show(title));

        end = Ui.Screen(canvas, "End", ShellTheme.Dim);
        endHeading = Heading(end, "");
        endStats = Ui.Rect("Stats", end);
        Ui.Column(endStats, 2f, TextAnchor.UpperCenter);
        retry = Ui.Button(end, "Retry", "Retry", StartRun);
        endMenu = Ui.Button(end, "MainMenu", "Main menu", ShowTitle);

        screens = new[] { title, pause, settings, controls, credits, end };
    }

    private static Text Heading(RectTransform screen, string text)
    {
        var label = Ui.Label(screen, "Heading", text, ShellTheme.HeadingSize);
        Ui.Size(label, 1000f, 64f);
        return label;
    }

    private static void Spacer(RectTransform screen, float height) => Ui.Size(Ui.Rect("Space", screen), 10f, height);

    private static Slider SliderRow(RectTransform screen, string name, string label, UnityEngine.Events.UnityAction<float> onChange)
    {
        var row = Ui.Rect(name + "Row", screen);
        var layout = row.gameObject.AddComponent<HorizontalLayoutGroup>();
        layout.spacing = 20f;
        layout.childControlWidth = false;
        layout.childControlHeight = false;
        layout.childAlignment = TextAnchor.MiddleCenter;
        Ui.Size(row, 600f, 40f);
        Ui.Size(Ui.Label(row, "Label", label, ShellTheme.BodySize, TextAnchor.MiddleRight), 220f, 40f);
        var slider = Ui.Slider(row, name, onChange);
        Ui.Size(slider, 300f, 32f);
        return slider;
    }

    private static void StatRow(RectTransform parent, string name, string value)
    {
        var row = Ui.Rect(name, parent);
        Ui.Size(row, 460f, 30f);
        var left = Ui.Label(row, "Name", name, ShellTheme.BodySize, TextAnchor.MiddleLeft, ShellTheme.MutedText);
        Ui.Fill(left.rectTransform);
        var right = Ui.Label(row, "Value", value, ShellTheme.BodySize, TextAnchor.MiddleRight);
        Ui.Fill(right.rectTransform);
    }

    private static Texture2D Gradient()
    {
        var texture = new Texture2D(1, 64, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
        for (var y = 0; y < 64; y++) texture.SetPixel(0, y, Color.Lerp(ShellTheme.Backdrop, ShellTheme.BackdropTop, y / 63f));
        texture.Apply();
        return texture;
    }

    /// <summary>Every shell button press; plays Assets/Audio/ui_click.wav when the game has one.</summary>
    internal static void Click()
    {
        var art = ShellAssets.Load();
        if (art != null && art.clickSound != null) Sound.Sfx(art.clickSound, 0.5f, 0.03f, true);
    }

    // --- settings ---

    private static string SettingsPath => Path.Combine(Application.persistentDataPath, SettingsFile);

    private void LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath) && Kurambit.Json.Parse(File.ReadAllText(SettingsPath)) is Dictionary<string, object> data)
            {
                float Number(string key, float fallback) => data.TryGetValue(key, out var value) && value is double d ? Mathf.Clamp01((float)d) : fallback;
                saved.master = Number("master", 1f);
                saved.music = Number("music", 1f);
                saved.sfx = Number("sfx", 1f);
                saved.fullscreen = data.TryGetValue("fullscreen", out var full) && full is bool on && on;
                saved.bindings = data.TryGetValue("bindings", out var bindings) && bindings is Dictionary<string, object> keys ? keys : new Dictionary<string, object>();
            }
        }
        catch (Exception error)
        {
            Debug.LogWarning($"Shell: settings.json ignored ({error.Message}).");
        }
        Controls.LoadOverrides(saved.bindings);
        master.SetValueWithoutNotify(saved.master);
        music.SetValueWithoutNotify(saved.music);
        sfx.SetValueWithoutNotify(saved.sfx);
        ApplyVolumes();
        if (saved.fullscreen) Screen.fullScreenMode = FullScreenMode.FullScreenWindow;
        fullscreen.GetComponentInChildren<Text>().text = saved.fullscreen ? "Fullscreen: On" : "Fullscreen: Off";
    }

    private void WriteSettings()
    {
        var data = new Dictionary<string, object>
        {
            ["master"] = saved.master,
            ["music"] = saved.music,
            ["sfx"] = saved.sfx,
            ["fullscreen"] = saved.fullscreen,
            ["bindings"] = saved.bindings,
        };
        try
        {
            Directory.CreateDirectory(Application.persistentDataPath);
            File.WriteAllText(SettingsPath, Kurambit.Json.Write(data));
        }
        catch (Exception error)
        {
            Debug.LogWarning($"Shell: settings not saved ({error.Message}).");
        }
    }

    private void SetVolume(ref float field, float value)
    {
        field = Mathf.Clamp01(value);
        ApplyVolumes();
        WriteSettings();
    }

    private void ApplyVolumes()
    {
        AudioListener.volume = saved.master;
        Sound.MusicVolume = saved.music;
        Sound.SfxVolume = saved.sfx;
    }

    private void ToggleFullscreen()
    {
        saved.fullscreen = !(Screen.fullScreenMode == FullScreenMode.FullScreenWindow || Screen.fullScreenMode == FullScreenMode.ExclusiveFullScreen);
        Screen.fullScreenMode = saved.fullscreen ? FullScreenMode.FullScreenWindow : FullScreenMode.Windowed;
        fullscreen.GetComponentInChildren<Text>().text = saved.fullscreen ? "Fullscreen: On" : "Fullscreen: Off";
        WriteSettings();
    }

    private void OpenSettings(RectTransform from)
    {
        settingsFrom = from;
        resetProgress.gameObject.SetActive(GameState.HasProgress);
        resetProgress.interactable = true;
        resetProgress.GetComponentInChildren<Text>().text = "Reset progress";
        Show(settings);
    }

    private void CloseSettings()
    {
        WriteSettings();
        Show(settingsFrom != null ? settingsFrom : title);
    }

    // Two presses, so a stray click cannot wipe a best score.
    private void ResetProgress()
    {
        var label = resetProgress.GetComponentInChildren<Text>();
        if (label.text != "Press again to reset")
        {
            label.text = "Press again to reset";
            return;
        }
        Run.ResetProgress();
        label.text = "Progress reset";
        resetProgress.interactable = false;
    }

    private void OpenCredits()
    {
        var art = ShellAssets.Load();
        var text = art != null && art.credits != null ? art.credits.text : "";
        var lines = text.Split('\n').Select(line => line.Trim()).Where(line => !line.StartsWith("#"));
        var shown = string.Join("\n", lines).Trim();
        creditsText.text = shown.Length > 0 ? shown : "Made with Unity";
        Show(credits);
    }

    // --- controls ---

    private void OpenControls()
    {
        foreach (Transform child in controlsList) Destroy(child.gameObject);
        keyButtons.Clear();
        padLabels.Clear();
        var names = Controls.Names.ToList();
        ControlsRow("Header", null);
        foreach (var name in names) ControlsRow(name, name);
        Ui.Size(controlsList, 900f, (names.Count + 1) * 38f);
        RefreshControls("Select a key binding, then press the new key");
        Show(controls);
    }

    private void ControlsRow(string name, string action)
    {
        var row = Ui.Rect(name, controlsList);
        var layout = row.gameObject.AddComponent<HorizontalLayoutGroup>();
        layout.spacing = 16f;
        layout.childControlWidth = false;
        layout.childControlHeight = false;
        layout.childAlignment = TextAnchor.MiddleCenter;
        Ui.Size(row, 900f, 34f);
        var size = ShellTheme.BodySize - 2;
        if (action == null)
        {
            foreach (var head in new[] { "Action", "Keyboard", "Gamepad" })
                Ui.Size(Ui.Label(row, head, head, size, TextAnchor.MiddleLeft, ShellTheme.MutedText), 260f, 34f);
            return;
        }
        Ui.Size(Ui.Label(row, "Action", Controls.Pretty(action), size, TextAnchor.MiddleLeft), 260f, 34f);
        var key = Ui.Button(row, "Key", "", () => StartRebind(action), new Vector2(260f, 34f), size);
        key.interactable = Controls.CanRebind(action);
        keyButtons[action] = key;
        var pad = Ui.Label(row, "Gamepad", "", size, TextAnchor.MiddleLeft);
        Ui.Size(pad, 260f, 34f);
        padLabels[action] = pad;
    }

    private void RefreshControls(string note)
    {
        controlsNote.text = note;
        foreach (var entry in keyButtons)
        {
            var label = entry.Value.GetComponentInChildren<Text>();
            var text = rebinding == entry.Key ? "Press a key" : Controls.BindingText(entry.Key, true);
            if (label.text != text) label.text = text;
            padLabels[entry.Key].text = Controls.BindingText(entry.Key, false);
        }
    }

    private void StartRebind(string action)
    {
        // The Enter that finished the last rebind also reaches the focused button.
        if (Time.frameCount == rebindEndedFrame || !Controls.CanRebind(action)) return;
        rebindListener?.Dispose();
        rebinding = action;
        rebindListener = InputSystem.onAnyButtonPress.Call(OnRebindPress);
        RefreshControls($"Press a key for {Controls.Pretty(action)} · Esc cancels");
    }

    private void OnRebindPress(InputControl control)
    {
        if (rebinding == null) return;
        if (control.device is Gamepad && control.name == "buttonEast")
        {
            StopRebind("Not changed");
            return;
        }
        if (!(control.device is Keyboard) || control.name == "anyKey") return;
        if (control.name == "escape")
        {
            StopRebind("Not changed");
            return;
        }
        var note = Controls.Rebind(rebinding, "<Keyboard>/" + control.name);
        saved.bindings = Controls.SaveOverrides();
        WriteSettings();
        StopRebind(note);
    }

    private void StopRebind(string note)
    {
        if (rebinding == null) return;
        rebindListener?.Dispose();
        rebindListener = null;
        rebinding = null;
        rebindEndedFrame = Time.frameCount;
        if (note != null) RefreshControls(note);
    }

    private void ResetControls()
    {
        StopRebind(null);
        Controls.ResetOverrides();
        saved.bindings = new Dictionary<string, object>();
        WriteSettings();
        RefreshControls("Controls reset to defaults");
    }
}
