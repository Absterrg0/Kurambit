# {{GAME_NAME}} — Blank (browser) starter template

This game started from the **Blank (browser)** template: one static three.js
project under `web/`. It has no real gameplay yet, but it ships the shell a
demo needs, so build the game, not the menus.

## Shortest path

The first playable build, in this order (the game's AGENTS.md, "The first turn"):

1. The look: `game_assets_search` lists the library by style family; write
   `STYLE.json`, then `game_assets_add` the player and one or two threats or
   props. They land under `web/assets/library/<pack>/`; name them in `ASSETS`
   by the path the add reports. The shell loads them and compiles their
   shaders behind the loading screen, so play never starts on a freeze; keep
   the default look (or name one preset, below; no lights besides `ctx.look.sun`).
2. The game: paste the recipe for your view from `studio-skills/three.md`
   (third person, top-down, side view) over `web/main.js`, swap in your
   models, and grow it into the brief's core loop with the kits below.
3. A win and a lose through `GameState`, the HUD through `ctx.ui`, `Juice` on
   every action, then `game_check` clean. Ending the turn plays the build.

The rest of this file is reference: read a section when you use its kit.

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
- Three more optional exports, for a game that outgrows the starter's shape
  without forking the shell: `async prepare({ renderer, assets, look,
progress })` runs once behind the loading bar, after `ASSETS` (build a big
  world kept across runs, `look.bake` its shadow, compile its shaders;
  `progress(0..1)` fills the bar); `render(ctx, dt)` draws each frame instead
  of the shell (`ctx.look.render(scene, camera)` still draws through the look);
  `title(dt, ctx)` makes the title live: `ctx` (`scene`, `camera`, `renderer`,
  `assets`, `look`) lasts across visits and the shell draws it through the look
  every frame the title is up. A world kept across runs comes out of
  `ctx.scene` in `stop(ctx)`, or the shell disposes it with the run.
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
"assets/library/kaykit-adventurers/Characters/gltf/Knight.glb" }`: the shell loads them behind a loading bar
  before the title, and `ctx.assets.model("knight")` returns a fresh copy
  (with `.animations`) and `ctx.assets.texture(name)` a texture, ready in
  `start`. A model `game_blender_export` made is named by its sidecar,
  `cat: "assets/blender/space_cat.asset.json"`: the GLB beside it loads, and
  every copy carries the sidecar as `userData.asset` for `animate`. That GLB
  ships compressed (WebP images, meshopt geometry; the loader decodes it), and
  its sidecar names those bytes: never re-compress it by hand. A path
  that fails to load is reported as a page error. The
  loading screen also compiles the models' shaders, lit as a run is, so the
  first frame of play does not stall on them.
- `GameState.state` reads `"title"`, `"playing"`, `"paused"` or `"ended"`
  (`GameState.result` is `"won"` or `"lost"` after a run). The shell sets it;
  the game reads it.
- To boot straight into play while building, set `BOOT_INTO_PLAY = true` in
  `web/shell/shell.js` (or open `index.html?play`). Ship with it `false`.
  The Stage reloads a game the person is playing with `#kurambit-play`,
  which starts the run the same way, so a save lands them back in play.
- `web/credits.txt` is what the credits screen shows. ASSETS.md stays the
  full record of every file's source and licence; every asset whose licence
  asks for attribution also gets a line in `credits.txt`.
- The look lives in `web/style.css` (theme tokens at the top, then one rule
  set per screen) and the screen markup in `web/index.html`. The art pass
  restyles both to the game's key art; keep the element ids and
  `data-action` attributes. `CLICK_SOUND` in `shell.js` names a file to
  replace the synthesized menu tick.
- Play music with `playMusic(url)`, an ambience bed (wind, rain, a room's hum)
  with `playAmbience(url, { volume })` (one at a time, crossfading;
  `stopAmbience()`), and effects with `Juice.sfx(url)` (or `playSfx`) from
  `./shell/audio.js`, so the volume sliders reach them.

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
  `export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad: ["rb"] }, alt: null };`
  adds `dash` (keys are `KeyboardEvent.code` values; pad names are listed at
  the top of `controls.js`), gives a default new bindings when you name it,
  and drops one the game never reads with `null`, so Settings > Controls
  lists only controls that work. Reading an undeclared action throws.
- Settings > Controls lists every action with its keys and gamepad inputs,
  rebinds keys (saved with the other settings; Reset to defaults) and is the
  place players and testers read the controls. Name keys in a HUD hint as
  `{dash}`, as the starter does, so the hint stays true after a rebind.
- Put every HUD line through `ctx.ui` (`web/shell/hud.js`), called each frame
  from `update`: `counter("Gems", n, 5)`, `bar("Health", hp, 3)` (hearts up to
  10), `timer("Time", seconds)`, `objective(text)`; `toast("Gate opened!")` on
  the event; `hint("{jump} to jump", { until: () => jumped })` teaches a
  control once. They stay out of the play area's centre, clear on Retry and
  freeze on pause. Do not write raw text into `ctx.hud` beside them.

## Game feel

`Juice` (`web/shell/juice.js`) answers player actions in one call each:
`Juice.shake(0.4)`, `Juice.hitPause()`, `Juice.pop(mesh)`,
`Juice.squash(mesh)`, `Juice.flash(mesh)`, `Juice.flashScreen(color)`,
`Juice.burst(position, color)` and `Juice.sfx("./assets/sfx/hit.wav")`.
A fight wants more: `Juice.sparks(at, away)`, `Juice.blood(at, away)`,
`Juice.dust(at)` and `Juice.emit(at, { ... })` draw from one pooled particle
system (one draw call for every kind), and `Juice.trail(hero.root, { bone:
"hand_r" })` is a weapon trail measured from what that hand holds, shown while
`trail.on`. All of it runs on game time, so `Juice.hitPause()` holds it too.
The comment block at the top of the file shows each call.

## Characters and cameras

`animate(ctx.assets.model("hero"))` (`web/shell/animate.js`) plays a model's clips by state: call
`hero.play("idle" | "walk" | "run" | "jump" | "fall" | "attack" | "hit" |
"die", { speed })` every frame and it crossfades, returns from one-shots and
falls back (run to walk to idle) when a clip is missing. A generated
creature on its own rig plays its own clips the same way ("Trot" is its walk,
"Bite" its attack); its sidecar measures a walk's ground speed from its lowest
bones. A model loaded
from its sidecar knows more: `hero.play("run", { moveSpeed })` plays at the
speed the body moves over the clip's measured ground speed, so the feet stay
planted; its spring chains (a tail, ears) swing on their own, and
`hero.spring("tail", { stiffness, damping, gravity })` retunes one;
`hero.lookAt(point)` turns the head; a sidecar `face` (eyes made with the
Blender kit's `eye_lid` or `eye_squash`) blinks on its own every 2–6 s, and
`hero.blink()` blinks now. `locomotion(hero, { walk, run })`
(`web/shell/locomotion.js`) drives it: call `loco.update({ speed, grounded,
vy, dt })` every frame with the speed the body really moved, and
`loco.act("attack")` for a one-shot move. The console's `animate:` line names
each state's clip and its ground speed. For combat, a call can play a clip by
its exact name (`hero.play("Sword_Attack", { once: true, fade: 0.08 })`), from
an offset (`from: 0.25`), backwards (`reverse: true`) or again from its start
(`restart: true`, a combo's next cut); `hero.time` is the clip's own seconds
for hit windows (`hero.progress`, `hero.duration`, `hero.clip` beside it), on
game time. `followCamera2D`
and `followCamera3D` (`web/shell/camera.js`) follow the player with a dead
zone, look-ahead, damping and level bounds, and in 3D pull in at walls and
props (its near plane's corners too, so a post never fills the view). For
action, `followCamera3D` takes `shoulder` (an over-the-shoulder offset),
`orbitButton` (which mouse button drags the view; `null` keeps right-click free
for a dodge) and `ground` (a height function to stay above), and
`cam.focus = foe.root` turns it to keep a foe in frame.
The shell ticks both after `update` and drops them between runs. The comment
block at the top of each file shows each call.

## The look

`web/shell/look.js` draws every frame. A preset picks the light, the sky, the
fog and the post chain, in one line in `main.js`:
`export const LOOK = { preset: "golden" }`. `day` is the default: a soft sky
that lights the scene (an environment probe drawn from it), height fog, soft
sun shadows, Neutral tone mapping and a light grade, drawn straight to the
canvas with its anti-aliasing, so it costs what a plain three.js frame costs.
`golden` (a low warm sun, long shadows), `night` (moonlight, glows) and
`interior` (a studio light, no sky) add the post chain: ambient occlusion,
bloom, filmic tone mapping, the grade and SMAA in one merged pass. `flat` is
the stylised one, bright and ungraded. Any part can be overridden (`exposure`,
`sun`, `sky`, `fog`, `ao`, `bloom`, `grade`); `ao: true` or `bloom: true` turns
the chain on for any preset. The render scale adapts: when frames run late, the
look draws fewer pixels (down to half per side) and sharpens, and comes back up
when the GPU has room; `resolution: 1` fixes it. A browser drawing in software
always gets the plain path. The comment block at the top of the file lists
every option.

`ctx.look.sun({ follow: ctx.player, size: 30 })` adds a sun whose soft shadows
follow the player, as the starter does; models from `ASSETS` cast and receive
shadows, and a mesh you build needs `castShadow` (and `receiveShadow` for the
ground). A big static level renders its shadow once with
`ctx.look.bake(level)` (or `look.bake` in `prepare`): the sun's own shadow then
holds only what moves, which saves most of the shadow's cost each frame. The
look's fog and baked shadow reach every built-in material; one with its own
`onBeforeCompile` calls `lookShader(shader)` from `look.js` first.

Through an orthographic camera with no preset and no `toneMapping` named,
nothing is tone mapped, fogged or graded, so a 2D or pixel-art game's sprites
draw their files' exact colours; such a game also sets
`export const LOOK = { environment: false, shadows: false }`.

## Levels

`buildLevel(ctx, rows, legend, { floor })` (`web/shell/level.js`) builds a
level from a text map and a legend of ASSETS models, instanced so a large map
stays cheap, and returns `spawns` by letter, `bounds`, `walls` (camera
blockers) and `move(position, step, radius)`, which slides a circle along the
walls. The comment block at the top of the file shows each call.

## What else the template ships

- `web/vendor/three.module.js` + `web/vendor/three.core.js` — three.js
  r0.180.0, pinned and vendored (MIT, see `web/vendor/LICENSE`), imported
  with a relative path. The module entry re-exports the core file, so both
  stay together. No install step, no bundler, no CDN. Keep the pin; say why
  in `web/vendor/PROVENANCE.md` before changing it. `web/vendor/postprocessing/`
  (Zlib) and `web/vendor/n8ao/` (CC0) are the look's post chain, loaded only
  when the look uses it.
- `web/assets/` — every visual and sound the game adds. Reference local
  files; nothing loads from the network at runtime.

## The studio bridge (keep it)

`window.__studio` (`web/shell/studio.js`) is how the harness plays this game:
`ready` after the first frame, `getState()` returning `{gameState, player,
hudText}` (the shell's `state` and `result` first, then the game's values;
`hudText` is the text on screen, menus included), `errors[]` carrying page
errors, `perf()` (the look's play stats, which the facts read), and
`setState(target, values)` reaching named late content when
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

Kurambit plays and measures the build when a chat turn ends; its facts include
the game's performance during the random-input play, as the shell measured
it (`window.__studio.perf()`): "60 fps · 1% low 48 · GPU 9 ms at 0.8× of
1280×720" is the frame rate, the slowest 1% of frames, the GPU's time per
frame and the render scale the look settled on. Play with the
`game_explore_*` tools (target web) only when you need to see play, and study
every frame. The game opens on the title: press `Enter` (Play is selected) or
click Play.
