// The Hill Temple: a warring-states sword slice. Walk the old path to the hill temple at golden
// hour and cut down the bandits who hold it. The world, the light and the post chain are built
// once behind the loading bar (prepare) and kept across runs; each run adds the hero and the
// bandits. Ported from round 2's Godot build, on the same level and the same combat numbers.
import * as THREE from "./vendor/three.module.js";
import { GameState } from "./shell/run-state.js";
import { Juice } from "./shell/juice.js";
import { animate } from "./shell/animate.js";
import { playMusic } from "./shell/audio.js";
import { buildGrid, PLATEAU_H, path, STAIR_A, groundAt } from "./game/level.js";
import { buildWorld, SUN_COLOR, SUN_DIR } from "./game/world.js";
import { buildGrass, grassUniforms } from "./game/grass.js";
import { createPipeline, makeFog } from "./game/render.js";
import { createThirdPerson } from "./game/camera.js";
import { createFx } from "./game/fx.js";
import { bladeEnds, createBandit, createHero } from "./game/fighters.js";
import { setAnisotropy } from "./game/materials.js";
import { createSounds } from "./game/sounds.js";
import { createAutopilot } from "./game/autopilot.js";

// ?dev: round 2's own GLBs and clip names, until the pipeline's exports exist (removed before shipping)
const DEV = new URLSearchParams(location.search).has("dev");
const DEV_PROPS = DEV || new URLSearchParams(location.search).has("devprops");
const DEV_ASSETS = Object.fromEntries(
  ["gate", "temple", "lantern", "pine_0", "pine_1", "pine_2", "tree_0", "tree_1", "tree_2"].map((n) => [n, `assets/dev/${n}.glb`]),
);
export const ASSETS = DEV
  ? { ...DEV_ASSETS, hero: "assets/dev/hero_r2.glb", bandit: "assets/dev/bandit_r2.glb", lion: "assets/dev/lion2.glb", boulder_02: "assets/models/namaqualand_boulder_02.glb", rock_moss: "assets/models/rock_moss_set_01.glb", pebble: "assets/models/pebble.glb" }
  : DEV_PROPS
  ? { ...DEV_ASSETS, hero: "assets/blender/hero.asset.json", bandit: "assets/blender/bandit.asset.json", lion: "assets/dev/lion2.glb", boulder_02: "assets/models/namaqualand_boulder_02.glb", rock_moss: "assets/models/rock_moss_set_01.glb", pebble: "assets/models/pebble.glb" }
  : {
  hero: "assets/blender/hero.asset.json",
  bandit: "assets/blender/bandit.asset.json",
  gate: "assets/blender/gate.asset.json",
  temple: "assets/blender/temple.asset.json",
  lantern: "assets/blender/lantern.asset.json",
  lion: "assets/blender/lion.asset.json",
  pine_0: "assets/blender/pine_0.asset.json",
  pine_1: "assets/blender/pine_1.asset.json",
  pine_2: "assets/blender/pine_2.asset.json",
  tree_0: "assets/blender/tree_0.asset.json",
  tree_1: "assets/blender/tree_1.asset.json",
  tree_2: "assets/blender/tree_2.asset.json",
  boulder_02: "assets/models/namaqualand_boulder_02.glb",
  rock_moss: "assets/models/rock_moss_set_01.glb",
    pebble: "assets/models/pebble.glb",
  };
export const LOOK = {
  renderer: { antialias: false, powerPreference: "high-performance", stencil: false, depth: true },
  maxPixelRatio: 1,
  environment: false,
};
export const ACTIONS = {
  jump: null,
  alt: null,
  action: { keys: ["KeyJ"], pad: ["x", "rb"], mouse: [0], label: "Strike" },
  dodge: { keys: ["Space"], pad: ["a"], mouse: [2], label: "Dodge step" },
  roll: { keys: ["KeyC"], pad: ["b"], label: "Roll" },
  sprint: { keys: ["ShiftLeft"], pad: ["lb", "ls"], label: "Sprint" },
  look_left: { keys: [], pad: ["rstick_left"] },
  look_right: { keys: [], pad: ["rstick_right"] },
  look_up: { keys: [], pad: ["rstick_up"] },
  look_down: { keys: [], pad: ["rstick_down"] },
};

GameState.hp = 100;
GameState.bandits_left = 5;
GameState.cut_down = 0;
GameState.seconds = 0;
GameState.zone = "path";

const HERO_CLIPS = {
  idle: "Sword_Idle",
  walk: "Walk_Loop",
  jog: "Jog_Fwd_Loop",
  sprint: "Sprint_Loop",
  roll: "Roll",
  rollSpeed: 1.45,
  hit: "Hit_Chest",
  hit2: "Hit_Head",
  death: "Death01",
  dodgeBack: "DodgeBack",
  dodgeLeft: "DodgeLeft",
  dodgeRight: "DodgeRight",
  combo: [
    // Sword_Attack from its wind-up's end (0.25 s), at 1.4x: contact lands 0.2 s after the press
    { clip: "Sword_Attack", from: 0.25, speed: 1.4, hit: [0.12, 0.28], lunge: [0.06, 0.22], chain: 0.26, len: 0.92, dmg: 30, lungeV: 3.2 },
    // round 2's hand-keyed backhand, from the first cut's follow-through
    { clip: "Slash2", speed: 1.35, hit: [6 / 30 / 1.35, 11 / 30 / 1.35], lunge: [4 / 30 / 1.35, 9 / 30 / 1.35], chain: 99, len: 30 / 30 / 1.35, dmg: 38, lungeV: 3.6 },
  ],
};
if (DEV) {
  Object.assign(HERO_CLIPS, { idle: "Idle", walk: "Walk", jog: "Jog", sprint: "Sprint", hit: "Hit", hit2: "Hit2", death: "Death", rollSpeed: 1.55 });
  HERO_CLIPS.combo[0] = { clip: "Slash", speed: 1.3, hit: [9 / 39, 14 / 39], lunge: [6 / 39, 12 / 39], chain: 13 / 39, len: 30 / 39, dmg: 30, lungeV: 3.2 };
}
const BANDIT_CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  jog: "Jog_Fwd_Loop",
  hit: "Hit_Chest",
  hit2: "Hit_Head",
  death: "Death01",
  // the same cut, slower: a 0.4 s readable wind-up, tracking until 0.45 s of clip time, then committed
  attack: { clip: "Sword_Attack", from: 0.1, speed: 1.0, track: 0.42, lunge: [0.45, 0.62], hit: [0.5, 0.68], len: 1.25 },
};
if (DEV) Object.assign(BANDIT_CLIPS, { idle: "Idle", walk: "Walk", jog: "Jog", hit: "Hit", hit2: "Hit2", death: "Death", attack: { clip: "Slash", from: 0, speed: 1, track: 6 / 30, lunge: [7 / 30, 11 / 30], hit: [9 / 30, 13 / 30], len: 22 / 30 } });
const POSTS = [
  { x: 1.0, z: 8.5, hp: 85, name: "Bandit" },
  { x: 4.5, z: 13.5, hp: 70, name: "Bandit" },
  { x: 0.6, z: -8.5, hp: 85, name: "Bandit" },
  { x: -2.0, z: -11.0, hp: 70, name: "Bandit" },
  { x: 0.0, z: -38.5, hp: 130, name: "Bandit captain", scale: 1.08, dmg: 28 },
];

let shared = null; // the world, the pipeline and the title, built once
let run = null; // this run's bodies

const rimmed = new WeakSet();
const rimUniforms = { rimDir: { value: new THREE.Vector3() }, rimCol: { value: SUN_COLOR.clone().multiplyScalar(1.4) } };
/** A warm rim on a character where its silhouette faces the low sun, plus a hurt flash. */
function characterLook(root, flash = null) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false; // skinned: its bounds do not follow the clips
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = mats.map((m) => {
      if (flash === null && rimmed.has(m)) return m;
      const c = flash === null ? m : m.clone();
      rimmed.add(c);
      const own = c.onBeforeCompile;
      c.onBeforeCompile = function (shader, r) {
        own?.call(this, shader, r);
        Object.assign(shader.uniforms, rimUniforms);
        shader.uniforms.hurt = flash ?? { value: 0 };
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform vec3 rimDir;\nuniform vec3 rimCol;\nuniform float hurt;")
          .replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
  {
    vec3 Vv = normalize(vViewPosition);
    float fr = pow(1.0 - clamp(dot(normal, -Vv), 0.0, 1.0), 3.0);
    float toward = clamp(dot(normal, rimDir) * 0.5 + 0.5, 0.0, 1.0);
    totalEmissiveRadiance += rimCol * fr * (0.12 + 0.9 * toward * toward) * diffuseColor.rgb * 2.2;
    totalEmissiveRadiance += vec3(0.5, 0.04, 0.01) * hurt * (0.03 + fr * 0.7);
  }`,
          );
      };
      c.customProgramCacheKey = () => `char:${m.uuid.slice(0, 4)}:${m.map ? 1 : 0}`;
      return c;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
}

function sceneFor(target, s) {
  target.add(s.world, s.grass.group, s.pipeline.shadowParent, ...s.fx.objects);
  target.environment = s.env;
  target.fog = Q.has("nofog") ? null : s.fog;
  target.environmentIntensity = 0.5;
}

/** Built once, behind the loading bar: the world, the light, the post chain, every shader. */
export async function prepare({ renderer, assets, progress }) {
  const t0 = performance.now();
  progress(0.05);
  setAnisotropy(renderer.capabilities.getMaxAnisotropy());
  buildGrid();
  progress(0.2);
  const models = {};
  for (const name of ["gate", "temple", "lantern", "lion", "pine_0", "pine_1", "pine_2", "tree_0", "tree_1", "tree_2", "boulder_02", "rock_moss", "pebble"])
    models[name] = assets.gltf(name).scene;
  const world = buildWorld(models);
  progress(0.35);
  const grass = buildGrass({ density: Q.has("grass") ? Number(Q.get("grass")) : 1 });
  progress(0.5);
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1500);
  const pipeline = createPipeline(renderer, camera, { quality: 2 });
  pipeline.prepare(world);
  pipeline.prepare(grass.group);
  // the static world's sun shadow, once, over the whole play area
  pipeline.shadows.bake(world, new THREE.Box3(new THREE.Vector3(-80, -8, -88), new THREE.Vector3(80, 36, 56)));
  const fx = createFx();

  // the environment light: the painted sky itself, prefiltered once
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  skyScene.add(world.getObjectByName("sky").clone(), world.getObjectByName("sky_far").parent.clone());
  const env = pmrem.fromScene(skyScene, 0.02, 0.5, 1200).texture;
  pmrem.dispose();

  // the title: the live valley, the hero and a bandit standing on the path
  const title = new THREE.Scene();
  const titleHero = animate(assets.model("hero"));
  const titleBandit = animate(assets.model("bandit"));
  characterLook(titleHero.root);
  characterLook(titleBandit.root, { value: 0 });
  pipeline.prepare(titleHero.root);
  pipeline.prepare(titleBandit.root);
  titleHero.root.position.set(-3.4, groundAt(-3.4, 22.5), 22.5);
  titleHero.root.rotation.y = Math.PI + 0.35;
  titleBandit.root.position.set(1.2, groundAt(1.2, 13), 13);
  titleBandit.root.rotation.y = 0.2;
  const fog = makeFog();
  shared = { fog, world, grass, pipeline, camera, fx, env, title, titleHero, titleBandit, t: 0, frames: [], scaleWait: 0, renderer };
  sceneFor(title, shared);
  title.add(titleHero.root, titleBandit.root);
  progress(0.65);

  // compile every program the run will use, then draw a few frames so the post chain's own
  // programs and the shadow maps exist before the title shows
  placeTitleCamera(0);
  await renderer.compileAsync(title, camera);
  progress(0.85);
  for (let i = 0; i < 3; i++) {
    shared.grass.update(camera);
    pipeline.render(title, 1 / 60);
  }
  // a frame from the start of the path too, where the run's camera opens
  camera.position.set(0, groundAt(0, 40) + 2.2, 40.5);
  camera.lookAt(0, groundAt(0, 30) + 1.5, 30);
  pipeline.render(title, 1 / 60);
  progress(1);
  pipeline.setScale(pipeline.scale);
  placeTitleCamera(0);
  await calibrate(title);
  shared.prepareMs = Math.round(performance.now() - t0);
  console.info(`hill-temple: prepared in ${shared.prepareMs} ms; grass ${grass.count} clumps`);
  window.__hill = {
    shared,
    get run() {
      return run;
    },
    GameState,
    /** Frames the hero at (x, z) facing (fx, fz), the camera settled behind him (for comparison shots). */
    pose(x, z, fx, fz, turn = 0) {
      if (run === null) return false;
      const h = run.hero;
      h.pos.set(x, groundAt(x, z), z);
      h.vel.set(0, 0, 0);
      h.face(new THREE.Vector3(fx - x, 0, fz - z));
      h.root.rotation.y = h.facing + Math.PI;
      run.cam.snap(h.pos, h.facing + turn);
      // a held camera and an untouchable hero, so the shot is the framing asked for
      run.cam.state.override = { yaw: h.facing + turn, pitch: THREE.MathUtils.degToRad(-13), arm: 4.3 };
      h.invulnerable = true;
      return true;
    },
  };
}

function placeTitleCamera(t) {
  const k = Math.sin(t * 0.05) * 0.5 + 0.5;
  const x = -9 + 5 * k;
  const z = 34 - 6 * k;
  shared.camera.position.set(x, groundAt(x, z) + 2.2, z);
  shared.camera.lookAt(0, PLATEAU_H + 3, -45);
}

const Q = new URLSearchParams(location.search);
/**
 * Every frame: the render scale follows the GPU's own time per frame (timer queries) when the
 * browser gives it, else the frame time: down a step when a frame costs more than ~15 ms, up
 * a step when it costs under ~10 ms, never below 0.6 of 1080p's pixels per side.
 */
function adapt(real) {
  const s = shared;
  if (real <= 0 || real > 0.25 || Q.has("fixed")) return;
  s.frames.push(real);
  s.scaleWait = Math.max(0, s.scaleWait - real);
  if (s.frames.length < 90) return;
  const frameMs = s.frames.slice().sort((a, b) => a - b)[s.frames.length >> 1] * 1000;
  s.frames.length = 0;
  const gpu = s.pipeline.gpuMs.slice(-90).sort((a, b) => a - b);
  const gpuMs = gpu.length > 30 ? gpu[gpu.length >> 1] : null;
  if (s.scaleWait > 0) return;
  const scale = s.pipeline.scale;
  const heavy = gpuMs !== null ? gpuMs > 15 : frameMs > 19;
  const light = gpuMs !== null ? gpuMs < 10 : false;
  if (heavy && scale > 0.6) {
    s.pipeline.setScale(Math.max(0.6, +(scale - 0.08).toFixed(2)));
    s.scaleWait = 2;
  } else if (light && scale < 1) {
    s.pipeline.setScale(Math.min(1, +(scale + 0.08).toFixed(2)));
    s.scaleWait = 4;
  }
}

/** Before the title: a few timed frames pick the starting scale, so play does not open slow. */
async function calibrate(scene) {
  const s = shared;
  if (Q.has("fixed") || Q.has("scale")) return;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  s.pipeline.gpuMs.length = 0;
  for (let i = 0; i < 24; i++) {
    s.pipeline.render(scene, 1 / 60);
    await frame();
  }
  const g = s.pipeline.gpuMs.slice().sort((a, b) => a - b);
  if (g.length < 6) return;
  const ms = g[g.length >> 1];
  // fragment work scales with the pixel count: aim at 13 ms
  const scale = Math.min(1, Math.max(0.6, Math.sqrt(13 / ms)));
  s.pipeline.setScale(+scale.toFixed(2));
  s.calibrated = { gpuMs: +ms.toFixed(2), scale: +scale.toFixed(2) };
  console.info(`hill-temple: calibrated at ${ms.toFixed(1)} ms GPU per frame: render scale ${scale.toFixed(2)}`);
}

const sunView = new THREE.Vector3();
function frameCommon(dt, scene) {
  const s = shared;
  s.t += dt;
  grassUniforms.time.value = s.t;
  s.world.getObjectByName("sky").material.uniforms.time.value = s.t;
  s.grass.update(s.camera);
  sunView.copy(SUN_DIR).transformDirection(s.camera.matrixWorldInverse);
  rimUniforms.rimDir.value.copy(sunView);
  s.fx.update(dt, s.camera);
  s.pipeline.render(scene, dt);
}

export function title(real) {
  if (shared === null) return;
  placeTitleCamera(shared.t);
  shared.pipeline.followAt.copy(shared.titleHero.root.position);
  shared.titleHero.mixer.update(real);
  shared.titleBandit.mixer.update(real);
  if (Math.random() < 0.5) shared.fx.motes(new THREE.Vector3(-4, groundAt(-4, 26), 26));
  adapt(real);
  frameCommon(real, shared.title);
}

export function render(ctx, real) {
  adapt(real);
  frameCommon(run?.dt ?? real * (window.__timeScale ?? 1), ctx.scene);
}

export function resize() {
  shared?.pipeline.resize();
}

export function start(ctx) {
  const s = shared;
  ctx.camera = s.camera;
  s.title.remove(s.titleHero.root, s.titleBandit.root);
  sceneFor(ctx.scene, s);
  s.fx.clear();
  const sounds = createSounds();
  const heroAnim = animate(ctx.assets.model("hero"));
  characterLook(heroAnim.root);
  s.pipeline.prepare(heroAnim.root);
  const start = path[0];
  heroAnim.root.position.set(start.x, groundAt(start.x, start.z + 0), start.z - 2);
  ctx.scene.add(heroAnim.root);
  ctx.player = heroAnim.root;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  // the attack token: free when no bandit is in an attack and the last one ended 0.6 s ago
  const token = {
    holder: null,
    gap: 0,
    tick(dt) {
      if (this.holder !== null && this.holder.state !== "attack") {
        this.holder = null;
        this.gap = 0.6;
      }
      this.gap = Math.max(0, this.gap - dt);
    },
    take(body) {
      if (this.holder !== null || this.gap > 0) return false;
      this.holder = body;
      return true;
    },
  };
  const r = { ctx, sounds, token, dt: 0, bandits: [], engaged: null, hurtCooldown: 0, ended: false, started: performance.now() };
  run = r;
  const hero = createHero(
    heroAnim,
    {
      swing: (n) => sounds.swing(n),
      hit: (n) => {
        Juice.hitPause(n === 0 ? 0.075 : 0.1, 0.06);
        Juice.shake(n === 0 ? 0.32 : 0.45);
        sounds.hit(n);
      },
      step: () => {
        sounds.dodge();
        s.fx.dust(hero.pos.clone(), 6, 0.5);
      },
      roll: () => sounds.roll(),
      land: () => s.fx.dust(hero.pos.clone(), 12, 0.8),
      footstep: (speed) => {
        sounds.footstep(speed, hero.pos.y > PLATEAU_H - 0.5 || isOnStairs(hero.pos));
        if (speed > 4.5) s.fx.dust(hero.pos.clone(), 2, 0.4);
      },
      hurt: (dmg) => {
        Juice.flashScreen("#8a1a10");
        Juice.shake(0.5);
        Juice.hitPause(0.08, 0.08);
        sounds.hurt();
        bladeEnds(hero, tmpA, tmpB);
        s.fx.hit(hero.pos.clone().add(new THREE.Vector3(0, 1.25, 0)), new THREE.Vector3(0, 0.3, 0), false);
        GameState.hp = Math.round(hero.hp);
      },
      died: () => {
        GameState.hp = 0;
        sounds.death();
        ctx.after(1.6, () => GameState.lose("Fallen", stats()));
      },
    },
    HERO_CLIPS,
  );
  hero.facing = 0;
  r.hero = hero;
  for (const post of POSTS) {
    const a = animate(ctx.assets.model("bandit"));
    const flash = { value: 0 };
    characterLook(a.root, flash);
    s.pipeline.prepare(a.root);
    a.root.scale.setScalar(post.scale ?? 1);
    a.root.position.set(post.x, groundAt(post.x, post.z), post.z);
    ctx.scene.add(a.root);
    const b = createBandit(
      a,
      {
        aggro: () => sounds.aggro(),
        windup: () => sounds.windup(),
        hurt: (body, dir) => {
          s.fx.hit(body.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), dir, false);
        },
        died: (body, dir) => {
          s.fx.hit(body.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), dir, true);
          ctx.after(0.9, () => s.fx.dust(body.pos.clone(), 16, 1));
          sounds.fall();
          GameState.cut_down += 1;
          GameState.bandits_left = r.bandits.filter((x) => x.alive()).length;
          ctx.ui.toast(GameState.bandits_left === 0 ? "The path is clear" : `${body.name} cut down`);
        },
      },
      BANDIT_CLIPS,
      { hp: post.hp, dmg: post.dmg, name: post.name },
    );
    b.facing = Math.PI; // facing down the path, toward whoever climbs it
    b.flash = flash;
    r.bandits.push(b);
  }
  r.cam = createThirdPerson(s.camera);
  r.cam.snap(hero.pos, hero.facing);
  r.cam.update(1 / 60, hero.pos, { facing: hero.facing });
  // enemy health bars over the engaged bandits (DOM, positioned by projection)
  r.bars = r.bandits.map(() => {
    const el = document.createElement("div");
    el.className = "foe-bar";
    el.innerHTML = "<i></i>";
    el.hidden = true;
    ctx.hud.append(el);
    return el;
  });
  ctx.listen(ctx.canvas, "contextmenu", (e) => e.preventDefault());
  ctx.listen(ctx.canvas, "click", () => {
    if (document.pointerLockElement === null && !r.autopilot) ctx.canvas.requestPointerLock?.()?.catch?.(() => undefined);
  });
  sounds.ambience();
  playMusic("./assets/music/hill_temple.ogg");
  GameState.hp = 100;
  GameState.bandits_left = r.bandits.length;
  r.autopilot = new URLSearchParams(location.search).has("autopilot") ? createAutopilot(r, ctx) : null;
}

const isOnStairs = (p) => p.z < STAIR_A.z + 0.5 && p.z > -34.5 && Math.abs(p.x) < 2.1;
function stats() {
  const secs = Math.round(GameState.seconds);
  return {
    Time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
    "Bandits cut down": `${GameState.cut_down} of ${run?.bandits.length ?? 5}`,
    Health: `${GameState.hp}`,
  };
}

const _proj = new THREE.Vector3();
export function update(dt, ctx) {
  const r = run;
  const s = shared;
  if (r === null) return;
  r.dt = dt;
  GameState.seconds += dt;
  const hero = r.hero;
  const input = ctx.input;
  let wish = new THREE.Vector3();
  let flags = { sprint: input.down("sprint"), walk: false };
  if (r.autopilot !== null) {
    const auto = r.autopilot.update(dt);
    wish = auto.wish;
    flags = auto.flags;
  } else if (hero.alive()) {
    const v = input.vector();
    const yaw = r.cam.yaw;
    // the stick turned to the view: forward is away from the camera
    wish.set(Math.cos(yaw) * v.x + Math.sin(yaw) * v.y, 0, -Math.sin(yaw) * v.x + Math.cos(yaw) * v.y);
    if (input.pressed("action")) hero.requestAttack();
    if (input.pressed("dodge")) hero.requestStep();
    if (input.pressed("roll")) hero.requestRoll();
  }
  const living = r.bandits.filter((b) => b.alive());
  hero.update(dt, wish, flags, living);
  r.token.tick(dt);
  for (const b of r.bandits) {
    b.update(dt, hero, r.token);
    b.flash.value = b.hurtFlash;
  }
  GameState.hp = Math.round(hero.hp);

  // the engaged foe: the nearest living bandit that has noticed the hero
  r.engaged = null;
  let best = 9;
  for (const b of living) {
    const d = b.pos.distanceTo(hero.pos);
    if (b.state !== "idle" && d < best) {
      best = d;
      r.engaged = b;
    }
  }
  const mouse = ctx.mouse.movement;
  const stickX = input.axis("look_left", "look_right");
  const stickY = input.axis("look_up", "look_down");
  const free = window.__hill?.freeCam;
  if (free) {
    s.camera.position.fromArray(free.p);
    s.camera.lookAt(new THREE.Vector3().fromArray(free.l));
  } else r.cam.update(dt, hero.pos, {
    lookX: r.autopilot ? 0 : mouse.x * 0.0035 + stickX * 2.4 * dt,
    lookY: r.autopilot ? 0 : mouse.y * 0.0028 + stickY * 1.6 * dt,
    moving: hero.vel.length() > 0.5,
    facing: hero.facing,
    foe: r.engaged?.pos ?? null,
  });

  // the blade's trail through each cut
  const base = new THREE.Vector3();
  const tip = new THREE.Vector3();
  if (bladeEnds(hero, base, tip)) s.fx.blade(base, tip, hero.state === "attack" && hero.t < 0.45);
  grassUniforms.pushers.value[0].set(hero.pos.x, hero.pos.y, hero.pos.z, 0.9);
  living.slice(0, 2).forEach((b, i) => grassUniforms.pushers.value[i + 1].set(b.pos.x, b.pos.y, b.pos.z, 0.8));
  for (let i = living.length + 1; i < 3; i++) grassUniforms.pushers.value[i].w = 0;
  if (Math.random() < 0.6) s.fx.motes(hero.pos);
  s.pipeline.followAt.copy(hero.pos).addScaledVector(hero.forward(new THREE.Vector3()), 3);

  // HUD
  ctx.ui.bar("Health", GameState.hp, 100);
  const left = living.length;
  GameState.bandits_left = left;
  GameState.zone = hero.pos.y > PLATEAU_H - 1 ? "temple" : isOnStairs(hero.pos) ? "stairs" : "path";
  ctx.ui.objective(left > 0 ? `Reach the hill temple · bandits on the path: ${left}` : "The path is clear. Climb to the temple.");
  ctx.ui.hint("{action} strike · twice for the combo", { until: () => GameState.cut_down > 0 || hero.combo > 0 });
  ctx.ui.hint("{dodge} dodge step · {roll} roll", { until: () => hero.state === "step" || hero.state === "roll" });
  r.bandits.forEach((b, i) => {
    const el = r.bars[i];
    const show = b.alive() && b.state !== "idle" && b.pos.distanceTo(hero.pos) < 14;
    el.hidden = !show;
    if (!show) return;
    _proj.copy(b.pos).add(new THREE.Vector3(0, 2.15 * (b.root.scale.y || 1), 0)).project(s.camera);
    if (_proj.z > 1) {
      el.hidden = true;
      return;
    }
    el.style.transform = `translate(${((_proj.x + 1) / 2) * innerWidth}px, ${((1 - _proj.y) / 2) * innerHeight}px)`;
    el.firstChild.style.width = `${(b.hp / b.maxHp) * 100}%`;
  });

  // the end: all three cut down and the hero at the temple's court
  if (!r.ended && left === 0 && hero.pos.y > PLATEAU_H - 1 && hero.pos.z < -36 && hero.alive()) {
    r.ended = true;
    r.sounds.win();
    GameState.win("The temple is reached", stats());
  }
}

export function stop(ctx) {
  const s = shared;
  // the world outlives the run: take it out before the shell disposes the run's scene
  ctx.scene.remove(s.world, s.grass.group, s.pipeline.shadowParent, ...s.fx.objects);
  ctx.scene.environment = null;
  ctx.scene.fog = null;
  run?.sounds.stop();
  for (const b of run?.bandits ?? []) ctx.scene.remove(b.root);
  if (run?.hero) ctx.scene.remove(run.hero.root);
  s.title.add(s.titleHero.root, s.titleBandit.root);
  sceneFor(s.title, s);
  run = null;
}

/** The studio's reach: teleport the hero (`hero` {x, z}) or settle the fights (`bandits` {left}). */
export function setState(target, values, ctx) {
  if (ctx === null || run === null) return false;
  if (target === "hero" && typeof values.x === "number" && typeof values.z === "number") {
    run.hero.pos.set(values.x, groundAt(values.x, values.z), values.z);
    return true;
  }
  if (target === "bandits" && values.left === 0) {
    for (const b of run.bandits) if (b.alive()) b.hit(new THREE.Vector3(0, 0, 1), 999);
    return true;
  }
  return false;
}
