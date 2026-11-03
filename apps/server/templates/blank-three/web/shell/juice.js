// Game feel, one call each. Every player action wants an answer the player can
// see and hear; overlapping calls combine instead of fighting, everything runs
// on game time (it freezes on pause) except pop on a DOM element and
// flashScreen, which run on real time, and nothing here can leave the game stuck.
//
//   import { Juice } from "./shell/juice.js";
//   Juice.shake(0.4);                         // camera shake: trauma 0..1 adds up, decays
//   Juice.hitPause();                         // ~60 ms time dip on a hit; never longer than 0.3 s
//   Juice.pop(mesh);                          // quick scale-up and settle (pickups, hits); a DOM element works too
//   Juice.squash(mesh);                       // wide-and-short, springs back (jumps, landings)
//   Juice.flash(mesh);                        // flash white (or a color), fades back
//   Juice.flashScreen("#ff3b30");             // whole-screen flash (taking damage)
//   Juice.burst(mesh.position, 0xffaa33);     // one-shot particles at a point
//   Juice.sfx("./assets/sfx/hit.wav");        // pooled one-shot on the sfx volume, slight pitch jitter
//
// A hit, all together:
//   Juice.shake(0.3); Juice.hitPause(); Juice.flash(enemy);
//   Juice.burst(enemy.position); Juice.sfx("./assets/sfx/hit.wav");
//
// The shell shakes whatever camera it renders (ctx.camera) by moving it just
// for the draw, so the game's own camera code keeps working. pop and squash
// animate `scale` from what it was when called. flash swaps in a copy of each
// mesh's material for the flash, so a material shared with other meshes does
// not flash them too. Bursts spawn in the run's scene and go with it.
import * as THREE from "../vendor/three.module.js";
import { GameState } from "./run-state.js";
import { playSfx } from "./audio.js";

const MAX_HIT_PAUSE_S = 0.3;
const MAX_FLASH_MESHES = 32;
const MAX_BURSTS = 48;

let trauma = 0;
let shakeTime = 0;
const shakeApplied = new THREE.Vector2();
let hitUntil = 0;
let hitScale = 1;
let tweens = [];
let bursts = [];
const scaleTweens = new WeakMap();
const flashes = new WeakMap();

export const Juice = {
  /** Camera offset at full trauma, in world units. */
  shakeUnits: 0.3,
  /** Trauma lost per second. */
  shakeDecay: 1.6,
  /** Where bursts spawn by default; the shell points it at the run's scene. */
  stage: null,

  shake(amount = 0.4) {
    trauma = Math.min(1, Math.max(0, trauma + amount));
  },

  hitPause(seconds = 0.06, timeScale = 0.05) {
    if (GameState.state !== "playing") return;
    const until = performance.now() + Math.min(Math.max(seconds, 0), MAX_HIT_PAUSE_S) * 1000;
    hitUntil = Math.max(hitUntil, until);
    hitScale = Math.min(hitScale, timeScale);
  },

  pop(target, amount = 0.25, seconds = 0.2) {
    if (target instanceof Element) {
      target.animate(
        [
          { transform: "scale(1)" },
          { transform: `scale(${1 + amount})` },
          { transform: "scale(1)" },
        ],
        { duration: seconds * 1000, easing: "ease-out" },
      );
      return;
    }
    scaleTween(target, seconds, (base, k) => {
      const up = k < 0.35 ? easeOutQuad(k / 0.35) : 1 - easeOutBack((k - 0.35) / 0.65);
      return base.clone().multiplyScalar(1 + amount * up);
    });
  },

  squash(target, amount = 0.3, seconds = 0.25) {
    scaleTween(target, seconds, (base, k) => {
      const s = k < 0.3 ? easeOutQuad(k / 0.3) : 1 - easeOutElastic((k - 0.3) / 0.7);
      return new THREE.Vector3(
        base.x * (1 + amount * s),
        base.y * (1 - amount * s),
        base.z * (1 + amount * s),
      );
    });
  },

  flash(object, color = 0xffffff, seconds = 0.12) {
    if (!(object instanceof THREE.Object3D)) return;
    flashes.get(object)?.finish();
    const tint = new THREE.Color(color);
    const swaps = [];
    object.traverse((mesh) => {
      if (swaps.length >= MAX_FLASH_MESHES || !mesh.isMesh || mesh.material == null) return;
      const original = mesh.material;
      const list = Array.isArray(original) ? original : [original];
      // A mesh already flashing (a child flashed on its own) keeps that flash.
      if (list.some((m) => m.userData.juiceFlash === true)) return;
      const copies = list.map((m) => {
        const copy = m.clone();
        copy.userData.juiceFlash = true;
        return copy;
      });
      mesh.material = Array.isArray(original) ? copies : copies[0];
      swaps.push({ mesh, original, copies });
    });
    if (swaps.length === 0) return;
    const set = (k) => {
      for (const { original, copies } of swaps)
        copies.forEach((copy, i) => {
          const from = Array.isArray(original) ? original[i] : original;
          if (copy.emissive !== undefined) {
            copy.emissive.lerpColors(from.emissive, tint, k);
            copy.emissiveIntensity = THREE.MathUtils.lerp(
              from.emissiveIntensity,
              Math.max(1, from.emissiveIntensity),
              k,
            );
          } else if (copy.color !== undefined) copy.color.lerpColors(from.color, tint, k);
        });
    };
    set(1);
    const tween = addTween(
      seconds,
      (k) => set(1 - k),
      () => {
        flashes.delete(object);
        for (const { mesh, original, copies } of swaps) {
          const current = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          if (current === copies[0]) mesh.material = original;
          for (const copy of copies) copy.dispose();
        }
      },
    );
    flashes.set(object, tween);
  },

  flashScreen(color = "#ffffff", seconds = 0.15, opacity = 0.55) {
    let layer = document.getElementById("flash");
    if (layer === null) {
      layer = document.createElement("div");
      layer.id = "flash";
      document.body.append(layer);
    }
    layer.style.background = color;
    layer.animate([{ opacity }, { opacity: 0 }], { duration: seconds * 1000, easing: "ease-out" });
  },

  burst(position, color = 0xffffff, count = 16, parent = null) {
    const into = parent ?? Juice.stage;
    if (into === null || position == null) return;
    const n = Math.min(Math.max(1, Math.floor(count)), 256);
    const at = new Float32Array(n * 3);
    const velocity = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const dir = new THREE.Vector3().randomDirection();
      dir.y = Math.abs(dir.y) * 0.8 + 0.2;
      dir.multiplyScalar(THREE.MathUtils.randFloat(2, 5));
      velocity.set([dir.x, dir.y, dir.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(at, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: 0.2,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.position.set(position.x, position.y, position.z);
    points.frustumCulled = false;
    into.add(points);
    if (bursts.length >= MAX_BURSTS) bursts.shift().finish();
    const life = 0.6;
    const tween = addTween(
      life,
      (k) => {
        const t = k * life;
        for (let i = 0; i < n; i += 1) {
          at[i * 3] = velocity[i * 3] * t;
          at[i * 3 + 1] = velocity[i * 3 + 1] * t - 4.5 * t * t;
          at[i * 3 + 2] = velocity[i * 3 + 2] * t;
        }
        geometry.attributes.position.needsUpdate = true;
        material.opacity = 1 - k * k;
      },
      () => {
        points.removeFromParent();
        geometry.dispose();
        material.dispose();
        bursts = bursts.filter((each) => each !== tween);
      },
    );
    bursts.push(tween);
  },

  sfx(sound, { volume = 1, pitch = 0.08 } = {}) {
    playSfx(sound, { volume, pitch });
  },
};

function addTween(seconds, step, done) {
  const tween = {
    t: 0,
    duration: Math.max(seconds, 0.001),
    over: false,
    step,
    finish() {
      if (tween.over) return;
      tween.over = true;
      step(1);
      done?.();
    },
  };
  step(0);
  tweens.push(tween);
  return tween;
}

function scaleTween(target, seconds, scaleAt) {
  if (!(target instanceof THREE.Object3D)) return;
  scaleTweens.get(target)?.finish();
  const base = target.scale.clone();
  const tween = addTween(
    seconds,
    (k) => target.scale.copy(k >= 1 ? base : scaleAt(base, k)),
    () => scaleTweens.delete(target),
  );
  scaleTweens.set(target, tween);
}

const easeOutQuad = (k) => 1 - (1 - k) * (1 - k);
const easeOutBack = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const easeOutElastic = (k) =>
  k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;

const wobble = (seed, t) =>
  Math.sin(t * 1.9 + seed) * 0.5 +
  Math.sin(t * 3.7 + seed * 2.3) * 0.3 +
  Math.sin(t * 7.1 + seed * 4.1) * 0.2;

// The shell's side: game-time ticks, the hit-pause time scale, the shake
// around each draw and the reset between runs.
export const juiceShell = {
  /** The time scale a hit pause asks for now; ends on its own in real time. */
  timeScale() {
    if (hitUntil === 0) return 1;
    if (performance.now() < hitUntil && GameState.state === "playing") return hitScale;
    hitUntil = 0;
    hitScale = 1;
    return 1;
  },

  update(dt) {
    trauma = Math.max(0, trauma - Juice.shakeDecay * dt);
    shakeTime += dt;
    const active = tweens;
    tweens = [];
    for (const tween of active) {
      if (tween.over) continue;
      tween.t += dt;
      if (tween.t >= tween.duration) tween.finish();
      else {
        tween.step(tween.t / tween.duration);
        tweens.push(tween);
      }
    }
  },

  beforeRender(camera) {
    const strength = trauma * trauma * Juice.shakeUnits;
    shakeApplied.set(wobble(11, shakeTime * 9) * strength, wobble(73, shakeTime * 9) * strength);
    if (shakeApplied.x === 0 && shakeApplied.y === 0) return;
    camera.translateX(shakeApplied.x);
    camera.translateY(shakeApplied.y);
    camera.updateMatrixWorld();
  },

  afterRender(camera) {
    if (shakeApplied.x === 0 && shakeApplied.y === 0) return;
    camera.translateX(-shakeApplied.x);
    camera.translateY(-shakeApplied.y);
    camera.updateMatrixWorld();
    shakeApplied.set(0, 0);
  },

  endHitPause() {
    hitUntil = 0;
    hitScale = 1;
  },

  /** Between runs: still camera, no hit pause, every tween and burst finished. */
  reset() {
    trauma = 0;
    juiceShell.endHitPause();
    for (const tween of tweens) tween.finish();
    tweens = [];
    bursts = [];
  },
};
