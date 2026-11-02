# {{GAME_NAME}} blank starter

An editable Godot project lives under `godot/`. The starter has no gameplay.
Extend its structure to suit the game.

## Project structure

- `project.godot` uses the Compatibility renderer and boots `scenes/main.tscn`.
  Keep that scene as the entry point; compose other scenes from it as needed.
- Put scenes under `scenes/` and scripts under `scripts/`. Give distinct rules,
  state, player behavior and presentation clear owners as the game grows.
- Put runtime assets under `assets/`, including imported GLB files under
  `assets/models/`. Keep editable `.blend` sources outside `godot/`.
- `export_presets.cfg` provides Web and Linux exports through `game_export`.
  Keep Web single-threaded so it works without special response headers.

Read BRIEF.md and the relevant files in `studio-skills/`. When PLAN.md exists,
use it to guide the core loop and organization. More content is the creator's
choice; depth should serve the game's decisions and feel.

## Studio integration

Keep the `GameState` and `StudioProbe` autoloads. Expose useful public primitive
run values in GameState and add the player node to the `player` group so
exploration can report state and position. Keep those facts legible in the game.
For a game without a player node, expose a primitive `GameState.state` that
distinguishes the menu from play.

Keep the probe's visibility handling. It pauses and mutes the game when its
stage tab is hidden, then restores the prior state when shown.

## Check and play

Use `game_check` for import, load and boot problems. A clean check says the
project boots; it cannot establish that the game is good to play. Godot's
shutdown-only resource-use chatter is noise, not a gameplay defect.

Use `game_explore_start`, `game_explore_act` and `game_explore_close` to play.
Inspect the frames, try real inputs, and report what you reached and what
remains unverified. Fix the cause of the biggest play flaw. Games are verified
by playing, without game test suites, acceptance IDs or scripted routes.
