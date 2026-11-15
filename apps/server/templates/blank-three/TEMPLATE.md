# {{GAME_NAME}}: the bridge contract

`web/` is a static three.js page, and everything a player sees in it is this game's own: the
title, menus, HUD, endings, light, sky and post. Design them for the brief. Kurambit's runtime
runs `web/main.js` for the Stage, Tune, Controls, the checks and replays, and draws nothing. This
is all it needs from the game:

1. **A run.** `main.js` exports `start(ctx)`, which builds a run into `ctx.scene` with
   `ctx.camera`, and `update(dt, ctx)`, which moves it each fixed step. Every run starts fresh on
   a new scene, so build in `start`, never at the module's top level; `stop(ctx)` undoes anything
   `start` did outside `ctx` (the page's own elements are yours to keep). Set `ctx.player`.
2. **An end.** `GameState.win(text)` and `GameState.lose(text)`, from `./shell/run-state.js`.
   Plain values the game puts on `GameState` (a score, health) are what the harness reads, and
   each run starts from their first values again.
3. **The run's moves, through `GameState`.** `GameState.title()` in `start` opens the run on the
   game's own title (`GameState.state` is `"title"`; update keeps running); `GameState.play()`
   starts a fresh run in play (from the title, and as Retry), `menu()` a fresh run on the title,
   `pause()` and `resume()` hold play. The harness's plays open in play: there `title()` does
   nothing. `<body data-state>` carries the state, for the page's CSS.
4. **Controls through `ctx.input`.** `ctx.input.down("jump")`, `pressed`, `vector()` (the move
   actions) read named actions; `export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad:
["rb"] } }` adds one. The Stage's Controls rebinds them, the QA play presses each one the game
   reads, and replays record them. `ctx.mouse` and `ctx.keys` are the raw input; timers and
   listeners through `ctx.after` and `ctx.listen`, chance through `ctx.random()`, so a replay
   plays the same.
5. **Tunable values.** `ctx.tune(id, defaults, ranges)` returns a live object for the Stage's Tune
   (read it every frame); `ctx.thing(object, { name, kind })` names what a person would select.
   `web/tune.json` holds the person's tuned values and wins over your defaults.

`index.html?play` boots straight into play while building, and the Stage reloads a game being
played with `#kurambit-play`. Everything else is a choice: draw the frame yourself with `export
function render(ctx, dt)` (your own post chain), or not. List models and textures in `export const
ASSETS = { knight: "assets/models/knight.glb" }` to load them before the first run
(`ctx.assets.model(name)`; a Blender export by its `.asset.json` sidecar).

## Helpers you may import

`./shell/` holds kits, each with its calls in its comment block (`studio-skills/runtime/shell/`):
`look.js` (an `export const LOOK` with sky, fog, AO, bloom and grade presets), `model.js`
(models in code), `animate.js` and `locomotion.js` (clips), `camera.js`, `level.js`, `water.js`,
`juice.js`, `audio.js`. None is needed.

## Conventions

- ES modules, no build step; keep imports relative. Every file loads from `web/`: nothing from
  the network.
- `web/credits.txt` lists what each asset's licence asks to be credited; show it in the game if
  it has menus. ASSETS.md is the full record of every file's source and licence.

## Check and play

`game_check` is a quick look: it opens `index.html?play` headless, plays a moment of random keys
and returns a frame of play (beside the game's reference picture, when it has one), errors with
file and line, and the frame rate. With `final: true` it also opens the page as a player does
(your title), plays the scene report (what a person would see is wrong, with a frame outlining
each) and the QA play (every control, a retry, and whether the page's text fits the view).
`game_model_sheet` draws one named thing alone from four sides. When a chat turn ends, Kurambit
plays and measures the build.
