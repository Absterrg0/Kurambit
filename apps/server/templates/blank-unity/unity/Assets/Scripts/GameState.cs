using UnityEngine;

/// <summary>
/// The game's run state: one object every scene and the StudioProbe read
/// instead of walking the scene graph. It installs itself before the first
/// scene loads and survives scene changes.
///
/// The Blank starter ships no gameplay, so it starts with no values. Add the
/// public primitive fields (int, float, bool, string, enum) the game needs;
/// the StudioProbe reports them. A leading underscore keeps a helper out of
/// that snapshot.
/// </summary>
public sealed class GameState : MonoBehaviour
{
    public static GameState Instance { get; private set; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Install()
    {
        if (Instance != null) return;
        var host = new GameObject("GameState");
        DontDestroyOnLoad(host);
        Instance = host.AddComponent<GameState>();
    }
}
