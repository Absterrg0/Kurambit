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
// For a fight, particles from one pooled system (every kind in one draw call),
// on game time, so a hit pause holds them too:
//   Juice.sparks(at, away);                   // bright sparks off steel; away: the hit's direction
//   Juice.blood(at, away);                    // dark drops that fall
//   Juice.dust(at, { count: 12 });            // a puff where feet strike or a body lands
//   Juice.emit(at, { count: 20, color: 0x88ccff, speed: [1, 4], life: [0.3, 0.8],
//                    size: [0.06, 0], gravity: 2, drag: 1, additive: true }); // your own kind
// and a weapon trail, measured from the weapon in a hand (a skinned blade or a
// sword mesh held under that bone), drawn while on and fading after:
//   const trail = Juice.trail(hero.root, { bone: "hand_r" }); // or { tip: {x, y, z} } in the bone's frame
//   trail.on = hero.state === "attack";       // every frame
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
const MAX_PARTICLES = 1500;
const TRAIL_SAMPLES = 14;
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

  emit(at, options = {}) {
    particles().emit(at, options);
  },

  sparks(at, away = null, { count = 24 } = {}) {
    particles().emit(at, {
      count,
      color: new THREE.Color(4, 2.2, 0.9),
      speed: [4, 10],
      life: [0.18, 0.4],
      size: [0.035, 0],
      gravity: 14,
      drag: 2.5,
      direction: away,
      bias: 0.9,
      additive: true,
    });
  },

  blood(at, away = null, { count = 16 } = {}) {
    particles().emit(at, {
      count,
      color: new THREE.Color(0.16, 0.012, 0.008),
      speed: [1.5, 4.5],
      life: [0.4, 0.8],
      size: [0.05, 0.03],
      gravity: 9.8,
      drag: 1,
      direction: away,
      bias: 1.3,
      lift: 0.6,
      additive: false,
    });
  },

  dust(at, { count = 10, spread = 0.6, color = 0x4d3a26 } = {}) {
    particles().emit(at, {
      count,
      color,
      speed: [0.4 * spread * 2, 1.2 * spread * 2],
      life: [0.6, 1.3],
      size: [0.12, 0.4],
      gravity: -0.15,
      drag: 2.2,
      lift: 0.35,
      flat: true,
      alpha: 0.22,
      additive: false,
    });
  },

  trail(root, { bone = "hand_r", tip = null, color = 0xffd9a8, strength = 0.3 } = {}) {
    const trail = makeTrail(root, bone, tip, color, strength);
    trails.add(trail);
    return trail;
  },
};

// ── One pooled particle system: positions and colours on the CPU, every kind in
// one THREE.Points with premultiplied blending (an additive spark adds light, a
// dusty one covers).
let pool = null;
function particles() {
  if (pool === null) pool = makePool();
  if (Juice.stage !== null && pool.points.parent !== Juice.stage) Juice.stage.add(pool.points);
  return pool;
}

const rand = (range, fallback) =>
  Array.isArray(range) ? range[0] + Math.random() * (range[1] - range[0]) : (range ?? fallback);

function makePool() {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(MAX_PARTICLES * 3);
  const colour = new Float32Array(MAX_PARTICLES * 4);
  const size = new Float32Array(MAX_PARTICLES);
  const dynamic = (array, n) =>
    new THREE.BufferAttribute(array, n).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", dynamic(position, 3));
  geometry.setAttribute("colour", dynamic(colour, 4));
  geometry.setAttribute("size", dynamic(size, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { viewHeight: { value: 540 } },
    vertexShader: /* glsl */ `
      attribute vec4 colour;
      attribute float size;
      uniform float viewHeight;
      varying vec4 vColour;
      void main() {
        vColour = colour;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = size * projectionMatrix[ 1 ][ 1 ] * viewHeight / max( - mv.z, 0.1 );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColour;
      void main() {
        float a = smoothstep( 0.5, 0.15, length( gl_PointCoord - 0.5 ) );
        gl_FragColor = vec4( vColour.rgb * a, vColour.a * a );
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  points.name = "juice particles";
  const live = Array.from({ length: MAX_PARTICLES }, () => ({
    life: 0,
    max: 1,
    p: new THREE.Vector3(),
    v: new THREE.Vector3(),
    c: new THREE.Color(),
    a: 1,
    add: true,
    s0: 0.05,
    s1: 0,
    g: 0,
    drag: 0,
  }));
  let next = 0;
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  return {
    points,
    emit(at, o) {
      if (at == null) return;
      if (at.isObject3D === true) at.getWorldPosition(from);
      else from.set(at.x, at.y, at.z);
      const color = o.color?.isColor === true ? o.color : new THREE.Color(o.color ?? 0xffffff);
      const count = Math.min(Math.max(1, Math.floor(o.count ?? 16)), 256);
      for (let i = 0; i < count; i += 1) {
        const q = live[next];
        next = (next + 1) % MAX_PARTICLES;
        dir.set(
          Math.random() * 2 - 1,
          Math.random() * (o.lift ?? 1.2) - 0.2,
          Math.random() * 2 - 1,
        );
        if (o.flat === true) dir.y = Math.abs(dir.y) * 0.5 + 0.1;
        dir.normalize();
        if (o.direction != null) dir.addScaledVector(o.direction, o.bias ?? 1).normalize();
        q.life = q.max = rand(o.life, 0.6);
        q.p.copy(from);
        if (o.flat === true) q.p.x += (Math.random() - 0.5) * 0.4;
        if (o.flat === true) q.p.z += (Math.random() - 0.5) * 0.4;
        q.v.copy(dir).multiplyScalar(rand(o.speed, 3));
        q.c.copy(color);
        q.a = o.alpha ?? 1;
        q.add = o.additive !== false;
        q.s0 = Array.isArray(o.size) ? o.size[0] : (o.size ?? 0.05);
        q.s1 = Array.isArray(o.size) ? o.size[1] : (o.size ?? 0.05);
        q.g = o.gravity ?? 9.8;
        q.drag = o.drag ?? 1;
      }
    },
    update(dt) {
      let n = 0;
      for (const q of live) {
        if (q.life <= 0) continue;
        q.life -= dt;
        if (q.life <= 0) continue;
        q.v.y -= q.g * dt;
        q.v.multiplyScalar(Math.max(0, 1 - q.drag * dt));
        q.p.addScaledVector(q.v, dt);
        const k = q.life / q.max;
        const fade = Math.min(1, k * 3);
        const cover = q.add ? 1 : q.a;
        position[n * 3] = q.p.x;
        position[n * 3 + 1] = q.p.y;
        position[n * 3 + 2] = q.p.z;
        colour[n * 4] = q.c.r * fade * cover;
        colour[n * 4 + 1] = q.c.g * fade * cover;
        colour[n * 4 + 2] = q.c.b * fade * cover;
        colour[n * 4 + 3] = q.add ? 0 : q.a * fade;
        size[n] = q.s1 + (q.s0 - q.s1) * k;
        n += 1;
      }
      geometry.setDrawRange(0, n);
      for (const name of ["position", "colour", "size"])
        geometry.attributes[name].needsUpdate = true;
    },
    clear() {
      for (const q of live) q.life = 0;
      geometry.setDrawRange(0, 0);
      points.removeFromParent();
    },
  };
}

// ── Weapon trails: the blade's base and tip, sampled every game-time frame, as a
// fading ribbon.
const trails = new Set();
const blades = new WeakMap();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** The blade in a hand bone's frame: the farthest point of what the hand holds is its tip. */
function measureBlade(root, bone) {
  const points = [];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    if (!object.isSkinnedMesh) return;
    const index = object.skeleton.bones.indexOf(bone);
    if (index < 0) return;
    const { position, skinIndex, skinWeight } = object.geometry.attributes;
    if (skinIndex === undefined) return;
    for (let i = 0; i < position.count; i += 1)
      for (let k = 0; k < 4; k += 1)
        if (skinIndex.getComponent(i, k) === index && skinWeight.getComponent(i, k) > 0.98) {
          v.fromBufferAttribute(position, i)
            .applyMatrix4(object.bindMatrix)
            .applyMatrix4(object.skeleton.boneInverses[index]);
          points.push(v.clone());
        }
  });
  // A rigid weapon held under the bone (a library character's sword slot).
  bone.updateWorldMatrix(true, true);
  const toBone = new THREE.Matrix4().copy(bone.matrixWorld).invert();
  bone.traverse((object) => {
    if (!object.isMesh || object.isSkinnedMesh) return;
    const position = object.geometry.attributes.position;
    const toLocal = new THREE.Matrix4().multiplyMatrices(toBone, object.matrixWorld);
    for (let i = 0; i < position.count; i += 1)
      points.push(v.fromBufferAttribute(position, i).applyMatrix4(toLocal).clone());
  });
  let tip = null;
  for (const p of points) if (tip === null || p.lengthSq() > tip.lengthSq()) tip = p;
  return tip;
}

function makeTrail(root, boneName, tipOption, color, strength) {
  let bone = null;
  root.traverse((object) => {
    if (bone === null && object.isBone && object.name === boneName) bone = object;
  });
  if (bone === null) root.traverse((object) => (bone ??= object.name === boneName ? object : null));
  let tip = tipOption === null ? null : new THREE.Vector3(tipOption.x, tipOption.y, tipOption.z);
  if (tip === null && bone !== null) {
    if (!blades.has(bone)) blades.set(bone, measureBlade(root, bone));
    tip = blades.get(bone);
  }
  if (bone === null || tip === null || tip.length() < 0.05)
    console.warn(
      `Juice.trail: no blade found in "${boneName}"${bone === null ? " (no such bone)" : ""}; pass { tip: {x, y, z} }`,
    );
  // From a quarter of the way out, so the ribbon follows the blade, not the grip.
  const base = tip === null ? null : tip.clone().multiplyScalar(0.25);
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(TRAIL_SAMPLES * 2 * 3);
  const alpha = new Float32Array(TRAIL_SAMPLES * 2);
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "alpha",
    new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage),
  );
  const index = [];
  for (let i = 0; i < TRAIL_SAMPLES - 1; i += 1)
    index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  geometry.setIndex(index);
  const tint = new THREE.Color(color).multiplyScalar(1.6);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { tint: { value: tint }, strength: { value: strength } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 tint;
        uniform float strength;
        varying float vAlpha;
        void main() { gl_FragColor = vec4( tint * vAlpha * strength, 1.0 ); }`,
    }),
  );
  mesh.frustumCulled = false;
  mesh.name = "juice trail";
  const samples = [];
  let shown = 0;
  const trail = {
    /** Draws while true; fades out after. */
    on: false,
    mesh,
    update(dt) {
      if (base === null || bone === null) return;
      if (Juice.stage !== null && mesh.parent !== Juice.stage) Juice.stage.add(mesh);
      bone.updateWorldMatrix(true, false);
      samples.unshift([
        _a.copy(base).applyMatrix4(bone.matrixWorld).clone(),
        _b.copy(tip).applyMatrix4(bone.matrixWorld).clone(),
      ]);
      if (samples.length > TRAIL_SAMPLES) samples.length = TRAIL_SAMPLES;
      shown = trail.on ? 1 : Math.max(0, shown - dt * 8);
      for (let i = 0; i < TRAIL_SAMPLES; i += 1) {
        const sample = samples[Math.min(i, samples.length - 1)];
        sample[0].toArray(position, i * 6);
        sample[1].toArray(position, i * 6 + 3);
        const a = shown * (1 - i / (TRAIL_SAMPLES - 1)) ** 1.5;
        alpha[i * 2] = a * 0.15;
        alpha[i * 2 + 1] = a;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.alpha.needsUpdate = true;
      mesh.visible = shown > 0.01;
    },
    dispose() {
      trails.delete(trail);
      mesh.removeFromParent();
      geometry.dispose();
      mesh.material.dispose();
    },
  };
  return trail;
}

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

const viewSize = new THREE.Vector2();
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
    pool?.update(dt);
    for (const trail of trails) trail.update(dt);
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

  beforeRender(camera, renderer = null) {
    if (pool !== null && renderer !== null)
      pool.points.material.uniforms.viewHeight.value =
        renderer.getDrawingBufferSize(viewSize).y / 2;
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
    pool?.clear();
    for (const trail of trails) trail.dispose();
  },
};
