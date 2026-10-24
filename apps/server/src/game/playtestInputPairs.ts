import type {
  GamePlaytestProbe,
  GamePlaytestStateValue,
  GamePlaytestScreenshot,
  GamePlaytestStep,
} from "@t3tools/contracts";
import { compareFrameSamples, type FrameSample } from "./playtestFrames.ts";

interface Capture {
  readonly screenshot: GamePlaytestScreenshot;
  readonly pixels: FrameSample | null;
  readonly probe: GamePlaytestProbe | null;
}

const values = (
  probe: GamePlaytestProbe | null,
): Record<string, GamePlaytestStateValue | null> => ({
  ...Object.fromEntries(
    Object.entries(probe?.gameState ?? {}).map(([key, value]) => [`state.${key}`, value]),
  ),
  "player.x": probe?.player?.x ?? null,
  "player.y": probe?.player?.y ?? null,
  "player.z": probe?.player?.z ?? null,
  hudText: probe?.hudText ?? null,
});

const inputAction = (step: GamePlaytestStep): string =>
  "holdMs" in step
    ? `held ${"keys" in step ? step.keys.join("+") : "key" in step ? step.key : "hold" in step ? step.hold : "drag"} ${step.holdMs}ms`
    : "click" in step
      ? `clicked ${step.click}${step.x === undefined || step.y === undefined ? "" : ` at ${step.x},${step.y}`} 0ms`
      : "mouseMove" in step
        ? `mouseMove ${step.mouseMove.dx},${step.mouseMove.dy} 0ms`
        : "press" in step
          ? `pressed ${step.press}`
          : "waitMs" in step
            ? `waited ${step.waitMs}ms`
            : "screenshot";

/** The input in words, shared by frame labels and composed pair cards. */
export const playtestStepAction = inputAction;

/** Capture input causality, including zero change, without inferring response. */
export const playtestStepWithEvidence = async (input: {
  readonly step: GamePlaytestStep;
  readonly stepIndex: number;
  readonly capture: () => Promise<Capture>;
  readonly execute: () => Promise<boolean>;
  readonly captureAllSteps?: boolean;
}): Promise<{ readonly executed: boolean; readonly frames: readonly GamePlaytestScreenshot[] }> => {
  const { step, stepIndex } = input;
  if (("waitMs" in step && !input.captureAllSteps) || "screenshot" in step)
    return { executed: await input.execute(), frames: [] };
  const before = await input.capture();
  const executed = await input.execute();
  if (!executed && !input.captureAllSteps) return { executed, frames: [] };
  const after = await input.capture();
  const changedPercent =
    before.pixels === null || after.pixels === null
      ? null
      : compareFrameSamples(before.pixels, after.pixels).changedPercent;
  const beforeState = values(before.probe);
  const afterState = values(after.probe);
  const stateChanges = [...new Set([...Object.keys(beforeState), ...Object.keys(afterState)])]
    .filter((key) => beforeState[key] !== afterState[key])
    .map((key) => ({ key, before: beforeState[key] ?? null, after: afterState[key] ?? null }));
  const action = inputAction(step);
  const pair = {
    stepIndex,
    input: step,
    changedPercent,
    stateChanges: before.probe === null || after.probe === null ? null : stateChanges,
  };
  return {
    executed,
    frames: [
      {
        ...before.screenshot,
        label: `input ${stepIndex + 1} before: no input`,
        inputPair: { ...pair, phase: "before" },
      },
      {
        ...after.screenshot,
        label: `input ${stepIndex + 1} after: ${action}`,
        inputPair: { ...pair, phase: "after" },
      },
    ],
  };
};

/** Four complete pairs replace loose frames; spread across long routes. */
export const selectInputPairFrames = <
  T extends {
    readonly inputPair?: {
      readonly stepIndex: number;
      readonly phase: "before" | "after";
      readonly input?: GamePlaytestStep;
    };
  },
>(
  frames: readonly T[],
): readonly T[] => {
  const pairs = new Map<number, T[]>();
  for (const frame of frames) {
    if (frame.inputPair === undefined) continue;
    if (
      frame.inputPair.input !== undefined &&
      ("waitMs" in frame.inputPair.input || "screenshot" in frame.inputPair.input)
    )
      continue;
    const pair = pairs.get(frame.inputPair.stepIndex) ?? [];
    pair.push(frame);
    pairs.set(frame.inputPair.stepIndex, pair);
  }
  const complete = [...pairs.values()].filter(
    (pair) =>
      pair.length === 2 &&
      pair[0]!.inputPair!.phase === "before" &&
      pair[1]!.inputPair!.phase === "after",
  );
  if (complete.length === 0)
    return frames.filter((frame) => frame.inputPair === undefined).slice(0, 8);
  if (complete.length <= 4) return complete.flat();
  return Array.from(
    { length: 4 },
    (_, index) => complete[Math.round((index * (complete.length - 1)) / 3)]!,
  ).flat();
};
