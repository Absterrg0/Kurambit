// Bot kit: the masher, the harness's random-input play. A stepped bot: it plays inside the
// game's page on the run's own clock, so a slow machine plays the same run, only later. It
// presses the shell's keyboard verbs at random with a fixed seed, so every build gets the same
// sequence: does random input win or lose, and when? Its first five seconds measure the first
// response: a second with no input gives the drift the game makes on its own (gravity, a
// settle, an auto-runner), then each direction is held for a second. A hold answered only
// counts when the opposite hold moved the other way, so movement the keys did not cause is
// never a response. Never presses Escape or P (pause): obs.keys leaves pause out.
export const goal = "press the shell's keys at random";

const DIRECTIONS = [
  ["KeyD", "ArrowRight"],
  ["KeyA", "ArrowLeft"],
  ["KeyW", "ArrowUp"],
  ["KeyS", "ArrowDown"],
];
const TAPS = ["Space", "ShiftLeft", "KeyE", "Enter", "KeyJ", "KeyK", "KeyZ", "KeyX"];
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
const vec = (at) => (at === null ? null : { x: at[0], y: at[1], z: at[2] });

/** The keys held this step, as the game's actions they press (obs.keys: key code → action). */
const pressing = (obs, codes) => [
  ...new Set(codes.flatMap((code) => (obs.keys?.[code] === undefined ? [] : [obs.keys[code]]))),
];

export function decide(obs) {
  const since = obs.t;
  const pos = vec(obs.player);
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
    return pressing(obs, DIRECTIONS[index]);
  }
  // A tap is down for this one step.
  let tap = [];
  if (since >= nextChange) {
    nextChange = since + 0.3 + random() * 0.5;
    const first = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
    const second = random() < 0.4 ? DIRECTIONS[Math.floor(random() * DIRECTIONS.length)] : [];
    mashHeld = [...new Set([...first, ...second])];
    if (random() < 0.6) tap = [TAPS[Math.floor(random() * TAPS.length)]];
  }
  return pressing(obs, [...mashHeld, ...tap]);
}

// A pair of opposite holds answered when both moved, and against each other.
const answered = (a, b) => {
  const x = holds[a];
  const y = holds[b];
  if (x.end === null || y.end === null || length(x.end) < MOVED || length(y.end) < MOVED) return [];
  const dot = x.end.x * y.end.x + x.end.y * y.end.y + x.end.z * y.end.z;
  return dot < 0 ? [x.answeredAfter, y.answeredAfter].filter((t) => t !== null) : [];
};

/** The bot's own evidence beside the run's answer: the first response. */
export function report() {
  const responses = [...answered(0, 1), ...answered(2, 3)];
  return {
    response: {
      positions,
      seconds: responses.length === 0 ? null : Number(Math.min(...responses).toFixed(2)),
      window: PROBE_HOLD,
    },
  };
}
