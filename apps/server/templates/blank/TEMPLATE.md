# {{GAME_NAME}} — Blank starter template

This game started from the **Blank** template: one Godot 4.7 project under `godot/` with no
gameplay yet. Everything below is the starting point to extend, not a fixed structure.

## What the template ships

- `godot/project.godot` — project settings: window 960×540, the Compatibility (`gl_compatibility`)
  renderer, and `res://scenes/main.tscn` as the main scene. No autoloads; add them here as
  `[autoload]` entries when a system needs one.
- `godot/scenes/main.tscn` — a `Node3D` named `Main` with a camera and a directional light. This is
  the one scene the game boots into.
- `godot/export_presets.cfg` — the **Web** preset (single-threaded, Compatibility renderer, output
  `../builds/web/index.html`) and the **Linux** preset. `game_export` uses these presets.
- `godot/assets/models/`, `godot/scripts/`, `godot/tests/` — empty folders for imported GLB models,
  GDScript, and headless tests.

## Where to add content

- Build gameplay inside `godot/scenes/main.tscn` instead of creating a second root scene, so the
  main scene stays the entry point.
- Split anything bigger than a script per concept into its own scene under `godot/scenes/`
  (`Player.tscn`, `HUD.tscn`, …) with a `class_name` script under `godot/scripts/` and instantiate
  it from `Main`.
- Put imported models under `godot/assets/models/` only (Godot imports that folder; `.blend`
  sources never go inside `godot/`).
- Keep the Web export single-threaded, so preview and playtest need no COOP/COEP headers.

## Conventions

- GDScript only, typed where practical, one script per scene or system.
- The game must be playable from `res://scenes/main.tscn` on a fresh checkout.

## Tests

There are no tests yet. Add headless GDScript tests under `godot/tests/` that extend `SceneTree`,
drive the real gameplay loop, assert observable outcomes, and quit with a nonzero exit code on
failure. Run them with the `game_godot_test` tool using a project-relative path such as
`tests/smoke_test.gd`. A screenshot is not a gameplay test.
