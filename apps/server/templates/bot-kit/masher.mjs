// Bot kit: the masher tier. Starts a run, then plays the shell's keyboard
// verbs at random with a fixed seed, so every build gets the same sequence:
// does random input win or lose, and when? Its first five seconds measure the
// first response: a second with no input gives the drift the game makes on
// its own (gravity, a settle, an auto-runner), then each direction is held
// for a second. A hold answered only counts when the opposite hold moved the
// other way, so movement the keys did not cause is never a response. Never
// presses Escape or P (pause).
import { makeTier } from "./tier.mjs";

const DIRECTIONS = [
  ["D", "ArrowRight"],
  ["A", "ArrowLeft"],
  ["W", "ArrowUp"],
  ["S", "ArrowDown"],
];
const TAPS = ["Space", "Shift", "E", "Enter", "J", "K", "Z", "X"];
const BASELINE = 1;
const PROBE_HOLD = 1;
const MOVED = 0.05;

// mulberry32: a small seeded generator, so the sequence is the same on every build.
let seed = 0x9e3779b9;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

let baseline = { from: null, startedAt: 0, drift: null };
let probe = null;
// Per direction: when it first answered, and where the hold ended, both net of drift.
const holds = DIRECTIONS.map(() => ({ answeredAfter: null, end: null }));
let positions = false;
let nextChange = 0;
let mashHeld = [];

const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const length = (v) => Math.hypot(v.x, v.y, v.z);

const drive = (api, { since, pos }) => {
  if (pos !== null) positions = true;
  if (since < BASELINE) {
    if (baseline.from === null && pos !== null)
      baseline = { from: pos, startedAt: since, drift: null };
    if (baseline.from !== null && pos !== null && since > baseline.startedAt) {
      const span = since - baseline.startedAt;
      const moved = minus(pos, baseline.from);
      baseline.drift = { x: moved.x / span, y: moved.y / span, z: moved.z / span };
    }
    return [];
  }
  const index = Math.floor((since - BASELINE) / PROBE_HOLD);
  if (index < DIRECTIONS.length) {
    if (probe === null || probe.index !== index) probe = { index, startedAt: since, from: pos };
    if (probe.from !== null && pos !== null) {
      const drift = baseline.drift ?? { x: 0, y: 0, z: 0 };
      const dt = since - probe.startedAt;
      const net = minus(minus(pos, probe.from), {
        x: drift.x * dt,
        y: drift.y * dt,
        z: drift.z * dt,
      });
      const hold = holds[index];
      hold.end = net;
      if (hold.answeredAfter === null && length(net) >= MOVED) hold.answeredAfter = dt;
    }
    return DIRECTIONS[index];
  }
  if (since >= nextChange) {
    nextChange = since + 0.3 + random() * 0.5;
    const first = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
    const second = random() < 0.4 ? DIRECTIONS[Math.floor(random() * DIRECTIONS.length)] : [];
    mashHeld = [...new Set([...first, ...second])];
    if (random() < 0.6) api.press(TAPS[Math.floor(random() * TAPS.length)]);
  }
  return mashHeld;
};

// A pair of opposite holds answered when both moved, and against each other.
const answered = (a, b) => {
  const x = holds[a];
  const y = holds[b];
  if (x.end === null || y.end === null || length(x.end) < MOVED || length(y.end) < MOVED) return [];
  const dot = x.end.x * y.end.x + x.end.y * y.end.y + x.end.z * y.end.z;
  return dot < 0 ? [x.answeredAfter, y.answeredAfter].filter((t) => t !== null) : [];
};

const tier = makeTier("masher", drive);
export const { goal, observe, options } = tier;
export { stallSeconds } from "./tier.mjs";
export const status = (obs) => {
  const responses = [...answered(0, 1), ...answered(2, 3)];
  return tier.status(obs, {
    response: {
      positions,
      seconds: responses.length === 0 ? null : Number(Math.min(...responses).toFixed(2)),
      window: PROBE_HOLD,
    },
  });
};
