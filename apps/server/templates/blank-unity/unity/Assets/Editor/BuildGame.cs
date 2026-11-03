using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

// The game's scene builder: what Assets/Scenes/Game.unity holds (camera,
// lights, level, player, props, their components and references) is made
// here, in code that stays in the project, so it survives a revert and runs
// again after any change. Run it with game_unity_eval:
//
//   return BuildGame.Run();
//
// It saves the scene, so stills, the probe and the first frame of play all
// show the built content (a scene built only at runtime starts empty).
// Ensure() keeps an object that already exists, with any edits made to it,
// and creates it only when missing; LevelMap.Build replaces the last level.
// Models load from their files: Load("Assets/Blender/hero.glb"). A model
// changed after Unity imported it is exported under a new file name and
// loaded by that name; Unity keeps drawing the old one otherwise.
public static class BuildGame
{
    private const string ScenePath = "Assets/Scenes/Game.unity";

    [MenuItem("Game/Build scene")]
    public static string Run()
    {
        var scene = OpenGameScene();
        var notes = new List<string>();

        var camera = Ensure(scene, "Main Camera", () =>
        {
            var made = new GameObject("Main Camera", typeof(Camera), typeof(AudioListener)) { tag = "MainCamera" };
            made.transform.SetPositionAndRotation(new Vector3(0f, 2f, -6f), Quaternion.Euler(12f, 0f, 0f));
            return made;
        });
        Ensure(scene, "Directional Light", () =>
        {
            var made = new GameObject("Directional Light", typeof(Light));
            var light = made.GetComponent<Light>();
            light.type = LightType.Directional;
            light.shadows = LightShadows.Soft;
            made.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            return made;
        });

        // The game's content goes here. For example:
        //
        // var root = Ensure(scene, "Level", () => new GameObject("Level")).transform;
        // var level = LevelMap.Build(root, Rows, new Dictionary<char, object>
        // {
        //     ['#'] = Load("Assets/Library/<pack>/wall.glb"),
        //     ['P'] = "spawn",
        // }, new LevelMap.Options { cell = 2f });
        // notes.AddRange(level.errors);
        // var player = Ensure(scene, "Player", () => Place("Assets/Blender/hero.glb", "Player"));
        // player.tag = "Player";
        // player.transform.position = level.Spawn('P');
        // CharacterAnimator.On(player);
        // if (!camera.TryGetComponent(out FollowCamera3D follow)) follow = camera.AddComponent<FollowCamera3D>();
        // follow.target = player.transform;

        EditorSceneManager.MarkSceneDirty(scene);
        EditorSceneManager.SaveScene(scene);
        return $"Built {ScenePath}: {string.Join(", ", scene.GetRootGameObjects().Select(root => root.name))}" +
               (notes.Count > 0 ? $"\nProblems: {string.Join("; ", notes)}" : "");
    }

    /// <summary>The root object with this name, made by `make` only when the scene has none.</summary>
    public static GameObject Ensure(Scene scene, string name, Func<GameObject> make)
    {
        var found = scene.GetRootGameObjects().FirstOrDefault(root => root.name == name);
        if (found != null) return found;
        var made = make();
        made.name = name;
        SceneManager.MoveGameObjectToScene(made, scene);
        return made;
    }

    /// <summary>A model, prefab or other asset by its path under Assets/.</summary>
    public static T Load<T>(string path) where T : UnityEngine.Object
    {
        var asset = AssetDatabase.LoadAssetAtPath<T>(path);
        if (asset == null) Debug.LogError($"BuildGame: nothing at {path} (a typo, or a file game_import has not imported yet).");
        return asset;
    }

    public static GameObject Load(string path) => Load<GameObject>(path);

    /// <summary>An instance of a model or prefab, still linked to its file.</summary>
    public static GameObject Place(string path, string name)
    {
        var source = Load(path);
        if (source == null) return new GameObject(name);
        var placed = (GameObject)PrefabUtility.InstantiatePrefab(source);
        placed.name = name;
        return placed;
    }

    private static Scene OpenGameScene()
    {
        var active = SceneManager.GetActiveScene();
        if (active.path == ScenePath) return active;
        var scene = System.IO.File.Exists(ScenePath)
            ? EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single)
            : EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        if (string.IsNullOrEmpty(scene.path)) EditorSceneManager.SaveScene(scene, ScenePath);
        // The shell loads Game.unity by name, so it must be in the build list.
        if (!EditorBuildSettings.scenes.Any(entry => entry.path == ScenePath))
            EditorBuildSettings.scenes = EditorBuildSettings.scenes.Append(new EditorBuildSettingsScene(ScenePath, true)).ToArray();
        return scene;
    }
}
