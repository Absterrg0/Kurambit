// Bot kit: the masher tier. Starts a run, then plays the shell's keyboard
// verbs at random with a fixed seed, so every build gets the same sequence:
// does random input win or lose, and when? Its first four seconds hold each
// direction for a second to measure the first response: how long after a
// held key the player moved. Never presses Escape or P (pause).
import { makeTier } from "./tier.mjs";

const DIRECTIONS = [
  ["D", "ArrowRight"],
  ["A", "ArrowLeft"],
  ["W", "ArrowUp"],
  ["S", "ArrowDown"],
];
const TAPS = ["Space", "Shift", "E", "Enter", "J", "K", "Z", "X"];
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

let probe = { index: -1, startedAt: 0, from: null, answered: false };
const responses = [];
let positions = false;
let nextChange = 0;
let mashHeld = [];

const drive = (api, { since, pos }) => {
  if (pos !== null) positions = true;
  const index = Math.floor(since / PROBE_HOLD);
  if (index < DIRECTIONS.length) {
    if (index !== probe.index) probe = { index, startedAt: since, from: pos, answered: false };
    if (!probe.answered && probe.from !== null && pos !== null) {
      const moved = Math.hypot(pos.x - probe.from.x, pos.y - probe.from.y, pos.z - probe.from.z);
      if (moved >= MOVED) {
        probe.answered = true;
        responses.push(since - probe.startedAt);
      }
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

const tier = makeTier("masher", drive);
export const { goal, observe, options } = tier;
export { stallSeconds } from "./tier.mjs";
export const status = (obs) =>
  tier.status(obs, {
    response: {
      positions,
      seconds: responses.length === 0 ? null : Math.min(...responses),
      window: PROBE_HOLD,
    },
  });
