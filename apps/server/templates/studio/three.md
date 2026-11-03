# Three.js game

The browser lane: one static project under `web/`, checked, played and
exported with the same `game_*` tools as a Godot game.

1. No install step, no bundler, no CDN. `web/vendor/three.module.js` is
   pinned; import it with a relative path. Keep the pin and its LICENSE.
2. The file the browser loads is the file you edit: `web/index.html`,
   `web/main.js` (the gameplay), `web/style.css`, `web/assets/` for every
   visual and sound.
   Nothing loads from the network at runtime.
   Models are GLB files under `web/assets/`. Name every model and texture in
   `export const ASSETS = { knight: "assets/models/knight.glb", ... }` in
   `main.js`: the shell loads them before the title, and `ctx.assets.model("knight")`
   returns a fresh copy (skinned characters included; `.animations` holds its
   clips) and `ctx.assets.texture(name)` a texture, both synchronously in
   `start`. Never load files inside `start` or `update`. Keep the import map.
3. Never launch your own browser. Check, play, export, bot-test and package
   ONLY with the `game_*` tools (`game_check` to check, `game_export`
   to export).
4. The starter has title, pause, settings, end and credits screens and owns
   the render loop (TEMPLATE.md). Never build your own menus or loop: build
   each run in `start(ctx)` and move it in `update(dt, ctx)` in `web/main.js`,
   end it with `GameState.win(text, stats)` or `GameState.lose(text, stats)`,
   and restyle the shell instead of replacing it; for the title backdrop,
   set `--title-art: linear-gradient(rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.55)), url("assets/ui/title_bg.png")`
   in `style.css` with the key art there, and replace the placeholder tab icon
   `web/assets/ui/icon.png` with a 256x256 cut of its main subject. Read controls as named actions
   through `ctx.input` (`vector()`, `down`, `pressed`), never key codes, so
   the gamepad and the player's rebinding work; add the game's own and drop
   unused defaults with `export const ACTIONS = { dash: { keys: ["ShiftLeft"], pad: ["rb"] }, alt: null }`
   in `main.js` (TEMPLATE.md). Use `ctx.input`,
   `ctx.mouse`, `ctx.listen` and `ctx.after`, never raw listeners,
   `setTimeout` or `requestAnimationFrame`: those run through pause and pile
   up across retries. Retry resets every plain-data GameState value (numbers,
   strings, arrays, plain objects) to a copy of its starting value; list the
   ones that must survive (best score, unlocks) in
   `export const KEEP_ACROSS_RUNS = [...]`; the shell saves those between
   visits (numbers, strings, arrays, plain objects) and Settings can reset them.
   Show the score, health, timer, objective, event toasts and control hints
   through `ctx.ui` (`web/shell/hud.js`; TEMPLATE.md), never raw text, and
   teach each control with a `hint` the first time it matters.
   Answer every player action through `Juice` (`web/shell/juice.js`):
   `shake`, `hitPause`, `pop`, `squash`, `flash`, `flashScreen`, `burst`,
   `sfx`.
5. Never hand-write clip switching or camera follow; the shell kits do it
   and the shell ticks them on game time. Character: `const hero =
animate(ctx.assets.model("knight"))` (`web/shell/animate.js`), then every frame
   `hero.play(state, { speed })` with the state chosen from gameplay (on
   floor, speed, attacking) and `hero.play("attack")` on the event; it finds
   clips by name, crossfades, returns from one-shots, and the console line
   says which clip each state got. Library models face +z: face the move
   direction with `rotation.y = Math.atan2(dir.x, dir.z)`. Camera
   (`web/shell/camera.js`): `followCamera2D(ctx, player, { bounds })` for a
   side or top-down view, `followCamera3D(ctx, player, { blockers: [level] })`
   for third person, moving the player relative to `cam.yaw`. Juice.shake
   applies on top. Each `ctx.assets.model` call is its own copy, so every
   character or enemy gets its own `animate`; call its `dispose()` when the
   enemy is gone for good.
6. Write every top-down level (rows run along x/z on the ground) as a text map with `buildLevel(ctx, rows, legend, { floor })`
   (`web/shell/level.js`), never pieces placed by coordinates: `#` walls,
   `.` floor, a letter per spawn, the legend naming ASSETS models. Make more
   than one room, joined by corridors, when the brief allows. Put the player,
   enemies and pickups at `level.spawns.P[0]`, `level.spawns.E`, never at
   hard-coded positions; move them with `level.move(position, step, radius)`
   so they slide along walls (keep the radius under half a cell); a side-view
   level is built by hand; pass `level.walls` to `followCamera3D`'s
   `blockers` and `level.bounds` to `followCamera2D`.
7. Keep `window.__studio`: `ready` after the first frame, `getState()`
   returning `{gameState, player, hudText}`, page errors in `errors[]`,
   `setState(target, values)` for named late content (the starter refuses).
   Extend `GameState`, not the bridge.
8. Keep `GameState` the single source of truth with public primitives only
   (the probe reports those; Retry resets them too). Build meshes, class
   instances and functions in `start(ctx)`, never on `GameState`.
   Keep the values that matter on screen too (the probe reports the overlay).
   Set `ctx.player` so the probe reports the player's position.
9. Playtest with `game_explore_*` (target web): real keys
   (`"Enter"`, `"w"`, `"ArrowLeft"`, not Godot action names), real clicks.
   The game opens on the title: press `"Enter"` to play.
   Bots read the probe and write `clickAt(x, y)`; id-clicks have no control
   to land on. `setState` reaches late content; verdicts still come from
   real input after.
10. Export checklist before calling it done: web export builds, the page
    stays clean in `game_check`, the game is playable from `web/index.html`
    on a fresh checkout.
11. Work in `./web` plus VISION.md, PLAN.md and NOTES.md. Never commit,
    never reset git, never use subagents.
