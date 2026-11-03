# {{GAME_NAME}} blank starter

An editable Godot project lives under `godot/`. The starter has no gameplay,
but it ships the shell a demo needs, so build the game, not the menus.

## Demo shell

- `scenes/main.tscn` (script `shell/shell.gd`) is the entry point: a title
  screen (the project name, Play, Settings, Credits, Quit; Quit hides on Web),
  pause on Esc, P or gamepad Start (Resume, Settings, Main menu), settings
  (master, music and sound-effect volume on the `Master`, `Music` and `SFX`
  buses, plus fullscreen, saved to `user://settings.cfg`), an end screen
  (the result message, the game's stats, Retry, Main menu) and credits.
- Gameplay plugs in at `scenes/game.tscn`. The shell instances it on Play and
  on Retry (a fresh instance each run) and freezes it on pause and at the end.
  Build the game there; split it into more scenes as it grows.
- End a run with `GameState.win("You escaped!", {"Time": "1:42"})` or
  `GameState.lose("Out of fuel", {"Distance": "340 m"})`. The last hit plays
  out in slow motion for a moment, then the end screen shows the message and
  the stats in the order given.
- Each Play and Retry resets every value declared in `scripts/game_state.gd`;
  name the ones that must outlive a run in its `KEEP_ACROSS_RUNS`; they persist
  in `user://progress.cfg` between launches and Settings shows "Reset progress".
- `GameState.state` reads `"title"`, `"playing"`, `"paused"` or `"ended"`
  (`GameState.result` is `"won"` or `"lost"` after a run). The shell sets it;
  the game reads it.
- To boot straight into play while building, set `BOOT_INTO_PLAY := true` in
  `shell/shell.gd`. Ship with it `false`.
- `credits.txt` is what the credits screen shows. ASSETS.md stays the full
  record of every file's source and licence; every asset whose licence asks
  for attribution also gets a line in `credits.txt`.
- The look lives in `shell/theme.tres` (the project-wide theme, so the game's
  HUD inherits it) and the screen nodes in `scenes/main.tscn`. The art pass
  restyles both to the game's key art. A file at `assets/sfx/ui_click.wav`
  makes every shell button click.
- Music plays on the `Music` bus and effects on `SFX`, so the volume sliders
  reach them.

## Game feel

`Juice` (`shell/juice.gd`) answers player actions in one call each:
`Juice.shake(0.4)`, `Juice.hit_pause()`, `Juice.pop(node)`,
`Juice.squash(node)`, `Juice.flash(node)`, `Juice.tint(node, color)`,
`Juice.burst(position, color)` and `Juice.sfx("res://assets/sfx/hit.wav")`.
The comment block at the top of the file shows each call.

## Characters and cameras

`CharacterAnimator.on($Model)` (`shell/character_animator.gd`) plays an
instanced GLB's clips by state: `anim.play("idle" | "walk" | "run" | "jump" |
"fall" | "attack" | "hit" | "die", {"speed": s})` every frame crossfades,
returns from one-shots and falls back (run to walk to idle) when a clip is
missing. `SpriteStrips.apply(sprite, {...}, view)` (`shell/sprite_strips.gd`)
loads `game_blender_render_sprites` strips into an AnimatedSprite2D.
`FollowCamera2D` (Camera2D smoothing, drag margins and limits plus look-ahead)
and `FollowCamera3D` (a SpringArm3D that pulls in at walls, with orbit) follow
the player. The comment block at the top of each file shows each call.

## Project structure

- `project.godot` uses the Compatibility renderer and boots `scenes/main.tscn`.
- Put scenes under `scenes/` and scripts under `scripts/`. Give distinct rules,
  state, player behavior and presentation clear owners as the game grows.
- Put runtime assets under `assets/`, including imported GLB files under
  `assets/models/`. Keep editable `.blend` sources outside `godot/`.
- `export_presets.cfg` provides Web, Windows and Linux exports through
  `game_export`. Keep Web single-threaded so it works without special
  response headers.

Read BRIEF.md and the relevant files in `studio-skills/`. When PLAN.md exists,
use it to guide the core loop and organization. More content is the creator's
choice; depth should serve the game's decisions and feel.

## Studio integration

Keep the `GameState`, `StudioProbe` and `Juice` autoloads. Expose useful public
primitive run values in GameState and add the player node to the `player`
group so exploration can report state and position. Keep those facts legible
in the game.

Keep the probe's visibility handling. It pauses and mutes the game when its
stage tab is hidden, then restores the prior state when shown.

## Check and play

Use `game_check` for import, load and boot problems; it runs both the shell
and `scenes/game.tscn`. A clean check says the project boots; it cannot
establish that the game is good to play. Godot's shutdown-only resource-use
chatter is noise, not a gameplay defect.

Use `game_explore_start`, `game_explore_act` and `game_explore_close` to play.
The game opens on the title: click `Title.Play` or press Enter. Inspect the
frames, try real inputs, and report what you reached and what remains
unverified. Fix the cause of the biggest play flaw. Games are verified by
playing, without game test suites, acceptance IDs or scripted routes.
