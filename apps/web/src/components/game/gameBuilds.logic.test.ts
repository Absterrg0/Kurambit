import { describe, expect, it } from "vite-plus/test";

import { FAKE_DELTAS, FAKE_FACT_VIEWS } from "./gameBuilds.fixtures";
import { deltaLine, factLine } from "./gameBuilds.logic";

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
