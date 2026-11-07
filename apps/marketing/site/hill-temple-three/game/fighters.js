// The hero and the bandits, ported from round 2's hero.gd and bandit.gd: the same states, speeds,
// windows and AI. Clips come from the Universal Animation Library on the standard skeleton
// (idle, locomotion, the first cut, roll, hits, death) plus round 2's hand-keyed backhand cut
// and dodge steps, crossfaded on one AnimationMixer per body.
import * as THREE from "../vendor/three.module.js";
import { collide } from "./world.js";
import { groundAt } from "./level.js";

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, t) => a + wrap(b - a) * t;
const fwdOf = (f, out = new THREE.Vector3()) => out.set(-Math.sin(f), 0, -Math.cos(f));
const moveToward = (v, target, maxDelta) => {
  const d = new THREE.Vector3().subVectors(target, v);
  const l = d.length();
  if (l <= maxDelta || l === 0) return v.copy(target);
  return v.addScaledVector(d, maxDelta / l);
};

/**
 * One body's clips: play(name, {fade, speed, once, reverse}) crossfades into a clip on the shared
 * mixer; `time` is the current clip's own seconds, `done` whether a one-shot ended.
 */
function clipPlayer(animator) {
  const mixer = animator.mixer;
  mixer.stopAllAction();
  const byName = new Map(animator.root.animations.map((c) => [c.name, c]));
  let cur = null;
  let curName = "";
  return {
    has: (n) => byName.has(n),
    get name() {
      return curName;
    },
    get time() {
      return cur === null ? 0 : cur.time;
    },
    get duration() {
      return cur === null ? 1 : cur.getClip().duration;
    },
    play(name, { fade = 0.2, speed = 1, once = false, reverse = false, from = null, restart = true } = {}) {
      const clip = byName.get(name);
      if (clip === undefined) {
        console.warn(`no clip ${name}`);
        return;
      }
      const a = mixer.clipAction(clip);
      if (cur === a && !restart) {
        a.timeScale = reverse ? -speed : speed;
        return;
      }
      const prev = cur;
      a.reset();
      a.enabled = true;
      a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      a.clampWhenFinished = once;
      a.timeScale = reverse ? -speed : speed;
      if (reverse) a.time = clip.duration;
      else if (from !== null) a.time = from;
      else if (!once && prev !== null && prev.loop === THREE.LoopRepeat && prev !== a)
        a.time = (prev.time / prev.getClip().duration) * clip.duration; // keep the step phase
      a.setEffectiveWeight(1);
      a.play();
      if (prev !== null && prev !== a) prev.crossFadeTo(a, fade, false);
      cur = a;
      curName = name;
    },
    loco(name, speed, fade = 0.25) {
      if (curName === name) cur.timeScale = speed;
      else this.play(name, { fade, speed });
    },
  };
}

/** Ground speed (m/s) of a locomotion clip at rate 1, from the export's sidecar. */
const groundSpeed = (model, clip, fallback) =>
  model.userData.asset?.clips?.find((c) => c.name === clip)?.groundSpeed ?? fallback;

/**
 * Where the sword's blade runs, in the right hand bone's frame: measured once per model from the
 * vertices skinned wholly to that hand (the blade and grip), farthest one the tip.
 */
const bladeCache = new WeakMap();
function findBlade(root) {
  const hand = root.getObjectByName("hand_r");
  if (hand === undefined) return null;
  let mesh = null;
  root.traverse((o) => {
    if (o.isSkinnedMesh && mesh === null) mesh = o;
  });
  if (mesh === null) return null;
  const key = mesh.geometry;
  if (!bladeCache.has(key)) {
    const bones = mesh.skeleton.bones;
    const bi = bones.findIndex((b) => b.name === "hand_r");
    const inv = mesh.skeleton.boneInverses[bi];
    const pos = mesh.geometry.attributes.position;
    const si = mesh.geometry.attributes.skinIndex;
    const sw = mesh.geometry.attributes.skinWeight;
    const v = new THREE.Vector3();
    const pts = [];
    for (let i = 0; i < pos.count; i++)
      if (si.getX(i) === bi && sw.getX(i) > 0.98) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix).applyMatrix4(inv);
        pts.push(v.clone());
      }
    let tip = null;
    for (const p of pts) if (tip === null || p.length() > tip.length()) tip = p;
    // the base: a third of the way from the grip to the tip, so the trail follows the blade, not the hilt
    const base = tip === null ? null : tip.clone().multiplyScalar(0.25);
    bladeCache.set(key, tip !== null && tip.length() > 0.4 ? { base, tip } : null);
  }
  const found = bladeCache.get(key);
  return found === null ? null : { hand, base: found.base, tip: found.tip };
}

export const HERO = {
  WALK: 1.3,
  JOG: 4.0,
  SPRINT: 6.0,
  ACCEL: 22,
  DECEL: 26,
  TURN: 14,
  MAX_HP: 100,
  STEP_LEN: 14 / 30 / 1.25,
  STEP_IFRAMES: 0.24,
  ROLL_LEN: 0.95,
  ROLL_IFRAMES: 0.42,
};

/**
 * The swordsman. `opts.clips` names his clips; `events` gets hit, hurt, died, step, swing,
 * roll, footstep callbacks for sound and effects.
 */
export function createHero(animator, events, clips) {
  const root = animator.root;
  const anim = clipPlayer(animator);
  const C = clips;
  const jogSpeed = groundSpeed(root, C.jog, 3.9);
  const walkSpeed = groundSpeed(root, C.walk, 1.35);
  const sprintSpeed = groundSpeed(root, C.sprint, 6.2);
  const combo = C.combo;
  const body = {
    root,
    anim,
    pos: root.position,
    vel: new THREE.Vector3(),
    facing: 0,
    state: "move",
    t: 0,
    hp: HERO.MAX_HP,
    combo: 0,
    hitDone: false,
    moveDir: new THREE.Vector3(0, 0, -1),
    buffers: { attack: 0, step: 0, roll: 0 },
    invulnerable: false,
    radius: 0.34,
    blade: findBlade(root),
    stepPhase: 0,
    alive: () => body.state !== "dead",
    forward: (out) => fwdOf(body.facing, out),
    face(dir) {
      if (dir.lengthSq() > 1e-4) body.facing = Math.atan2(-dir.x, -dir.z);
    },
    requestAttack: () => (body.buffers.attack = 0.3),
    requestStep: () => (body.buffers.step = 0.2),
    requestRoll: () => (body.buffers.roll = 0.2),
  };
  anim.play(C.idle, { fade: 0 });

  const softTarget = (foes, dir) => {
    let best = null;
    let bd = 4;
    for (const f of foes) {
      if (!f.alive()) continue;
      const to = new THREE.Vector3(f.pos.x - body.pos.x, 0, f.pos.z - body.pos.z);
      const d = to.length();
      if (d < bd && (dir.lengthSq() < 0.01 || dir.clone().normalize().dot(to.divideScalar(Math.max(d, 0.01))) > -0.2)) {
        bd = d;
        best = f;
      }
    }
    return best;
  };
  const startAttack = (wish, n, foes) => {
    body.buffers.attack = 0;
    body.state = "attack";
    body.combo = n;
    body.t = 0;
    body.hitDone = false;
    const tgt = softTarget(foes, wish.lengthSq() > 0.01 ? wish : body.forward(new THREE.Vector3()));
    if (tgt !== null) body.face(new THREE.Vector3().subVectors(tgt.pos, body.pos));
    else if (wish.lengthSq() > 0.01) body.face(wish);
    const c = combo[n];
    anim.play(c.clip, { fade: n === 0 ? 0.08 : 0.05, speed: c.speed, once: true, from: c.from ?? 0 });
    events.swing?.(n);
  };
  const startStep = (wish, foes) => {
    body.buffers.step = 0;
    body.state = "step";
    body.t = 0;
    const tgt = softTarget(foes, body.forward(new THREE.Vector3()));
    if (tgt !== null) body.face(new THREE.Vector3().subVectors(tgt.pos, body.pos));
    const fwd = body.forward(new THREE.Vector3());
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    body.moveDir.copy(wish.lengthSq() < 0.01 ? fwd.clone().negate() : wish.clone().normalize());
    const side = body.moveDir.dot(right);
    const ahead = body.moveDir.dot(fwd);
    if (Math.abs(side) > Math.abs(ahead)) anim.play(side > 0 ? C.dodgeRight : C.dodgeLeft, { fade: 0.04, speed: 1.25, once: true });
    else anim.play(C.dodgeBack, { fade: 0.04, speed: 1.25, once: true, reverse: ahead > 0 });
    events.step?.();
  };
  const startRoll = (wish) => {
    body.buffers.roll = 0;
    body.state = "roll";
    body.t = 0;
    body.moveDir.copy(wish.lengthSq() > 0.01 ? wish.clone().normalize() : body.forward(new THREE.Vector3()));
    body.face(body.moveDir);
    anim.play(C.roll, { fade: 0.06, speed: C.rollSpeed, once: true });
    events.roll?.();
  };
  const checkHit = (c, foes) => {
    const fwd = body.forward(new THREE.Vector3());
    let any = false;
    for (const f of foes) {
      if (!f.alive()) continue;
      const to = new THREE.Vector3(f.pos.x - body.pos.x, 0, f.pos.z - body.pos.z);
      if (to.length() < 2.5 && fwd.dot(to.clone().normalize()) > 0.25) {
        any = true;
        f.hit(to.normalize(), c.dmg);
      }
    }
    if (any) {
      body.hitDone = true;
      events.hit?.(body.combo);
    }
  };

  body.takeHit = (dir, dmg) => {
    if (body.state === "dead" || body.invulnerable) return false;
    body.hp = Math.max(body.hp - dmg, 0);
    body.vel.copy(dir).multiplyScalar(3.5);
    body.face(dir.clone().negate());
    body.t = 0;
    if (body.hp <= 0) {
      body.state = "dead";
      anim.play(C.death, { fade: 0.1, once: true });
      events.died?.();
    } else {
      body.state = "hit";
      anim.play(Math.random() < 0.5 ? C.hit : C.hit2, { fade: 0.05, speed: 1.3, once: true });
      events.hurt?.(dmg);
    }
    return true;
  };

  /** One step: wish is the camera-relative move (length <= 1), input flags, the living foes. */
  body.update = (dt, wish, { sprint = false, walk = false }, foes) => {
    const b = body.buffers;
    b.attack = Math.max(b.attack - dt, 0);
    b.step = Math.max(b.step - dt, 0);
    b.roll = Math.max(b.roll - dt, 0);
    const hv = new THREE.Vector3(body.vel.x, 0, body.vel.z);
    body.t += dt;
    switch (body.state) {
      case "move": {
        if (b.roll > 0) startRoll(wish);
        else if (b.step > 0) startStep(wish, foes);
        else if (b.attack > 0) startAttack(wish, 0, foes);
        else {
          const top = sprint ? HERO.SPRINT : walk ? HERO.WALK : HERO.JOG;
          const desired = wish.clone().clampLength(0, 1).multiplyScalar(top);
          moveToward(hv, desired, (desired.length() > hv.length() ? HERO.ACCEL : HERO.DECEL) * dt);
          if (wish.lengthSq() > 0.01) body.facing = lerpAngle(body.facing, Math.atan2(-wish.x, -wish.z), 1 - Math.exp(-HERO.TURN * dt));
          const sp = hv.length();
          if (sp < 0.25) anim.loco(C.idle, 1, 0.3);
          else if (sp < 2.4) anim.loco(C.walk, Math.max(sp / walkSpeed, 0.6));
          else if (sp < 5.0) anim.loco(C.jog, sp / jogSpeed, 0.2);
          else anim.loco(C.sprint, sp / sprintSpeed, 0.2);
        }
        break;
      }
      case "attack": {
        const c = combo[body.combo];
        const lunge = body.t > c.lunge[0] && body.t < c.lunge[1] ? c.lungeV : 0;
        moveToward(hv, body.forward(new THREE.Vector3()).multiplyScalar(lunge), 40 * dt);
        if (body.t < 0.08 && wish.lengthSq() > 0.01 && softTarget(foes, wish) === null)
          body.facing = lerpAngle(body.facing, Math.atan2(-wish.x, -wish.z), 1 - Math.exp(-20 * dt));
        if (!body.hitDone && body.t >= c.hit[0] && body.t <= c.hit[1]) checkHit(c, foes);
        if (body.t > c.hit[1] + 0.03 && (b.step > 0 || b.roll > 0)) {
          if (b.roll > 0) startRoll(wish);
          else startStep(wish, foes);
        } else if (body.t > c.chain && b.attack > 0 && body.combo + 1 < combo.length) startAttack(wish, body.combo + 1, foes);
        else if (body.t > c.len * 0.8 && b.attack > 0) startAttack(wish, 0, foes);
        else if (body.t > c.len * 0.72 && wish.lengthSq() > 0.04) body.state = "move";
        else if (body.t >= c.len) body.state = "move";
        break;
      }
      case "step": {
        const k = Math.min(body.t / HERO.STEP_LEN, 1);
        hv.copy(body.moveDir).multiplyScalar(7.5 * (1 - k) ** 2 + 0.2);
        body.invulnerable = body.t < HERO.STEP_IFRAMES;
        if (body.t >= HERO.STEP_LEN) {
          body.state = "move";
          body.invulnerable = false;
        } else if (body.t > HERO.STEP_LEN * 0.6 && b.attack > 0) {
          body.invulnerable = false;
          startAttack(wish, 0, foes);
        }
        break;
      }
      case "roll": {
        const k = Math.min(body.t / HERO.ROLL_LEN, 1);
        hv.copy(body.moveDir).multiplyScalar(8.0 * (1 - k) ** 1.4 + 0.6);
        body.invulnerable = body.t < HERO.ROLL_IFRAMES;
        if (body.t >= HERO.ROLL_LEN * 0.88) {
          body.state = "move";
          body.invulnerable = false;
          events.land?.();
        }
        break;
      }
      case "hit":
        moveToward(hv, new THREE.Vector3(), 12 * dt);
        if (body.t > 0.42) body.state = "move";
        break;
      case "dead":
        moveToward(hv, new THREE.Vector3(), 10 * dt);
        break;
    }
    body.vel.set(hv.x, 0, hv.z);
    const before = body.pos.clone();
    body.pos.x += hv.x * dt;
    body.pos.z += hv.z * dt;
    collide(body.pos, body.radius);
    for (const f of foes) {
      // bodies do not overlap: the hero is pushed off a living foe
      if (!f.alive()) continue;
      const dx = body.pos.x - f.pos.x;
      const dz = body.pos.z - f.pos.z;
      const d = Math.hypot(dx, dz);
      const min = body.radius + f.radius;
      if (d < min && d > 1e-4) {
        body.pos.x = f.pos.x + (dx / d) * min;
        body.pos.z = f.pos.z + (dz / d) * min;
      }
    }
    const gy = groundAt(body.pos.x, body.pos.z);
    body.pos.y += (gy - body.pos.y) * Math.min(1, dt * 18);
    if (Math.abs(gy - body.pos.y) > 0.6) body.pos.y = gy;
    root.rotation.y = body.facing + Math.PI;
    body.moved = Math.hypot(body.pos.x - before.x, body.pos.z - before.z) / Math.max(dt, 1e-5);
    // footsteps from the locomotion clip's phase: two strikes a cycle
    if (body.state === "move" && hv.length() > 0.6) {
      const phase = (anim.time / anim.duration) % 1;
      const half = phase < 0.5 ? 0 : 1;
      if (half !== body.stepPhase) events.footstep?.(hv.length());
      body.stepPhase = half;
    }
  };
  return body;
}

export const BANDIT = { MAX_HP: 85, AGGRO: 13, REACH: 2.1, ATK_SPEED: 0.78, DMG: 22 };

/** A bandit: idle at his post, chase, circle at the edge of reach, wind up, cut, recover. */
export function createBandit(animator, events, clips, { hp = BANDIT.MAX_HP, dmg = BANDIT.DMG, name = "Bandit" } = {}) {
  const root = animator.root;
  const anim = clipPlayer(animator);
  const C = clips;
  const jogSpeed = groundSpeed(root, C.jog, 3.9);
  const walkSpeed = groundSpeed(root, C.walk, 1.35);
  const atk = C.attack;
  const body = {
    root,
    name,
    anim,
    pos: root.position,
    vel: new THREE.Vector3(),
    facing: 0,
    state: "idle",
    t: 0,
    hp,
    maxHp: hp,
    cooldown: 1,
    circleDir: Math.random() < 0.5 ? 1 : -1,
    hitDone: false,
    radius: 0.34,
    hurtFlash: 0,
    blade: findBlade(root),
    alive: () => body.state !== "dead",
    forward: (out) => fwdOf(body.facing, out),
  };
  anim.play(C.idle, { fade: 0 });
  const turnTo = (to, rate, dt) => {
    if (to.lengthSq() > 0.0025) body.facing = lerpAngle(body.facing, Math.atan2(-to.x, -to.z), 1 - Math.exp(-rate * dt));
  };
  body.hit = (dir, dmg) => {
    if (body.state === "dead") return;
    body.hp = Math.max(body.hp - dmg, 0);
    body.vel.copy(dir).multiplyScalar(4);
    body.facing = Math.atan2(dir.x, dir.z);
    body.t = 0;
    body.hurtFlash = 1;
    if (body.hp <= 0) {
      body.state = "dead";
      anim.play(C.death, { fade: 0.06, once: true });
      events.died?.(body, dir);
    } else {
      body.state = "hit";
      anim.play(Math.random() < 0.6 ? C.hit : C.hit2, { fade: 0.04, speed: 1.35, once: true });
      body.cooldown = Math.max(body.cooldown, 0.6);
      events.hurt?.(body, dir, dmg);
    }
  };
  body.update = (dt, hero, token = null) => {
    body.t += dt;
    body.cooldown = Math.max(body.cooldown - dt, 0);
    body.hurtFlash = Math.max(0, body.hurtFlash - dt * 4);
    const hv = new THREE.Vector3(body.vel.x, 0, body.vel.z);
    const to = new THREE.Vector3(hero.pos.x - body.pos.x, 0, hero.pos.z - body.pos.z);
    const dist = to.length();
    const ok = hero.alive();
    switch (body.state) {
      case "idle":
        moveToward(hv, new THREE.Vector3(), 10 * dt);
        anim.loco(C.idle, 1, 0.3);
        if (ok && dist < BANDIT.AGGRO) {
          body.state = "chase";
          body.t = 0;
          events.aggro?.(body);
        }
        break;
      case "chase": {
        if (!ok) {
          body.state = "idle";
          break;
        }
        turnTo(to, 8, dt);
        const sp = dist > 4 ? 3.4 : 1.6;
        moveToward(hv, body.forward(new THREE.Vector3()).multiplyScalar(sp), 14 * dt);
        if (sp > 2.4) anim.loco(C.jog, sp / jogSpeed, 0.2);
        else anim.loco(C.walk, sp / walkSpeed, 0.2);
        if (dist < BANDIT.REACH + 0.6) {
          body.state = "circle";
          body.t = 0;
        } else if (dist > BANDIT.AGGRO * 1.8) body.state = "idle";
        break;
      }
      case "circle": {
        if (!ok) {
          body.state = "idle";
          break;
        }
        turnTo(to, 10, dt);
        const n = to.clone().normalize();
        const side = new THREE.Vector3(-n.z, 0, n.x).multiplyScalar(body.circleDir);
        const keep = n.multiplyScalar(Math.min(Math.max(dist - BANDIT.REACH, -1), 1));
        moveToward(hv, side.multiplyScalar(1.2).add(keep.multiplyScalar(1.6)), 10 * dt);
        anim.loco(C.walk, Math.max(hv.length() / walkSpeed, 0.7), 0.25);
        // one bandit attacks at a time (the token), so a pair takes turns and every wind-up reads
        if (body.cooldown <= 0 && dist < BANDIT.REACH + 0.5 && (token === null || token.take(body))) {
          body.state = "attack";
          body.t = 0;
          body.hitDone = false;
          anim.play(atk.clip, { fade: 0.1, speed: BANDIT.ATK_SPEED * atk.speed, once: true, from: atk.from ?? 0 });
          events.windup?.(body);
        } else if (dist > BANDIT.REACH + 2) body.state = "chase";
        else if (body.t > 1.6) {
          body.circleDir = -body.circleDir;
          body.t = 0;
        }
        break;
      }
      case "attack": {
        const k = 1 / (BANDIT.ATK_SPEED * atk.speed);
        if (body.t < atk.track * k) turnTo(to, 6, dt); // tracks through the wind-up, then commits
        const lunge = body.t > atk.lunge[0] * k && body.t < atk.lunge[1] * k ? 2.6 : 0;
        moveToward(hv, body.forward(new THREE.Vector3()).multiplyScalar(lunge), 30 * dt);
        if (!body.hitDone && body.t > atk.hit[0] * k && body.t < atk.hit[1] * k && ok) {
          if (dist < BANDIT.REACH + 0.4 && body.forward(new THREE.Vector3()).dot(to.clone().normalize()) > 0.35) {
            body.hitDone = true;
            hero.takeHit(to.clone().normalize(), body.dmg ?? BANDIT.DMG);
          }
        }
        if (body.t >= atk.len * k) {
          body.state = "recover";
          body.t = 0;
        }
        break;
      }
      case "recover":
        moveToward(hv, new THREE.Vector3(), 10 * dt);
        anim.loco(C.idle, 1, 0.3);
        if (body.t > 0.55) {
          body.state = "circle";
          body.t = 0;
          body.cooldown = 1.2 + Math.random();
        }
        break;
      case "hit":
        moveToward(hv, new THREE.Vector3(), 9 * dt);
        if (body.t > 0.5) {
          body.state = "circle";
          body.t = 0;
        }
        break;
      case "dead":
        moveToward(hv, new THREE.Vector3(), 8 * dt);
        break;
    }
    body.vel.set(hv.x, 0, hv.z);
    body.pos.x += hv.x * dt;
    body.pos.z += hv.z * dt;
    if (body.state !== "dead") collide(body.pos, body.radius);
    const gy = groundAt(body.pos.x, body.pos.z);
    body.pos.y += (gy - body.pos.y) * Math.min(1, dt * 18);
    root.rotation.y = body.facing + Math.PI;
  };
  body.dmg = dmg;
  return body;
}

const _m = new THREE.Matrix4();
/** The blade's base and tip in world space, for the trail. */
export function bladeEnds(body, base, tip) {
  if (body.blade === null) return false;
  _m.copy(body.blade.hand.matrixWorld);
  base.copy(body.blade.base).applyMatrix4(_m);
  tip.copy(body.blade.tip).applyMatrix4(_m);
  return true;
}
