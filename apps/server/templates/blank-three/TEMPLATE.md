# {{GAME_NAME}} — Blank (browser) starter template

This game started from the **Blank (browser)** template: one static three.js
project under `web/`. It has no real gameplay yet, but it ships the shell a
demo needs, so build the game, not the menus.

## Demo shell

- `web/index.html` loads `web/shell/shell.js`, which owns the page: a title
  screen (the game's name, Play, Settings, Credits), pause on Esc, P,
  gamepad Start or a hidden tab (Resume, Settings, Main menu), settings
  (master, music and sound-effect volume, plus fullscreen; an exported build
  keeps the volumes in the browser, while each Game panel rebuild is a new
  origin and starts at full volume), an
  end screen (the result message, the game's stats, Retry, Main menu) and
  credits, plus a Controls screen under Settings. Menus work with the mouse,
  the keys (arrows, Enter, Esc) and a gamepad (d-pad, A, B, Start).
- Gameplay plugs in at `web/main.js`, which exports `start(ctx)`,
  `update(dt, ctx)` and optionally `stop(ctx)`. The shell calls `start` on
  Play and on Retry with a fresh `ctx` (a new `ctx.scene` and `ctx.camera`),
  calls `update` every frame of play and through the short slow-motion beat
  after a win or loss, and stops calling it while paused and once the end
  screen opens. Build the run inside `start`, never at the module's top
  level; split it into more modules under `web/` as it grows. An optional
  `resize(ctx)` runs on every window resize, paused or not; the shell
  already refits a perspective or orthographic `ctx.camera`.
- `ctx` also carries `renderer`, `canvas`, `hud` (the game's DOM overlay,
  emptied each run), `player` (set it to the player object so the probe
  reports its position), `input` (the controls, below), `mouse` (`x`, `y` in canvas pixels, `ndc.x` / `ndc.y` for a `Raycaster`,
  `movement.x` / `movement.y` this frame, also under pointer lock, and
  `down(0)` / `pressed(0)` for the left button), `listen(target, type, fn)`
  and `after(seconds, fn)`. `ctx.keys` (raw keys) stays for older games;
  new code reads `ctx.input`. Input and mouse carry gameplay input only: a click
  on a menu never reaches them. Listeners and timers made through `ctx` fire
  only during play (timers also through the slow-motion end beat) and end
  with the run; a raw `addEventListener`, `setTimeout` or
  `requestAnimationFrame` keeps running through pause and stacks up across
  retries. The starter uses `ctx.input` for its moves and dash and
  `ctx.after` for its clock.
- End a run with `GameState.win("You escaped!", {Time: "1:42"})` or
  `GameState.lose("Out of fuel", {Distance: "340 m"})` (import `GameState`
  from `./shell/run-state.js`). The last hit plays out in slow motion for a
  moment, then the end screen shows the message and the stats in the order
  given.
- Put the game's run values on `GameState` at the top of `main.js`. Each Play
  and Retry puts every plain-data value (numbers, strings, booleans, arrays,
  plain objects, `Map`, `Set`) back to a copy of that starting value; a
  function, class instance or three.js object is left as it is, with a
  console warning, so build those in `start`. Name the values that must
  outlive a run in `export const KEEP_ACROSS_RUNS = ["best"]`; they persist
  in localStorage between visits and Settings shows "Reset progress".
- Name every model and texture in `export const ASSETS = { knight:
"assets/models/knight.glb" }`: the shell loads them behind a loading bar
  before the title, and `ctx.assets.model("knight")` returns a fresh copy
  (with `.animations`) and `ctx.assets.texture(name)` a texture, ready in
  `start`. A path that fails to load is reported as a page error.
- `GameState.state` reads `"title"`, `"playing"`, `"paused"` or `"ended"`
  (`GameState.result` is `"won"` or `"lost"` after a run). The shell sets it;
  the game reads it.
- To boot straight into play while building, set `BOOT_INTO_PLAY = true` in
  `web/shell/shell.js` (or open `index.html?play`). Ship with it `false`.
- `web/credits.txt` is what the credits screen shows. ASSETS.md stays the
  full record of every file's source and licence; every asset whose licence
  asks for attribution also gets a line in `credits.txt`.
- The look lives in `web/style.css` (theme tokens at the top, then one rule
  set per screen) and the screen markup in `web/index.html`. The art pass
  restyles both to the game's key art; keep the element ids and
  `data-action` attributes. `CLICK_SOUND` in `shell.js` names a file to
  replace the synthesized menu tick.
- Play music with `playMusic(url)` and effects with `Juice.sfx(url)` (or
  `playSfx`) from `./shell/audio.js`, so the volume sliders reach them.

## Controls

- Gameplay reads named actions through `ctx.input`, never keys:
  `input.vector()` (`{x, y}` from the four moves, y down, analog on a
  stick), `input.down("jump")`, `input.pressed("action")` (once per press),
  `input.released("alt")`, `input.axis("move_left", "move_right")`. A raw
  key check skips the gamepad and the player's rebinding.
- The defaults (`web/shell/controls.js`): `move_left` / `move_right` /
  `move_up` / `move_down` (WASD, arrows, left stick, d-pad), `jump` (Space,
  gamepad A), `action` (J, Enter, left click on the canvas, gamepad X), `alt`
  (K, Shift, gamepad B) and the shell's `pause` (Esc, P, Start).
- `main.js` changes them in one place:
  `export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad: ["rb"] }, jump: null };`
  adds `dash` (keys are `KeyboardEvent.code` values; pad names are listed at
  the top of `controls.js`), gives a default new bindings when you name it,
  and drops one the game never reads with `null`, so Settings > Controls
  lists only controls that work. Reading an undeclared action throws.
- Settings > Controls lists every action with its keys and gamepad inputs,
  rebinds keys (saved with the other settings; Reset to defaults) and is the
  place players and testers read the controls. Name keys in a HUD hint with
  `input.label("dash")`, as the starter does, so the hint stays true after
  a rebind.

## Game feel

`Juice` (`web/shell/juice.js`) answers player actions in one call each:
`Juice.shake(0.4)`, `Juice.hitPause()`, `Juice.pop(mesh)`,
`Juice.squash(mesh)`, `Juice.flash(mesh)`, `Juice.flashScreen(color)`,
`Juice.burst(position, color)` and `Juice.sfx("./assets/sfx/hit.wav")`.
The comment block at the top of the file shows each call.

## Characters and cameras

`animate(ctx.assets.model("hero"))` (`web/shell/animate.js`) plays a model's clips by state: call
`hero.play("idle" | "walk" | "run" | "jump" | "fall" | "attack" | "hit" |
"die", { speed })` every frame and it crossfades, returns from one-shots and
falls back (run to walk to idle) when a clip is missing. `followCamera2D`
and `followCamera3D` (`web/shell/camera.js`) follow the player with a dead
zone, look-ahead, damping and level bounds, and in 3D pull in at walls.
The shell ticks both after `update` and drops them between runs. The comment
block at the top of each file shows each call.

## What else the template ships

- `web/vendor/three.module.js` + `web/vendor/three.core.js` — three.js
  r0.180.0, pinned and vendored (MIT, see `web/vendor/LICENSE`), imported
  with a relative path. The module entry re-exports the core file, so both
  stay together. No install step, no bundler, no CDN. Keep the pin; say why
  in `web/vendor/PROVENANCE.md` before changing it.
- `web/assets/` — every visual and sound the game adds. Reference local
  files; nothing loads from the network at runtime.

## The studio bridge (keep it)

`window.__studio` (`web/shell/studio.js`) is how the harness plays this game:
`ready` after the first frame, `getState()` returning `{gameState, player,
hudText}` (the shell's `state` and `result` first, then the game's values;
`hudText` is the text on screen, menus included), `errors[]` carrying page
errors, and `setState(target, values)` reaching named late content when
`main.js` exports its own `setState(target, values, ctx)` (the starter
refuses; `ctx` is `null` when no run is going, so return `false` then).
Keep the shape; extend `GameState`, not the bridge. While the stage tab is hidden the bridge
holds play and suspends sound, then restores what it found.

## Conventions

- ES modules only, no build step: the file the browser loads is the file you
  edit. Keep imports relative.
- The game must be playable from `web/index.html` over HTTP on a fresh
  checkout (`file://` is not supported). Never open anything outside `web/`
  at runtime, never phone home.

## Check and play

`game_check` loads the page and then `index.html?play` headless and reports
console and page errors with file and line, so a failure in `start` cannot
hide behind the title. Keep both clean. A clean check says the page boots; it
cannot establish that the game is good to play.

Play with the `game_explore_*` tools (target web) and study every frame. The
game opens on the title: press `Enter` (Play is selected) or click Play.
