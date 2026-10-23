import { describe, expect, it } from "vite-plus/test";
import type { GamePlaytestStep } from "@t3tools/contracts";
import { playtestStepWithEvidence, selectInputPairFrames } from "./playtestInputPairs.ts";

describe("input pairs", () => {
  it("captures one before/after pair per real input and none for waits or screenshots", async () => {
    const steps: GamePlaytestStep[] = [
      { key: "ArrowRight", holdMs: 1000 },
      { waitMs: 200 },
      { screenshot: "loose" },
      { click: "left" },
      { keys: ["Shift", "w"], holdMs: 800 },
      { mouseMove: { dx: 4, dy: -2 } },
    ];
    let captures = 0;
    const all = [];
    for (const [stepIndex, step] of steps.entries()) {
      let executed = false;
      const result = await playtestStepWithEvidence({
        stepIndex,
        step,
        execute: async () => {
          executed = true;
          return !("waitMs" in step) && !("screenshot" in step);
        },
        capture: async () => {
          captures++;
          return {
            screenshot: { label: "raw", data: "cG5n", mimeType: "image/png", width: 1, height: 1 },
            pixels: { width: 1, height: 1, data: [executed ? 255 : 0, 0, 0, 255] },
            probe: { gameState: { card: executed ? "chosen" : "ready" }, player: null },
          };
        },
      });
      all.push(...result.frames);
      if ("waitMs" in step || "screenshot" in step) expect(result.frames).toEqual([]);
      else {
        expect(result.frames.map((frame) => frame.inputPair?.phase)).toEqual(["before", "after"]);
        expect(result.frames[1]?.inputPair).toMatchObject({
          stepIndex,
          input: step,
          changedPercent: 100,
          stateChanges: [{ key: "state.card", before: "ready", after: "chosen" }],
        });
      }
    }
    expect(captures).toBe(8);
    expect(all).toHaveLength(8);
    expect(all[1]?.label).toBe("input 1 after: held ArrowRight 1000ms");
    expect(selectInputPairFrames(all)).toEqual(all);
  });

  it("keeps at most four complete pairs across a long route and replaces loose frames", async () => {
    const frames = [];
    for (let stepIndex = 0; stepIndex < 10; stepIndex++) {
      const pair = await playtestStepWithEvidence({
        stepIndex,
        step: { click: "left" },
        execute: async () => true,
        capture: async () => ({
          screenshot: { label: "raw", data: "cG5n", mimeType: "image/png", width: 1, height: 1 },
          pixels: null,
          probe: null,
        }),
      });
      frames.push(...pair.frames);
    }
    const chosen = selectInputPairFrames([
      { label: "loose", data: "cG5n", mimeType: "image/png" as const, width: 1, height: 1 },
      ...frames,
    ]);
    expect(chosen).toHaveLength(8);
    expect(chosen.map((frame) => frame.inputPair?.stepIndex)).toEqual([0, 0, 3, 3, 6, 6, 9, 9]);
    expect(chosen[0]?.inputPair?.changedPercent).toBeNull();
  });
});
