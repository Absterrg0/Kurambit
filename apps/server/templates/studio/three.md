# Three.js game

The browser lane: one static project under `web/` on Kurambit's runtime, the
shell and three.js (TEMPLATE.md). The Stage reloads the game on every save, so
add a model to `ASSETS` only once its file is in place.

## The first turn

- Library art from the first build: the player, threats and level pieces are
  library models (sprites in 2D) named in `ASSETS`. A Box, Sphere or Cylinder
  never stands in for a character, an enemy or a prop; effects (`Juice.burst`,
  a glow) are fine.
- Packs differ in scale (a Kenney blocky character stands several times a
  mini one): when you mix packs, size each model with `root.scale.setScalar(n)`.
- In a 3D view the look draws the sky, its light and the fog: do not set
  `scene.background` or `scene.fog` over them.
- Start from the recipe for your view below and grow it into the brief's
  loop. Each is pasted whole over `web/main.js` and passes `game_check`.

## View recipes

Third person (KayKit: `kaykit-adventurers`, `kaykit-skeletons`,
`kaykit-dungeon-remastered`). `action` attacks; the move is turned to the view.

```js
import * as THREE from "./vendor/three.module.js";
import { animate } from "./shell/animate.js";
import { followCamera3D } from "./shell/camera.js";
import { buildLevel } from "./shell/level.js";
import { Juice } from "./shell/juice.js";

const LIB = "assets/library/";
export const ASSETS = {
  hero: LIB + "kaykit-adventurers/Characters/gltf/Knight.glb",
  foe: LIB + "kaykit-skeletons/Characters/gltf/Skeleton_Minion.glb",
  wall: LIB + "kaykit-dungeon-remastered/Assets/gltf/wall.gltf.glb",
  floor: LIB + "kaykit-dungeon-remastered/Assets/gltf/floor_tile_large.gltf.glb",
};
export const ACTIONS = { jump: null, alt: null };
let hero, foe, cam, level, tuned;

export function start(ctx) {
  // KayKit pieces are 4 m across, so the cells are too.
  level = buildLevel(
    ctx,
    ["#######", "#..P..#", "#.....#", "#..E..#", "#######"],
    { "#": "wall", P: "spawn", E: "spawn" },
    { cell: 4, floor: "floor" },
  );
  hero = animate(ctx.assets.model("hero"));
  foe = animate(ctx.assets.model("foe"));
  hero.root.position.copy(level.spawns.P[0]);
  foe.root.position.copy(level.spawns.E[0]);
  ctx.scene.add(hero.root, foe.root);
  ctx.thing(hero.root, { name: "Hero", kind: "character" }); // what the person points at (Rules 4)
  ctx.thing(foe.root, { name: "Foe", kind: "creature" });
  tuned = ctx.tune("Hero", { speed: 5 }, { speed: [1, 12, 0.5] }); // read live, every frame
  ctx.player = hero.root;
  ctx.look.sun({ follow: hero.root, size: 30 });
  cam = followCamera3D(ctx, hero.root, { blockers: level.walls }); // framed by the hero's height
}

export function update(dt, ctx) {
  const { x, y } = ctx.input.vector();
  const s = Math.sin(cam.yaw),
    c = Math.cos(cam.yaw);
  const dir = new THREE.Vector3(x * c + y * s, 0, y * c - x * s); // the stick, turned to the view
  const speed = tuned.speed * Math.min(1, dir.length());
  if (speed > 0.1) {
    hero.root.rotation.y = Math.atan2(dir.x, dir.z);
    level.move(hero.root.position, dir.setLength(speed * dt), 0.5);
  }
  hero.play(speed > 3 ? "run" : speed > 0.1 ? "walk" : "idle", { speed: Math.max(speed / 4, 0.6) });
  if (ctx.input.pressed("action")) {
    hero.play("attack");
    Juice.shake(0.2);
  }
  foe.play("idle");
}
```

Top-down (the starter's roam, with `kenney-mini-dungeon`; low walls keep the
characters in sight).

```js
import * as THREE from "./vendor/three.module.js";
import { animate } from "./shell/animate.js";
import { followCamera2D } from "./shell/camera.js";
import { buildLevel } from "./shell/level.js";

const LIB = "assets/library/kenney-mini-dungeon/Models/GLB-format/";
export const ASSETS = {
  hero: LIB + "character-human.glb",
  orc: LIB + "character-orc.glb",
  wall: LIB + "wall-half.glb",
  barrel: LIB + "barrel.glb",
  floor: LIB + "floor.glb",
};
export const ACTIONS = { jump: null, alt: null };
let hero, orc, level, tuned;

export function start(ctx) {
  level = buildLevel(
    ctx,
    ["##############", "#..b......b..#", "#.....P......#", "#..b......E..#", "##############"],
    { "#": "wall", b: "barrel", P: "spawn", E: "spawn" },
    { floor: "floor" },
  );
  hero = animate(ctx.assets.model("hero"));
  orc = animate(ctx.assets.model("orc"));
  hero.root.position.copy(level.spawns.P[0]);
  orc.root.position.copy(level.spawns.E[0]);
  ctx.scene.add(hero.root, orc.root);
  ctx.thing(hero.root, { name: "Hero", kind: "character" });
  ctx.thing(orc.root, { name: "Orc", kind: "creature" });
  tuned = ctx.tune("Hero", { speed: 3 }, { speed: [1, 8, 0.25] });
  ctx.player = hero.root;
  ctx.look.sun({ follow: hero.root, size: 20 });
  ctx.camera.position.set(hero.root.position.x, 6, hero.root.position.z + 4); // tilted, looking down
  followCamera2D(ctx, hero.root, { plane: "xz", bounds: level.bounds });
}

export function update(dt, ctx) {
  const { x, y } = ctx.input.vector(); // y is down the screen: +z, towards this camera
  const speed = tuned.speed * Math.min(1, Math.hypot(x, y));
  if (speed > 0.1) {
    hero.root.rotation.y = Math.atan2(x, y);
    level.move(hero.root.position, new THREE.Vector3(x, 0, y).setLength(speed * dt), 0.3);
  }
  hero.play(speed > 0.1 ? "walk" : "idle");
  orc.play("idle");
}
```

Side view (an orthographic camera and pixel sprites from
`kenney-pixel-platformer`; a pixel lock needs `palette` in STYLE.json). Each
`ctx.assets.texture` is shared, so swap frames by changing the material's map.

```js
import * as THREE from "./vendor/three.module.js";
import { followCamera2D } from "./shell/camera.js";
import { Juice } from "./shell/juice.js";

const LIB = "assets/library/kenney-pixel-platformer/Tiles/";
export const ASSETS = {
  stand: LIB + "Characters/tile_0000.png",
  step: LIB + "Characters/tile_0001.png",
  ground: LIB + "tile_0002.png",
};
export const LOOK = { environment: false, shadows: false };
export const ACTIONS = { action: null, alt: null };
let hero, frames, vy, clock, tuned;
const sprite = (ctx, name) => {
  const map = ctx.assets.texture(name);
  map.magFilter = THREE.NearestFilter; // pixel art stays crisp
  return new THREE.Sprite(new THREE.SpriteMaterial({ map }));
};

export function start(ctx) {
  ctx.scene.background = new THREE.Color(0x9fd8ef);
  const half = 5,
    aspect = innerWidth / innerHeight; // 10 tiles tall; the shell refits on resize
  ctx.camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 100);
  for (let x = -12; x <= 60; x++) {
    const tile = sprite(ctx, "ground");
    tile.position.set(x, -0.5, 0);
    ctx.scene.add(tile);
  }
  hero = sprite(ctx, "stand");
  hero.position.set(0, 0.5, 1);
  ctx.scene.add(hero);
  ctx.thing(hero, { name: "Hero", kind: "character" });
  tuned = ctx.tune(
    "Hero",
    { run: 6, jump: 12, gravity: 30 },
    { run: [2, 12, 0.5], jump: [4, 24, 0.5], gravity: [10, 60, 1] },
  );
  ctx.player = hero;
  ctx.camera.position.set(hero.position.x, hero.position.y, 10); // followCamera2D keeps this offset
  frames = [ctx.assets.texture("stand"), ctx.assets.texture("step")];
  vy = 0;
  clock = 0;
  followCamera2D(ctx, hero, { bounds: { minX: -12, maxX: 60, minY: -1, maxY: 30 } });
}

export function update(dt, ctx) {
  const run = ctx.input.axis("move_left", "move_right");
  const grounded = hero.position.y <= 0.5;
  if (grounded && ctx.input.pressed("jump")) {
    vy = tuned.jump;
    Juice.squash(hero);
  }
  vy -= tuned.gravity * dt;
  hero.position.x += run * tuned.run * dt;
  hero.position.y = Math.max(0.5, hero.position.y + vy * dt);
  if (run !== 0) hero.scale.x = Math.sign(run); // face the run
  clock += dt;
  hero.material.map = frames[run !== 0 && grounded ? Math.floor(clock * 8) % 2 : 0];
}
```

## Rules

1. The shell owns the page: the title, pause, settings, end and credits
   screens, the render loop, the look and the Stage bridge. Build each run in
   `start(ctx)`, move it in `update(dt, ctx)`, end it with `GameState.win` or
   `lose`, and restyle the screens rather than replace them. Never write your
   own menus, loop, renderer, post chain, lighting rig, clip switching or
   camera follow: the kits do it (TEMPLATE.md lists them; each kit's comment
   block shows every call). An older game with no `runtime` in game.json keeps
   its own copy in `web/vendor/` and `web/shell/`: keep that pin and its LICENSE.
2. Go through `ctx`: controls through `ctx.input` (named actions, never key
   codes, so the gamepad and rebinding work), the HUD through `ctx.ui`,
   listeners and timers through `ctx.listen` and `ctx.after` (a raw listener,
   `setTimeout` or `requestAnimationFrame` runs through pause and piles up
   across retries). Answer every player action with `Juice`.
3. `GameState` is the single source of truth, in public plain data (the probe
   reports it and Retry resets it); build meshes, class instances and
   functions in `start(ctx)`. Keep the values that matter on screen too, and
   set `ctx.player`.
4. Name what a person would point at and tune. On the Stage the person
   freezes the game, selects things, drags their values live and asks you
   about one. Name the player, each kind of enemy, the level and the pickups
   with `ctx.thing`, and read every speed, jump, gravity, spawn rate, life
   count, damage and timer from `ctx.tune` where it is used, every frame,
   never copied into a constant, each with its range (TEMPLATE.md, Things and
   live values).
5. A message that starts "The person selected this in the running game" is
   an Ask from the Stage's Inspector. The attached image is the canvas as
   they asked; the block names the thing (a `ctx.thing` name, a `ctx.tune` id
   or an `ASSETS` path), its asset and sidecar, its live values (what the
   person was trying, which may differ from `web/tune.json` and your
   defaults), where it sits on that frame and its path over the last 10 s.
   Find it in the code by its id and answer about that thing.
6. Levels seen from above are text maps through `buildLevel`, with more than
   one room joined by corridors when the brief allows; spawn from
   `level.spawns` and move with `level.move`. A side-view level is built by hand.
7. Library models face +z: face the move with `rotation.y = Math.atan2(dir.x,
dir.z)`. Each `ctx.assets.model` call is its own copy, so each character
   gets its own `animate`; `dispose()` it when it is gone for good. A
   character exported from Blender is named in `ASSETS` by its sidecar and
   moves with `locomotion`, so its feet stay planted.
8. The facts' Performance row is the random-input play ("60 fps · 1% low 48 ·
   GPU 9 ms at 0.8× of 1280×720"): a low 1% or a small scale is a reason to
   bake the level's shadow, trim triangles or drop a pass. "Not measured"
   because the harness drew in software is Kurambit's machine, not your game.
9. When you play with `game_explore_*`, send real keys (`"Enter"`, `"w"`,
   `"ArrowLeft"`); the game opens on the title, so press `"Enter"` first.
