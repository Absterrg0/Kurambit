# Unity game

The Unity lane: one Unity 6 project under `unity/`, edited in one live editor
and checked, played and exported with the same `game_*` tools as a Godot game.

1. You have no local Unity binary: never look for one or run it. The
   `game_unity_*` tools drive this game's one live batchmode editor (the
   first call opens it; that can take a few minutes on a fresh project).
   Kurambit runs it lean: one asset import worker and two job threads, so
   imports are serial; keep imported files few and small.
2. Write C# yourself under `unity/Assets/Scripts/` (gameplay) and
   `unity/Assets/Editor/` (the scene builder). After a script change run
   `game_unity_recompile` (or `game_check`) and fix every `file:line` error
   before anything else: a project that does not compile cannot play.
3. Every file Unity should use sits under `unity/Assets/`, capital A: models
   as GLB in `unity/Assets/Blender/`, library packs in
   `unity/Assets/Library/`, textures and sprites as PNG in
   `unity/Assets/Art/`, sound in `unity/Assets/Audio/`. Unity never sees
   `unity/assets/`. Run `game_import` after adding files. Never write or edit
   `.meta` files; Unity makes them. A model changed after Unity imported it
   goes out under a new file name (`hero_v2.glb`) and is loaded by that
   name; Unity keeps drawing the old one otherwise.

## The shell and the kits

4. The starter already has title, pause, settings, controls, end and credits
   screens, built in code (TEMPLATE.md). Never build menus, a Canvas, an
   EventSystem or your own HUD text. Gameplay lives in
   `unity/Assets/Scenes/Game.unity`, which the shell loads fresh on Play and
   Retry; `Main.unity` stays empty. Never call `SceneManager.LoadScene`
   yourself: the shell owns starts, restarts and the menu. End a run with
   `GameState.Win(text, ("Coins", 12))` or `GameState.Lose(text, ...)`.
5. Run values are public fields in `unity/Assets/Scripts/GameState.cs`;
   Retry resets each to the value written there. Name the ones that must
   survive (best score, unlocks) in `KeepAcrossRuns`; the shell saves those
   between launches and Settings can reset them. Tag the player `Player`.
6. Read controls only through `Controls` (`Controls.Move()`,
   `Controls.Pressed("jump")`, `Controls.Down("action")`), never
   `Keyboard.current` or `UnityEngine.Input`, so the gamepad and the player's
   rebinding work. Add the game's own actions and drop unused defaults in
   `unity/Assets/Scripts/GameControls.cs`. Read presses in `Update` and keep
   one until it is used (a jump waits for the ground): playtests run the
   player at a few frames per second, so a press checked against a single
   frame's state is lost.
7. Show score, health, timer, objective, event toasts and control hints
   through `Hud` (`Hud.Counter`, `Hud.Bar`, `Hud.Timer`, `Hud.Objective`,
   `Hud.Toast`, `Hud.Hint("{jump} to jump", () => jumped)`), called every
   frame, and teach each control with a hint the first time it matters.
   Answer every player action through `Juice` (`Shake`, `HitPause`, `Pop`,
   `Squash`, `Flash`, `Burst`, `Sfx`); play music with `Sound.Music(clip)`.
8. Never hand-write clip switching, an Animator Controller or camera follow.
   Character: `CharacterAnimator.On(model)` on the placed rigged model, then
   every frame `anim.Play(state, speed)` with the state chosen from gameplay
   (grounded, speed, attacking) and `anim.Play("attack")` on the event; the
   console line says which clip each state got. Camera: `FollowCamera3D`
   (`target`; move with `cam.Flat(Controls.Move())`) or `FollowCamera2D`
   (`target`, `bounds`) on the main camera. Juice.Shake applies on top.
   Keep post-processing on for every camera that draws the game
   (`GetUniversalAdditionalCameraData().renderPostProcessing = true`, as
   BuildGame does): the look's tonemapping and bloom come from it.
9. Write every grid level as a text map with `LevelMap.Build` (parent,
   rows, legend, options): walls collide, `level.Spawn('P')` places the
   player, and `level.errors` names any character the legend lacks.
10. The title shows `unity/Assets/UI/title_bg.png` (the key art, 16:9) once
    it exists; `unity/Assets/UI/icon.png` is the player icon: replace the
    placeholder with a 256x256 cut of the key art's main subject. Restyle the
    shell's colours and sizes in `unity/Assets/Kurambit/Shell/ShellTheme.cs`
    and put a matching font at `unity/Assets/UI/font.ttf`.

## Building the scene

11. Build Game.unity's content in `unity/Assets/Editor/BuildGame.cs` and run
    it with `game_unity_eval` (`return BuildGame.Run();`): camera, lights,
    level, player, props, their components and references. It saves the
    scene. Keep scene setup in that builder, not in one-off eval calls, so it
    survives a revert and runs again; `Ensure` keeps objects that exist.
12. Build levels and scene content into the saved scene, not only at
    runtime: a scene filled only when play starts is empty in every still,
    in the editor and on its first frame.
13. For a small change, `game_unity_tools` lists the editing tools (scene,
    gameobject, component, prefab, material, settings) with their inputs;
    call one with `game_unity_edit` (open scenes are saved after each call).
    Never hand-edit `.unity`, `.prefab` or `.asset` YAML. Attach your scripts
    with `script_attach` after they compile, or add them in the builder.

## Check, play, export

14. Look at the scene with `game_unity_screenshot` (the Game view), read
    errors with `game_unity_console`. `game_unity_play` enters and exits
    play mode for a quick look; real playtests use `game_explore_*`, which
    build and run a Linux player of the current sources with real keys and
    mouse, paused between acts. The game opens on the title: press `Enter`
    or click `Shell/Title/Play`.
15. `game_check` recompiles, then plays Game.unity for 120 frames (the shell
    starts a run around it) and reports runtime exceptions with `file:line`.
    A clean check proves it compiles and boots, not that it is fun.
16. Export checklist: `game_export` Linux builds `builds/linux/` (the
    executable, `game_Data/` and `UnityPlayer.so` together); Windows builds
    `builds/windows/`. Web is refused. Bot runs play the same Linux player as
    `game_explore_*`, at normal speed; they take no `setState` writes.
17. In a production run's role, work in `./unity` plus VISION.md, PLAN.md,
    NOTES.md and, when your step chooses or changes the look, STYLE.json, and never commit, reset git or use subagents: the run keeps
    the builds. Never touch `Library/`, `Temp/`,
    `Logs/` or `UserSettings/`; they are the editor's caches.
