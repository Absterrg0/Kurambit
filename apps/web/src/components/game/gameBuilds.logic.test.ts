import type { GameFactView } from "@kurambit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { FAKE_DELTAS } from "./gameBuilds.fixtures";
import { compareRows, deltaLine } from "./gameBuilds.logic";

// A fact with no reading never reads as a result, a good or bad tone, or "unchanged".
describe("facts as drawn", () => {
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
  it("say a run's ending and a number from the readings, not from their words", () => {
    const measured = (value: number) =>
      ({ _tag: "measured", text: "", value, tone: "neutral" }) as const;
    const delta = (id: "masher" | "motion", a: string, b: string) =>
      ({ id, label: id, a, b, change: "changed", tone: "neutral", why: null }) as const;
    const check = (id: "masher" | "motion", value: number, ending: "lost" | "won" | null) => ({
      id,
      sentence: "Anything",
      value: ending === null ? null : "at 4.8 s",
      reading: measured(value),
      ending,
    });
    const side = (ending: "lost" | "won", motion: number) => [
      check("masher", 4.8, ending),
      check("motion", motion, null),
    ];
    const { rows } = compareRows([delta("masher", "x", "y"), delta("motion", "x", "y")], [], [], {
      a: side("lost", 3.21),
      b: side("won", 7.5),
    });
    expect(rows.map((row) => [row.id, row.a, row.b])).toEqual([
      ["masher", "Lost at 4.8 s", "Won at 4.8 s"],
      ["motion", "3.2", "7.5"],
    ]);
  });
});
