import { describe, expect, it } from "vite-plus/test";

import {
  GAME_VISUAL_DIMENSIONS,
  type GameVisualFrame,
  type GameVisualReview,
  evaluateVisualReview,
} from "./gameVisual.ts";

const frame = (role: GameVisualFrame["role"], id = role): GameVisualFrame => ({
  id,
  label: `${role}-caption`,
  path: `builds/playtests/run/${role}.png`,
  role,
});

const review = (scores: ReadonlyArray<number | "missing">): GameVisualReview => ({
  dimensions: GAME_VISUAL_DIMENSIONS.map((dimension, index) => ({
    dimension,
    score: scores[index] ?? 3,
  })),
  repairRequests: [],
});

const frames = [frame("early"), frame("hazard"), frame("finish")];

describe("the visual pass rule", () => {
  it("passes only when every applicable dimension reaches three", () => {
    expect(evaluateVisualReview({ review: review([4, 3, 3, 3, 4, 3]), frames }).passed).toBe(true);
    // A single 2 fails the whole review; there is no average that hides it.
    const low = evaluateVisualReview({ review: review([4, 4, 2, 4, 4, 4]), frames });
    expect(low.passed).toBe(false);
    expect(low.detail).toContain("cameraFraming scored 2");
  });

  it("treats missing evidence as missing, not as a zero", () => {
    const missing = evaluateVisualReview({
      review: review([3, 3, 3, "missing", 3, 3]),
      frames,
    });
    expect(missing.passed).toBe(false);
    expect(missing.detail).toContain("styleConsistency has no evidence");
    // A zero is evidence the frames show the thing and it fails, which is a
    // different sentence from "no frame shows it".
    const zero = evaluateVisualReview({ review: review([3, 3, 0, 3, 3, 3]), frames });
    expect(zero.passed).toBe(false);
    expect(zero.detail).toContain("cameraFraming scored 0");
  });

  it("refuses to pass without hazard or finish frames even at perfect scores", () => {
    const noHazard = evaluateVisualReview({
      review: review([4, 4, 4, 4, 4, 4]),
      frames: [frame("early"), frame("finish")],
    });
    expect(noHazard.passed).toBe(false);
    expect(noHazard.detail).toContain("no hazard frame");
    const noFinish = evaluateVisualReview({
      review: review([4, 4, 4, 4, 4, 4]),
      frames: [frame("early"), frame("hazard")],
    });
    expect(noFinish.passed).toBe(false);
    expect(noFinish.detail).toContain("no finish frame");
  });
});
