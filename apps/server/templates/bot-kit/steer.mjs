// Bot kit: steering. Hold keys toward a target, release what isn't held.
// The runner has no mouse-look: "facing" a target means moving toward it
// (top-down 2D) or walking its way (3D world axes). Attacks aim by standing
// close, not by turning a camera.

const KNOWN = [
  "W",
  "A",
  "S",
  "D",
  "Shift",
  "Space",
  "Enter",
  "E",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

// Key sets for an XZ offset (3D world axes: -Z forward, +X right).
export function keysForXZ(dx, dz, dead = 0.6) {
  const keys = [];
  if (dz < -dead) keys.push("W");
  else if (dz > dead) keys.push("S");
  if (dx > dead) keys.push("D");
  else if (dx < -dead) keys.push("A");
  return keys;
}

// Key sets for a 2D screen offset. keyMap names the game's own bindings:
// {negX, posX, negY, posY} defaulting to arrows (screen up = -Y).
export function keysForXY(dx, dy, keyMap = {}) {
  const { negX = "ArrowLeft", posX = "ArrowRight", negY = "ArrowUp", posY = "ArrowDown" } = keyMap;
  const keys = [];
  if (dx > 0.5) keys.push(posX);
  else if (dx < -0.5) keys.push(negX);
  if (dy > 0.5) keys.push(posY);
  else if (dy < -0.5) keys.push(negY);
  return keys;
}

// Stateful held-key tracking across ticks (call once per tick).
export function makeHolds() {
  const held = new Set();
  return {
    set(api, keys) {
      const want = new Set(keys);
      for (const k of [...KNOWN, ...want]) {
        if (want.has(k)) {
          if (!held.has(k)) {
            api.hold(k);
            held.add(k);
          }
        } else if (held.has(k)) {
          api.release(k);
          held.delete(k);
        }
      }
    },
    releaseAll(api) {
      for (const k of [...held]) {
        api.release(k);
        held.delete(k);
      }
    },
  };
}

// Press a key, at most every `cooldownS` game seconds. Returns true when pressed.
export function makeTapper(key, cooldownS) {
  let last = -1e9;
  return {
    maybe(api, t) {
      if (t - last >= cooldownS) {
        last = t;
        api.press(key);
        return true;
      }
      return false;
    },
  };
}

// Hold a key for `seconds`, then release. Step each tick; returns true when done.
export function makeHoldFor(key, seconds) {
  let held = false;
  let t0 = 0;
  return {
    step(api, t) {
      if (!held) {
        held = true;
        t0 = t;
        api.hold(key);
        return "running";
      }
      if (t - t0 >= seconds) {
        api.release(key);
        return "done";
      }
      return "running";
    },
    cancel(api) {
      if (held) api.release(key);
      held = false;
    },
  };
}
