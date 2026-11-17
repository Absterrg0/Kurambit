import { describe, expect, it } from "@effect/vitest";

import { savedPlayReading, savedPlayWords, type GamePlay, type GamePlayMark } from "./gamePlays.ts";

const mark = (t: number, x: number): GamePlayMark => ({ t, at: [x, 0, 0], values: {} });
const marks = (seconds: number, at: (t: number) => number = (t) => t) =>
  Array.from({ length: seconds }, (_, i) => mark(i + 1, at(i + 1)));

/** A run of an open-ended game, saved 70 s in: it never ended. */
const open: GamePlay = {
  version: 1,
  seed: 1,
  dt: 1 / 60,
  steps: 4200,
  inputs: [],
  events: [],
  marks: marks(70),
  outcome: { won: false, text: "", seconds: 70, left: true },
};

describe("a saved play with no ending", () => {
  it("plays the same while it stands where it stood, whatever the replay did past its end", () => {
    // A replay runs on past the play's end: what it does there was never played.
    const run = {
      outcome: null,
      seconds: 80,
      steps: 4800,
      marks: marks(80, (t) => (t > 70 ? -t : t)),
    };
    const reading = savedPlayReading("evening walk", open, run);
    expect(reading.reading).toBe("same");
    expect(savedPlayWords(reading)).toBe("evening walk plays the same for 1:10");
  });

  it("is an ending changed when the build now ends within its length, and not after it", () => {
    const lost = { won: false, text: "You fell in", seconds: 42 };
    const within = savedPlayReading("evening walk", open, {
      outcome: lost,
      seconds: 42,
      steps: 2520,
      marks: marks(42),
    });
    expect(within.reading).toBe("ending-changed");
    expect(savedPlayWords(within)).toBe(
      "evening walk now loses at 42 s, within the 1:10 it played",
    );
    const after = savedPlayReading("evening walk", open, {
      outcome: { ...lost, seconds: 75 },
      seconds: 75,
      steps: 4500,
      marks: marks(75),
    });
    expect(after.reading).toBe("same");
  });

  it("plays differently from the first second it stands elsewhere", () => {
    const run = {
      outcome: null,
      seconds: 80,
      steps: 4800,
      marks: marks(80, (t) => (t >= 30 ? t + 1 : t)),
    };
    const reading = savedPlayReading("evening walk", open, run);
    expect(reading.reading).toBe("plays-differently");
    expect(reading.differs).toEqual({ seconds: 30, what: "the player is elsewhere" });
  });
});
