// @effect-diagnostics globalTimers:off -- Slow captures are real wall-clock work proving nominal time stays independent.
import { describe, expect, it } from "vite-plus/test";
import { runCaptureWindow } from "./playtestTiming.ts";

const fakeClock = (calls: number[]) => ({
  runFor: async (ticks: number) => {
    calls.push(ticks);
  },
});

describe("capture window timing", () => {
  it("advances nominal game time only through the controlled clock", async () => {
    const runFor: number[] = [];
    const captures: number[] = [];
    await runCaptureWindow({
      duration: 300,
      captureInterval: 100,
      clock: fakeClock(runFor),
      capture: async (elapsed) => {
        captures.push(elapsed);
      },
    });
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(300);
    expect(captures).toEqual([100, 200]);
  });

  it("does not let slow capture work stretch the nominal hold", async () => {
    const runFor: number[] = [];
    const captures: number[] = [];
    const moves: number[] = [];
    await runCaptureWindow({
      duration: 250,
      captureInterval: 100,
      clock: fakeClock(runFor),
      move: async (fraction) => {
        moves.push(fraction);
      },
      capture: async (elapsed) => {
        captures.push(elapsed);
        // A screenshot read is wall-clock work while the clock stays paused;
        // it must not consume nominal game time.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });
    // Nominal game time is exactly the hold; wall-clock capture cost stays out.
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(250);
    expect(captures).toEqual([100, 200]);
    expect(moves.at(-1)).toBe(1);
  });

  it("keeps a drag's movement fractions inside the requested duration", async () => {
    const runFor: number[] = [];
    const moves: number[] = [];
    await runCaptureWindow({
      duration: 200,
      clock: fakeClock(runFor),
      move: async (fraction) => {
        moves.push(fraction);
      },
    });
    expect(runFor.reduce((sum, ticks) => sum + ticks, 0)).toBe(200);
    expect(moves.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
    expect(moves.at(-1)).toBe(1);
  });

  it("stops promptly on abort without advancing further", async () => {
    const runFor: number[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCaptureWindow({
        duration: 1000,
        captureInterval: 100,
        clock: fakeClock(runFor),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(runFor).toEqual([]);
  });
});
