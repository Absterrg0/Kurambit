import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  GAME_TRY_INPUT_BOUNDS,
  GameReviewExperimentRoute,
  tryInputIssues,
} from "@t3tools/contracts";
import { playtestStepWithEvidence } from "./playtestInputPairs.ts";

const decodeExperiment = Schema.decodeUnknownSync(GameReviewExperimentRoute);

describe("try_input setup prelude (late-game evidence)", () => {
  it("keeps defaults byte/behavior compatible", () => {
    expect(GAME_TRY_INPUT_BOUNDS.maxSteps).toBe(12);
    expect(GAME_TRY_INPUT_BOUNDS.maxSetupSteps).toBe(48);
    expect(GAME_TRY_INPUT_BOUNDS.maxFrames).toBe(32);
    expect(GAME_TRY_INPUT_BOUNDS.maxSequenceMs).toBe(30_000);
    expect(GAME_TRY_INPUT_BOUNDS.maxCalls).toBe(6);
    expect(GAME_TRY_INPUT_BOUNDS.maxRunMs).toBe(180_000);
    expect(tryInputIssues({ steps: [{ press: "Space" }] })).toEqual([]);
    // T115 13-step rejection is unchanged when no setup is present.
    expect(
      tryInputIssues({ steps: Array.from({ length: 13 }, () => ({ press: "w" })) }).join("\n"),
    ).toContain("1–12 steps");
  });

  it("accepts a >12-step but <30s setup+suffix replay within the 32-frame cap", () => {
    const setupSteps = Array.from({ length: 20 }, () => ({ press: "Enter" as const }));
    const steps = Array.from({ length: 8 }, () => ({ press: "Space" as const }));
    // 28 total steps, ~1400ms nominal, observed frames 2+16=18 <=32.
    expect(tryInputIssues({ steps, setupSteps })).toEqual([]);
  });

  it("validates combined duration, total steps, coords and frames before any browser work", () => {
    expect(
      tryInputIssues({
        steps: [{ key: "w", holdMs: 2000 }],
        setupSteps: [{ key: "w", holdMs: 29_000 }],
      }).join("\n"),
    ).toContain("30000 ms");
    expect(
      tryInputIssues({
        steps: Array.from({ length: 12 }, () => ({ press: "w" })),
        setupSteps: Array.from({ length: 49 }, () => ({ press: "w" })),
      }).join("\n"),
    ).toMatch(/48|60/);
    expect(
      tryInputIssues({
        steps: [{ press: "Space" }],
        setupSteps: [{ click: "left" as const, x: 9999, y: 10 }],
      }).join("\n"),
    ).toContain("pointer coordinates");
    expect(
      tryInputIssues({
        steps: [{ hold: "w", holdMs: 10_000 }],
        setupSteps: [],
        captureEveryMs: 100,
      }).join("\n"),
    ).toContain("limit is 32");
  });

  it("forbids screenshots in setup; setup adds no frames", () => {
    expect(
      tryInputIssues({
        steps: [{ press: "Space" }],
        setupSteps: [{ screenshot: "reach-state" }],
      }).join("\n"),
    ).toContain("screenshot");
    // Same observed route passes with or without an empty setup: setup adds no frames.
    const steps = [{ press: "Space" as const }];
    expect(tryInputIssues({ steps })).toEqual(tryInputIssues({ steps, setupSteps: [] }));
  });

  it("executes uncaptured steps once without calling capture hooks", async () => {
    const ran: string[] = [];
    const setup = [{ press: "Enter" }, { waitMs: 200 }, { key: "w", holdMs: 80 }] as const;
    for (const [setupIndex, step] of setup.entries()) {
      let captures = 0;
      const paired = await playtestStepWithEvidence({
        step,
        stepIndex: setupIndex,
        skipCapture: true,
        capture: async () => {
          captures += 1;
          throw new Error("setup must not capture");
        },
        execute: async () => {
          ran.push(`setup${setupIndex + 1}`);
          return !("waitMs" in step);
        },
      });
      expect(captures).toBe(0);
      expect(paired.frames).toEqual([]);
      if (setupIndex === 0) expect(paired.executed).toBe(true);
    }
    expect(ran).toEqual(["setup1", "setup2", "setup3"]);
  });

  it("keeps zero-based combined indices so pairs never alias", async () => {
    const setupLength = 20;
    const paired = await playtestStepWithEvidence({
      step: { press: "Space" },
      stepIndex: setupLength,
      capture: async () => ({
        screenshot: {
          label: "raw",
          mimeType: "image/png" as const,
          data: "cG5n",
          width: 1,
          height: 1,
        },
        pixels: null,
        probe: null,
      }),
      execute: async () => true,
    });
    expect(paired.frames).toHaveLength(2);
    expect(paired.frames[0]?.inputPair).toMatchObject({ stepIndex: setupLength, phase: "before" });
    expect(paired.frames[1]?.inputPair).toMatchObject({ stepIndex: setupLength, phase: "after" });
    expect(paired.frames[1]?.label).toBe("input 21 after: pressed Space");
  });

  it("propagates cancellation without leaving capture work behind", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      playtestStepWithEvidence({
        step: { press: "Space" },
        stepIndex: 0,
        skipCapture: true,
        capture: async () => {
          throw new Error("must not capture");
        },
        execute: async () => {
          controller.signal.throwIfAborted();
          return true;
        },
      }),
    ).rejects.toThrow();
  });

  it("persists setup unambiguously and replays the full route (schema compat)", () => {
    // Legacy routes without setupSteps stay readable.
    expect(() =>
      decodeExperiment({
        id: "try-1",
        buildId: "b",
        steps: [{ press: "Space" }],
        captureEveryMs: 1000,
        viewport: null,
        frames: [],
      }),
    ).not.toThrow();
    // New routes carry setupSteps alongside observed steps.
    const route = decodeExperiment({
      id: "try-1",
      buildId: "b",
      steps: [{ press: "Space" }],
      setupSteps: [{ press: "Enter" }],
      captureEveryMs: 1000,
      viewport: null,
      frames: [{ frameId: "try1f1", label: "input 2 after: pressed Space", stepIndex: 1 }],
    });
    expect(route.setupSteps).toEqual([{ press: "Enter" }]);
    expect(route.frames[0]?.stepIndex).toBe(1);
    // Full replay is setup+steps in order with the same boundary.
    const full = [...(route.setupSteps ?? []), ...route.steps];
    expect(full).toEqual([{ press: "Enter" }, { press: "Space" }]);
    expect(full.length).toBe(2);
  });
});
