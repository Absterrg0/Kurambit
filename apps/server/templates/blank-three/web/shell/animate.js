// Character animation by state. Choose the state from gameplay every frame and
// call play(state); this finds the clip, crossfades, plays one-shots through
// and returns to the loop, and runs on game time (the shell ticks it, so it
// freezes on pause).
//
//   import { animate } from "./shell/animate.js";
//   // main.js lists the model: export const ASSETS = { hero: "assets/models/hero.glb" };
//   const hero = animate(ctx.assets.model("hero")); // a fresh copy, its clips found by role
//   scene.add(hero.root);
//   // every frame in update(dt, ctx):
//   hero.play(!onFloor ? "fall" : speed > 4 ? "run" : speed > 0.1 ? "walk" : "idle",
//             { speed: Math.max(speed / 3, 0.6) }); // playback rate: moving speed / clip's speed
//   if (keys.pressed("Space")) hero.play("attack"); // one-shot, then back to the loop
//
// States: idle, walk, run, jump, fall, attack, hit, die, or any word in a clip
// name ("dance", "roll", "roar"); a creature's own clips ("Trot", "Bite") count. Names match by word, case-insensitive: "Idle",
// "Walk_Loop", "CharacterArmature|Run", "attack-melee-right". A missing run
// plays walk, then idle (fall plays jump); each miss warns once with the
// clips the model has. jump, attack and hit play once each time the state is
// entered (asked for again, they hold their last pose), then the loop asked
// for meanwhile takes over; die plays once and holds until hero.revive().
// hero.clips lists the clip names; the console shows which clip each role got.
//
// For combat, each call can also say how it plays:
//   hero.play("Sword_Attack", { once: true, fade: 0.08 }); // a clip by its exact name; its own crossfade
//   hero.play("attack", { restart: true });   // the next cut of a combo: from the start again
//   hero.play("roll", { once: true, reverse: true }); // backwards, from the clip's end
//   hero.play("attack", { from: 0.2 });       // start 0.2 s into the clip
//   if (hero.time > 0.32 && hero.time < 0.45) hit(); // the clip's own seconds now: hit windows
//   hero.progress;                            // 0..1 through it; hero.duration, hero.clip (its name)
// The shell ticks every animator on game time, so a Juice.hitPause holds the
// clip, and its time, with the world.
//
// A model exported through Kurambit's pipeline (ASSETS names its .asset.json
// sidecar) knows more, and animate reads it from the copy:
//   hero.play("run", { moveSpeed: 5.5 }); // m/s it moves: the clip plays at
//     // moveSpeed / its measured ground speed, so the feet stay planted
//   hero.spring("tail", { stiffness: 0.09, damping: 0.14, gravity: 4 }); // retune a chain
//   hero.lookAt(target.position, { maxYaw: 1, maxPitch: 0.6 }); // neck and head turn
//     // toward a point within limits; null: ahead
//   hero.blink();                         // blink now (a face blinks on its own anyway)
//   if (hero.striking?.by === "prop") hit(); // the clip's measured hit window, not a guess
// And the runtime layer, each off until asked for and free when off:
//   hero.react("Hit_Chest");              // any clip's upper body once, on top of a walk
//   hero.lean();                          // into turns and forward with speed, from how
//                                         // the game moves hero.root (lean(false): off)
//   hero.feetOn((x, z) => terrainHeight(x, z)); // feet on stairs and slopes: each foot
//     // holds the ground through the sidecar's measured stances; null: off
// The sidecar's spring chains (a tail, ears) swing on their own from the
// start; spring(["bone_a", "bone_b"], opts) adds a chain to any model, root
// to tip. A sidecar face (eye bones from the kit's eye helpers) blinks every
// 2-6 s, sometimes twice. A model with no measured ground speed plays at
// `speed` (default 1).
import * as THREE from "../vendor/three.module.js";
import {
  findBone,
  layered,
  makeFootIK,
  makeLean,
  makeReactions,
  rotateWorld,
} from "./motion-layer.js";

// Creatures (a generated wolf or dragon on its own rig) name their clips the same way, plus
// gaits and natural attacks.
const ROLES = {
  idle: ["idle", "fly", "flying", "hover", "stand", "breathe", "breathing"],
  walk: ["walk", "walking", "trot", "crawl", "slither", "swim"],
  run: ["run", "running", "jog", "sprint", "gallop", "canter", "dash"],
  jump: ["jump", "leap", "pounce"],
  fall: ["fall", "falling", "air", "airborne"],
  attack: [
    "attack",
    "punch",
    "slash",
    "swing",
    "melee",
    "kick",
    "shoot",
    "bite",
    "claw",
    "peck",
    "sting",
  ],
  hit: ["hit", "hurt", "damage", "recievehit", "receivehit"],
  die: ["die", "death", "dead", "defeat", "dying"],
};
const FALLBACK = { run: "walk", walk: "idle", fall: "jump", jump: "idle" };
const ONCE = new Set(["attack", "hit", "die", "jump"]);
// Words that say nothing about the motion; any other word makes a clip a
// variant ("Idle_Talking_Loop" loses to "Idle_Loop").
const FILLER = new Set(["loop", "anim", "animation", "fwd", "forward", "inplace", "cycle"]);
// Clips with these words are held poses or guards, never a role's pick
// (KayKit's "Block_Attack" is not its attack); play them by their own word.
const NOT_A_ROLE = ["block", "blocking", "pose", "aiming", "reload"];

const words = (name) =>
  name
    .split("|")
    .at(-1)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);

/**
 * The clip for a role: a clip named exactly so first, then one whose words hold a
 * role keyword, fewest extra words, earliest keyword.
 */
export function findClip(clips, state) {
  const exact = state.toLowerCase();
  const named = clips.find((clip) => clip.name.split("|").at(-1).toLowerCase() === exact);
  if (named !== undefined) return named;
  const keys = ROLES[state] ?? [state.toLowerCase()];
  let best = null;
  let bestScore = Infinity;
  for (const clip of clips) {
    const w = words(clip.name);
    if (ROLES[state] !== undefined && NOT_A_ROLE.some((x) => w.includes(x))) continue;
    const k = keys.findIndex((key) => w.includes(key));
    if (k < 0) continue;
    // A lone letter is a variant tag ("Hit_A"), not another motion.
    const score =
      w.filter((x) => !keys.includes(x) && !FILLER.has(x) && x.length > 1).length * 10 + k;
    if (score < bestScore) [best, bestScore] = [clip, score];
  }
  return best;
}

const live = new Set();

const SPRING = { stiffness: 0.15, damping: 0.2, gravity: 0 };
/** A frame step this long is a hitch, not motion: springs start again from their pose. */
const HITCH_SECONDS = 0.1;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
// How shut the eyes are, one value a frame at 24 fps: 3 frames closing, 1 held, 4 opening.
const BLINK = [0, 0.35, 0.8, 1, 1, 0.75, 0.45, 0.2, 0];
const BLINK_SECONDS = (BLINK.length - 1) / 24;

/**
 * A spring chain: each bone's tip is a point mass pulled toward where the clip
 * puts it, with damping and gravity, held at the bone's length; the bone turns
 * to point at it. Steps scale with dt, so it holds across frame rates; a jump
 * further than a teleport snaps it back.
 */
function makeSpring(root, names, options) {
  const bones = names.map((name) => findBone(root, name)).filter((bone) => bone !== null);
  if (bones.length === 0) {
    console.warn(`animate: no bones ${names.join(", ")} for a spring`);
    return null;
  }
  root.updateWorldMatrix(true, true);
  const at = (bone) => bone.getWorldPosition(new THREE.Vector3());
  const links = bones.map((bone, i) => {
    const next = bones[i + 1];
    // Toward the child; the last bone points along its local +y (Blender's bone axis).
    const axis =
      next !== undefined ? next.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const length =
      next !== undefined
        ? at(bone).distanceTo(at(next))
        : i > 0
          ? at(bones[i - 1]).distanceTo(at(bone))
          : 0.2 * root.getWorldScale(new THREE.Vector3()).y;
    return {
      bone,
      axis,
      length,
      tip: null,
      prev: new THREE.Vector3(),
      base: bone.quaternion.clone(),
      wrote: new THREE.Quaternion(),
      written: false,
    };
  });
  const head = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  return {
    key: bones.map((bone) => bone.name).join(","),
    options,
    update(dt) {
      if (dt <= 0) return;
      const { stiffness, damping, gravity } = options;
      const k = 1 - Math.pow(1 - stiffness, dt * 60);
      const keep = Math.pow(1 - damping, dt * 60);
      for (const link of links) {
        const { bone } = link;
        // A clip that does not key this bone leaves our last rotation: start from its pose again.
        if (link.written && bone.quaternion.equals(link.wrote)) bone.quaternion.copy(link.base);
        bone.updateWorldMatrix(true, false);
        bone.getWorldPosition(head);
        goal
          .copy(link.axis)
          .applyQuaternion(bone.getWorldQuaternion(q))
          .multiplyScalar(link.length)
          .add(head);
        // A hitch (a frame far longer than a frame) carries the whole jump on as velocity and
        // throws the chain past its limits: start it from its pose, as after a teleport.
        if (
          link.tip === null ||
          dt > HITCH_SECONDS ||
          link.tip.distanceTo(goal) > Math.max(link.length * 4, 1)
        ) {
          link.tip = goal.clone();
          link.prev.copy(goal);
        }
        vel.subVectors(link.tip, link.prev).multiplyScalar(keep);
        link.prev.copy(link.tip);
        link.tip.add(vel).addScaledVector(_v3.subVectors(goal, link.tip), k);
        link.tip.y -= gravity * dt * dt;
        link.tip.sub(head).setLength(link.length).add(head);
        from.subVectors(goal, head).normalize();
        to.subVectors(link.tip, head).normalize();
        q.setFromUnitVectors(from, to);
        bone.parent.getWorldQuaternion(pq);
        bone.quaternion.premultiply(turn.copy(pq).invert().multiply(q).multiply(pq));
        link.wrote.copy(bone.quaternion);
        link.written = true;
        bone.updateMatrixWorld(true);
      }
    },
  };
}

export function animate(gltf, { fade = 0.2 } = {}) {
  const root = gltf.scene ?? gltf;
  const clips = gltf.animations ?? [];
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map();
  const warned = new Set();
  // The pipeline's sidecar (shell/assets.js); a library model has none.
  const asset = gltf.userData?.asset ?? root.userData?.asset ?? null;
  const strikesOf = new Map((asset?.clips ?? []).map((clip) => [clip.name, clip.strikes ?? []]));
  const groundSpeeds = new Map(
    (asset?.clips ?? [])
      .filter((clip) => typeof clip.groundSpeed === "number" && clip.groundSpeed > 0)
      .map((clip) => [clip.name, clip.groundSpeed]),
  );
  const springs = [];
  const addSpring = (names, options, name = null) => {
    const chain = makeSpring(root, names, { ...SPRING, ...options });
    if (chain !== null) springs.push(Object.assign(chain, { name }));
  };
  for (const chain of asset?.springs ?? []) addSpring(chain.bones, {}, chain.name);
  const gaze = {
    target: null,
    name: null,
    parts: [],
    yaw: 0,
    pitch: 0,
    maxYaw: 1,
    maxPitch: 0.6,
    split: 0.4,
    rate: 6,
  };
  const settleGaze = (dt) => {
    if (gaze.parts.length === 0) return;
    for (const part of gaze.parts) part.begin();
    let wantYaw = 0;
    let wantPitch = 0;
    if (gaze.target !== null) {
      // The target in the character's own frame, from its head: yaw about up, pitch above level.
      const head = gaze.parts[gaze.parts.length - 1].bone;
      root.getWorldQuaternion(_q1);
      _v3.subVectors(gaze.target, head.getWorldPosition(_v1)).applyQuaternion(_q1.invert());
      if (_v3.lengthSq() > 1e-4) {
        wantYaw = THREE.MathUtils.clamp(Math.atan2(_v3.x, _v3.z), -gaze.maxYaw, gaze.maxYaw);
        wantPitch = THREE.MathUtils.clamp(
          Math.atan2(_v3.y, Math.hypot(_v3.x, _v3.z)),
          -gaze.maxPitch,
          gaze.maxPitch,
        );
      }
    }
    const k = 1 - Math.exp(-gaze.rate * dt);
    gaze.yaw += (wantYaw - gaze.yaw) * k;
    gaze.pitch += (wantPitch - gaze.pitch) * k;
    root.getWorldQuaternion(_q1);
    _v2.set(1, 0, 0).applyQuaternion(_q1);
    // The neck takes `split` of the turn and the head the rest; a lone head takes all of it.
    gaze.parts.forEach((part, i) => {
      const share = gaze.parts.length === 1 ? 1 : i === 0 ? gaze.split : 1 - gaze.split;
      rotateWorld(part.bone, _v1.set(0, 1, 0), gaze.yaw * share);
      rotateWorld(part.bone, _v2, -gaze.pitch * share);
      part.end();
    });
  };
  const layers = { lean: null, feet: null, reactions: null };
  // The sidecar's face: each blink bone keyed on top of the clips, restored first like the gaze.
  const blinks = (asset?.face?.blink ?? [])
    .map((part) => ({
      ...part,
      bone: findBone(root, part.bone),
      baseQ: new THREE.Quaternion(),
      baseS: new THREE.Vector3(),
      wroteQ: new THREE.Quaternion(),
      wroteS: new THREE.Vector3(),
      written: false,
    }))
    .filter((part) => part.bone !== null && AXES[part.axis] !== undefined);
  const blinking = { t: -1, wait: 2 + Math.random() * 4, again: false };
  const settleBlink = (dt) => {
    if (blinks.length === 0) return;
    if (blinking.t < 0 && (blinking.wait -= dt) <= 0) {
      blinking.t = 0;
      blinking.again = Math.random() < 0.25;
    }
    let shut = 0;
    if (blinking.t >= 0) {
      const f = Math.min(blinking.t * 24, BLINK.length - 1);
      const i = Math.min(Math.floor(f), BLINK.length - 2);
      shut = BLINK[i] + (BLINK[i + 1] - BLINK[i]) * (f - i);
      blinking.t += dt;
      if (blinking.t >= BLINK_SECONDS) {
        blinking.t = -1;
        blinking.wait = blinking.again ? 0.12 : 2 + Math.random() * 4;
        blinking.again = false;
      }
    }
    for (const part of blinks) {
      const { bone } = part;
      if (part.written && bone.quaternion.equals(part.wroteQ) && bone.scale.equals(part.wroteS)) {
        bone.quaternion.copy(part.baseQ);
        bone.scale.copy(part.baseS);
      }
      part.baseQ.copy(bone.quaternion);
      part.baseS.copy(bone.scale);
      part.written = shut > 0;
      if (!part.written) continue;
      if (part.kind === "turn")
        bone.quaternion.multiply(_q1.setFromAxisAngle(AXES[part.axis], part.amount * shut));
      else if (part.kind === "squash")
        bone.scale.setComponent(
          "xyz".indexOf(part.axis),
          part.baseS.getComponent("xyz".indexOf(part.axis)) * (1 + (part.amount - 1) * shut),
        );
      // Highlights gone by mid-blink, or they leave a streak on the closed eye.
      else bone.scale.copy(part.baseS).multiplyScalar(Math.max(1e-4, 1 - 2 * shut));
      part.wroteQ.copy(bone.quaternion);
      part.wroteS.copy(bone.scale);
    }
  };
  const unmeasured = new Set();
  const rate = (action, options) => (options.reverse === true ? -1 : 1) * pace(action, options);
  const pace = (action, options) => {
    if (options.moveSpeed === undefined) return options.speed ?? 1;
    const clip = action.getClip().name;
    const ground = groundSpeeds.get(clip);
    if (ground !== undefined) return THREE.MathUtils.clamp(options.moveSpeed / ground, 0.25, 3);
    if (!unmeasured.has(clip)) {
      unmeasured.add(clip);
      console.warn(`animate: no measured ground speed for ${clip}; pass speed`);
    }
    return options.speed ?? 1;
  };
  let current = null; // { state, action }
  let loopState = "idle";
  let loopOptions = {};
  let held = false;
  let asked = null;

  const resolve = (state) => {
    for (let s = state; s !== undefined; s = FALLBACK[s]) {
      const clip = findClip(clips, s);
      if (clip !== null) return clip;
    }
    return state === "idle" || ROLES[state] === undefined || FALLBACK[state] !== undefined
      ? (findClip(clips, "idle") ?? clips[0] ?? null)
      : null;
  };
  const actionFor = (state) => {
    if (actions.has(state)) return actions.get(state);
    const clip = resolve(state);
    if (clip === null || findClip(clips, state) !== clip) warnOnce(state, clip);
    const action = clip === null ? null : mixer.clipAction(clip);
    actions.set(state, action);
    return action;
  };
  const warnOnce = (state, clip) => {
    if (warned.has(state)) return;
    warned.add(state);
    console.warn(
      `animate: no "${state}" clip${clip === null ? "" : `, playing ${clip.name}`}; clips: ${clips.map((c) => c.name).join(", ") || "none"}`,
    );
  };

  const start = (state, action, options) => {
    const { once, fade: f = fade } = options;
    const previous = current?.action ?? null;
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.timeScale = rate(action, options);
    const duration = action.getClip().duration;
    if (options.from !== undefined) action.time = Math.min(Math.max(options.from, 0), duration);
    else if (options.reverse === true) action.time = duration;
    // Loop to loop keeps the step phase (walk to run lands on the same foot).
    else if (
      !once &&
      previous !== null &&
      previous.loop === THREE.LoopRepeat &&
      previous !== action
    )
      action.time = (previous.time / previous.getClip().duration) * duration;
    action.play();
    if (previous !== null && previous !== action) action.crossFadeFrom(previous, f, false);
    current = { state, action, once, done: false };
  };

  const animator = {
    root,
    mixer,
    clips: clips.map((c) => c.name),
    /** The state playing now. */
    get state() {
      return current?.state ?? null;
    },
    /** The playing clip's name, or null. */
    get clip() {
      return current?.action.getClip().name ?? null;
    },
    /** The playing clip's own seconds now (hit windows), on game time. */
    get time() {
      return current?.action.time ?? 0;
    },
    /** The playing clip's length in seconds. */
    get duration() {
      return current?.action.getClip().duration ?? 0;
    },
    /**
     * The sidecar's strike whose window holds the playing clip's time ({at, from, to, by,
     * speed}: by is "prop", "hand_l", "foot_r"...), or null: a measured hit window.
     */
    get striking() {
      if (current === null) return null;
      const t = current.action.time;
      for (const strike of strikesOf.get(current.action.getClip().name) ?? [])
        if (t >= strike.from && t <= strike.to) return strike;
      return null;
    },
    /** How far through the playing clip, 0..1. */
    get progress() {
      const length = current?.action.getClip().duration ?? 0;
      return length > 0 ? Math.min(Math.max(current.action.time / length, 0), 1) : 0;
    },
    play(state, options = {}) {
      const entered = state !== asked;
      asked = state;
      if (held) return;
      const once = options.once ?? ONCE.has(state);
      const action = actionFor(state);
      if (action === null) return;
      if (once) {
        // Plays once each time the state is entered; asked again, it plays on or holds its
        // end, unless asked to restart.
        if (!entered && current?.action === action && options.restart !== true) return;
        if (state === "die") held = true;
        start(state, action, { ...options, once });
        return;
      }
      loopState = state;
      loopOptions = options;
      // A one-shot plays through; the loop asked for meanwhile follows it.
      if (current?.once && !current.done) return;
      if (current?.action === action && !current.once && options.restart !== true) {
        current.state = state;
        action.timeScale = rate(action, options);
        return;
      }
      start(state, action, { ...options, once });
    },
    /**
     * A chain that lags and swings on top of the clips: a sidecar chain's name
     * ("tail"; "ear" is ear_l and ear_r) retunes it, a list of bones (root to tip)
     * adds one. Options: stiffness, damping (0..1 per frame at 60 fps), gravity (m/s²).
     */
    spring(namesOrChain, options = {}) {
      if (typeof namesOrChain === "string") {
        const named = springs.filter(
          (chain) =>
            chain.name !== null &&
            (chain.name === namesOrChain || chain.name.startsWith(`${namesOrChain}_`)),
        );
        if (named.length === 0)
          console.warn(
            `animate: no spring chain "${namesOrChain}"; chains: ${springs.map((chain) => chain.name ?? chain.key).join(", ") || "none"}`,
          );
        for (const chain of named) Object.assign(chain.options, options);
        return animator;
      }
      const existing = springs.find((chain) => chain.key === namesOrChain.join(","));
      if (existing !== undefined) Object.assign(existing.options, options);
      else addSpring(namesOrChain, options);
      return animator;
    },
    /**
     * Turn the head toward a world point (a Vector3 the game keeps moving), within limits, split
     * over the neck and the head; null looks ahead again. maxYaw and maxPitch in radians, split
     * the neck's share, rate per second.
     */
    lookAt(
      point,
      { bone = "Head", neck = "neck_01", maxYaw = 1, maxPitch = 0.6, split = 0.4, rate = 6 } = {},
    ) {
      const key = `${neck}|${bone}`;
      if (gaze.name !== key) {
        gaze.name = key;
        gaze.parts = [neck, bone]
          .map((name) => (name === null ? null : findBone(root, name)))
          .filter((found) => found !== null)
          .map(layered);
        if (findBone(root, bone) === null) console.warn(`animate: no bone "${bone}" to look with`);
      }
      Object.assign(gaze, { target: point, maxYaw, maxPitch, split, rate });
      return animator;
    },
    /**
     * Play a clip's upper body once on top of whatever plays (a flinch while walking, a shrug):
     * additive, so the walk's legs and timing carry on. weight scales it, speed its rate.
     */
    react(clip, options = {}) {
      layers.reactions ??= makeReactions(mixer, clips, findClip);
      layers.reactions.play(clip, options);
      return animator;
    },
    /**
     * Lean into turns and forward with speed, from how the game moves root: on (true or options
     * {max (rad), gain, forward (rad per m/s), rate}) or off (false).
     */
    lean(on = true) {
      if (on === false) layers.lean = null;
      else {
        const options = {
          max: 0.3,
          gain: 1.6,
          forward: 0.025,
          rate: 8,
          ...(on === true ? {} : on),
        };
        if (layers.lean === null) layers.lean = makeLean(root, options);
        else Object.assign(layers.lean.options, options);
      }
      return animator;
    },
    /**
     * Keep the feet on uneven ground: ground(x, z) is the world height there. Each foot holds
     * the ground where it landed through the sidecar's measured stances of the playing clip;
     * the pelvis drops for the lower foot. null turns it off. Options: rate (per second).
     */
    feetOn(ground, { rate = 18 } = {}) {
      if (ground === null) layers.feet = null;
      else if (layers.feet === null) layers.feet = makeFootIK(root, asset, { ground, rate });
      else Object.assign(layers.feet.options, { ground, rate });
      return animator;
    },
    /** Blink now; a model whose sidecar has no face has nothing to blink. */
    blink() {
      if (blinking.t < 0) {
        blinking.t = 0;
        blinking.again = false;
      }
      return animator;
    },
    /** After the mixer: springs, the lean, the gaze, the feet, then the blink. The shell calls it. */
    settle(dt) {
      for (const chain of springs) chain.update(dt);
      if (layers.lean !== null) layers.lean.update(dt);
      settleGaze(dt);
      if (layers.feet !== null) layers.feet.update(dt, current?.action ?? null);
      settleBlink(dt);
    },
    /** Back to playing after die (a respawn). */
    revive() {
      held = false;
      current = null;
      asked = null;
      mixer.stopAllAction();
      animator.play("idle");
    },
    dispose() {
      mixer.stopAllAction();
      live.delete(animator);
    },
  };
  mixer.addEventListener("finished", (event) => {
    if (current?.action !== event.action) return;
    current.done = true;
    // Still asked for (airborne in a jump): hold the last pose until the game moves on.
    if (held || asked === current.state) return;
    const action = actionFor(loopState);
    if (action !== null) start(loopState, action, { ...loopOptions, once: false });
  });
  if (clips.length === 0) console.warn("animate: this model has no animation clips");
  else
    console.info(
      `animate: clips ${animator.clips.join(", ")}; ` +
        Object.keys(ROLES)
          .map((role) => {
            const name = findClip(clips, role)?.name;
            if (name === undefined) return `${role}=-`;
            const ground = groundSpeeds.get(name);
            return `${role}=${name}${ground === undefined ? "" : ` (${ground.toFixed(2)} m/s)`}`;
          })
          .join(" ") +
        (springs.length === 0
          ? ""
          : `; springs ${springs.map((chain) => chain.name ?? chain.key).join(", ")}`) +
        (blinks.length === 0 ? "" : `; blinks ${blinks.map((part) => part.bone.name).join(", ")}`),
    );
  live.add(animator);
  animator.play("idle");
  return animator;
}

// The shell's side: tick every animator on game time; a new run starts empty.
export const animateShell = {
  update(dt) {
    // A model taken out of the scene (a defeated enemy) costs nothing; it
    // resumes if it is added back. dispose() forgets it for good.
    for (const animator of live)
      if (animator.root.parent !== null) {
        animator.mixer.update(dt);
        animator.settle(dt);
      }
  },
  reset() {
    for (const animator of live) animator.mixer.stopAllAction();
    live.clear();
  },
  /** The state and clip an object's animator plays ({ state, clip }), or null: the scene report reads it. */
  stateOf(object) {
    for (const animator of live) {
      const root = animator.root;
      let related = root === object;
      for (let node = root.parent; !related && node !== null; node = node.parent)
        related = node === object;
      for (let node = object.parent; !related && node !== null; node = node.parent)
        related = node === root;
      if (related) return { state: animator.state, clip: animator.clip };
    }
    return null;
  },
};
