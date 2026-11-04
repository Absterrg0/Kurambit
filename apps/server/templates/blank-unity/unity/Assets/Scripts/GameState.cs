/// <summary>
/// The game's run values: one object every script and the StudioProbe read
/// instead of walking the scene. GameState.Instance exists before the first
/// scene loads and survives scene changes.
///
/// The shell half (Assets/Kurambit/Shell/GameState.Shell.cs) holds `state`
/// ("title", "playing", "paused", "ended"), `result` and the calls that end a
/// run: GameState.Win(text, stats...) and GameState.Lose(text, stats...).
///
/// Add the public fields the game needs here (int, float, bool, string, enum
/// are what the probe reports; a leading underscore hides a helper). Each Play
/// and Retry puts every field back to the value written here, except the names
/// in KeepAcrossRuns, which persist between launches (a best score, an unlock).
///
///   public int score;
///   public float health = 3f;
///   public int best;
///   public static readonly string[] KeepAcrossRuns = { "best" };
///
/// The harness can jump the game to a named state (a check's setup, a bot's
/// shortcut to late content). "game_state" and "player" are built in; add the
/// game's own targets here and return true when the game is there:
///
///   public static bool StudioSetState(string target, Dictionary<string, object> values)
///   {
///       if (target == "boss_room") { Player.Teleport(new Vector3(40, 1, 0)); return true; }
///       return false;
///   }
/// </summary>
public sealed partial class GameState
{
    public static readonly string[] KeepAcrossRuns = { };
}
