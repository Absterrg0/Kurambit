# Three.js game

The browser lane: one static page under `web/`, on Kurambit's runtime (TEMPLATE.md). The Stage
reloads the game on every save, so add a model to `ASSETS` only once its file is in place.

## Rules

1. The game is yours: its title, menus, HUD, endings, camera, light, sky and post, made for the
   brief. TEMPLATE.md's contract is all the harness needs. The runtime also has optional helper
   modules, each documented at its top in `studio-skills/runtime/shell/`; none is needed.
2. Go through `ctx` for what replays and the checks see: a raw `setTimeout` runs through pause
   and piles up across runs, so timers and listeners go through `ctx.after` and `ctx.listen`,
   and chance through `ctx.random()`. `GameState` holds only plain data; meshes, class
   instances and functions are built in `start(ctx)`.
3. Name what a person would point at and tune. On the Stage the person
   freezes the game, selects things, drags their values live and asks you
   about one. Name the player, each kind of enemy, the level and the pickups
   with `ctx.thing`, and read every speed, jump, gravity, spawn rate, life
   count, damage and timer from `ctx.tune` where it is used, every frame,
   never copied into a constant, each with its range (TEMPLATE.md, item 5).
4. A message that starts "The person selected this in the running game" is
   an Ask from the Stage's Inspector. The attached image is the canvas as
   they asked; the block names the thing (a `ctx.thing` name, a `ctx.tune` id
   or an `ASSETS` path), its asset and sidecar, its live values (what the
   person was trying, which may differ from `web/tune.json` and your
   defaults), where it sits on that frame and its path over the last 10 s.
   Find it in the code by its id and answer about that thing.
5. Library models face +z, and packs differ in scale (a KayKit piece is 4 m across): face the
   move with `rotation.y = Math.atan2(dir.x, dir.z)` and size each with
   `root.scale.setScalar(n)`. Each `ctx.assets.model` call is its own copy, so each character
   gets its own `animate`; `dispose()` it when it is gone for good. A character exported from
   Blender is named in `ASSETS` by its sidecar and moves with `locomotion`, so its feet stay
   planted. Size it by the sidecar's height (`copy.userData.asset.height`, metres at scale 1): a
   box measured around a skinned copy before its bones move reads the bind data, not what
   draws, and scales it wildly.
6. The facts' Performance row is the random-input play ("41 fps · 1% low 22 ·
   GPU 14 ms at 0.8× of 1280×720 · 1,900 draw calls · 2.1M triangles"): cut draw
   calls past a few hundred (one InstancedMesh per repeated model, merge static
   pieces) and triangles past about 1.5M. A frame rate "not measured" in software
   is Kurambit's machine, not your game; the counts are still your game's.
7. When you play with `game_play` ops `start`, `act` and `close`, send real keys (`"Enter"`, `"w"`, `"ArrowLeft"`), and a click
   before the game can capture the pointer; the page opens as a player opens
   it, on your title when the game has one.
