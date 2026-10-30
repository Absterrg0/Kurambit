/**
 * Runs a bounded hold or wait on the page's controlled clock. Nominal game
 * time advances only through `clock.runFor`, so screenshot, probe and frame
 * work that happens while the clock stays paused never stretches a hold: a
 * slow capture leaves the game's elapsed time exactly where it was.
 *
 * The driver pauses the Playwright clock once after boot and keeps it paused
 * for the whole route. Every `runCaptureWindow` slice is an explicit nominal
 * duration from the route (waitMs, holdMs, press 50ms, drag holdMs), never a
 * wall-clock deadline while the page is frozen.
 */
import type { Clock } from "playwright-core";

/** The Playwright clock surface this window needs; nothing else can advance game time. */
export type ControlledClock = Pick<Clock, "runFor">;

export interface CaptureWindow {
  readonly duration: number;
  /** Undefined disables interval captures; otherwise the minimum spacing. */
  readonly captureInterval?: number | undefined;
  readonly clock: ControlledClock;
  readonly signal?: AbortSignal | undefined;
  readonly move?: ((fraction: number) => Promise<void>) | undefined;
  /** Called at each interval with the nominal elapsed milliseconds. */
  readonly capture?: ((elapsedMs: number) => Promise<void>) | undefined;
}

export const runCaptureWindow = async (input: CaptureWindow): Promise<void> => {
  if (input.duration <= 0) {
    await input.move?.(1);
    return;
  }
  const interval = Math.max(1, input.captureInterval ?? input.duration);
  let elapsed = 0;
  let nextCapture = interval;
  for (;;) {
    input.signal?.throwIfAborted();
    if (elapsed >= input.duration) break;
    const remaining = input.duration - elapsed;
    const untilCapture = nextCapture - elapsed;
    const slice = Math.max(
      0,
      Math.min(input.move === undefined ? interval : 50, untilCapture, remaining),
    );
    if (slice > 0) {
      await input.clock.runFor(slice);
      input.signal?.throwIfAborted();
      elapsed = Math.min(input.duration, elapsed + slice);
      await input.move?.(elapsed / input.duration);
      input.signal?.throwIfAborted();
    }
    if (
      input.captureInterval !== undefined &&
      input.capture !== undefined &&
      elapsed >= nextCapture &&
      elapsed < input.duration
    ) {
      await input.capture(Math.round(elapsed));
      input.signal?.throwIfAborted();
      // Captures run while the clock stays paused, so nominal time does not
      // move under them; never burst to catch up.
      while (nextCapture <= elapsed) nextCapture += interval;
      if (slice === 0) continue;
    } else if (slice === 0) {
      // No progress is possible: an interval with no capture callback would
      // stall once elapsed passes it (unused in production, where a capture
      // interval always has a capture). Advance the remainder directly so a
      // miswired caller cannot spin forever.
      const rest = input.duration - elapsed;
      if (rest <= 0) break;
      await input.clock.runFor(rest);
      input.signal?.throwIfAborted();
      elapsed = input.duration;
      await input.move?.(elapsed / input.duration);
      input.signal?.throwIfAborted();
      break;
    }
  }
  // Capture work can consume the tail of the window; the drag still finishes.
  await input.move?.(1);
};
