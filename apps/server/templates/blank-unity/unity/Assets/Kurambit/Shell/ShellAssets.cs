using UnityEngine;

/// <summary>
/// The files the shell shows, found by fixed paths so nothing needs wiring by
/// hand: Assets/UI/title_bg.png (behind the title), Assets/UI/font.ttf or
/// .otf (every shell and HUD text), Assets/Audio/ui_click.wav (button clicks)
/// and Assets/credits.txt (the credits screen). The editor fills this asset
/// whenever one of those files is imported (Kurambit/Editor/ShellAssetsSync.cs);
/// Assets/UI/icon.png becomes the player icon the same way.
/// </summary>
public sealed class ShellAssets : ScriptableObject
{
    public Texture2D titleArt;
    public Font font;
    public AudioClip clickSound;
    public TextAsset credits;
    /// <summary>The particle material Juice.Burst draws with.</summary>
    public Material burstMaterial;

    private static ShellAssets loaded;

    public static ShellAssets Load()
    {
        if (loaded == null) loaded = Resources.Load<ShellAssets>("ShellAssets");
        return loaded;
    }
}
