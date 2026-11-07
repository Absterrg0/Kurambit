import { describe, expect, it } from "vite-plus/test";

import {
  BUILD_A,
  BUILD_B,
  BUILD_C,
  FAKE_DELTAS,
  FAKE_FACT_VIEWS,
  fakeRound,
} from "./gameBuilds.fixtures";
import { deltaLine, factLine, roundCardAction } from "./gameBuilds.logic";

// A wrong target restores the wrong build over the person's folder.
describe("roundCardAction", () => {
  const stopped = { active: false, best: BUILD_B };

  it("reverts a kept round that is still the best to the build it was judged against", () => {
    expect(roundCardAction(fakeRound({}), stopped)).toMatchObject({
      kind: "revert",
      target: BUILD_A,
      blocked: null,
    });
  });

  it("offers nothing it cannot name exactly", () => {
    expect(roundCardAction(fakeRound({ base: null }), stopped)).toBeNull();
    const { build: _build, ...unbuilt } = fakeRound({});
    expect(roundCardAction(unbuilt, stopped)).toBeNull();
    expect(roundCardAction(fakeRound({ build: "not-an-oid" }), stopped)).toBeNull();
    // A later round moved the best: reverting this one would skip that round's work.
    expect(roundCardAction(fakeRound({}), { active: false, best: BUILD_C })).toBeNull();
    expect(roundCardAction(fakeRound({ outcome: "abandoned" }), stopped)).toBeNull();
    // A round that was not kept can no longer become the run's best: no run continues.
    expect(
      roundCardAction(fakeRound({ outcome: "rejected", kept: false, build: BUILD_C }), stopped),
    ).toBeNull();
  });

  it("waits for a live run to stop and the chat's turn to end", () => {
    expect(roundCardAction(fakeRound({}), { active: true, best: BUILD_B })?.blocked).not.toBeNull();
    expect(roundCardAction(fakeRound({}), stopped, true)?.blocked).not.toBeNull();
  });
});

// A fact with no reading never reads as a result, a good or bad tone, or "unchanged".
describe("facts as drawn", () => {
  it("shows a missing reading only as its reason", () => {
    const lines = FAKE_FACT_VIEWS.map(factLine);
    expect(lines.find((line) => line.label === "Skilled")).toEqual({
      label: "Skilled",
      text: "Not measured: this game has no skilled bot",
      tone: null,
    });
    expect(lines.find((line) => line.label === "First response")?.tone).toBeNull();
    expect(lines.find((line) => line.label === "Masher")?.tone).toBe("bad");
  });

  it("never marks a not-comparable fact", () => {
    const lines = FAKE_DELTAS.map(deltaLine);
    expect(lines.map((line) => line.mark)).toEqual(["↑", "↑", "↓", "=", "≠", null]);
    const skilled = lines.at(-1);
    expect(skilled?.tone).toBeNull();
    expect(skilled?.why).toBe("Not comparable: this game has no skilled bot");
    expect(lines[1]?.tone).toBe("worse");
  });
});
