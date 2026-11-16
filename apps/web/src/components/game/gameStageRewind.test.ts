import { GamePlay } from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { canCompare, compareReplays, resumeNotice, type RunFork } from "./gameStageRewind";

const still = { k: [], p: [], b: [], c: [], m: [0, 0, 0, 0, 0, 0] as const };
const right = { ...still, k: ["ArrowRight"] };
const mark = (t: number, x: number) => ({ t, at: [x, 0.5, 0] as const, values: { coins: t } });

/** A 10 s run at 60 steps a second, holding right from 1 s. */
const origin: GamePlay = {
  version: 1,
  seed: 7,
  dt: 1 / 60,
  clock: [1000, 2000],
  steps: 600,
  inputs: [
    [0, still],
    [60, right],
  ],
  events: [
    [0, "speed", 1],
    [0, "can-lose", true],
  ],
  marks: Array.from({ length: 10 }, (_, i) => mark(i + 1, i * 4)),
  outcome: { won: false, text: "", seconds: 10, left: true },
};

/** Rewound to 4 s (step 240), Speed tuned there, then played on 5 s with its own input. */
const fork: RunFork = { origin, step: 240, seconds: 4 };
const tuned = [240, "tune", "Runner", "speed", 7] as const;
const forked: GamePlay = {
  ...origin,
  fork: 4,
  steps: 540,
  inputs: [...origin.inputs, [240, still], [250, right]],
  events: [...origin.events, [240, "speed", 1], [240, "can-lose", true], tuned],
  tunes: { Runner: { speed: 4 } },
};

it("a run with a tuned value decodes, so it reaches the Stage and the agent", () => {
  expect(Schema.decodeUnknownOption(GamePlay)(forked)._tag).toBe("Some");
});

it("compares the fork's own next seconds without and with the values tuned there", () => {
  expect(canCompare(fork, forked)).toBe(true);
  const { before, after, stop } = compareReplays(fork, forked);
  expect(stop).toBe(240 + 180);
  expect(after).toBe(forked);
  expect(before.inputs).toBe(forked.inputs);
  expect(before.events.some((event) => event[1] === "tune")).toBe(false);
  expect(before.events).toHaveLength(forked.events.length - 1);
});

it("compares on the run before the rewind when the fork has not played on that long", () => {
  const short = { ...forked, steps: 300 };
  const { before, after, stop } = compareReplays(fork, short);
  expect(stop).toBe(420);
  expect(before).toEqual({ ...origin, tunes: { Runner: { speed: 4 } } });
  expect(after.inputs).toBe(origin.inputs);
  expect(after.tunes).toEqual({ Runner: { speed: 4 } });
  expect(after.events).toEqual([...origin.events, tuned]);
});

it("has nothing to compare on a fork with no tuned value, or another run", () => {
  expect(canCompare(fork, { ...forked, events: forked.events.slice(0, -1) })).toBe(false);
  expect(canCompare(fork, { ...forked, fork: 6 })).toBe(false);
});

it("says where a reloaded run comes back and where the change first played differently", () => {
  const marks = origin.marks.map((each, i) =>
    i < 2 ? each : { ...each, values: { coins: each.t * 2 } },
  );
  expect(resumeNotice(origin, { type: "studio-replayed", id: 1, seconds: 10, marks }).text).toBe(
    "Back where you were (0:10); with the change, play differs from 0:03: coins 3 → 6",
  );
  expect(
    resumeNotice(origin, {
      type: "studio-replayed",
      id: 1,
      ended: { won: false, text: "You fell", seconds: 6.4 },
    }),
  ).toEqual({
    text: "With the change, this run now ends at 0:06 (You fell)",
    handedOver: false,
    ended: true,
  });
});
