using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using UnityEngine;

/// <summary>
/// The shell's half of GameState: the run state the shell and the StudioProbe
/// read, the calls that end a run, and saved progress. Assets/Scripts/GameState.cs
/// is the game's half (same class); the game's values belong there.
///
///   GameState.Win("You escaped!", ("Time", "1:42"), ("Coins", 12));
///   GameState.Lose("Out of fuel", ("Distance", "340 m"));
///
/// Either call plays the last moment in slow motion, freezes play and opens the
/// end screen with the message, the stats in the order given, Retry and Main menu.
/// </summary>
public sealed partial class GameState : MonoBehaviour
{
    public static GameState Instance { get; private set; }

    /// <summary>"title", "playing", "paused" or "ended". The shell sets it; the game reads it.</summary>
    public string state = "title";
    /// <summary>"won" or "lost" once a run ended, "" while it runs.</summary>
    public string result = "";
    /// <summary>The message the end screen shows.</summary>
    public string resultText = "";

    /// <summary>Raised once when Win or Lose ends a run: won, message, stats in order.</summary>
    public static event Action<bool, string, IReadOnlyList<KeyValuePair<string, string>>> Ended;

    public static bool IsPlaying => Instance != null && Instance.state == "playing";

    private static readonly HashSet<string> ShellFields = new HashSet<string> { "state", "result", "resultText" };
    private const string ProgressFile = "progress.json";
    private readonly Dictionary<FieldInfo, object> starting = new Dictionary<FieldInfo, object>();
    private readonly Dictionary<FieldInfo, object> keptStart = new Dictionary<FieldInfo, object>();
    private readonly HashSet<string> warned = new HashSet<string>();
    private bool progressLoaded;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Install()
    {
        if (Instance != null) return;
        var host = new GameObject("GameState");
        DontDestroyOnLoad(host);
        Instance = host.AddComponent<GameState>();
        Instance.RememberStart();
    }

    public static void Win(string text = "You win!", params (string name, object value)[] stats) => Instance?.End(true, text, stats);

    public static void Lose(string text = "Game over", params (string name, object value)[] stats) => Instance?.End(false, text, stats);

    private void End(bool won, string text, (string name, object value)[] stats)
    {
        if (state != "playing") return;
        result = won ? "won" : "lost";
        resultText = text;
        state = "ended";
        var list = new List<KeyValuePair<string, string>>();
        foreach (var (name, value) in stats ?? Array.Empty<(string, object)>())
            list.Add(new KeyValuePair<string, string>(name, Convert.ToString(value, CultureInfo.InvariantCulture)));
        Ended?.Invoke(won, text, list);
        // Next frame: a game usually updates its best score right after Win().
        StartCoroutine(SaveSoon());
    }

    private IEnumerator SaveSoon()
    {
        yield return null;
        SaveProgress();
    }

    /// <summary>The game's own public fields: what each run resets and the probe reports.</summary>
    private IEnumerable<FieldInfo> GameFields()
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly;
        foreach (var field in typeof(GameState).GetFields(flags))
            if (!field.Name.StartsWith("_") && !ShellFields.Contains(field.Name)) yield return field;
    }

    private void RememberStart()
    {
        foreach (var field in GameFields()) starting[field] = Copy(field, field.GetValue(this));
    }

    /// <summary>
    /// The shell calls this before every Play and Retry: every game value returns
    /// to its starting value except the names in KeepAcrossRuns, so a retry never
    /// inherits the last run's score, health or timers.
    /// </summary>
    internal void NewRun()
    {
        SaveProgress();
        var keep = new HashSet<string>(KeepAcrossRuns);
        foreach (var entry in starting)
            if (!keep.Contains(entry.Key.Name)) entry.Key.SetValue(this, Copy(entry.Key, entry.Value));
        result = "";
        resultText = "";
    }

    private object Copy(FieldInfo field, object value)
    {
        switch (value)
        {
            case null: return null;
            case string _: return value;
            case Array array: return array.Clone();
            case IList list when value.GetType().IsGenericType: return Activator.CreateInstance(value.GetType(), list);
        }
        if (value.GetType().IsValueType) return value;
        if (warned.Add(field.Name))
            Debug.LogWarning($"GameState.{field.Name} is a {value.GetType().Name}, which a new run cannot reset; build it in the gameplay scene instead.");
        return value;
    }

    private static string ProgressPath => Path.Combine(Application.persistentDataPath, ProgressFile);

    /// <summary>Whether the game keeps anything across runs (Settings shows "Reset progress" only then).</summary>
    public static bool HasProgress => KeepAcrossRuns.Length > 0;

    /// <summary>The shell calls this once at launch, so the title can show last session's best.</summary>
    internal void LoadProgress()
    {
        foreach (var field in KeptFields()) keptStart[field] = Copy(field, field.GetValue(this));
        progressLoaded = true;
        if (!File.Exists(ProgressPath)) return;
        string text;
        // An unreadable file must not stop the shell from starting; the next save replaces it.
        try { text = File.ReadAllText(ProgressPath); }
        catch (Exception error) { Debug.LogWarning($"Saved progress could not be read: {error.Message}"); return; }
        if (!(Kurambit.Json.Parse(text) is Dictionary<string, object> saved)) return;
        foreach (var field in KeptFields())
        {
            if (!saved.TryGetValue(field.Name, out var raw) || raw == null) continue;
            try
            {
                var type = field.FieldType;
                field.SetValue(this, type.IsEnum ? Enum.Parse(type, raw.ToString()) : Convert.ChangeType(raw, type, CultureInfo.InvariantCulture));
            }
            catch (Exception error)
            {
                Debug.LogWarning($"GameState: saved {field.Name} could not be read ({error.Message}); it starts fresh.");
            }
        }
    }

    internal void SaveProgress()
    {
        // Before LoadProgress ran, saving would overwrite last session's file with starting values.
        if (!progressLoaded || KeepAcrossRuns.Length == 0) return;
        var values = new Dictionary<string, object>();
        foreach (var field in KeptFields())
        {
            var value = field.GetValue(this);
            values[field.Name] = value is Enum ? value.ToString() : value;
        }
        try
        {
            Directory.CreateDirectory(Application.persistentDataPath);
            File.WriteAllText(ProgressPath, Kurambit.Json.Write(values));
        }
        catch (Exception error)
        {
            Debug.LogWarning($"GameState: progress not saved ({error.Message}).");
        }
    }

    /// <summary>Puts every kept value back to its starting value and forgets the saved file.</summary>
    internal void ResetProgress()
    {
        foreach (var entry in keptStart) entry.Key.SetValue(this, Copy(entry.Key, entry.Value));
        try { File.Delete(ProgressPath); } catch (IOException) { }
    }

    private IEnumerable<FieldInfo> KeptFields()
    {
        foreach (var name in KeepAcrossRuns)
        {
            var field = typeof(GameState).GetField(name, BindingFlags.Instance | BindingFlags.Public);
            if (field == null)
            {
                if (warned.Add("keep:" + name)) Debug.LogError($"GameState.KeepAcrossRuns names \"{name}\", which is not a public field of GameState.");
                continue;
            }
            yield return field;
        }
    }

    private void OnApplicationQuit() => SaveProgress();
}
