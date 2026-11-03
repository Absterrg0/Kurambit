# {{GAME_NAME}} blank Unity starter

An editable Unity 6 project lives under `unity/`. The starter has no gameplay.
Extend its structure to suit the game.

## Project structure

- `Assets/Scenes/Main.unity` is the main scene and the first scene in the
  build. Keep it as the entry point; add other scenes to the build list
  through the live editor when the game needs them.
- Game code goes under `Assets/Scripts/`, art and audio under `Assets/Art/`
  and `Assets/Audio/`. Blender exports land in `Assets/Blender/` as GLB,
  which the bundled glTFast package imports.
- Input goes through the Input System package (`UnityEngine.InputSystem`):
  `Keyboard.current`, `Mouse.current` or Input Actions. The legacy
  `UnityEngine.Input` class does not see the harness's input.
- `Packages/manifest.json` pins the packages. `com.unity.pipeline` is how
  Kurambit drives the editor; keep it.
- `Library/`, `Temp/`, `Logs/` and `UserSettings/` are Unity's caches and stay
  out of git.

Read BRIEF.md and the relevant files in `studio-skills/`. When PLAN.md exists,
use it to guide the core loop and organization.

## Studio integration

Keep `Assets/Scripts/GameState.cs` and `Assets/Kurambit/StudioProbe.cs`. Add the
public primitive run values (int, float, bool, string, enum) to GameState and
tag the player GameObject `Player`, so exploration can report state and
position. Keep those facts on screen too: the probe reports visible UI text.
For a game without a player, expose a primitive `state` on GameState that
distinguishes the menu from play.

## Edit, check and play

Edit scenes, GameObjects and components with the `game_unity_*` tools; they
drive one live editor for this game. Write C# files directly, then use
`game_unity_recompile` or `game_check` for compile errors with file:line.
`game_check` also plays the main scene briefly and reports runtime
exceptions. A clean check says the project compiles and boots; it cannot
establish that the game is good to play.

Use `game_explore_start`, `game_explore_act` and `game_explore_close` to play a
real Linux build of the current sources with real keyboard and mouse input.
Inspect the frames, report what you reached and what remains unverified.
