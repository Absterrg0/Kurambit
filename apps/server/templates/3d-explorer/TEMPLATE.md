# {{GAME_NAME}} — 3D Explorer starter template

This game started from the **3D Explorer** template: a complete third-person exploration
game in Godot 4.7 (Compatibility renderer, GDScript only) that runs in the editor, on
Linux, and in the single-threaded Web export. It is a real game — menu, HUD, pause,
settings, relics, a hazard, checkpoints, a locked gate, win and lose screens — and every
system below is meant to be extended, not replaced.

Play it with `game_preview` / `game_run_native`, test it with
`game_godot_test { script: "tests/smoke_test.gd" }`.

## The 60-second tour

```
godot/
  project.godot           autoloads, InputMap, physics layers, window/stretch, theme
  default_bus_layout.tres Master / Music / SFX buses
  ui/theme.tres           every button, panel, label, bar and slider style
  scenes/
    main_menu.tscn        title, Play / Settings / Quit (Quit hides on Web)
    game.tscn             one run: Level + Player + UI (Hud, PauseMenu, EndScreen)
    levels/level_01.tscn  the playable area (see "level anatomy" below)
    player/player.tscn    CharacterBody3D + placeholder body + third-person camera rig
    pickups/collectible.tscn, hazards/hazard.tscn, checkpoint.tscn, goal.tscn
    ui/hud.tscn, ui/pause_menu.tscn, ui/settings_menu.tscn, ui/end_screen.tscn
  scripts/                one script per scene, plus the three autoloads
  materials/*.tres        the shared colour palette (grass, stone, wood, lava, glow…)
  tests/smoke_test.gd     entry point,  tests/smoke_harness.gd  the checks
```

The run is `MENU → PLAYING → (PAUSED) → WON | LOST`. `Game` owns that lifecycle,
`Level` owns the world, `Player` owns movement, and `GameState` owns the rules.

## Autoloads

**GameState** (`scripts/game_state.gd`) — the whole run lives here, so a restart is one
reset. Signals: `state_changed(state)`, `run_started(total)`, `collected_changed(collected,
total, score)`, `health_changed(health, max_health)`, `lives_changed(lives)`,
`life_lost(reason)`, `all_collected()`, `run_won(score, seconds, lives)`,
`run_lost(reason)`, `toast(text)`. Methods: `start_run(total)`, `collect(label)`,
`apply_damage(amount, reason)`, `lose_life(reason)`, `reach_goal()`, `pause_game()`,
`resume_game()`, `to_menu()`, `is_playing()`, `notify(text)`, `reason_text(reason)`,
`time_text(seconds)`. State: `state`, `collected`, `total`, `score`, `lives`, `health`,
`run_seconds`, `best_score`, `best_seconds`, `won` (best score/time persist in
`user://progress.cfg`).

**Settings** (`scripts/settings.gd`) — `master_volume`, `music_volume`, `sfx_volume`,
`mouse_sensitivity`, `invert_y`, each with a `set_*` method that applies the change to the
audio buses and saves `user://settings.cfg` (debounced; `apply()` and `save()` are public).

**Audio** (`scripts/audio.gd`) — `play(name, pitch)` with `jump`, `land`, `step`, `pickup`,
`hurt`, `unlock`, `win`, `lose`, `ui_move`, `ui_accept`; `start_music()`, `stop_music()`,
`stop_all()`, and `wire_ui(node)` which adds click/focus sounds to every button in a UI
scene. Every sound is synthesised at startup, so there are no `.wav` files to manage:
replace the bodies of `_build_library()` and `_ambient_loop()` with loaded streams when
real audio exists and nothing else has to change.

## Level anatomy

`level_01.tscn` is a `Level` (`scripts/level.gd`) with named containers — keep these names
in any level you add, because `Level` and `Game` read them:

- `Solid` — one `StaticBody3D` holding every block as a `MeshInstance3D` +
  `CollisionShape3D` pair (`…Shape`). This is the real collision; add new blocks the same
  way (or a `CSGBox3D` with `use_collision = true`, which builds static collision for you).
- `WorldEnvironment` — procedural sky, sky ambient light, soft depth fog, filmic tonemap.
- `Sun` — one shadow-casting `DirectionalLight3D`. Keep the shadow budget small: shadows
  are the most expensive thing in the Web export.
- `Relics` — `collectible.tscn` instances; `label` names the relic, and their count is the
  level's goal count.
- `Checkpoints` — `checkpoint.tscn` instances. The last one touched is where a lost life
  respawns; without one, respawns use `Spawn`.
- `Goal` — `goal.tscn`: the gate that unlocks when every relic is collected and wins the
  run when the player walks in.
- `Hazard` — `hazard.tscn`: a damaging volume that damages and knocks back anything that
  stays inside, `damage` and `reason` included. The lava pool is the level's only hazard.
- `KillPlane` — an `Area3D` far below the level: falling through costs a life.

Relic positions are set so that the node origin sits **on the ground the relic floats
over** (the crystal is 0.95 above it); the smoke test teleports the player onto those
origins, so keep the convention.

Flat decoration — the dirt yard and the paved route — is `MeshInstance3D` only, without
collision, with its top a couple of centimetres above the ground: a visible lip without a
ledge to trip the character on. Anything the player should stand on needs a real collider
(the ground strips, the bridge, the platforms). The lava pool is 0.95 m deep, so a player
who falls in is hurt, knocked back, and can jump out; its hazard volume deliberately stops
below the bridge deck, because standing on the bridge must never count as standing in lava.

## Recipes

**Another level.** Copy `scenes/levels/level_01.tscn`, keep the container names, and point
`scenes/game.tscn`'s `Level` node at the new scene. Nothing else changes: `Game` asks
`Level` for the spawn point, the relic list and the goal.

**Another relic.** Instance `scenes/pickups/collectible.tscn` under `Relics`, set
`label`, and put it somewhere that needs a jump or a detour. Total, HUD counter, gate
unlock and score all follow automatically (100 points each).

**Another hazard.** Instance `scenes/hazards/hazard.tscn`, set `damage` (34 = three hits
per life) and `reason` (used by the HUD message). Anything that stays inside is damaged
once per invulnerability window.

**An enemy.** Make a `CharacterBody3D` scene with its own script and put it under the
level. Route every hit through the player so knockback, invulnerability and health stay in
one place:

```gdscript
if _player_inside and not player.is_invulnerable():
    player.apply_hit(global_position, 20.0, "enemy")
```

**An interactable** (chest, lever, lore stele). Nothing in the template uses the `interact`
action yet — it is bound to E and the pad's X. The pattern is an `Area3D` that tracks the
player:

```gdscript
if player_inside and Input.is_action_just_pressed("interact"):
    GameState.notify("The lever gives away")
    Audio.play("unlock")
```

**Movement feel.** Every number is an `@export` on `Player` (groups _Movement_, _Jump_,
_Survival_, _Feedback_) and `CameraRig` (pivot height, follow speed, distance, pitch
limits, stick speed). Defaults are tuned for 1.25 m jumps: steps of ≤ 1 m and gaps of
≤ 2.5 m are comfortable at walking speed.

**Placeholder art → Blender models.** The body, the relics and the world are primitives on
purpose. When a model exists (`game_blender_run` writes `godot/assets/models/<id>.glb`),
instance the GLB and _keep the collision_: for the player, add it under `Visual` and leave
the capsule `CollisionShape3D` alone; for a prop, add a `StaticBody3D` +
`CollisionShape3D` matching its footprint, or name the mesh `<name>-col` in Blender so
Godot imports collision with the model. Materials live in `materials/*.tres` — reuse the
palette so the world keeps one look.

**The player's animation** is procedural (`Player._animate()`: bob, stretch, lean) so the
template needs no rig. Replace that method with an `AnimationPlayer` (idle/walk/jump
states) when the character gets a real rig.

**UI.** Add nodes to `scenes/ui/hud.tscn` and listen to `GameState` signals, or make a new
Control scene and instance it in `scenes/game.tscn` under `UI`. `ui/theme.tres` styles every
control via the project setting `gui/theme/custom`; the HUD adds a font outline through
`theme_override_*` on its root. No font files ship with the template — drop a `.ttf` in
`godot/assets/fonts/` and set it as the theme's `default_font` if the game needs one.

## Tests

`tests/smoke_test.gd` is the entry point (`SceneTree`) and `tests/smoke_harness.gd` holds
the checks. The split exists because Godot compiles a `--script` entry point _before_ the
autoloads exist, so only the runtime-loaded harness can name `GameState`. Add checks as
`_check_*(…)` helpers in the harness and call them from `run()`; keep the entry point
alone. The harness drives the real loop — synthetic input for movement, jump and pause
(`Input.parse_input_event`), teleports for content checks — and exits nonzero with a list
of failures. Extend it whenever you add a system: it is the fastest way to prove a change
did not break the game, and the template's own quality bar comes from it.

## Acceptance scenarios

`godot/tests/scenarios/full-run.json` is the server-owned completion route: it starts at
the main menu, collects all five relics, and walks into the unlocked gate. It is data, not
code — `press`, `hold` and `wait` steps using this project's InputMap actions. Extend it
when you add a relic, level or platform: the server runs it under real physics and grades
the approved DESIGN.md observations with `game_scenarios_run`. Keep the interaction checks
in the smoke harness; a scenario proves the whole game can be finished, not that one
mechanic works in isolation. Do not teleport, call game methods or write GameState from a
route.

Tune a route by running it (`game_scenarios_run` returns frames, the values observed and
the failing criterion). The template route collects the Sunstone, Tideglass, Verdant Idol
and Sky Shard on the east/north side, then crosses to Emberheart and the gate; keep the
jump timings in step with actual physics rather than moving collectibles onto the path.
