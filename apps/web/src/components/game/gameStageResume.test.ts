import { GamePlay } from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { resumeNotice } from "./gameStageResume";

const decodePlay = Schema.decodeUnknownOption(GamePlay);
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

it("a run with a tuned value decodes, so it reaches the Stage and the agent", () => {
  const tuned: GamePlay = {
    ...origin,
    events: [...origin.events, [240, "tune", "Runner", "speed", 7]],
    tunes: { Runner: { speed: 4 } },
  };
  expect(decodePlay(tuned)._tag).toBe("Some");
});

it("says where a reloaded run comes back and where the change first played differently", () => {
  const marks = origin.marks.map((each, i) =>
    i < 2 ? each : { ...each, values: { coins: each.t * 2 } },
  );
  expect(resumeNotice(origin, { type: "studio-replayed", id: 1, seconds: 10, marks })).toBe(
    "Back where you were (0:10); with the change, play differs from 0:03: coins 3 → 6",
  );
  expect(
    resumeNotice(origin, { type: "studio-replayed", id: 1, seconds: 10, marks: origin.marks }),
  ).toBeNull();
  expect(
    resumeNotice(origin, {
      type: "studio-replayed",
      id: 1,
      ended: { won: false, text: "You fell", seconds: 6.4 },
    }),
  ).toBe("With the change, this run now ends at 0:06 (You fell)");
});
