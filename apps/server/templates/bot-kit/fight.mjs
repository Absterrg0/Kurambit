// Bot kit: fighting. Attack and retreat patterns, keep-away, press/hold
// helpers, for 2D and 3D. Adapted from Aura's kit/control.py melee,
// strike_and_retreat, keep_away, press/hold_for (Apache-2.0,
// ramenvr/autopilot): the patterns are theirs, shaped to our runner (keys,
// not mouse aim; per-tick steps).

import { posOf, distXZ, dist2 } from "./sensors.mjs";
import { makeTapper } from "./steer.mjs";
import { makeWalkTo, driveWalk } from "./walk.mjs";

// Close in and strike with `key` every `cooldownS` while in `reach`,
// until targetDown() is true. step() returns "running" | "done" | "failed".
export function makeAttack(target, opts = {}) {
  const { key = "J", reach = 1.6, cooldownS = 0.5, timeoutS = 20, mode = "xz", keyMap = {} } = opts;
  const walk = makeWalkTo(target, {
    mode,
    within: reach * 0.8,
    timeoutS,
    keyMap,
    avoidDrops: false,
  });
  const tap = makeTapper(key, cooldownS);
  let strikes = 0;
  return {
    strikes: () => strikes,
    step(holds, api, raw, t, targetDown) {
      if (targetDown === true) {
        holds.set(api, []);
        return "done";
      }
      const d = typeof targetDown === "function" && targetDown() === true ? 0 : -1;
      if (d === 0) {
        holds.set(api, []);
        return "done";
      }
      const pos = posOf(raw);
      const goal = typeof target === "function" ? target() : target;
      if (pos === null || goal == null) return "running";
      const dist = mode === "xy" ? dist2(pos, goal) : distXZ(pos, goal);
      if (dist <= reach) {
        holds.set(api, []);
        if (tap.maybe(api, t)) strikes += 1;
        return "running";
      }
      return driveWalk(holds, walk, api, raw, t);
    },
  };
}

// Back off out of reach: hold away from threat for `seconds`, then done.
export function makeRetreat(threat, opts = {}) {
  const { seconds = 2.0, mode = "xz", keyMap = {} } = opts;
  let t0 = -1;
  return {
    step(holds, api, raw, t) {
      if (t0 < 0) t0 = t;
      if (t - t0 >= seconds) {
        holds.set(api, []);
        return "done";
      }
      const pos = posOf(raw);
      const at = typeof threat === "function" ? threat() : threat;
      if (pos === null || at == null) {
        holds.set(api, []);
        return "running";
      }
      const dx = pos.x - at.x;
      const dz = (pos.z ?? 0) - (at.z ?? 0);
      const dy = (pos.y ?? 0) - (at.y ?? 0);
      const n = Math.hypot(dx, mode === "xy" ? dy : dz) || 1;
      const away =
        mode === "xy"
          ? { x: pos.x + (dx / n) * 3, y: pos.y + (dy / n) * 3 }
          : { x: pos.x + (dx / n) * 3, z: pos.z + (dz / n) * 3 };
      holds.set(api, awayKeys(mode, away, pos, keyMap));
      return "running";
    },
  };
}

function awayKeys(mode, away, pos, keyMap) {
  if (mode === "xy") {
    const dx = away.x - pos.x;
    const dy = away.y - pos.y;
    const {
      negX = "ArrowLeft",
      posX = "ArrowRight",
      negY = "ArrowUp",
      posY = "ArrowDown",
    } = keyMap;
    const keys = [];
    if (dx > 0.2) keys.push(posX);
    else if (dx < -0.2) keys.push(negX);
    if (dy > 0.2) keys.push(posY);
    else if (dy < -0.2) keys.push(negY);
    return keys;
  }
  const dx = away.x - pos.x;
  const dz = (away.z ?? pos.z) - pos.z;
  const keys = [];
  if (dz < -0.2) keys.push("W");
  else if (dz > 0.2) keys.push("S");
  if (dx > 0.2) keys.push("D");
  else if (dx < -0.2) keys.push("A");
  return keys;
}

// Move away from a threat until `dist` away or timeoutS. Returns status.
export function makeKeepAway(threat, opts = {}) {
  const { dist = 4, timeoutS = 6, mode = "xz", keyMap = {} } = opts;
  const retreat = makeRetreat(threat, { seconds: timeoutS, mode, keyMap });
  return {
    step(holds, api, raw, t) {
      const pos = posOf(raw);
      const at = typeof threat === "function" ? threat() : threat;
      if (pos !== null && at != null) {
        const d = mode === "xy" ? dist2(pos, at) : distXZ(pos, at);
        if (d >= dist) {
          holds.set(api, []);
          return "done";
        }
      }
      return retreat.step(holds, api, raw, t);
    },
  };
}

// Strike-and-retreat: approach, strike `strikes` times, back off to recover,
// repeat until targetDown() or timeoutS. For fights a plain attack loses.
export function makeStrikeAndRetreat(target, threat, opts = {}) {
  const {
    key = "J",
    reach = 1.6,
    strikes = 1,
    cooldownS = 0.5,
    retreatDist = 4,
    recoverS = 2.0,
    timeoutS = 30,
    mode = "xz",
    keyMap = {},
  } = opts;
  const attack = makeAttack(target, { key, reach, cooldownS, timeoutS, mode, keyMap });
  const away = makeKeepAway(threat, { dist: retreatDist, timeoutS: 6, mode, keyMap });
  let phase = "in";
  let made = 0;
  let t0 = -1;
  let recoverAt = 0;
  return {
    step(holds, api, raw, t, targetDown) {
      if (t0 < 0) t0 = t;
      if (t - t0 > timeoutS) {
        holds.set(api, []);
        return "failed";
      }
      const down = typeof targetDown === "function" ? targetDown() : targetDown === true;
      if (down === true) {
        holds.set(api, []);
        return "done";
      }
      if (phase === "in") {
        const r = attack.step(holds, api, raw, t, false);
        if (attack.strikes() > made) {
          made = attack.strikes();
          if (made >= strikes) {
            phase = "out";
            recoverAt = 0;
          }
        }
        if (r === "failed") return "failed";
        return "running";
      }
      const r = away.step(holds, api, raw, t);
      if (r === "done") {
        if (recoverAt === 0) recoverAt = t;
        if (t - recoverAt >= recoverS) {
          phase = "in";
          made = 0;
        }
      }
      return "running";
    },
  };
}
