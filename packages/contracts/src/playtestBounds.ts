import {
  GAME_PLAYTEST_BOUNDS,
  GAME_TRY_INPUT_BOUNDS,
  type GamePlaytestStep,
  type GameViewport,
  type GameWebPlaytestInput,
} from "./game.ts";

export { GAME_PLAYTEST_BOUNDS };

const durationMs = (step: GamePlaytestStep) => {
  if ("press" in step) return 50;
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
  if (
    input.captureEveryMs !== undefined &&
    (!Number.isFinite(input.captureEveryMs) ||
      input.captureEveryMs < GAME_TRY_INPUT_BOUNDS.minCaptureEveryMs)
  )
    issues.push(`captureEveryMs must be at least ${GAME_TRY_INPUT_BOUNDS.minCaptureEveryMs} ms.`);
  if (input.captureEveryMs !== undefined && input.captureEveryMs > 0) {
    const captures =
      2 +
      (input.steps ?? []).reduce(
        (sum, step) =>
          sum +
          ("screenshot" in step ? 1 : "waitMs" in step && !input.captureAllSteps ? 0 : 2) +
          Math.max(0, Math.ceil(durationMs(step) / input.captureEveryMs!) - 1),
        0,
      );
    if (captures > GAME_TRY_INPUT_BOUNDS.maxFrames)
      issues.push(
        `Interval capture requests ${captures} frames; limit is ${GAME_TRY_INPUT_BOUNDS.maxFrames}. ` +
          "The plan is 2 setup frames + 2 per input step (1 per screenshot; a wait adds 2 only with captureAllSteps) + ceil(stepMs / captureEveryMs) - 1 per step. " +
          "Increase captureEveryMs or shorten the steps.",
      );
  }
  for (const [name, value] of [
    ["width", input.width],
    ["height", input.height],
    ["bootTimeoutMs", input.bootTimeoutMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) issues.push(`${name} must be a positive number.`);
  }
  if (input.exactSize === true && (input.width === undefined || input.height === undefined))
    issues.push("exactSize requires both width and height.");
  const width = input.width ?? PLAYTEST_DEFAULT_CAPTURE.width;
  const height = input.height ?? PLAYTEST_DEFAULT_CAPTURE.height;
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

/** The capture box a playtest targets when the caller does not ask for one. */
export const PLAYTEST_DEFAULT_CAPTURE = { width: 1280, height: 720 } as const;

/**
 * The integer-scaled capture size for a web playtest. The game keeps its own
 * pixel grid: the browser window is a whole-number multiple of the project's
 * base viewport, so a 640×360 game is captured at 1280×720 instead of fit
 * inside an unrelated box that would letterbox most of the frame.
 *
 * The box bounds the scale, never up: a base wider than the box still captures
 * at least at scale 1, and a game larger than a result bound must not silently
 * report an oversized capture. Returns null when the base viewport itself does
 * not fit the result bounds, which the caller must reject.
 */
export const integerScaledCapture = (
  base: GameViewport,
  box: GameViewport,
  bounds: {
    readonly maxDimension: number;
    readonly minDimension: number;
  } = GAME_PLAYTEST_BOUNDS,
): (GameViewport & { readonly scale: number }) | null => {
  const widest = Math.max(base.width, base.height);
  if (
    !Number.isFinite(base.width) ||
    !Number.isFinite(base.height) ||
    base.width <= 0 ||
    base.height <= 0
  )
    return null;
  if (widest > bounds.maxDimension || Math.min(base.width, base.height) < bounds.minDimension)
    return null;
  const scale = Math.max(
    1,
    Math.min(
      Math.floor(box.width / base.width),
      Math.floor(box.height / base.height),
      Math.floor(bounds.maxDimension / widest),
    ),
  );
  return { width: base.width * scale, height: base.height * scale, scale };
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

/** The active critic gets a short experiment, with every requested frame accounted for. */
export const tryInputIssues = (input: import("./game.ts").GameTryInput): readonly string[] => {
  const bounds = GAME_TRY_INPUT_BOUNDS;
  const issues = [...playtestInputIssues(input)];
  if (input.steps.length === 0 || input.steps.length > bounds.maxSteps)
    issues.push(
      `game_try_input requires 1–${bounds.maxSteps} steps; received ${input.steps.length}.`,
    );
  const interval = input.captureEveryMs ?? 1000;
  if (!Number.isFinite(interval) || interval < bounds.minCaptureEveryMs)
    issues.push(`captureEveryMs must be at least ${bounds.minCaptureEveryMs} ms.`);
  const total = input.steps.reduce((sum, step) => sum + durationMs(step), 0);
  if (total > bounds.maxSequenceMs)
    issues.push(`game_try_input steps take ${total} ms; limit is ${bounds.maxSequenceMs} ms.`);
  const frames =
    2 +
    input.steps.reduce(
      (sum, step) =>
        sum +
        ("screenshot" in step ? 1 : 2) +
        Math.max(0, Math.ceil(durationMs(step) / interval) - 1),
      0,
    );
  if (frames > bounds.maxFrames)
    issues.push(
      `game_try_input requests ${frames} frames; limit is ${bounds.maxFrames}. Increase captureEveryMs or shorten the steps.`,
    );
  for (const [index, step] of input.steps.entries()) {
    if ("keys" in step && (step.keys.length === 0 || step.keys.length > 8))
      issues.push(`Step ${index + 1} requires 1–8 keys.`);
    const keys =
      "keys" in step
        ? step.keys
        : "key" in step
          ? [step.key]
          : "press" in step
            ? [step.press]
            : "hold" in step
              ? [step.hold]
              : [];
    if (keys.some((key) => key.length === 0 || key.length > 80))
      issues.push(`Step ${index + 1} keys must contain 1–80 characters.`);
    const points = "drag" in step ? [step.drag.from, step.drag.to] : "click" in step ? [step] : [];
    for (const point of points)
      if (
        (point.x !== undefined &&
          (!Number.isFinite(point.x) ||
            point.x < 0 ||
            point.x > GAME_PLAYTEST_BOUNDS.maxDimension)) ||
        (point.y !== undefined &&
          (!Number.isFinite(point.y) || point.y < 0 || point.y > GAME_PLAYTEST_BOUNDS.maxDimension))
      )
        issues.push(
          `Step ${index + 1} pointer coordinates must be finite and within the viewport.`,
        );
    if ("click" in step && (step.x === undefined) !== (step.y === undefined))
      issues.push(`Step ${index + 1} click requires both x and y.`);
    if (
      "mouseMove" in step &&
      (!Number.isFinite(step.mouseMove.dx) || !Number.isFinite(step.mouseMove.dy))
    )
      issues.push(`Step ${index + 1} mouse movement must be finite.`);
  }
  return issues;
};
