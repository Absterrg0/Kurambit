# {{GAME_NAME}} blank Unity starter

An editable Unity 6 project lives under `unity/`. The starter has no gameplay,
but it ships the shell a demo needs, so build the game, not the menus, input
or HUD.

## Demo shell

- The shell (`Assets/Kurambit/Shell/Shell.cs`) builds every screen in code
  when the game starts: a title (the product name, Play, Settings, Credits,
  Quit), pause on Esc, P or gamepad Start (Resume, Settings, Main menu),
  settings (master, music and sound-effect volume, fullscreen, Controls,
  Reset progress), an end screen (the result message, the game's stats,
  Retry, Main menu) and credits. Never build menus, an EventSystem or a
  Canvas for them; they already exist and take the mouse, the keys and a
  gamepad.
- `Assets/Scenes/Main.unity` is the entry scene and stays empty.
  Gameplay lives in `Assets/Scenes/Game.unity`: the shell loads it on Play
  and on Retry (a fresh copy each run, as the active scene) and unloads it on
  Main menu. The live editor opens Game.unity; build the game there.
- End a run with `GameState.Win("You escaped!", ("Time", "1:42"))` or
  `GameState.Lose("Out of fuel", ("Distance", "340 m"))`. The last hit plays
  out in slow motion for a moment, then the end screen shows the message and
  the stats in the order given.
- Put the game's run values on GameState as public fields in
  `Assets/Scripts/GameState.cs`. Each Play and Retry puts every field back to
  the value written there; name the ones that must outlive a run in
  `KeepAcrossRuns` (`{ "best" }`): they persist between launches in
  `progress.json` under `Application.persistentDataPath`, and Settings shows
  "Reset progress".
- `GameState.Instance.state` reads `"title"`, `"playing"`, `"paused"` or
  `"ended"` (`result` is `"won"` or `"lost"` after a run). The shell sets it;
  the game reads it (`GameState.IsPlaying`).
- Pause and the end screen set `Time.timeScale` to 0 and pause audio. Move
  things with `Time.deltaTime` (or physics) so they freeze with it.
- To boot straight into play while building, set `Shell.BootIntoPlay = true`
  in `Shell.cs`. Ship it `false`.
- `Assets/credits.txt` is what the credits screen shows. ASSETS.md stays the
  full record of every file's source and licence; every asset whose licence
  asks for attribution also gets a line in `credits.txt`.
- The look lives in `Assets/Kurambit/Shell/ShellTheme.cs` (colours and
  sizes); the art pass restyles it to the key art. `Assets/UI/title_bg.png`
  shows behind the title, `Assets/UI/font.ttf` (or `.otf`) replaces the
  font, `Assets/Audio/ui_click.wav` makes every shell button click, and
  `Assets/UI/icon.png` (a placeholder until the art step replaces it) is the
  player's icon. The editor picks each up when it is imported; no wiring.
- Post-processing comes from the pipeline's default volume,
  `Assets/Settings/SampleSceneProfile.asset` (tonemapping, bloom, vignette),
  and draws on the main camera, which renders post-processing with SMAA. A
  camera made in code draws it only after
  `cam.GetUniversalAdditionalCameraData().renderPostProcessing = true`
  (`using UnityEngine.Rendering.Universal;`).
- Play music with `Sound.Music(clip)` and effects with `Juice.Sfx(clip)`, so
  the volume sliders reach them.

## Controls

- Gameplay reads named actions through `Controls`, never keys:
  `Controls.Move()` (a Vector2 from the four moves, y up, analog on a
  stick), `Controls.Pressed("jump")` (once per press),
  `Controls.Down("action")`, `Controls.Released("alt")`,
  `Controls.Axis("move_left", "move_right")`. `Keyboard.current` and the
  legacy `UnityEngine.Input` skip the gamepad and the player's rebinding.
  Actions read idle outside play, so a menu press never reaches the game.
- `Assets/Scripts/GameControls.cs` declares them, one line each, with Input
  System paths: `move_left` / `move_right` / `move_up` / `move_down` (WASD,
  arrows, left stick, d-pad), `jump` (Space, gamepad A), `action` (J, Enter,
  left click, gamepad X), `alt` (K, Shift, gamepad B); the shell adds
  `pause` (Esc, P, Start). Add the game's own as one more line:
  `("dash", new[] { "<Keyboard>/l", "<Gamepad>/rightShoulder" })`. Delete
  the defaults the game never reads, so Settings > Controls lists only
  controls that work. Reading an undeclared action throws.
- Settings > Controls lists every action with its keys and gamepad inputs,
  rebinds keys (saved with the other settings; Reset to defaults) and is the
  place players and testers read the controls. Name keys in a HUD hint as
  `{jump}` (or `Controls.KeyLabel("jump")`), so the hint stays true after a
  rebind.

## HUD

Put every HUD line through `Hud` (`Assets/Kurambit/Shell/Hud.cs`), called
each frame from `Update`: `Hud.Counter("Gems", n, 5)`,
`Hud.Bar("Health", hp, 3)` (hearts up to 10), `Hud.Timer("Time", seconds)`,
`Hud.Objective(text)`; `Hud.Toast("Gate opened!")` on the event;
`Hud.Hint("{jump} to jump", () => jumped)` teaches a control once. The shell
clears it on every run, it freezes with the game, and its text is what the
probe reads. Do not build your own HUD canvas or text beside it.

## Game feel

`Juice` (`Assets/Kurambit/Shell/Juice.cs`) answers player actions in one
call each: `Juice.Shake(0.4f)`, `Juice.HitPause()`, `Juice.Pop(transform)`,
`Juice.Squash(transform)`, `Juice.Flash(enemy)`,
`Juice.Burst(position, Color.yellow)` and `Juice.Sfx(clip)`. The shake adds
to whatever camera code runs. The comment block at the top of the file shows
each call.

## Characters and cameras

`CharacterAnimator.On(model)` (`Assets/Kurambit/Shell/CharacterAnimator.cs`)
plays a rigged GLB's or FBX's clips by state, with no Animator Controller:
`anim.Play("idle" | "walk" | "run" | "jump" | "fall" | "attack" | "hit" |
"die", speed)` every frame crossfades, returns from one-shots and falls back
(run to walk to idle) when a clip is missing. Add it in the scene builder so
it finds the model's clips. `FollowCamera3D` (behind the target, pulls in at
walls, orbit with right drag or the right stick, `Flat(Controls.Move())` for
camera-relative movement) and `FollowCamera2D` (dead zone, look-ahead, level
bounds) follow the player. The comment block at the top of each file shows
each call.

## Levels

`LevelMap.Build(parent, rows, legend, options)`
(`Assets/Kurambit/Shell/LevelMap.cs`) builds a level from a text map and a
legend of prefabs or models, with box colliders on walls and floor, and
records `Spawn('P')` by letter and `bounds`. An unknown legend character is
reported in `level.errors` and the console. `Options.flat` builds in the XY
plane for 2D and top-down games. The comment block at the top of the file
shows each call.

## Building the scene

- Build Game.unity's content (camera, lights, level, player, props, their
  components and references) in `Assets/Editor/BuildGame.cs` and run it with
  `game_unity_eval` (`return BuildGame.Run();`). It saves the scene. Keep the
  builder in the project and extend it rather than making one-off edits, so
  it survives a revert and runs again.
- Build levels and scene content into the saved scene, not only at runtime:
  a scene filled only when play starts is empty in every still, in the editor
  and on its first frame.
- Never write or edit `.meta` files; Unity makes them on import.
- A model changed after Unity imported it goes out under a new file name
  (`hero_v2.glb`), loaded by that name; Unity keeps drawing the old one
  otherwise.

## Project structure

- Game code goes under `Assets/Scripts/`, editor-only code (the builder)
  under `Assets/Editor/`. Art goes under `Assets/Art/`, sound under
  `Assets/Audio/`, Blender exports as GLB under `Assets/Blender/` (glTFast
  imports them), library packs under `Assets/Library/`. Unity imports only
  what sits under `unity/Assets/`, with a capital A.
- Text uses uGUI `Text` with the shell's font (`ShellTheme.Font`); the
  project ships no TextMesh Pro font asset.
- `Packages/manifest.json` pins the packages. `com.unity.pipeline` is how
  Kurambit drives the editor; keep it.
- `Library/`, `Temp/`, `Logs/` and `UserSettings/` are Unity's caches and stay
  out of git.

Read BRIEF.md and the relevant files in `studio-skills/`. When PLAN.md exists,
use it to guide the core loop and organization. More content is the creator's
choice; depth should serve the game's decisions and feel.

## Studio integration

Keep `Assets/Kurambit/` as shipped (StudioProbe.cs and the shell kits). Expose
useful public run values on GameState and tag the player GameObject `Player`,
so exploration can report state and position. Keep those facts legible in
the game.

## Edit, check and play

Edit scenes through the builder or the `game_unity_*` tools; they drive one
live editor for this game. Write C# files directly, then use
`game_unity_recompile` or `game_check` for compile errors with file:line.
`game_check` plays Game.unity briefly (the shell starts a run around it) and
reports runtime exceptions. A clean check says the project compiles and
boots; it cannot establish that the game is good to play.

Use `game_explore_start`, `game_explore_act` and `game_explore_close` to play a
real Linux build of the current sources. The game opens on the title: press
`Enter` (Play is selected) or click `Shell/Title/Play` with a `ui` step.
Inspect the frames, try real inputs, and report what you reached and what
remains unverified. Fix the cause of the biggest play flaw. Games are verified
by playing, without game test suites, acceptance IDs or scripted routes.
