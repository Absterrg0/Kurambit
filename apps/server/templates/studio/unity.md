# Unity game

The Unity lane: one Unity 6 project under `unity/`, edited in one live editor
and checked, played and exported with the same `game_*` tools as a Godot game.

1. You have no local Unity binary: never look for one or run it. The
   `game_unity_*` tools drive this game's one live batchmode editor (the
   first call opens it; that can take a few minutes on a fresh project).
2. Write C# yourself under `unity/Assets/Scripts/`. After a script change run
   `game_unity_recompile` (or `game_check`) and fix every `file:line` error
   before anything else: a project that does not compile cannot play.
3. Edit scenes through the editor, never by hand-editing `.unity`,
   `.prefab` or `.asset` YAML: `game_unity_scene` to read the hierarchy,
   `game_unity_object` to create, move, rename and delete GameObjects and
   add or set components, `game_unity_eval` for anything else in C#. Save
   with `game_unity_scene` action save; unsaved edits are lost on close.
4. `Assets/Scenes/Main.unity` is the entry scene and first in the build list.
5. Input goes through the Input System (`Keyboard.current`, `Mouse.current`
   or Input Actions). The harness injects keys and mouse there; the legacy
   `UnityEngine.Input` class never sees them.
6. Keep `Assets/Kurambit/StudioProbe.cs` as shipped and extend
   `Assets/Scripts/GameState.cs`: public primitive fields (int, float, bool,
   string, enum) are what the probe reports. Tag the player `Player`. A game
   without a player marks play with a primitive `state` (0/false in menus).
   Keep the values that matter on screen too; the probe reads visible
   UI text (uGUI Text, TextMeshPro, UI Toolkit labels).
7. Models come from the `game_blender_*` tools exported as GLB under
   `unity/Assets/Blender/` (glTFast imports them); textures and sprites as
   PNG under `unity/Assets/Art/`, sound under `unity/Assets/Audio/`. Run
   `game_import` after adding files so the editor imports them.
8. Look at the scene with `game_unity_screenshot` (the Game view), read
   errors with `game_unity_console`. `game_unity_play` enters and exits
   play mode for a quick look; real playtests use `game_explore_*`, which
   build and run a Linux player of the current sources with real input,
   paused between acts.
9. `game_check` recompiles, then plays the main scene for 120 frames and
   reports runtime exceptions with `file:line`. A clean check proves it
   compiles and boots, not that it is fun.
10. Export checklist: `game_export` Linux builds `builds/linux/` (the
    executable, `game_Data/` and `UnityPlayer.so` together); Windows builds
    `builds/windows/`. Web is refused. Bot runs do not play Unity yet.
11. Work in `./unity` plus VISION.md, PLAN.md and NOTES.md. Never commit,
    never reset git, never use subagents. Never touch `Library/`, `Temp/`,
    `Logs/` or `UserSettings/`; they are the editor's caches.
