import { describe, expect, it } from "vite-plus/test";
import { runCaptureWindow } from "./playtestTiming.ts";

describe("capture window timing", () => {
  it("counts capture work against the same monotonic deadline", async () => {
    let now = 0;
    const captures: number[] = [];
    await runCaptureWindow({
      duration: 300,
      captureInterval: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      capture: async (elapsed) => {
        captures.push(elapsed);
        // A screenshot read is real elapsed time inside the hold.
        now += 40;
      },
    });
    expect(now).toBe(300);
    expect(captures).toEqual([100, 200]);
  });

  it("does not add a full step after a slow capture would overrun the hold", async () => {
    let now = 0;
    const captures: number[] = [];
    const moves: number[] = [];
    await runCaptureWindow({
      duration: 250,
      captureInterval: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      move: async (fraction) => {
        moves.push(fraction);
      },
      capture: async (elapsed) => {
        captures.push(elapsed);
        now += 300;
      },
    });
    // The slow capture is included; no extra sleep pushes the hold to 550.
    expect(now).toBe(400);
    expect(captures).toEqual([100]);
    expect(moves.at(-1)).toBe(1);
  });

  it("keeps a drag's movement fractions inside the requested duration", async () => {
    let now = 0;
    const moves: number[] = [];
    await runCaptureWindow({
      duration: 200,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      move: async (fraction) => {
        moves.push(fraction);
      },
    });
    expect(now).toBe(200);
    expect(moves.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
    expect(moves.at(-1)).toBe(1);
  });
});
