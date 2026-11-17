# {{GAME_NAME}}: the bridge contract

`web/` is the game, and it is yours to make however the brief is best made. Kurambit's bridge
(loaded by `web/index.html`; keep its import map and its two script tags) runs `web/main.js` for
the Stage, Tune, Controls, the checks and replays, and draws nothing itself. Until `main.js`
exists the page runs nothing. This is all the bridge needs from it:

1. **A run.** `main.js` exports `start(ctx)`, which builds a run into `ctx.scene` and
   `ctx.camera` (both fresh each run; `ctx.renderer` draws them), and `update(dt, ctx)`, which
   moves it each fixed step. Build the run in `start`, never at the module's top level; set
   `ctx.player`. `stop(ctx)` undoes what `start` did outside `ctx`.
2. **An end.** `GameState.win(text)` and `GameState.lose(text)`, with `GameState` imported from
   `./shell/run-state.js`. Plain values the game puts on `GameState` are what the harness reads,
   and each run starts from their first values again.
3. **The run's moves.** `GameState.title()` in `start` opens the run on the game's own title
   (`GameState.state` is `"title"`; update keeps running); `GameState.play()` starts a fresh run
   in play (from a title, or as a retry), `menu()` a fresh run on the title, `pause()` and
   `resume()` hold play. The harness's plays open in play, where `title()` does nothing.
4. **Controls through `ctx.input`.** `ctx.input.down(name)`, `pressed(name)` and `vector()` (the
   arrows and WASD) read named actions, and `export const ACTIONS` names the game's own, such as
   `{ dash: { keys: ["ShiftLeft"], pad: ["rb"], mouse: [0] } }`. The Stage's Controls rebinds
   them, the QA play presses each one the game reads, and replays record them. Timers go through
   `ctx.after(seconds, fn)` and chance through `ctx.random()`, so a replay plays the same.
   Runs saved as test plays (`.studio/plays/`) replay on every build, ending as they did.
5. **Tunable values.** `ctx.tune(id, defaults, ranges)` returns a live object the Stage's Tune
   changes (read it every frame); `ctx.thing(object, { name, kind })` names what a person would
   select. `web/tune.json` holds the person's tuned values and wins over your defaults.

Optional: `export const ASSETS = { name: "assets/…/file.glb" }` loads models and textures before
the first run (`ctx.assets.model(name)`), and `export function render(ctx, dt)` draws the frame
yourself. `index.html?play` boots straight into play while building. Every file loads from
`web/`, nothing from the network; ES modules, no build step.

When the person asks you to remember something about the game, add it to `.studio/decisions.md`
as one line, `- YYYY-MM-DD · what to remember`: every agent session on the game reads it.
