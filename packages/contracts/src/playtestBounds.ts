import { GAME_PLAYTEST_BOUNDS, type GamePlaytestStep, type GameWebPlaytestInput } from "./game.ts";

export { GAME_PLAYTEST_BOUNDS };

const durationMs = (step: GamePlaytestStep) => {
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  return 0;
};

/**
 * Everything wrong with a capture request, in the order a caller should fix it.
 * Empty means the run may start. Cheap and pure, so the server rejects before
 * it exports, serves a build, or launches the browser.
 */
export const playtestInputIssues = (input: GameWebPlaytestInput): readonly string[] => {
  const issues: string[] = [];
  const bounds = GAME_PLAYTEST_BOUNDS;
  for (const [name, value] of [
    ["width", input.width],
    ["height", input.height],
    ["bootTimeoutMs", input.bootTimeoutMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) issues.push(`${name} must be a positive number.`);
  }
  const width = input.width ?? 960;
  const height = input.height ?? 540;
  const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
  if (Number.isFinite(width) && (width < bounds.minDimension || width > bounds.maxDimension))
    issues.push(`width must be between ${bounds.minDimension} and ${bounds.maxDimension} pixels.`);
  if (Number.isFinite(height) && (height < bounds.minDimension || height > bounds.maxDimension))
    issues.push(`height must be between ${bounds.minDimension} and ${bounds.maxDimension} pixels.`);
  if (Number.isFinite(bootTimeoutMs) && bootTimeoutMs > bounds.maxBootTimeoutMs)
    issues.push(`bootTimeoutMs must be at most ${bounds.maxBootTimeoutMs} ms.`);
  const steps = input.steps ?? [];
  if (steps.length > bounds.maxSteps)
    issues.push(`Use at most ${bounds.maxSteps} steps; this request has ${steps.length}.`);
  let screenshots = 0;
  let sequenceMs = 0;
  for (const [index, step] of steps.entries()) {
    const duration = durationMs(step);
    if (!Number.isFinite(duration) || duration < 0)
      issues.push(`Step ${index + 1} has an invalid duration.`);
    if (Number.isFinite(duration) && duration > bounds.maxStepMs)
      issues.push(
        `Step ${index + 1} lasts ${duration} ms; one step may last at most ${bounds.maxStepMs} ms.`,
      );
    if ("screenshot" in step) screenshots += 1;
    if (Number.isFinite(duration)) sequenceMs += duration;
  }
  if (screenshots > bounds.maxScreenshotSteps)
    issues.push(
      `Capture at most ${bounds.maxScreenshotSteps} screenshots; this request asks for ${screenshots}.`,
    );
  if (sequenceMs > bounds.maxSequenceMs)
    issues.push(
      `The steps take ${sequenceMs} ms; a playtest may run at most ${bounds.maxSequenceMs} ms of steps.`,
    );
  return issues;
};

/** Decoded PNG bytes a base64 payload represents, without allocating the buffer. */
export const base64ByteLength = (data: string): number => {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

/**
 * The frames worth returning under the aggregate budget. Frames are considered
 * in capture order; the server persists every frame first, so a dropped one is
 * still available as evidence.
 */
export const fitScreenshotsToBudget = <T extends { readonly data: string }>(
  screenshots: readonly T[],
  maxBytes: number = GAME_PLAYTEST_BOUNDS.maxResultImageBytes,
): { readonly kept: readonly T[]; readonly dropped: readonly T[] } => {
  const kept: T[] = [];
  const dropped: T[] = [];
  let total = 0;
  for (const screenshot of screenshots) {
    const bytes = base64ByteLength(screenshot.data);
    if (total + bytes > maxBytes) dropped.push(screenshot);
    else {
      kept.push(screenshot);
      total += bytes;
    }
  }
  return { kept, dropped };
};
