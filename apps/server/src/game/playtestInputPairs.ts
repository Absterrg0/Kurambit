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
  /**
   * Explicit capture-off for an uncaptured prelude: run the exact same input
   * execution (clock, holds, releases) but take no before/after PNG, no sample
   * and no interval frames. The caller still runs each declared wait once.
   */
  readonly skipCapture?: boolean;
  /**
   * Already-declared contiguous trailing wait time the caller executed as part
   * of this input's observation window. The after capture runs after those
   * waits, so the pair credits the input with the effect they realize. The
   * route itself is unchanged: no extra game time, only the existing waits
   * attributed to the input that caused them.
   */
  readonly observation?:
    | { readonly delayMs: number; readonly observedAfterStepIndex: number }
    | undefined;
}): Promise<{ readonly executed: boolean; readonly frames: readonly GamePlaytestScreenshot[] }> => {
  const { step, stepIndex } = input;
  if (input.skipCapture === true) return { executed: await input.execute(), frames: [] };
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
  const delayMs = input.observation?.delayMs ?? 0;
  const observedAfterStepIndex = input.observation?.observedAfterStepIndex;
  const pair = {
    stepIndex,
    input: step,
    changedPercent,
    stateChanges: before.probe === null || after.probe === null ? null : stateChanges,
    ...(delayMs > 0 ? { observationDelayMs: delayMs } : {}),
    ...(observedAfterStepIndex === undefined ? {} : { observedAfterStepIndex }),
  };
  const afterLabel =
    delayMs > 0 && observedAfterStepIndex !== undefined
      ? `input ${stepIndex + 1} after: ${action} (+${delayMs}ms observation via step ${observedAfterStepIndex + 1})`
      : `input ${stepIndex + 1} after: ${action}`;
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
        label: afterLabel,
        inputPair: { ...pair, phase: "after" },
      },
    ],
  };
};

/**
 * Already-declared contiguous trailing waits an input's after-observation may
 * include. Only `waitMs` steps count, stopping at the first different step,
 * the route end, or a screenshot label. Callers skip consumption when
 * `captureAllSteps` is set, so waits keep their own pairs and budget math.
 * Pure, so both the one-shot driver and the persistent explore driver share it.
 */
export const trailingWaitObservation = (
  steps: readonly GamePlaytestStep[],
  fromIndex: number,
): { readonly count: number; readonly delayMs: number } => {
  let count = 0;
  let delayMs = 0;
  for (let index = fromIndex; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (!("waitMs" in step)) break;
    count += 1;
    delayMs += step.waitMs;
  }
  return { count, delayMs };
};

/** Four complete pairs replace loose frames; diverse and state-witness aware on long routes. */
export const playtestInputSignature = (step: GamePlaytestStep): string => {
  if ("click" in step) return `click:${step.click}`;
  if ("keys" in step) return `keys:${[...step.keys].sort().join("+")}`;
  if ("key" in step) return `key:${step.key}`;
  if ("press" in step) return `press:${step.press}`;
  if ("hold" in step) return `hold:${step.hold}`;
  if ("drag" in step) return `drag`;
  if ("mouseMove" in step) return `mouseMove`;
  return "other";
};

/**
 * Whether one pair shows a real gameplay effect, as selection evidence only.
 * HUD-only is not definite gameplay, and a lone numeric tick is weak (it has
 * the shape a clock would also show). Player movement, a qualitative state
 * change, or two counters moving together is a strong witness. Selection
 * measurements are not quality verdicts.
 */
export const playtestPairWitnessScore = (pair: {
  readonly stateChanges?: ReadonlyArray<{
    readonly key: string;
    readonly before: unknown;
    readonly after: unknown;
  }> | null;
}): 0 | 1 | 2 => {
  const changes = pair.stateChanges;
  if (changes == null || changes.length === 0) return 0;
  const meaningful = changes.filter((change) => change.key !== "hudText");
  if (meaningful.length === 0) return 0;
  for (const change of meaningful) {
    if (change.key.startsWith("player.") && change.before !== change.after) return 2;
  }
  let numericCount = 0;
  for (const change of meaningful) {
    if (change.before === change.after) continue;
    if (typeof change.before !== "number" || typeof change.after !== "number") return 2;
    numericCount += 1;
  }
  if (numericCount >= 2) return 2;
  if (numericCount === 1) return 1;
  return 0;
};

interface PairRank {
  readonly stepIndex: number;
  readonly signature: string;
  readonly score: 0 | 1 | 2;
}

const evenlySpacedIndices = (length: number, limit: number): number[] =>
  Array.from({ length: limit }, (_, index) => Math.round((index * (length - 1)) / (limit - 1)));

/**
 * Bounded deterministic diverse and state-witness aware whole-pair choice.
 * Keeps at most `limit` pairs: one best (highest witness, then latest for
 * later progression) per input signature, then fills or trims by witness.
 * A single signature or no witness falls back to even spread so timeline
 * coverage, not clustering, decides. The final order is timeline order, so
 * progression reads early to late. Never splits a before/after pair.
 */
export const chooseDiverseWitnessPairs = (
  ranks: ReadonlyArray<PairRank>,
  limit: number,
): ReadonlyArray<number> => {
  if (limit <= 0) return [];
  if (limit === 1)
    return ranks
      .toSorted((a, b) => b.score - a.score || b.stepIndex - a.stepIndex)
      .slice(0, 1)
      .map((rank) => rank.stepIndex);
  if (ranks.length <= limit) return ranks.map((rank) => rank.stepIndex);
  const maxScore = ranks.reduce((max, rank) => Math.max(max, rank.score), 0);
  const signatures = new Set(ranks.map((rank) => rank.signature));
  if (maxScore === 0 || (signatures.size === 1 && ranks.every((rank) => rank.score === maxScore))) {
    const indices = evenlySpacedIndices(ranks.length, limit);
    return indices.map((index) => ranks[index]!.stepIndex);
  }
  const bySignature = new Map<string, PairRank[]>();
  for (const rank of ranks) {
    const group = bySignature.get(rank.signature) ?? [];
    group.push(rank);
    bySignature.set(rank.signature, group);
  }
  const candidates = [...bySignature.values()].map(
    (group) =>
      group.toSorted(
        (left, right) => right.score - left.score || right.stepIndex - left.stepIndex,
      )[0]!,
  );
  const byScoreLatest = (left: PairRank, right: PairRank) =>
    right.score - left.score || right.stepIndex - left.stepIndex;
  if (candidates.length > limit) {
    return candidates
      .toSorted(byScoreLatest)
      .slice(0, limit)
      .map((rank) => rank.stepIndex)
      .sort((left, right) => left - right);
  }
  const chosen = new Set(candidates.map((rank) => rank.stepIndex));
  if (candidates.length < limit) {
    const remaining = ranks
      .filter((rank) => !chosen.has(rank.stepIndex))
      .toSorted((left, right) => right.score - left.score || left.stepIndex - right.stepIndex);
    for (const rank of remaining) {
      if (chosen.size >= limit) break;
      chosen.add(rank.stepIndex);
    }
  }
  return [...chosen].sort((left, right) => left - right);
};

export const selectInputPairFrames = <
  T extends {
    readonly inputPair?: {
      readonly stepIndex: number;
      readonly phase: "before" | "after";
      readonly input?: GamePlaytestStep;
      readonly stateChanges?: ReadonlyArray<{
        readonly key: string;
        readonly before: GamePlaytestStateValue | null;
        readonly after: GamePlaytestStateValue | null;
      }> | null;
    };
    readonly [key: string]: unknown;
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
  const complete = [...pairs.entries()]
    .filter(
      ([, pair]) =>
        pair.length === 2 &&
        pair[0]!.inputPair!.phase === "before" &&
        pair[1]!.inputPair!.phase === "after",
    )
    .sort(([left], [right]) => left - right);
  if (complete.length === 0)
    return frames.filter((frame) => frame.inputPair === undefined).slice(0, 8);
  if (complete.length <= 4) return complete.flatMap(([, pair]) => pair);
  const ranks: PairRank[] = complete.map(([stepIndex, pair]) => {
    const inputPair = pair[1]!.inputPair!;
    return {
      stepIndex,
      signature:
        inputPair.input === undefined ? "unknown" : playtestInputSignature(inputPair.input),
      score: playtestPairWitnessScore(inputPair),
    };
  });
  const chosen = new Set(chooseDiverseWitnessPairs(ranks, 4));
  return complete.filter(([stepIndex]) => chosen.has(stepIndex)).flatMap(([, pair]) => pair);
};
