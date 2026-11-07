// The runtime layer animate() puts on top of a clip, each part off until asked for and
// allocation-free per frame once on: an additive reaction from any clip on the upper body, a
// lean from speed and turn rate, and foot IK on a ground(x, z) height that holds each foot
// through the sidecar's measured stances instead of guessing contacts every frame. Everything
// runs in animate's settle on game time, so a hit pause slows it and a frozen Stage holds it.
import * as THREE from "../vendor/three.module.js";

// Bones only: a mesh may share a bone's name ("Head").
export const findBone = (root, name) => {
  let found = null;
  root.traverse((object) => {
    if (found === null && object.isBone && object.name === name) found = object;
  });
  return found;
};

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();

/** Turn a bone by a world rotation, keeping its parent's frame. */
export function turnWorld(bone, q) {
  bone.parent.getWorldQuaternion(_qa);
  bone.quaternion.premultiply(_qb.copy(_qa).invert().multiply(q).multiply(_qa));
  bone.updateMatrixWorld(true);
}

/** Rotate a bone by an angle about a world axis, keeping its parent's frame. */
export function rotateWorld(bone, axis, angle) {
  turnWorld(bone, _qc.setFromAxisAngle(axis, angle));
}

/**
 * A bone a layer changes after the mixer: a clip that does not key it would leave the layer's
 * last change in place and compound it, so the layer starts from its own last base instead.
 */
export function layered(bone) {
  return {
    bone,
    q: new THREE.Quaternion(),
    p: new THREE.Vector3(),
    wroteQ: new THREE.Quaternion(),
    wroteP: new THREE.Vector3(),
    written: false,
    begin() {
      if (
        this.written &&
        bone.quaternion.equals(this.wroteQ) &&
        bone.position.equals(this.wroteP)
      ) {
        bone.quaternion.copy(this.q);
        bone.position.copy(this.p);
      }
      this.q.copy(bone.quaternion);
      this.p.copy(bone.position);
    },
    end() {
      this.wroteQ.copy(bone.quaternion);
      this.wroteP.copy(bone.position);
      this.written = true;
    },
  };
}

// The upper body by the standard skeleton's names: a reaction never moves the legs, so a flinch
// layers onto a walk without its feet sliding.
const UPPER = /^(spine|neck|head|clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/i;

/** Additive reactions: any clip's upper body, played once on top of whatever plays. */
export function makeReactions(mixer, clips, find) {
  const made = new Map();
  return {
    play(name, { weight = 1, speed = 1, fade = 0.05 } = {}) {
      let action = made.get(name);
      if (action === undefined) {
        const clip = clips.find((c) => c.name === name) ?? find(clips, name);
        action = null;
        if (clip === null || clip === undefined)
          console.warn(
            `animate: no clip "${name}" to react with; clips: ${clips.map((c) => c.name).join(", ")}`,
          );
        else {
          const upper = new THREE.AnimationClip(
            `${clip.name}~react`,
            clip.duration,
            clip.tracks.filter((t) => UPPER.test(t.name.split(".")[0])).map((t) => t.clone()),
          );
          // Relative to its own first frame: only how the clip moves away from it is added.
          THREE.AnimationUtils.makeClipAdditive(upper, 0);
          action = mixer.clipAction(upper);
          action.blendMode = THREE.AdditiveAnimationBlendMode;
          action.setLoop(THREE.LoopOnce, 1);
        }
        made.set(name, action);
      }
      if (action === null) return;
      action.reset();
      action.setEffectiveTimeScale(speed);
      action.setEffectiveWeight(weight);
      action.fadeIn(fade);
      action.play();
    },
  };
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A lean from the root's own motion: into a turn by atan(speed · turn rate / g), forward with
 * speed, spread up the spine. Reads only the root's world transform, so it works however the
 * game moves the character.
 */
export function makeLean(root, options) {
  const spine = ["spine_01", "spine_02", "spine_03"]
    .map((name) => findBone(root, name))
    .filter((bone) => bone !== null)
    .map(layered);
  if (spine.length === 0) console.warn("animate: no spine bones to lean with");
  const share = 1 / Math.max(1, spine.length);
  const last = new THREE.Vector3();
  const now = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const side = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const state = { yaw: 0, primed: false, roll: 0, pitch: 0, speed: 0, turn: 0 };
  return {
    options,
    state,
    update(dt) {
      if (spine.length === 0) return;
      root.getWorldPosition(now);
      root.getWorldQuaternion(q);
      fwd.set(0, 0, 1).applyQuaternion(q);
      const yaw = Math.atan2(fwd.x, fwd.z);
      if (!state.primed || dt > 0.1) {
        state.primed = true;
      } else if (dt > 1e-4) {
        const speed = Math.hypot(now.x - last.x, now.z - last.z) / dt;
        const turn = Math.atan2(Math.sin(yaw - state.yaw), Math.cos(yaw - state.yaw)) / dt;
        state.speed += (speed - state.speed) * (1 - Math.exp(-options.rate * dt));
        state.turn += (turn - state.turn) * (1 - Math.exp(-options.rate * dt));
        const roll = THREE.MathUtils.clamp(
          Math.atan((state.speed * state.turn) / 9.81) * options.gain,
          -options.max,
          options.max,
        );
        const pitch = Math.min(state.speed * options.forward, options.max * 0.5);
        state.roll += (roll - state.roll) * (1 - Math.exp(-options.rate * dt));
        state.pitch += (pitch - state.pitch) * (1 - Math.exp(-options.rate * dt));
      }
      last.copy(now);
      state.yaw = yaw;
      // A left turn's centre is on the character's left (+x facing +z): the top tilts toward it.
      side.set(1, 0, 0).applyQuaternion(q);
      for (const part of spine) {
        part.begin();
        rotateWorld(part.bone, fwd, -state.roll * share);
        rotateWorld(part.bone, side, state.pitch * share);
        part.end();
      }
    },
  };
}

const EASE_S = 0.12;

/**
 * Foot IK on a ground height: each foot is held at the ground under where it landed, through each
 * stance the sidecar measured for the playing clip; between stances it travels from that height
 * to the height where it will land, predicted from the root's velocity. The pelvis drops by the
 * lower foot's need, and each leg is solved by two-bone IK in the plane of its knee.
 */
export function makeFootIK(root, asset, options) {
  const stancesOf = new Map(
    (asset?.clips ?? []).map((clip) => [
      clip.name,
      { stances: clip.stances ?? [], seconds: clip.seconds },
    ]),
  );
  const pelvis = findBone(root, "pelvis");
  const legs = ["l", "r"].map((s) => ({
    side: s,
    foot: `foot_${s}`,
    thigh: findBone(root, `thigh_${s}`),
    calf: findBone(root, `calf_${s}`),
    ankle: findBone(root, `foot_${s}`),
    ball: findBone(root, `ball_${s}`),
    held: null,
    planted: false,
    offset: 0,
    parts: null,
  }));
  const usable =
    pelvis !== null && legs.every((leg) => leg.thigh && leg.calf && leg.ankle && leg.ball);
  if (!usable) console.warn("animate: foot IK needs the standard skeleton's pelvis and legs");
  const pelvisPart = usable ? layered(pelvis) : null;
  for (const leg of legs) if (usable) leg.parts = [leg.thigh, leg.calf, leg.ankle].map(layered);
  const rootPos = new THREE.Vector3();
  const lastRoot = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const hip = new THREE.Vector3();
  const knee = new THREE.Vector3();
  const ankle = new THREE.Vector3();
  const target = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const newKnee = new THREE.Vector3();
  const footQ = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  const state = { drop: 0, primed: false, clip: null };

  // Where t (clip seconds) is against the foot's stances: inside one, the weight easing out of or
  // into one, and the seconds to the next stance's start. Written into one object: no garbage.
  const at = { inside: false, weight: 0, next: Infinity };
  const phase = (list, foot, t, length) => {
    let near = Infinity;
    at.inside = false;
    at.next = Infinity;
    for (const s of list) {
      if (s.foot !== foot) continue;
      if (t >= s.from && t <= s.to) at.inside = true;
      near = Math.min(near, Math.abs(t - s.from), Math.abs(t - s.to));
      at.next = Math.min(at.next, s.from >= t ? s.from - t : s.from + length - t);
    }
    at.weight = at.inside ? 1 : Math.max(0, 1 - near / EASE_S);
    return at;
  };

  const solveLeg = (leg, lift) => {
    leg.thigh.getWorldPosition(hip);
    leg.calf.getWorldPosition(knee);
    leg.ankle.getWorldPosition(ankle);
    leg.ankle.getWorldQuaternion(footQ);
    target.copy(ankle).addScaledVector(UP, lift);
    const la = hip.distanceTo(knee);
    const lb = knee.distanceTo(ankle);
    axis.subVectors(target, hip);
    const d = THREE.MathUtils.clamp(axis.length(), Math.abs(la - lb) + 1e-4, (la + lb) * 0.9995);
    axis.normalize();
    pole.subVectors(knee, hip);
    pole.addScaledVector(axis, -pole.dot(axis));
    if (pole.lengthSq() < 1e-10) return;
    pole.normalize();
    const cos = (la * la + d * d - lb * lb) / (2 * la * d);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    newKnee
      .copy(hip)
      .addScaledVector(axis, la * cos)
      .addScaledVector(pole, la * sin);
    q.setFromUnitVectors(
      a.subVectors(knee, hip).normalize(),
      b.subVectors(newKnee, hip).normalize(),
    );
    turnWorld(leg.thigh, q);
    leg.calf.getWorldPosition(knee);
    leg.ankle.getWorldPosition(ankle);
    target.copy(hip).addScaledVector(axis, d);
    q.setFromUnitVectors(
      a.subVectors(ankle, knee).normalize(),
      b.subVectors(target, knee).normalize(),
    );
    turnWorld(leg.calf, q);
    // The foot keeps the angle the clip gave it in the world.
    leg.ankle.parent.getWorldQuaternion(pq);
    leg.ankle.quaternion.copy(pq.invert().multiply(footQ));
    leg.ankle.updateMatrixWorld(true);
  };

  return {
    options,
    state,
    update(dt, action) {
      if (!usable) return;
      root.getWorldPosition(rootPos);
      if (!state.primed || dt > 0.1) {
        state.primed = true;
        vel.set(0, 0, 0);
      } else if (dt > 1e-4) vel.subVectors(rootPos, lastRoot).divideScalar(dt);
      lastRoot.copy(rootPos);
      const clip = action?.getClip().name ?? null;
      const known = clip === null ? undefined : stancesOf.get(clip);
      const list = known?.stances ?? [];
      const length = known?.seconds ?? action?.getClip().duration ?? 1;
      const t = action?.time ?? 0;
      const rate = Math.abs(action?.getEffectiveTimeScale() ?? 1) || 1;
      if (known === undefined && clip !== state.clip)
        console.warn(
          `animate: no measured stances for ${clip}; its feet follow the ground without holding`,
        );
      state.clip = clip;
      pelvisPart.begin();
      for (const leg of legs) for (const part of leg.parts) part.begin();
      for (const leg of legs) {
        leg.ball.getWorldPosition(a);
        leg.ankle.getWorldPosition(b);
        const x = (a.x + b.x) / 2;
        const z = (a.z + b.z) / 2;
        const p = phase(list, leg.foot, t, length);
        // World heights: the root climbs with the game, so a height kept from landing stays true.
        let height;
        if (known === undefined) height = options.ground(x, z);
        else if (p.inside) {
          // Landed: the ground under the foot once, held for the whole stance.
          if (!leg.planted || leg.held === null) leg.held = options.ground(x, z);
          height = leg.held;
        } else {
          // In the air: toward the height where it will land.
          const ahead = Number.isFinite(p.next) ? p.next / rate : 0;
          const land = options.ground(x + vel.x * ahead, z + vel.z * ahead);
          leg.held ??= land;
          height = leg.held + (land - leg.held) * Math.max(p.weight, 1 - Math.min(1, ahead / 0.25));
        }
        height -= rootPos.y;
        leg.planted = known !== undefined && p.inside;
        leg.offset += (height - leg.offset) * (1 - Math.exp(-options.rate * Math.max(dt, 0)));
      }
      const drop = Math.min(legs[0].offset, legs[1].offset);
      state.drop = drop;
      // The pelvis moves in its parent's frame: carry the world offset there.
      pelvis.parent.updateWorldMatrix(true, false);
      pelvis.getWorldPosition(a);
      b.copy(a).addScaledVector(UP, drop);
      pelvis.parent.worldToLocal(a);
      pelvis.parent.worldToLocal(b);
      pelvis.position.add(b.sub(a));
      pelvis.updateMatrixWorld(true);
      for (const leg of legs) solveLeg(leg, leg.offset - drop);
      pelvisPart.end();
      for (const leg of legs) for (const part of leg.parts) part.end();
    },
  };
}
