// Record and replay. The shell steps play in fixed slices of real time (one display frame at the
// display's own rate, measured), and a run's randomness comes from its seed: ctx.random(), and
// Math.random while a step runs. While a step runs, performance.now() and Date.now() read the
// run's own clock (its game time from the bases the play keeps), so a game timing itself with
// them replays the same. A run's play is then its seed, its slice, its clock, the raw input each
// step read and what the Stage changed mid-run; played again on any build, it is the same run
// until the build plays differently. What a game reads outside ctx.input, ctx.keys and
// ctx.mouse (its own listeners, timers outside ctx.after) is not in the play.
//
// The Stage keeps a person's ended runs; the harness replays one with window.__studio.replay.

/** Display rates a measured frame interval snaps to. */
const RATES = [60, 75, 90, 100, 120, 144, 165, 240];
/** A play longer than this, or with more input changes than this, is not kept. */
const MAX_STEPS = 20 * 60 * 240;
const MAX_CHANGES = 20_000;
const MAX_EVENTS = 2_000;

/** A seeded stream of numbers in [0, 1) (mulberry32): the same seed, the same run. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const freshSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** The display's frame time, from the frames drawn so far: the step a new run plays at. */
export function createRate() {
  const gaps = [];
  return {
    frame(ms) {
      // Only steady frames: a hitch or a hidden tab says nothing about the display.
      if (ms <= 2 || ms > 50) return;
      gaps.push(ms);
      if (gaps.length > 31) gaps.shift();
    },
    step() {
      if (gaps.length < 10) return 1 / 60;
      const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
      let best = RATES[0];
      for (const rate of RATES)
        if (Math.abs(1000 / rate - median) < Math.abs(1000 / best - median)) best = rate;
      return 1 / best;
    },
  };
}

/** The raw input one step reads, as plain data: keys and buttons held and pressed, the mouse, a pad. */
function snapshot(run, pad) {
  const mouse = run.ctx.mouse;
  return {
    k: [...run.down],
    p: [...run.pressed],
    b: [...run.buttons],
    c: [...run.clicked],
    m: [mouse.x, mouse.y, mouse.ndc.x, mouse.ndc.y, mouse.movement.x, mouse.movement.y],
    ...(pad == null
      ? {}
      : {
          g: [
            [...pad.axes],
            pad.buttons.map((button) =>
              button.pressed
                ? typeof button.value === "number" && button.value > 0
                  ? button.value
                  : 1
                : 0,
            ),
          ],
        }),
  };
}

/** Puts a recorded step's input on the run, as its devices would have; returns its pad or null. */
function apply(run, input) {
  const fill = (set, values) => {
    set.clear();
    for (const value of values) set.add(value);
  };
  fill(run.down, input.k);
  fill(run.pressed, input.p);
  fill(run.buttons, input.b);
  fill(run.clicked, input.c);
  const mouse = run.ctx.mouse;
  [mouse.x, mouse.y, mouse.ndc.x, mouse.ndc.y, mouse.movement.x, mouse.movement.y] = input.m;
  if (input.g === undefined) return null;
  const [axes, buttons] = input.g;
  return { axes, buttons: buttons.map((value) => ({ pressed: value > 0, value })) };
}

const round = (value, places) => {
  const k = 10 ** places;
  return Math.round(value * k) / k;
};

/** Where a run stands, once a second: the player's position and the game's own values. */
export function mark(time, player, state) {
  let at = null;
  if (player?.isObject3D === true) {
    const p = player.getWorldPosition(player.position.clone());
    at = [round(p.x, 2), round(p.y, 2), round(p.z, 2)];
  } else if (player != null && Number.isFinite(player.x))
    at = [round(player.x, 2), round(player.y ?? 0, 2), round(player.z ?? 0, 2)];
  const values = {};
  for (const [key, value] of Object.entries(state)) {
    if (Object.keys(values).length >= 24) break;
    if (["state", "result", "result_text"].includes(key) || key.startsWith("_")) continue;
    if (typeof value === "number" && Number.isFinite(value)) values[key] = round(value, 3);
    else if (typeof value === "boolean") values[key] = value;
  }
  return { t: round(time, 1), at, values };
}

/** Keeps one run's play as it is played: only the steps whose input changed. */
export function createRecorder(seed, dt, clock) {
  const play = {
    version: 1,
    seed,
    dt,
    clock,
    steps: 0,
    inputs: [],
    events: [],
    marks: [],
    outcome: null,
  };
  let last = "";
  let full = false;
  /** The named actions the run pressed: a build without one of them cannot replay it. */
  const actions = new Set();
  return {
    /** After a step sampled its input: the actions held in it. */
    actions(held) {
      for (const name of held) actions.add(name);
    },
    /** Before a step samples its input. */
    input(run, pad) {
      if (full) return;
      const now = snapshot(run, pad);
      const text = JSON.stringify(now);
      if (text !== last) {
        last = text;
        play.inputs.push([play.steps, now]);
      }
      if (play.inputs.length > MAX_CHANGES || play.steps > MAX_STEPS) full = true;
    },
    /** The Stage changed something mid-run: speed, Can't lose or a tuned value. */
    event(kind, ...args) {
      if (!full && play.events.length < MAX_EVENTS) play.events.push([play.steps, kind, ...args]);
    },
    stepped(steps, entry) {
      play.steps = steps;
      if (entry !== null) play.marks.push(entry);
    },
    /** The run ended: the play, or null when it outgrew what is kept. `read`: the actions the game read. */
    finish(outcome, read) {
      if (full) return null;
      play.outcome = outcome;
      play.actions = [...actions].filter((name) => read.has(name)).slice(0, 64);
      return play;
    },
  };
}

/** Feeds a recorded play back step by step. */
export function createPlayer(play) {
  let input = 0;
  let event = 0;
  let current = null;
  return {
    play,
    marks: [],
    /** Before step `steps` samples: the run gets that step's input; returns the pad, if any. */
    input(run, steps, onEvent) {
      while (event < play.events.length && play.events[event][0] <= steps) {
        const [, kind, ...args] = play.events[event];
        onEvent(kind, ...args);
        event += 1;
      }
      while (input < play.inputs.length && play.inputs[input][0] <= steps) {
        current = play.inputs[input][1];
        input += 1;
      }
      return current === null ? null : apply(run, current);
    },
  };
}
