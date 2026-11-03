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
// name ("dance", "roll"). Names match by word, case-insensitive: "Idle",
// "Walk_Loop", "CharacterArmature|Run", "attack-melee-right". A missing run
// plays walk, then idle (fall plays jump); each miss warns once with the
// clips the model has. jump, attack and hit play once each time the state is
// entered (asked for again, they hold their last pose), then the loop asked
// for meanwhile takes over; die plays once and holds until hero.revive().
// hero.clips lists the clip names; the console shows which clip each role got.
import * as THREE from "../vendor/three.module.js";

const ROLES = {
  idle: ["idle", "fly", "flying", "hover"],
  walk: ["walk", "walking"],
  run: ["run", "running", "jog", "sprint"],
  jump: ["jump"],
  fall: ["fall", "falling", "air", "airborne"],
  attack: ["attack", "punch", "slash", "swing", "melee", "kick", "shoot"],
  hit: ["hit", "hurt", "damage", "recievehit", "receivehit"],
  die: ["die", "death", "dead", "defeat", "dying"],
};
const FALLBACK = { run: "walk", walk: "idle", fall: "jump", jump: "idle" };
const ONCE = new Set(["attack", "hit", "die", "jump"]);
// Words that say nothing about the motion; any other word makes a clip a
// variant ("Idle_Talking_Loop" loses to "Idle_Loop").
const FILLER = new Set(["loop", "anim", "animation", "fwd", "forward", "inplace", "cycle"]);

const words = (name) =>
  name
    .split("|")
    .at(-1)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);

/** The clip for a role: one whose words hold a role keyword, fewest extra words, earliest keyword. */
export function findClip(clips, state) {
  const keys = ROLES[state] ?? [state.toLowerCase()];
  let best = null;
  let bestScore = Infinity;
  for (const clip of clips) {
    const w = words(clip.name);
    const k = keys.findIndex((key) => w.includes(key));
    if (k < 0) continue;
    const score = w.filter((x) => !keys.includes(x) && !FILLER.has(x)).length * 10 + k;
    if (score < bestScore) [best, bestScore] = [clip, score];
  }
  return best;
}

const live = new Set();

export function animate(gltf, { fade = 0.2 } = {}) {
  const root = gltf.scene ?? gltf;
  const clips = gltf.animations ?? [];
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map();
  const warned = new Set();
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

  const start = (state, action, { once, speed = 1, fade: f = fade }) => {
    const previous = current?.action ?? null;
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.timeScale = speed;
    // Loop to loop keeps the step phase (walk to run lands on the same foot).
    if (!once && previous !== null && previous.loop === THREE.LoopRepeat && previous !== action)
      action.time = (previous.time / previous.getClip().duration) * action.getClip().duration;
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
    play(state, options = {}) {
      const entered = state !== asked;
      asked = state;
      if (held) return;
      const once = options.once ?? ONCE.has(state);
      const action = actionFor(state);
      if (action === null) return;
      if (once) {
        // Plays once each time the state is entered; asked again, it plays on or holds its end.
        if (!entered && current?.action === action) return;
        if (state === "die") held = true;
        start(state, action, { ...options, once });
        return;
      }
      loopState = state;
      loopOptions = options;
      // A one-shot plays through; the loop asked for meanwhile follows it.
      if (current?.once && !current.done) return;
      if (current?.action === action && !current.once) {
        current.state = state;
        action.timeScale = options.speed ?? 1;
        return;
      }
      start(state, action, { ...options, once });
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
          .map((role) => `${role}=${findClip(clips, role)?.name ?? "-"}`)
          .join(" "),
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
    for (const animator of live) if (animator.root.parent !== null) animator.mixer.update(dt);
  },
  reset() {
    for (const animator of live) animator.mixer.stopAllAction();
    live.clear();
  },
};
