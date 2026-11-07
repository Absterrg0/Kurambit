# Three.js game

The browser lane: one static project under `web/`, checked, played and
exported with the same `game_*` tools as a Godot game.

The Stage is live: keep the game booting between saves. Kurambit serves
`web/` itself on the person's Stage and reloads it a moment after each save,
so every save is a version they may be playing. Write a new module before
the line that imports it, change `main.js` in whole working steps, and add a
model to `ASSETS` only once its file is in place. A save that throws shows
the person the error until a save boots again.

## The first turn

- Library art from the first build. The player, threats and level pieces
  are library models (sprites in 2D) named in `ASSETS`; the starter's sphere
  and beacon are placeholders. A Box, Sphere or Cylinder never stands in for
  a character, an enemy or a prop. Effects (`Juice.burst`, a glow) are fine.
- three.js loads GLB and glTF only. Animated GLB characters are in
  `kaykit-adventurers` and `kaykit-skeletons` (rig `kaykit-1`),
  `kenney-mini-characters` and `kenney-mini-dungeon` (rig `kenney-mini`) and
  `kenney-blocky-characters`; the FBX-only character packs
  (`quaternius-knight`, `quaternius-ultimate-characters`,
  `quaternius-monsters`, `kenney-animated-characters-1`) do not load here. Put in `ASSETS`
  the path `game_assets_add` reports: it renames folders (Kenney's
  `GLB format` becomes `GLB-format`). Packs differ in scale (a Kenney blocky
  character stands several times a mini one): when you mix packs, size each
  model with `root.scale.setScalar(n)`.
- Keep the default look on the first build: `LOOK` as it is, no lights
  besides `ctx.look.sun`. Builds are played and measured in a software
  renderer, where bloom and extra lights stall the start; the shell already
  loads every `ASSETS` model and compiles its shaders behind the loading
  screen, so play starts without a freeze. Glows are a later turn.
- No Blender, no key art, no plan, no `game_explore_*` to check your work:
  `game_check` clean is the check, and Kurambit plays and measures the build
  when the turn ends.
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
let hero, foe, cam, level;

export function start(ctx) {
  ctx.scene.background = new THREE.Color(0x141a24);
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
  ctx.player = hero.root;
  ctx.look.sun({ follow: hero.root, size: 30 });
  cam = followCamera3D(ctx, hero.root, { blockers: level.walls, distance: 8, height: 2.5 });
}

export function update(dt, ctx) {
  const { x, y } = ctx.input.vector();
  const s = Math.sin(cam.yaw),
    c = Math.cos(cam.yaw);
  const dir = new THREE.Vector3(x * c + y * s, 0, y * c - x * s); // the stick, turned to the view
  const speed = 5 * Math.min(1, dir.length());
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
let hero, orc, level;

export function start(ctx) {
  ctx.scene.background = new THREE.Color(0x1a1c22);
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
  ctx.player = hero.root;
  ctx.look.sun({ follow: hero.root, size: 20 });
  ctx.camera.position.set(hero.root.position.x, 6, hero.root.position.z + 4); // tilted, looking down
  followCamera2D(ctx, hero.root, { plane: "xz", bounds: level.bounds });
}

export function update(dt, ctx) {
  const { x, y } = ctx.input.vector(); // y is down the screen: +z, towards this camera
  const speed = 3 * Math.min(1, Math.hypot(x, y));
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
let hero, frames, vy, clock;
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
    vy = 12;
    Juice.squash(hero);
  }
  vy -= 30 * dt;
  hero.position.x += run * 6 * dt;
  hero.position.y = Math.max(0.5, hero.position.y + vy * dt);
  if (run !== 0) hero.scale.x = Math.sign(run); // face the run
  clock += dt;
  hero.material.map = frames[run !== 0 && grounded ? Math.floor(clock * 8) % 2 : 0];
}
```

## Rules

1. No install step, no bundler, no CDN. `web/vendor/three.module.js` is
   pinned; import it with a relative path. Keep the pin and its LICENSE.
2. The file the browser loads is the file you edit: `web/index.html`,
   `web/main.js` (the gameplay), `web/style.css`, `web/assets/` for every
   visual and sound.
   Nothing loads from the network at runtime.
   Models are GLB files under `web/assets/`, from the library
   (`game_assets_add` puts them under `web/assets/library/<pack>/`) or the
   live Blender. Name every model and texture in
   `export const ASSETS = { knight: "assets/library/kaykit-adventurers/Characters/gltf/Knight.glb", ... }` in
   `main.js`: the shell loads them before the title, and `ctx.assets.model("knight")`
   returns a fresh copy (skinned characters included; `.animations` holds its
   clips) and `ctx.assets.texture(name)` a texture, both synchronously in
   `start`. A model from `game_blender_export` is named by its sidecar
   (`cat: "assets/blender/space_cat.asset.json"`), never its GLB, so `animate`
   gets its measurements. Never load files inside `start` or `update`. Keep the import map.
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
   enemy is gone for good. A character loaded from its sidecar moves with
   `locomotion` (`web/shell/locomotion.js`) instead of a hand-picked state:

   ```js
   import { locomotion } from "./shell/locomotion.js";
   // in start(ctx):
   hero = animate(ctx.assets.model("cat")); // its tail and ears spring on their own
   loco = locomotion(hero, { walk: 0.3, run: 3.2 });
   // in update(dt, ctx), after moving it: the speed it really moved (walls stop it)
   loco.update({ speed: moved / dt, grounded: !airborne, vy, dt });
   if (ctx.input.pressed("action")) loco.act("attack");
   hero.lookAt(nearestFoe?.position ?? null);
   ```

   The standard clips have no attack: name one in `game_blender_character`'s
   `clips` (`Punch_Jab`, `Sword_Attack`, `Spell_Simple_Shoot`) when the
   character fights.

   Walk and run then play at the clip's measured ground speed, so the feet
   stay planted; never pass `speed` for them. Retune a chain with
   `hero.spring("tail", { stiffness: 0.09, damping: 0.14, gravity: 4 })`.

6. Never write a renderer, post-processing or lighting rig; the shell's look
   (`web/shell/look.js`; TEMPLATE.md) does it. Light the run with
   `ctx.look.sun({ follow: ctx.player, size })` and tune numbers through
   `export const LOOK = { ... }` in `main.js`. Turn on `bloom: true` only when
   glows matter to the game, with their emissive colours above 1: it costs
   several times the plain look every frame, and a machine without a GPU
   (some players', and the harness's fallback) draws it in software. Through an orthographic camera nothing is tone mapped
   unless LOOK names a toneMapping, so a 2D or pixel-art game's sprites keep
   their files' colours; it also sets `LOOK = { environment: false, shadows: false }`.
7. Write every top-down level (rows run along x/z on the ground) as a text map with `buildLevel(ctx, rows, legend, { floor })`
   (`web/shell/level.js`), never pieces placed by coordinates: `#` walls,
   `.` floor, a letter per spawn, the legend naming ASSETS models. Make more
   than one room, joined by corridors, when the brief allows. Put the player,
   enemies and pickups at `level.spawns.P[0]`, `level.spawns.E`, never at
   hard-coded positions; move them with `level.move(position, step, radius)`
   so they slide along walls (keep the radius under half a cell); a side-view
   level is built by hand; pass `level.walls` to `followCamera3D`'s
   `blockers` and `level.bounds` to `followCamera2D`.
8. Keep `window.__studio`: `ready` after the first frame, `getState()`
   returning `{gameState, player, hudText}`, page errors in `errors[]`,
   `setState(target, values)` for named late content (the starter refuses).
   Extend `GameState`, not the bridge.
9. Keep `GameState` the single source of truth with public primitives only
   (the probe reports those; Retry resets them too). Build meshes, class
   instances and functions in `start(ctx)`, never on `GameState`.
   Keep the values that matter on screen too (the probe reports the overlay).
   Set `ctx.player` so the probe reports the player's position.
10. Play-test with `game_explore_*` only when you need to see play: in a
    chat turn when the person asks or a fact names something the code cannot
    show, in a run when your role says so. Real keys
    (`"Enter"`, `"w"`, `"ArrowLeft"`, not Godot action names), real clicks.
    The game opens on the title: press `"Enter"` to play.
    Bots read the probe and write `clickAt(x, y)`; id-clicks have no control
    to land on. `setState` reaches late content; verdicts still come from
    real input after.
11. Export checklist before calling it done: web export builds, the page
    stays clean in `game_check`, the game is playable from `web/index.html`
    on a fresh checkout.
