import { describe, expect, it } from "vite-plus/test";
import type { GamePlaytestStep } from "@t3tools/contracts";
import {
  chooseDiverseWitnessPairs,
  playtestInputSignature,
  playtestPairWitnessScore,
  playtestStepAction,
  playtestStepWithEvidence,
  selectInputPairFrames,
  trailingWaitObservation,
} from "./playtestInputPairs.ts";

describe("input pairs", () => {
  it("names where a click landed so a pair card shows the input", () => {
    expect(playtestStepAction({ click: "left", x: 700, y: 120 })).toBe(
      "clicked left at 700,120 0ms",
    );
    expect(playtestStepAction({ click: "left" })).toBe("clicked left 0ms");
    expect(playtestStepAction({ keys: ["Shift", "w"], holdMs: 800 })).toBe("held Shift+w 800ms");
    expect(playtestStepAction({ press: "Space" })).toBe("pressed Space");
  });

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

it("captures waiting as an observation without crediting it as input", async () => {
  const result = await playtestStepWithEvidence({
    step: { waitMs: 100 },
    stepIndex: 2,
    captureAllSteps: true,
    execute: async () => false,
    capture: async () => ({
      screenshot: { label: "raw", mimeType: "image/png", data: "cG5n", width: 640, height: 360 },
      pixels: null,
      probe: null,
    }),
  });
  expect(result.executed).toBe(false);
  expect(result.frames.map((frame) => frame.inputPair?.phase)).toEqual(["before", "after"]);
  expect(result.frames[1]?.inputPair?.changedPercent).toBeNull();
  expect(result.frames[1]?.inputPair?.stateChanges).toBeNull();
});

it("excludes legacy wait pairs when selecting input evidence", async () => {
  const result = await playtestStepWithEvidence({
    step: { waitMs: 300 },
    stepIndex: 5,
    captureAllSteps: true,
    execute: async () => false,
    capture: async () => ({
      screenshot: { label: "raw", mimeType: "image/png", data: "cG5n", width: 1, height: 1 },
      pixels: null,
      probe: null,
    }),
  });
  expect(selectInputPairFrames(result.frames)).toEqual([]);
});

describe("diverse witness-aware sampling", () => {
  const pairFrames = (
    stepIndex: number,
    input: GamePlaytestStep,
    stateChanges: ReadonlyArray<{
      key: string;
      before: string | number | boolean | null;
      after: string | number | boolean | null;
    }> | null,
  ) => [
    {
      label: `input ${stepIndex + 1} before: no input`,
      data: "cG5n",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      inputPair: { stepIndex, phase: "before" as const, input, changedPercent: 0, stateChanges },
    },
    {
      label: `input ${stepIndex + 1} after`,
      data: "cG5n",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      inputPair: { stepIndex, phase: "after" as const, input, changedPercent: 0, stateChanges },
    },
  ];

  const witness = (trust: number) => [
    { key: "state.choices", before: trust - 2, after: trust - 1 },
    { key: "state.trust", before: trust - 1, after: trust },
    { key: "hudText", before: "before", after: "after" },
  ];

  it("keeps the actual state-changing choice when advances dominate the route", () => {
    const frames = [];
    for (let stepIndex = 0; stepIndex < 13; stepIndex++) {
      const choice = stepIndex % 2 === 1;
      frames.push(
        ...pairFrames(
          stepIndex,
          choice ? { key: "1", holdMs: 80 } : { key: "Enter", holdMs: 80 },
          choice ? witness(3 + stepIndex) : [],
        ),
      );
    }
    const chosen = selectInputPairFrames(frames);
    expect(chosen).toHaveLength(8);
    // Whole pairs only: every before has its after.
    const steps = chosen.map((frame) => frame.inputPair?.stepIndex);
    for (const step of new Set(steps)) {
      expect(steps.filter((entry) => entry === step)).toHaveLength(2);
    }
    // At least one real choice with trust movement survives; the old even
    // spread (0,4,8,12) kept only Enter advances with no state change.
    const keptChoices = chosen.filter(
      (frame) =>
        frame.inputPair?.phase === "after" &&
        frame.inputPair.input !== undefined &&
        "key" in frame.inputPair.input &&
        frame.inputPair.input.key === "1",
    );
    expect(keptChoices.length).toBeGreaterThan(0);
    expect(
      keptChoices.some((frame) =>
        (frame.inputPair?.stateChanges ?? []).some((change) => change.key === "state.trust"),
      ),
    ).toBe(true);
  });

  it("covers distinct inputs and keeps a late witness for progression", () => {
    const frames = [
      ...pairFrames(0, { click: "left", x: 940, y: 500 }, []),
      ...pairFrames(2, { key: "Enter", holdMs: 80 }, []),
      ...pairFrames(4, { key: "l", holdMs: 900 }, [
        { key: "state.listened", before: 0, after: 1 },
        { key: "hudText", before: "before", after: "after" },
      ]),
      ...pairFrames(6, { key: "1", holdMs: 80 }, witness(3)),
      ...pairFrames(8, { key: "Enter", holdMs: 80 }, []),
      ...pairFrames(10, { key: "1", holdMs: 80 }, witness(4)),
      ...pairFrames(12, { key: "Enter", holdMs: 80 }, []),
      ...pairFrames(14, { key: "1", holdMs: 80 }, witness(5)),
      ...pairFrames(16, { key: "Enter", holdMs: 80 }, []),
      ...pairFrames(18, { key: "1", holdMs: 80 }, witness(6)),
      ...pairFrames(20, { key: "Enter", holdMs: 80 }, []),
      ...pairFrames(22, { key: "1", holdMs: 80 }, witness(7)),
      ...pairFrames(24, { key: "Enter", holdMs: 80 }, []),
    ];
    const chosen = selectInputPairFrames(frames);
    expect(chosen).toHaveLength(8);
    const signatures = new Set(
      chosen
        .filter((frame) => frame.inputPair?.phase === "after")
        .map((frame) => playtestInputSignature(frame.inputPair!.input!)),
    );
    // Diverse: click, hear-out, choice and advance are all represented.
    expect(signatures.size).toBeGreaterThanOrEqual(3);
    expect(
      chosen.some(
        (frame) =>
          frame.inputPair?.phase === "after" &&
          (frame.inputPair.stateChanges ?? []).some((change) => change.key === "state.trust"),
      ),
    ).toBe(true);
    // Later progression is kept when the budget allows.
    const keptSteps = [...new Set(chosen.map((frame) => frame.inputPair?.stepIndex))].sort(
      (left, right) => (left ?? 0) - (right ?? 0),
    );
    expect(keptSteps[keptSteps.length - 1]).toBeGreaterThanOrEqual(22);
  });

  it("falls back to spread when no pair shows state", () => {
    const frames = [];
    for (let stepIndex = 0; stepIndex < 6; stepIndex++) {
      frames.push(...pairFrames(stepIndex, { key: "Enter", holdMs: 80 }, []));
    }
    const chosen = selectInputPairFrames(frames);
    expect(chosen).toHaveLength(8);
    expect(chosen.map((frame) => frame.inputPair?.stepIndex)).toEqual([0, 0, 2, 2, 3, 3, 5, 5]);
  });

  it("falls back to loose frames when no pair is complete", () => {
    const loose = [
      { label: "booted", data: "cG5n", mimeType: "image/png" as const, width: 1, height: 1 },
      { label: "after-steps", data: "cG5n", mimeType: "image/png" as const, width: 1, height: 1 },
    ];
    expect(selectInputPairFrames(loose)).toHaveLength(2);
  });

  it("treats HUD-only and single ticks as no definite witness", () => {
    expect(
      playtestPairWitnessScore({ stateChanges: [{ key: "hudText", before: "a", after: "b" }] }),
    ).toBe(0);
    expect(playtestPairWitnessScore({ stateChanges: null })).toBe(0);
    expect(
      playtestPairWitnessScore({ stateChanges: [{ key: "state.t", before: 1, after: 2 }] }),
    ).toBe(1);
    expect(
      playtestPairWitnessScore({
        stateChanges: [
          { key: "state.trust", before: 2, after: 3 },
          { key: "state.choices", before: 0, after: 1 },
        ],
      }),
    ).toBe(2);
  });

  it("keeps frozen ids within budget and whole pairs", () => {
    const frames = [];
    for (let stepIndex = 0; stepIndex < 13; stepIndex++) {
      const choice = stepIndex % 2 === 1;
      frames.push(
        ...pairFrames(
          stepIndex,
          choice ? { key: "1", holdMs: 80 } : { key: "Enter", holdMs: 80 },
          choice ? witness(3 + stepIndex) : [],
        ),
      );
    }
    const chosen = selectInputPairFrames(frames);
    // Critic ids f1..f8 must name whole pairs only.
    expect(chosen).toHaveLength(8);
    const ids = chosen.map((_, index) => `f${index + 1}`);
    expect(ids).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"]);
    expect(
      chooseDiverseWitnessPairs(
        chosen
          .filter((frame) => frame.inputPair?.phase === "after")
          .map((frame) => ({
            stepIndex: frame.inputPair!.stepIndex,
            signature: playtestInputSignature(frame.inputPair!.input!),
            score: playtestPairWitnessScore(frame.inputPair!),
          })),
        3,
      ),
    ).toHaveLength(3);
  });
});

it("handles zero and single-pair budgets without invalid indices", () => {
  const ranks = [
    { stepIndex: 0, signature: "key:x", score: 0 as const },
    { stepIndex: 1, signature: "key:x", score: 2 as const },
    { stepIndex: 2, signature: "key:x", score: 0 as const },
  ];
  expect(chooseDiverseWitnessPairs(ranks, 0)).toEqual([]);
  expect(chooseDiverseWitnessPairs(ranks, 1)).toEqual([1]);
  expect(chooseDiverseWitnessPairs([], 1)).toEqual([]);
});

it("retains a rare effect from repeated identical input instead of sampling past it", () => {
  const ranks = Array.from({ length: 13 }, (_, index) => ({
    stepIndex: index,
    signature: "key:x",
    score: index === 7 ? (2 as const) : (0 as const),
  }));
  expect(chooseDiverseWitnessPairs(ranks, 4)).toContain(7);
  expect(chooseDiverseWitnessPairs(ranks, 4)).toHaveLength(4);
});

describe("trailing-wait observation", () => {
  const shot = (realized: number) => ({
    screenshot: { label: "raw", mimeType: "image/png" as const, data: "cG5n", width: 1, height: 1 },
    pixels: {
      width: 1,
      height: 1,
      data: [realized === 0 ? 0 : 255, 0, 0, 255],
    },
    probe: { gameState: { v: realized }, player: null },
  });

  it("finds only contiguous trailing waits and stops at other inputs", () => {
    const steps: GamePlaytestStep[] = [
      { key: "Enter", holdMs: 80 },
      { waitMs: 100 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
      { waitMs: 400 },
    ];
    expect(trailingWaitObservation(steps, 1)).toEqual({ count: 2, delayMs: 300 });
    expect(trailingWaitObservation(steps, 3)).toEqual({ count: 0, delayMs: 0 });
    // A different input stops the window: the wait after it belongs to that input.
    expect(trailingWaitObservation(steps, 4)).toEqual({ count: 1, delayMs: 400 });
    expect(trailingWaitObservation([{ key: "1", holdMs: 80 }] as GamePlaytestStep[], 1)).toEqual({
      count: 0,
      delayMs: 0,
    });
  });

  it("credits a queued release effect to the input without stretching the hold or adding time", async () => {
    // Fake game: the release queues the effect; only the next clock frame
    // (the trailing wait) realizes it. Immediate capture sees nothing.
    const runFor: number[] = [];
    let pending = false;
    let realized = 0;
    const clock = { runFor: async (ms: number) => void runFor.push(ms) };
    const holdMs = 80;
    const waitMs = 200;
    const trailing = trailingWaitObservation(
      [{ key: "Enter", holdMs }, { waitMs }] as GamePlaytestStep[],
      1,
    );
    expect(trailing).toEqual({ count: 1, delayMs: 200 });

    const result = await playtestStepWithEvidence({
      step: { key: "Enter", holdMs },
      stepIndex: 0,
      observation: { delayMs: trailing.delayMs, observedAfterStepIndex: 1 },
      capture: async () => shot(realized),
      execute: async () => {
        await clock.runFor(holdMs);
        pending = true; // keyUp queues the release; the effect is not visible yet.
        await clock.runFor(waitMs); // the route's own declared wait realizes it.
        if (pending) {
          pending = false;
          realized += 1;
        }
        return true;
      },
    });
    expect(result.frames).toHaveLength(2);
    expect(result.frames[1]?.inputPair).toMatchObject({
      stepIndex: 0,
      changedPercent: 100,
      observationDelayMs: 200,
      observedAfterStepIndex: 1,
    });
    expect(result.frames[1]?.inputPair?.stateChanges).toEqual([
      { key: "state.v", before: 0, after: 1 },
    ]);
    expect(result.frames[1]?.label).toBe(
      "input 1 after: held Enter 80ms (+200ms observation via step 2)",
    );
    // The hold is exactly the route's hold and the total is exactly the
    // route's sum: no stretched keys, no fabricated settle.
    expect(runFor).toEqual([80, 200]);
    expect(realized).toBe(1);
  });

  it("keeps a genuinely broken handler at zero change even after its explicit wait", async () => {
    const runFor: number[] = [];
    const result = await playtestStepWithEvidence({
      step: { key: "Enter", holdMs: 80 },
      stepIndex: 4,
      observation: { delayMs: 400, observedAfterStepIndex: 5 },
      capture: async () => shot(0),
      execute: async () => {
        runFor.push(80, 400);
        return true;
      },
    });
    expect(result.frames[1]?.inputPair).toMatchObject({
      changedPercent: 0,
      observationDelayMs: 400,
      observedAfterStepIndex: 5,
    });
    expect(result.frames[1]?.inputPair?.stateChanges).toEqual([]);
    expect(runFor).toEqual([80, 400]);
  });

  it("captures a click's deferred effect after its wait but leaves a wait-less click immediate", async () => {
    let realized = 0;
    const withWait = await playtestStepWithEvidence({
      step: { click: "left" },
      stepIndex: 0,
      observation: { delayMs: 200, observedAfterStepIndex: 1 },
      capture: async () => shot(realized),
      execute: async () => {
        // Click costs no game time; the queued release realizes in the wait.
        realized = 1;
        return true;
      },
    });
    expect(withWait.frames[1]?.inputPair).toMatchObject({
      changedPercent: 100,
      observationDelayMs: 200,
    });
    expect(withWait.frames[1]?.label).toContain("(+200ms observation via step 2)");

    realized = 0;
    const immediate = await playtestStepWithEvidence({
      step: { click: "left" },
      stepIndex: 6,
      capture: async () => shot(realized),
      execute: async () => true,
    });
    // No trailing wait: honest and immediate, marked by the absent delay.
    expect(immediate.frames[1]?.inputPair).toMatchObject({ changedPercent: 0 });
    expect(immediate.frames[1]?.inputPair).not.toHaveProperty("observationDelayMs");
    expect(immediate.frames[1]?.label).toBe("input 7 after: clicked left 0ms");
  });

  it("runs each consumed wait once and aborts the rest on cancel", async () => {
    const steps: GamePlaytestStep[] = [
      { key: "Enter", holdMs: 80 },
      { waitMs: 100 },
      { waitMs: 200 },
      { key: "1", holdMs: 80 },
    ];
    const drive = async (signal?: AbortSignal) => {
      const ran: string[] = [];
      let stepIndex = 0;
      let executedInputs = 0;
      while (stepIndex < steps.length) {
        const step = steps[stepIndex]!;
        signal?.throwIfAborted();
        const trailing =
          !("waitMs" in step) && !("screenshot" in step)
            ? trailingWaitObservation(steps, stepIndex + 1)
            : { count: 0, delayMs: 0 };
        const paired = await playtestStepWithEvidence({
          step,
          stepIndex,
          ...(trailing.count > 0
            ? {
                observation: {
                  delayMs: trailing.delayMs,
                  observedAfterStepIndex: stepIndex + trailing.count,
                },
              }
            : {}),
          capture: async () => shot(0),
          execute: async () => {
            signal?.throwIfAborted();
            ran.push(`step${stepIndex + 1}`);
            for (let consumed = 1; consumed <= trailing.count; consumed += 1) {
              signal?.throwIfAborted();
              ran.push(`wait${stepIndex + consumed + 1}`);
            }
            return !("waitMs" in step);
          },
        });
        if (paired.executed) executedInputs += 1;
        stepIndex += 1 + trailing.count;
      }
      return { ran, executedInputs };
    };
    // Each declared wait runs exactly once, attributed to its input.
    await expect(drive()).resolves.toEqual({
      ran: ["step1", "wait2", "wait3", "step4"],
      executedInputs: 2,
    });
    // A cancel between the waits stops the route: no later input runs and no
    // wait runs twice. The input's keys were already released at the original
    // time, before the waits, so nothing is left stuck down.
    const controller = new AbortController();
    const aborting = (async () => {
      const ran: string[] = [];
      const trailing = trailingWaitObservation(steps, 1);
      expect(trailing).toEqual({ count: 2, delayMs: 300 });
      await playtestStepWithEvidence({
        step: steps[0]!,
        stepIndex: 0,
        capture: async () => shot(0),
        execute: async () => {
          ran.push("step1");
          ran.push("wait2");
          controller.abort();
          controller.signal.throwIfAborted();
          ran.push("wait3");
          return true;
        },
      });
      return ran;
    })();
    await expect(aborting).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps whole pairs together for sampling with the new observation fields", async () => {
    const pair = await playtestStepWithEvidence({
      step: { key: "Enter", holdMs: 80 },
      stepIndex: 24,
      observation: { delayMs: 400, observedAfterStepIndex: 25 },
      capture: async () => shot(1),
      execute: async () => true,
    });
    const chosen = selectInputPairFrames(pair.frames);
    expect(chosen.map((frame) => frame.inputPair?.phase)).toEqual(["before", "after"]);
    expect(chosen[1]?.inputPair).toMatchObject({
      stepIndex: 24,
      observedAfterStepIndex: 25,
      observationDelayMs: 400,
    });
  });
});
