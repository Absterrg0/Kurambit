# {{GAME_NAME}} — Blank (browser) starter template

This game started from the **Blank (browser)** template: one static three.js
project under `web/`. It has no real gameplay yet, but it ships the shell a
demo needs, so build the game, not the menus.

## Shortest path

The first playable build, in this order (the game's AGENTS.md, "The first turn"):

1. The look: `game_assets_search` lists the library by style family;
   `game_assets_add` the player and one or two threats or props, the first
   call with `lock` (the family and view), which writes `STYLE.json`. They land under `web/assets/library/<pack>/`; name them in `ASSETS`
   by the path the add reports. The shell loads them and compiles their
   shaders behind the loading screen, so play never starts on a freeze; keep
   the default look (or name one preset; no lights besides `ctx.look.sun`).
2. The game: paste the recipe for your view from `studio-skills/three.md`
   (third person, top-down, side view) over `web/main.js`, swap in your
   models, and grow it into the brief's core loop with the kits below.
3. A win and a lose through `GameState`, the HUD through `ctx.ui`, `Juice` on
   every action, then `game_check` clean, with each problem its scene report
   lists fixed. Ending the turn plays the build.

The rest of this file is reference: read a section when you use it.

## The runtime and its kits

The shell, its kits and three.js are Kurambit's runtime, not files of this
game: `web/index.html` loads them from `_kurambit/runtime/three/1/` (the
major `game.json` pins as `runtime`), and its import map points the game's
`./shell/...`, `./vendor/...`, `three` and `three/addons/...` imports there.
Kurambit serves the runtime, copies it into every export with its licences,
and brings fixes to it without a change here. Never copy or edit it: a
variant is a module of the game's own beside `main.js`.

Each kit's comment block shows every call; read it in
`studio-skills/runtime/shell/<file>` when you use the kit:

| kit               | what it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `shell.js`        | the screens and the loop; every export `main.js` may make, and what `ctx` carries     |
| `run-state.js`    | `GameState`, `win(text, stats)` and `lose(text, stats)`                               |
| `assets.js`       | `ASSETS`, loaded behind the loading bar; `ctx.assets.model(name)`, `texture(name)`    |
| `controls.js`     | named actions through `ctx.input`; `ACTIONS` adds, rebinds or drops one               |
| `hud.js`          | `ctx.ui`: counter, bar, timer, objective, toast, hint                                 |
| `juice.js`        | `Juice`: shake, hit pause, pop, squash, flash, bursts, sparks, dust, trails, sfx      |
| `animate.js`      | `animate(model)`: clips by state, combat timing, springs, look-at, feet on the ground |
| `locomotion.js`   | idle, walk, run and air from the speed the body moved                                 |
| `camera.js`       | `followCamera2D`, `followCamera3D` (shoulder, orbit, walls, focus on a foe)           |
| `level.js`        | `buildLevel` from a text map: spawns, bounds, walls, `move`, a ground to the horizon  |
| `look.js`         | `LOOK` presets (`day`, `golden`, `night`, `interior`, `flat`), the sun, baked shadows |
| `audio.js`        | `playMusic`, `playAmbience`, `playSfx` on the volume sliders                          |
| `stage-bridge.js` | `ctx.thing` and `ctx.tune` for the Stage                                              |

## The shell's contract

- `web/main.js` exports `start(ctx)` and `update(dt, ctx)`. The shell calls
  `start` on Play and on Retry with a fresh `ctx` (a new scene and camera):
  build the run there, never at the module's top level, and split it into
  more modules under `web/` as it grows. A world kept across runs comes out
  of `ctx.scene` in `stop(ctx)`, or the shell disposes it with the run.
- Name every model and texture in `ASSETS`; never load files inside `start`
  or `update`. A model `game_blender_export` made is named by its sidecar
  (`cat: "assets/blender/space_cat.asset.json"`), never its GLB, so `animate`
  gets its measurements; that GLB ships compressed, so never re-compress it.
- Retry resets every plain-data `GameState` value to a copy of its starting
  value; a function, class instance or three.js object is left as it is, so
  build those in `start`. `export const KEEP_ACROSS_RUNS = ["best"]` keeps
  values across runs and visits; Settings shows "Reset progress".
- `index.html?play` boots straight into play while building; the Stage
  reloads a game being played with `#kurambit-play`, so a save lands the
  person back in play.
- The screens' look lives in `web/style.css` (theme tokens at the top) and
  their markup in `web/index.html`: restyle both to the game's key art, and
  keep the element ids and `data-action` attributes. The title backdrop is
  `--title-art: linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("assets/ui/title_bg.png")`
  in `style.css`; replace the tab icon `web/assets/ui/icon.png` with a
  256x256 cut of the key art's main subject.
- `web/credits.txt` is what the credits screen shows. ASSETS.md stays the
  full record of every file's source and licence; every asset whose licence
  asks for attribution also gets a line in `credits.txt`.

## Things and live values (the Stage)

The Stage that frames the game freezes it, outlines things, tunes their
values live and shows where a thing went over the last 10 s. The bridge
costs nothing until the Stage asks.

```js
// in start(ctx): name what a person would select
ctx.thing(cat, { name: "Cat", kind: "character" });
ctx.thing(null, { name: "Music", kind: "sound" }); // no body
// every number a person would tune, read every frame, never copied
const cat = ctx.tune("Cat", { jump: 8, speed: 5 }, { jump: [2, 20], speed: [1, 12, 0.5] });
const rules = ctx.tune("Difficulty", { spawnEvery: 2.5, hard: false }, { spawnEvery: [0.5, 6] });
// in update: cat.jump, rules.spawnEvery
```

- Every `ctx.assets.model` copy is a thing already, named after its `ASSETS`
  key; `ctx.thing` on it renames it. Kinds: `character`, `creature`, `prop`,
  `level`, `effect`, `ui`, `rule`, `sound`, `other`.
- `ctx.tune(id, defaults, ranges)` returns one live object per id, lasting
  across retries: numbers and booleans, each number clamped to its range
  (`[min, max, step]`). An id no `ctx.thing` names is a rule of its own.
- `web/tune.json` holds kept values by id and key and is read once at boot
  over the defaults. The Stage's "Keep as a build" and `game_tune` write it;
  keep the file, even as `{}`.

## The studio bridge (keep it)

`window.__studio` (`shell/studio.js`) is how the harness plays this game:
`ready`, `getState()` (`{gameState, player, hudText}`), `errors[]`, `perf()`
and `setState(target, values)`, which reaches named late content when
`main.js` exports its own `setState(target, values, ctx)` (`ctx` is `null`
with no run; return `false` then). Extend `GameState`, not the bridge.

## Conventions

- ES modules only, no build step: the file the browser loads is the file
  you edit. Keep imports relative.
- The game plays from `web/index.html` over HTTP on a fresh checkout. Every
  visual and sound is a file under `web/assets/`; nothing loads from the
  network, nothing outside `web/` is opened, nothing phones home.

## Check and play

`game_check` boots the page and `index.html?play` headless and reports
console and page errors with file and line. Its scene report then plays 6 s
of random keys and lists what a person would see is wrong, each with a frame
that outlines it. It knows the player from `ctx.player` and the characters
from `ctx.thing` kinds (`character`, `creature`; `ASSETS` models with clips
are characters already). A clean check says the page boots and reads; it
cannot say the game is good to play.

When a chat turn ends, Kurambit plays and measures the build: its facts
include the scene report over a minute of random input and the performance
the shell measured (`window.__studio.perf()`).
