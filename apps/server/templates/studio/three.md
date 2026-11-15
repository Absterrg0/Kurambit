# Three.js game

The browser lane: one static page under `web/`, on Kurambit's runtime (TEMPLATE.md). The Stage
reloads the game on every save, so add a model to `ASSETS` only once its file is in place.

## Rules

1. The game is yours: its title, menus, HUD, endings, camera, light, sky and post, made for the
   brief. TEMPLATE.md's contract is all the harness needs (a run, an end, the run's moves,
   controls, tunable values). The runtime also has optional helper modules, each documented at
   its top in `studio-skills/runtime/shell/`; none is needed. A
   game made on the older demo shell (its `index.html` has the shell's `section.screen`
   elements) keeps those screens: restyle them, or remove every one of them to draw the page
   yourself under the contract. An older game with no `runtime` in game.json keeps its own copy
   in `web/vendor/` and `web/shell/`: keep that pin and its LICENSE.
2. Go through `ctx` for what replays and the checks see: controls through `ctx.input` (named
   actions, so the gamepad and rebinding work), timers and listeners through `ctx.after` and
   `ctx.listen` (a raw `setTimeout` runs through pause and piles up across runs), chance
   through `ctx.random()`.
3. `GameState` holds the run's values in public plain data (the harness reads them, and each run
   starts from their first values); build meshes, class instances and functions in `start(ctx)`.
4. Name what a person would point at and tune. On the Stage the person
   freezes the game, selects things, drags their values live and asks you
   about one. Name the player, each kind of enemy, the level and the pickups
   with `ctx.thing`, and read every speed, jump, gravity, spawn rate, life
   count, damage and timer from `ctx.tune` where it is used, every frame,
   never copied into a constant, each with its range (TEMPLATE.md, item 5).
5. A message that starts "The person selected this in the running game" is
   an Ask from the Stage's Inspector. The attached image is the canvas as
   they asked; the block names the thing (a `ctx.thing` name, a `ctx.tune` id
   or an `ASSETS` path), its asset and sidecar, its live values (what the
   person was trying, which may differ from `web/tune.json` and your
   defaults), where it sits on that frame and its path over the last 10 s.
   Find it in the code by its id and answer about that thing.
6. Library models face +z, and packs differ in scale (a KayKit piece is 4 m across): face the
   move with `rotation.y = Math.atan2(dir.x, dir.z)` and size each with
   `root.scale.setScalar(n)`. Each `ctx.assets.model` call is its own copy, so each character
   gets its own `animate`; `dispose()` it when it is gone for good. A character exported from
   Blender is named in `ASSETS` by its sidecar and moves with `locomotion`, so its feet stay
   planted. Size it by the sidecar's height (`copy.userData.asset.height`, metres at scale 1): a
   box measured around a skinned copy before its bones move reads the bind data, not what
   draws, and scales it wildly.
7. The facts' Performance row is the random-input play ("60 fps · 1% low 48 ·
   GPU 9 ms at 0.8× of 1280×720"): a low 1% or a small scale is a reason to
   bake the level's shadow, trim triangles or drop a pass. "Not measured"
   because the harness drew in software is Kurambit's machine, not your game.
8. When you play with `game_play` ops `start`, `act` and `close`, send real keys (`"Enter"`, `"w"`, `"ArrowLeft"`); the
   page opens as a player opens it, on your title when the game has one.
