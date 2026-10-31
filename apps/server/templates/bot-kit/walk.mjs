// Bot kit: walking. Walk to a point or node with stuck handling and sensed
// walls/drops, running through our runner (per-tick step functions).
// Adapted from Aura's kit/control.py walk_to + kit/nav.py (Apache-2.0,
// ramenvr/autopilot): no waypoints, no map; the target is re-read every
// tick and the walk steers, hops when stuck, and stops at sensed edges.

import { posOf, clearance, dropAhead, distXZ, dist2 } from "./sensors.mjs";
import { keysForXZ, keysForXY } from "./steer.mjs";

// target: {x, y?, z?} or () => point|null. mode "xz" (3D/third-person) or
// "xy" (top-down 2D screen plane). opts: within (m), timeoutS, jumpWhenStuck
// (Space hop after stillS), stillS, avoidDrops, avoidWalls (min clearance m),
// keyMap (2D bindings + optional crouch key), onStuck(api) override.
export function makeWalkTo(target, opts = {}) {
  const {
    mode = "xz",
    within = 1.2,
    timeoutS = 15,
    jumpWhenStuck = true,
    stillS = 2.0,
    avoidDrops = true,
    avoidWalls = true,
    wallGap = 1.0,
    keyMap = {},
    onStuck = null,
  } = opts;
  let lastPos = null;
  let lastMoveT = 0;
  let t0 = -1;
  let hops = 0;
  return {
    hops: () => hops,
    step(api, raw, t) {
      const goal = typeof target === "function" ? target() : target;
      if (goal === null || goal === undefined) return "failed";
      const pos = posOf(raw);
      if (pos === null) return "running";
      if (t0 < 0) {
        t0 = t;
        lastMoveT = t;
        lastPos = { ...pos };
      }
      const d = mode === "xy" ? dist2(pos, { x: goal.x, y: goal.y ?? pos.y }) : distXZ(pos, goal);
      if (d <= within) return "done";
      if (t - t0 > timeoutS) return "failed";
      const dx = goal.x - pos.x;
      const dz = (goal.z ?? pos.z) - pos.z;
      const dy = (goal.y ?? pos.y) - pos.y;
      let keys = mode === "xy" ? keysForXY(dx, dy, keyMap) : keysForXZ(dx, dz);
      // Sensed walls: don't walk into a short clearance.
      if (avoidWalls && mode === "xz") {
        const clear = clearance(raw, dx, dz);
        if (clear !== null && clear < wallGap) {
          // Sidestep: try the perpendicular with more room.
          const left = clearance(raw, dz, -dx) ?? 0;
          const right = clearance(raw, -dz, dx) ?? 0;
          const s = left >= right ? [dz, -dx] : [-dz, dx];
          keys = keysForXZ(s[0], s[1]);
        }
      }
      // Sensed drops: stop at the edge, never walk off it.
      if (avoidDrops && mode === "xz" && dropAhead(raw, dx, dz)) return "failed";
      const moved =
        lastPos === null
          ? 99
          : mode === "xy"
            ? Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y)
            : Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z);
      if (moved > 0.3) lastMoveT = t;
      lastPos = { ...pos };
      const stuck = t - lastMoveT > stillS && keys.length > 0;
      return { keys, stuck, dy };
    },
    // Default stuck response: one Space hop, then keep walking.
    stuck(api, state) {
      if (onStuck !== null) return onStuck(api, state);
      if (!jumpWhenStuck || hops >= 6) return "failed";
      api.press("Space");
      hops += 1;
      return "running";
    },
  };
}

// Drive a makeWalkTo walker: holds its keys, hops when stuck, releases on
// arrival. Returns "running" | "done" | "failed".
export function driveWalk(holds, walker, api, raw, t) {
  const state = walker.step(api, raw, t);
  if (state === "done" || state === "failed") {
    holds.set(api, []);
    return state;
  }
  if (state.stuck === true) {
    const r = walker.stuck(api, state);
    if (r === "failed") {
      holds.set(api, []);
      return "failed";
    }
  }
  holds.set(api, state.keys);
  return "running";
}

// Face (move toward) a target without arriving: steering only.
export function faceKeys(mode, pos, goal, keyMap = {}) {
  if (mode === "xy") return keysForXY(goal.x - pos.x, (goal.y ?? pos.y) - pos.y, keyMap);
  return keysForXZ(goal.x - pos.x, (goal.z ?? pos.z) - pos.z);
}
