# Three.js game

The browser lane: one static project under `web/`, checked, played and
exported with the same `game_*` tools as a Godot game.

1. No install step, no bundler, no CDN. `web/vendor/three.module.js` is
   pinned; import it with a relative path. Keep the pin and its LICENSE.
2. The file the browser loads is the file you edit: `web/index.html`,
   `web/main.js` (the gameplay), `web/style.css`, `web/assets/` for every
   visual and sound.
   Nothing loads from the network at runtime.
   Models are GLB files under `web/assets/`, loaded with the vendored
   `GLTFLoader` (`import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"`,
   mapped by the import map in `index.html`). Keep the import map.
3. Never launch your own browser. Check, play, export, bot-test and package
   ONLY with the `game_*` tools (`game_check` to check, `game_export`
   to export).
4. The starter has title, pause, settings, end and credits screens and owns
   the render loop (TEMPLATE.md). Never build your own menus or loop: build
   each run in `start(ctx)` and move it in `update(dt, ctx)` in `web/main.js`,
   end it with `GameState.win(text, stats)` or `GameState.lose(text, stats)`,
   and restyle the shell instead of replacing it; for the title backdrop,
   set `--title-art: linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("assets/ui/title_bg.png")`
   in `style.css` with the key art there. Read controls as named actions
   through `ctx.input` (`vector()`, `down`, `pressed`), never key codes, so
   the gamepad and the player's rebinding work; add the game's own and drop
   unused defaults with `export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad: ["rb"] }, jump: null }`
   in `main.js` (TEMPLATE.md). Use `ctx.input`,
   `ctx.mouse`, `ctx.listen` and `ctx.after`, never raw listeners,
   `setTimeout` or `requestAnimationFrame`: those run through pause and pile
   up across retries. Retry resets every plain-data GameState value (numbers,
   strings, arrays, plain objects) to a copy of its starting value; list the
   ones that must survive (best score, unlocks) in
   `export const KEEP_ACROSS_RUNS = [...]`; the shell saves those between
   visits (numbers, strings, arrays, plain objects) and Settings can reset them.
   Answer every player action through `Juice` (`web/shell/juice.js`):
   `shake`, `hitPause`, `pop`, `squash`, `flash`, `flashScreen`, `burst`,
   `sfx`.
5. Keep `window.__studio`: `ready` after the first frame, `getState()`
   returning `{gameState, player, hudText}`, page errors in `errors[]`,
   `setState(target, values)` for named late content (the starter refuses).
   Extend `GameState`, not the bridge.
6. Keep `GameState` the single source of truth with public primitives only
   (the probe reports those; Retry resets them too). Build meshes, class
   instances and functions in `start(ctx)`, never on `GameState`.
   Keep the values that matter on screen too (the probe reports the overlay).
   Set `ctx.player` so the probe reports the player's position.
7. Playtest with `game_explore_*` (target web): real keys
   (`"Enter"`, `"w"`, `"ArrowLeft"`, not Godot action names), real clicks.
   The game opens on the title: press `"Enter"` to play.
   Bots read the probe and write `clickAt(x, y)`; id-clicks have no control
   to land on. `setState` reaches late content; verdicts still come from
   real input after.
8. Export checklist before calling it done: web export builds, the page
   stays clean in `game_check`, the game is playable from `web/index.html`
   on a fresh checkout.
9. Work in `./web` plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.
