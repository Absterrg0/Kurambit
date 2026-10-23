/**
 * Runs a bounded hold or wait on a monotonic deadline. Capture work consumes
 * the window just like sleeping does, so a hold lasts its requested duration
 * instead of extending by every screenshot it takes.
 */
export interface CaptureWindow {
  readonly duration: number;
  /** Undefined disables interval captures; otherwise the minimum spacing. */
  readonly captureInterval?: number | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly move?: ((fraction: number) => Promise<void>) | undefined;
  /** Called at each interval with the actual elapsed milliseconds. */
  readonly capture?: ((elapsedMs: number) => Promise<void>) | undefined;
}

export const runCaptureWindow = async (input: CaptureWindow): Promise<void> => {
  if (input.duration <= 0) {
    await input.move?.(1);
    return;
  }
  const interval = Math.max(1, input.captureInterval ?? input.duration);
  const startedAt = input.now();
  const deadline = startedAt + input.duration;
  let nextCapture = interval;
  for (;;) {
    const elapsed = input.now() - startedAt;
    if (elapsed >= input.duration) break;
    const untilCapture = nextCapture - elapsed;
    const slice = Math.max(
      0,
      Math.min(input.move === undefined ? interval : 50, untilCapture, deadline - input.now()),
    );
    if (slice > 0) await input.sleep(slice);
    const after = Math.min(input.duration, input.now() - startedAt);
    await input.move?.(after / input.duration);
    if (
      input.captureInterval !== undefined &&
      input.capture !== undefined &&
      after >= nextCapture &&
      after < input.duration
    ) {
      await input.capture(Math.round(after));
      const capturedAt = input.now() - startedAt;
      // A slow capture spans several intervals; never burst to catch up.
      while (nextCapture <= capturedAt) nextCapture += interval;
    }
  }
  // Capture work can consume the tail of the window; the drag still finishes.
  await input.move?.(1);
};
