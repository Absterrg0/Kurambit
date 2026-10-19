# {{GAME_NAME}} — 2D Platformer starter template

This game started from the **2D Platformer** template: a two-level side-scroller in
Godot 4.7 (Compatibility renderer, GDScript only) that runs in the editor, on Linux and
in the single-threaded Web export. It is a real game — menu, HUD, pause, settings,
coins, a patrolling enemy, spikes, checkpoints, a goal door, level progression, win and
lose screens — and every system below is meant to be extended, not replaced.

Play it with `game_preview` / `game_run_native`, test it with
`game_godot_test { script: "tests/smoke_test.gd" }`.

## The 60-second tour

```
godot/
  project.godot            autoloads, InputMap, 2D physics layers, 640x360 pixel-crisp display
  default_bus_layout.tres  Master / Music / SFX buses
  ui/theme.tres            every button, panel, label and slider style
  scenes/
    main_menu.tscn         title, Play / Settings / Quit (Quit hides on Web)
    game.tscn              one run: Levels + Player + UI (Hud, PauseMenu, EndScreen)
    levels/level_01.tscn   Mossy Ridge  (generated from tools/level_01.map)
    levels/level_02.tscn   Sunken Steps (generated from tools/level_02.map)
    player/player.tscn     CharacterBody2D + AnimatedSprite2D + dust + follow camera
    enemies/slime.tscn, pickups/coin.tscn, checkpoint.tscn, goal.tscn
    ui/hud.tscn, ui/pause_menu.tscn, ui/settings_menu.tscn, ui/end_screen.tscn
  scripts/                 one script per scene, plus the three autoloads
  assets/tiles/tileset.tres      the TileSet: solid, one-way and hazard tiles
  assets/sprites/*_frames.tres   SpriteFrames for the player, slime, coin, flag
  tools/generate_art.mjs   the pixel-art generator (PNG sheets)
  tools/build_resources.gd rebuilds the TileSet, SpriteFrames and both level scenes
  tools/level_01.map       a level as ASCII: paint by editing this and rebuilding
  tests/smoke_test.gd      entry point,  tests/smoke_harness.gd  the checks
```

The run is `MENU → PLAYING → (PAUSED) → WON | LOST`, walked one level at a time.
`Game` owns that lifecycle and swaps level scenes, `Level` owns the world, `Player`
owns movement, and `GameState` owns the rules.

## Autoloads

**GameState** (`scripts/game_state.gd`) — the whole run lives here, so a restart is one
reset. Signals: `state_changed(state)`, `run_started(level_count)`,
`level_started(index, coin_total)`, `collected_changed(collected, total, score)`,
`lives_changed(lives)`, `life_lost(reason)`, `run_won(score, seconds, coins)`,
`run_lost(reason)`, `toast(text)`. Methods: `start_run(levels)`, `start_level(index,
total)`, `collect(label)`, `lose_life(reason)`, `reach_goal()`, `pause_game()`,
`resume_game()`, `to_menu()`, `is_playing()`, `notify(text)`, `reason_text(reason)`,
`time_text(seconds)`, `level_number()`. State: `state`, `level_index`, `level_count`,
`level_name`, `collected`, `total`, `run_coins`, `score`, `lives`, `run_seconds`,
`best_score`, `best_seconds` (best score/time persist in `user://progress.cfg`).

**Settings** (`scripts/settings.gd`) — `master_volume`, `music_volume`, `sfx_volume`,
`screen_shake`, each with a `set_*` method that applies the change and saves
`user://settings.cfg` (debounced; `apply()` and `save()` are public).

**Audio** (`scripts/audio.gd`) — `play(name, pitch)` with `jump`, `land`, `step`,
`coin`, `stomp`, `hurt`, `checkpoint`, `door`, `win`, `lose`, `ui_move`, `ui_accept`;
`start_music()`, `stop_music()`, `stop_all()`, and `wire_ui(node)` which adds click and
focus sounds to every button in a UI scene. Every sound, and the level theme (four bars
of Am–F–C–G with bass, arpeggio and percussion), is synthesised at startup: there are no
`.wav` files to manage. Replace the bodies of `_build_library()` and `_music_loop()` with
loaded streams when real audio exists and nothing else has to change.

## Level anatomy

A level is a `Node2D` with `scripts/level.gd` and these children — keep the names, they
are what `Level` and `Game` read:

- `Spawn` — a `Marker2D`; the player is put here at level start. Its origin is the
  ground line: the player's feet stand on it.
- `Terrain` — a `TileMapLayer` painted with `assets/tiles/tileset.tres`. Solid tiles
  (grass, dirt, stone) have a full-tile collision polygon; the wooden planks are
  **one-way** (a 6px lip you jump up through and land on).
- `Decor` — a second `TileMapLayer` with no collision at all: grass tufts, flowers,
  pebbles, bushes, rocks, glowing mushrooms. Decoration never changes the physics.
- `Hazards` — a `TileMapLayer` of spike tiles, plus `SpikeField` (one `Area2D` with one
  `CollisionShape2D` per run of spikes) that hurts whatever stands in it.
- `Pickups`, `Enemies`, `Checkpoints` — plain `Node2D` containers holding instances of
  `pickups/coin.tscn`, `enemies/slime.tscn` and `checkpoint.tscn`.
- `Goal` — `goal.tscn`: the door. Walking into it completes the level, which loads the
  next one, or wins the run on the last level.
- `Background` (a `CanvasLayer` with a `GradientTexture2D` sky) and `Far` / `Mid` /
  `Near` (`Parallax2D` bands). `Tint` is an optional `CanvasModulate` — level 2 uses it
  for its night mood without a second set of art.

Two exports drive the run: `camera_bounds` (a `Rect2` in pixels; the view never shows past
the level's bottom or sides, and may look into the sky above its top) and `kill_plane`
(falling below this line costs a life). The camera frames a level's floor at 70% of the
screen, so a map keeps at least seven rows of ground below that floor; each level names
its floor row in `LEVELS` in `tools/build_resources.gd`, which also hangs the parallax
bands off it.

Sprite origins, and the smoke test relies on them: a coin's origin is its centre, a
slime's, checkpoint's and door's origin is the **ground line under it**, and the player's
origin is the ground line under their feet.

## Recipes

**Another level.** The fast way is to paint one: duplicate `level_01.tscn`, keep the
container names, and paint with the TileSet — the tile meanings are in the tooltip of
every tile ("grass top", "one-way plank", "spikes"), and the spikes need a hurt box, so
either paint them and run `tools/build_resources.gd`, or add a `CollisionShape2D` to
`SpikeField` yourself. The other way is to edit `tools/level_01.map` (`.` empty,
`#` ground, `S` stone, `-` plank, `^` spikes; plus `[decor]` and `[objects]` sections)
and run `game_godot_test { script: "tools/build_resources.gd" }`. Then add the scene to
`Game.levels` in `scenes/game.tscn`, and its floor row to `LEVELS` in
`tools/build_resources.gd`.

**Another coin.** Instance `pickups/coin.tscn` under `Pickups` and put its centre about
two tiles above the floor (that is the height a jump reaches). Score, HUD counter and the
end-of-level total follow automatically.

**Another enemy.** Copy `enemies/slime.tscn` and give the copy its own script. Route every
hit through the player, so knockback, invulnerability and lives stay in one place:

```gdscript
if from_above and player.velocity.y > 20.0:
    player.bounce()
    squash()
else:
    player.hurt(global_position, "slime")
```

**Another hazard.** Add tiles to a `Hazards` layer (`SpikeField` picks up any run of
spike tiles when you rebuild) or make an `Area2D` that calls
`player.hurt(position, reason)`; `reason` is what the HUD prints.

**Movement feel.** Every number is an `@export` on `Player` (groups _Movement_, _Jump_,
_Wall_, _Survival_, _Feedback_) and `GameCamera` (framing height, look-ahead, the vertical
deadzone that keeps a jump from moving the view, shake).
Defaults are tuned so a running jump clears **three tiles up and five tiles across**;
`jump_velocity`, `gravity`, `fall_gravity_multiplier` and `apex_gravity_multiplier` are
what to change first, and `wall_slide_enabled` turns on the (off-by-default) wall slide
and wall jump. `tools/level_01.map` is built to those numbers: keep the two in step, or
the level becomes unfinishable.

**Replace the sprites.** Edit `tools/generate_art.mjs` (every tile and sprite is drawn
there) and run `node tools/generate_art.mjs`, then `game_godot_test { script:
"tools/build_resources.gd" }` to rebuild the TileSet and SpriteFrames. `player.png` is a
4x2 sheet of 16x16 cells in the order idle, idle, run x4, jump, fall;
`build_resources.gd` is where those cells become the `idle` / `run` / `jump` / `fall`
animations. A real sprite sheet can be dropped in instead: keep the same cell layout, or
update the animation tables in `build_resources.gd`.

**Pixel-crisp rendering.** `project.godot` renders a 640x360 viewport with
`window/stretch/mode="viewport"` and `scale_mode="integer"`, nearest-neighbour texture
filtering, and 2D transforms/vertices snapped to whole pixels. Change
`window/size/viewport_width/height` to pick a different pixel grid, and keep the window
override a whole multiple of it.

**UI.** Add nodes to `scenes/ui/hud.tscn` and listen to `GameState` signals, or make a new
`Control` scene and instance it under `UI` in `scenes/game.tscn`. `ui/theme.tres` styles
every control via the project setting `gui/theme/custom`; the HUD adds a font outline
through `theme_override_*` on its root. No font files ship with the template — drop a
`.ttf` in `godot/assets/fonts/` and set it as the theme's `default_font` if the game
needs one.

## Tests

`tests/smoke_test.gd` is the entry point (`SceneTree`) and `tests/smoke_harness.gd` holds
the checks. The split exists because Godot compiles a `--script` entry point _before_ the
autoloads exist, so only the runtime-loaded harness can name `GameState`. Add checks as
`_check_*(…)` helpers in the harness and call them from `run()`; keep the entry point
alone. The harness drives the real loop — synthetic input for running, jumping and pause
(`Input.parse_input_event`, `Input.action_press`), teleports for content checks — and
exits nonzero with a list of failures.

Two rules the checks teach, and that new ones have to respect:

- A `respawn()` grants invulnerability, so a check that wants damage to land must wait
  out the i-frames (about 1.4 s) and move the player by setting `global_position`
  instead of respawning.
- Levels are generated, so tiles are addressed by tile coordinates in the harness
  (`PLANK_TILE`, `SPIKE_TILE`). If you move them in the map, move them there too.

Whenever you add a system, extend the harness: it is the fastest way to prove a change
did not break the game, and the template's own quality bar comes from it.
