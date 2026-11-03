using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

/// <summary>
/// Keeps Assets/Kurambit/Resources/ShellAssets.asset pointing at the shell's
/// fixed files, and Assets/UI/icon.png set as the player icon, whenever the
/// editor imports, moves or deletes one of them. Writes only on a change, so
/// a re-import of the same files leaves the sources untouched.
/// </summary>
internal sealed class ShellAssetsSync : AssetPostprocessor
{
    private const string AssetPath = "Assets/Kurambit/Resources/ShellAssets.asset";
    private const string TitleArt = "Assets/UI/title_bg.png";
    private const string Icon = "Assets/UI/icon.png";
    private static readonly string[] Fonts = { "Assets/UI/font.ttf", "Assets/UI/font.otf" };
    private const string Click = "Assets/Audio/ui_click.wav";
    private const string Credits = "Assets/credits.txt";

    // UI pictures keep their size: Unity's default rounds a 1280x720 title to
    // 1024x512, and the title would fit the picture to the wrong aspect.
    private void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/UI/", StringComparison.OrdinalIgnoreCase)) return;
        var importer = (TextureImporter)assetImporter;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.mipmapEnabled = false;
    }

    private static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
    {
        var touched = imported.Concat(deleted).Concat(moved).Concat(movedFrom).ToArray();
        bool Touched(params string[] paths) => touched.Any(path => paths.Any(wanted => string.Equals(path, wanted, StringComparison.OrdinalIgnoreCase)));
        if (Touched(Icon)) SyncIcon();
        if (Touched(TitleArt, Click, Credits, AssetPath) || Touched(Fonts)) Sync();
    }

    [MenuItem("Kurambit/Sync shell assets")]
    public static void SyncAll()
    {
        Sync();
        SyncIcon();
    }

    private static void Sync()
    {
        var assets = AssetDatabase.LoadAssetAtPath<ShellAssets>(AssetPath);
        if (assets == null) return;
        var changed = false;
        void Set<T>(ref T field, T value) where T : UnityEngine.Object
        {
            if (field == value) return;
            field = value;
            changed = true;
        }
        Set(ref assets.titleArt, AssetDatabase.LoadAssetAtPath<Texture2D>(TitleArt));
        Set(ref assets.font, Fonts.Select(AssetDatabase.LoadAssetAtPath<Font>).FirstOrDefault(found => found != null));
        Set(ref assets.clickSound, AssetDatabase.LoadAssetAtPath<AudioClip>(Click));
        Set(ref assets.credits, AssetDatabase.LoadAssetAtPath<TextAsset>(Credits));
        if (!changed) return;
        EditorUtility.SetDirty(assets);
        AssetDatabase.SaveAssetIfDirty(assets);
    }

    private static void SyncIcon()
    {
        var icon = AssetDatabase.LoadAssetAtPath<Texture2D>(Icon);
        var current = PlayerSettings.GetIcons(NamedBuildTarget.Unknown, IconKind.Any);
        if (current.Length == 1 && current[0] == icon) return;
        if (icon == null && current.All(found => found == null)) return;
        PlayerSettings.SetIcons(NamedBuildTarget.Unknown, icon == null ? Array.Empty<Texture2D>() : new[] { icon }, IconKind.Any);
        AssetDatabase.SaveAssets();
    }
}
