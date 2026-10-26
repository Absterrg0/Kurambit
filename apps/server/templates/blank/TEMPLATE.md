# {{GAME_NAME}} — Blank starter template

This game started from the **Blank** template: one Godot 4.7 project under `godot/` with
no gameplay yet. Everything below is the starting point to extend, not a fixed structure.

## What the template ships

- `godot/project.godot` — project settings: window 960×540, the Compatibility
  (`gl_compatibility`) renderer, `res://scenes/main.tscn` as the main scene, and two
  autoloads:
  - `GameState` (`godot/scripts/game_state.gd`) — the game's single source of truth. It
    starts with no values; add the public primitive variables the game needs.
  - `StudioProbe` (`godot/scripts/studio_probe.gd`) — in web builds it registers the
    read-only `window.__studioProbe()` snapshot `game_web_playtest` reads. Keep it and its
    autoload line.
- `godot/scenes/main.tscn` — a `Node3D` named `Main` with a camera and a directional
  light. This is the one scene the game boots into; replace or extend it as the game
  needs.
- `godot/export_presets.cfg` — the **Web** preset (single-threaded, Compatibility
  renderer, output `../builds/web/index.html`) and the **Linux** preset. `game_export`
  uses these presets.
- `godot/tests/smoke_test.gd` — the headless smoke entry point, with its checks in
  `godot/tests/smoke_harness.gd`. It proves the project boots, the main scene enters the
  tree, and the probe reads GameState. It proves engine readiness only: there is no
  gameplay, no player and no run value to test yet.
- `godot/assets/models/`, `godot/scripts/`, `godot/tests/` — where imported GLB models,
  GDScript, and headless tests live.

## Where to add content

- Build gameplay inside `godot/scenes/main.tscn` instead of creating a second root
  scene, so the main scene stays the entry point.
- Split anything bigger than a script per concept into its own scene under
  `godot/scenes/` (`Player.tscn`, `HUD.tscn`, …) with a `class_name` script under
  `godot/scripts/` and instantiate it from `Main`.
- Put imported models under `godot/assets/models/` only (Godot imports that folder;
  `.blend` sources never go inside `godot/`).
- Keep the Web export single-threaded, so preview and playtest need no COOP/COEP
  headers.

## Conventions

- GDScript only, typed where practical, one script per scene or system.
- The game must be playable from `res://scenes/main.tscn` on a fresh checkout.
- Add run values to `GameState` as public variables. `StudioProbe` reports up to 40
  primitive values and the position of the first node in the `player` group, so keep the
  values that matter on screen too.
- A game with no player node marks play with a typed `GameState.state` (0/false before
  play, another value once play starts), so scenarios and playtests can find the gameplay
  baseline.
- The probe also answers the stage's `studio-visibility` messages: while the stage tab
  is hidden it pauses the scene tree and mutes the master audio bus, then restores what
  it found. Keep that half of the bridge as well.

## Tests

`game_godot_test` runs `tests/smoke_test.gd`. Keep its engine-readiness checks as you add
gameplay and run values. Extend them with the game's actual behaviour as you build it: boot
`res://scenes/main.tscn`, drive the real loop with input or physics, assert observable
outcomes, and quit with a nonzero exit code on failure. A green smoke test on an empty
project means the engine and the bridge work, not that a game exists.
