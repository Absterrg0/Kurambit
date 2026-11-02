# Three.js game

The browser lane: one static project under `web/`, checked, played and
exported with the same `game_*` tools as a Godot game.

1. No install step, no bundler, no CDN. `web/vendor/three.module.js` is
   pinned; import it with a relative path. Keep the pin and its LICENSE.
2. The file the browser loads is the file you edit: `web/index.html`,
   `web/main.js`, `web/style.css`, `web/assets/` for every visual and sound.
   Nothing loads from the network at runtime.
   Models are GLB files under `web/assets/`, loaded with the vendored
   `GLTFLoader` (`import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"`,
   mapped by the import map in `index.html`). Keep the import map.
3. Never launch your own browser. Check, play, export, bot-test and package
   ONLY with the `game_*` tools (`game_check` to check, `game_export`
   to export).
4. Keep `window.__studio`: `ready` after the first frame, `getState()`
   returning `{gameState, player, hudText}`, page errors in `errors[]`,
   `setState(target, values)` for named late content (the starter refuses).
   Extend `GameState`, not the bridge.
5. Keep `GameState` the single source of truth with public primitives only.
   Keep the values that matter on screen too (the probe reports the overlay).
6. A game with no player marks play with a typed `GameState.state`
   (0/false before play, another value once play starts).
7. Playtest with `game_explore_*` (target web): real keys
   (`"Enter"`, `"w"`, `"ArrowLeft"`, not Godot action names), real clicks.
   Bots read the probe and write `clickAt(x, y)`; id-clicks have no control
   to land on. `setState` reaches late content; verdicts still come from
   real input after.
8. Export checklist before calling it done: web export builds, the page
   stays clean in `game_check`, the game is playable from `web/index.html`
   on a fresh checkout.
9. Work in `./web` plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.
