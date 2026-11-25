import type { GameFactView } from "@kurambit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { FAKE_DELTAS } from "./gameBuilds.fixtures";
import { compareRows, deltaLine } from "./gameBuilds.logic";

// A fact with no reading never reads as a result, a good or bad tone, or "unchanged".
describe("facts as drawn", () => {
  it("never marks a not-comparable fact", () => {
    const lines = FAKE_DELTAS.map(deltaLine);
    expect(lines.map((line) => line.mark)).toEqual(["↑", "↑", "↓", "=", "≠", null]);
    const saved = lines.at(-1);
    expect(saved?.tone).toBeNull();
    expect(saved?.why).toBe("Not comparable: the saved plays changed between the two measurements");
    expect(lines[1]?.tone).toBe("worse");
  });
});

describe("a compare's rows", () => {
  it("says a reason neither side was measured for once, by the Inspector's names", () => {
    const busy =
      "the picture stood still while the machine was busy (load 10.8 on 8 cores), so it says nothing about the game";
    const view = (id: "motion" | "hud" | "boots"): GameFactView => ({
      id,
      label: id,
      reading:
        id === "boots"
          ? { _tag: "measured" as const, text: "Boots clean", value: null, tone: "good" as const }
          : { _tag: "not-measured" as const, why: busy, cause: "busy" as const },
      evidence: [],
    });
    const views = [view("boots"), view("motion"), view("hud")];
    const unmeasured = (id: "motion" | "hud") =>
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
        unmeasured("motion"),
        {
          id: "boots",
          label: "Boots",
          a: "Boots clean",
          b: "Boots clean",
          change: "same",
          tone: "neutral",
          why: null,
        },
        unmeasured("hud"),
      ],
      views,
      views,
    );
    expect(rows.map((row) => row.name)).toEqual(["Starts without errors"]);
    expect(groups).toEqual([
      {
        names: ["HUD fits the screen", "Picture change (motion)"],
        why: "this computer was busy with other work, so the reading says nothing about the game; the next measure takes it again",
      },
    ]);
  });
});

describe("a compare's cells", () => {
  it("say a number from the readings, not from their words", () => {
    const measured = (value: number) =>
      ({ _tag: "measured", text: "", value, tone: "neutral" }) as const;
    const delta = {
      id: "motion",
      label: "motion",
      a: "x",
      b: "y",
      change: "changed",
      tone: "neutral",
      why: null,
    } as const;
    const side = (motion: number) => [
      { id: "motion" as const, sentence: "Anything", value: null, reading: measured(motion) },
    ];
    const { rows } = compareRows([delta], [], [], { a: side(3.21), b: side(7.5) });
    expect(rows.map((row) => [row.id, row.a, row.b])).toEqual([["motion", "3.2", "7.5"]]);
  });
});
