import type { GameBuild, GameFactId, GameFactView } from "@kurambit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { FAKE_DELTAS, FAKE_FACT_VIEWS } from "./gameBuilds.fixtures";
import { compareRows, deltaLine, factLine, passDelta } from "./gameBuilds.logic";

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

describe("a compare's rows", () => {
  it("says a reason neither side was measured for once, by the Inspector's names", () => {
    const busy =
      "the picture stood still while the machine was busy (load 10.8 on 8 cores), so it says nothing about the game";
    const view = (id: "freeze" | "colour" | "boots"): GameFactView => ({
      id,
      label: id,
      reading:
        id === "boots"
          ? { _tag: "measured" as const, text: "Boots clean", value: null, tone: "good" as const }
          : { _tag: "not-measured" as const, why: busy },
      evidence: [],
    });
    const views = [view("boots"), view("freeze"), view("colour")];
    const unmeasured = (id: "freeze" | "colour") =>
      ({
        id,
        label: id,
        a: null,
        b: null,
        change: "not-comparable",
        tone: "neutral",
        why: busy,
      }) as const;
    const { rows, unmeasured: groups } = compareRows(
      [
        unmeasured("freeze"),
        {
          id: "boots",
          label: "Boots",
          a: "Boots clean",
          b: "Boots clean",
          change: "same",
          tone: "neutral",
          why: null,
        },
        unmeasured("colour"),
      ],
      views,
      views,
    );
    expect(rows.map((row) => row.name)).toEqual(["Starts"]);
    expect(groups).toEqual([
      {
        names: ["Keeps moving", "Largest single colour"],
        why: "the picture stood still while the machine was busy, so it says nothing about the game",
      },
    ]);
  });
});

describe("a build's pass change on the strip", () => {
  const build = (
    state: GameBuild["facts"]["state"],
    measured: ReadonlyArray<GameFactId>,
    passing: ReadonlyArray<GameFactId>,
  ): Pick<GameBuild, "facts"> => ({
    facts: {
      state,
      chips: [],
      notMeasured: 0,
      good: passing.length,
      bad: 0,
      lead: { pass: passing.length, of: 7, measured, passing },
    },
  });

  it("says nothing while either build is being measured", () => {
    const before = build("measured", ["boots", "idle"], ["boots", "idle"]);
    expect(passDelta(build("queued", [], []), before)).toBeNull();
    expect(passDelta(build("measuring", ["boots"], []), before)).toBeNull();
    expect(passDelta(before, build("never", [], []))).toBeNull();
  });

  it("counts only the checks both builds measured", () => {
    // The newer build measured more checks: coverage, not improvement.
    const before = build("incomplete", ["boots"], ["boots"]);
    const after = build("measured", ["boots", "idle", "masher"], ["boots", "idle", "masher"]);
    expect(passDelta(after, before)).toBe(0);
    // A check both measured that stopped passing is a loss.
    expect(passDelta(build("measured", ["boots", "idle"], ["idle"]), before)).toBe(-1);
  });

  it("has no answer for summaries counted before the measured list existed", () => {
    const old: Pick<GameBuild, "facts"> = {
      facts: {
        state: "measured",
        chips: [],
        notMeasured: 0,
        good: 3,
        bad: 0,
        lead: { pass: 3, of: 7 },
      },
    };
    expect(passDelta(old, build("measured", ["boots"], ["boots"]))).toBeNull();
  });
});
