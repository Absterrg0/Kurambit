import { describe, expect, it } from "vitest";
import { compareFrameSamples, type FrameSample } from "./playtestFrames.ts";

const frame = (width: number, height: number, pixel: readonly number[]): FrameSample => ({
  width,
  height,
  data: Array.from({ length: width * height }, () => pixel).flat(),
});

describe("compareFrameSamples", () => {
  it("calls identical frames unresponsive", () => {
    const before = frame(4, 2, [20, 40, 60, 255]);
    expect(compareFrameSamples(before, frame(4, 2, [20, 40, 60, 255]))).toEqual({
      changedPercent: 0,
      responded: false,
    });
  });

  it("sees a large visible change", () => {
    const before = frame(10, 10, [0, 0, 0, 255]);
    const after = frame(10, 10, [255, 255, 255, 255]);
    expect(compareFrameSamples(before, after)).toEqual({
      changedPercent: 100,
      responded: true,
    });
  });

  it("ignores differences below the per-channel tolerance", () => {
    const before = frame(10, 10, [100, 100, 100, 255]);
    const after = frame(10, 10, [108, 108, 108, 255]);
    expect(compareFrameSamples(before, after)).toEqual({
      changedPercent: 0,
      responded: false,
    });
  });

  it("requires the changed share to cross the response threshold", () => {
    // One changed pixel out of 2304 is noise; twelve (0.52%) is a response.
    const before = frame(64, 36, [0, 0, 0, 255]);
    const faint = frame(64, 36, [0, 0, 0, 255]) as { width: number; height: number; data: number[] };
    faint.data[0] = 255;
    expect(compareFrameSamples(before, faint).responded).toBe(false);

    const visible = frame(64, 36, [0, 0, 0, 255]) as {
      width: number;
      height: number;
      data: number[];
    };
    for (let index = 0; index < 12; index++) visible.data[index * 4] = 255;
    expect(compareFrameSamples(before, visible)).toEqual({
      changedPercent: 0.52,
      responded: true,
    });
  });

  it("treats mismatched samples as a full change rather than a pass", () => {
    expect(compareFrameSamples(frame(2, 2, [0, 0, 0, 255]), frame(3, 2, [0, 0, 0, 255]))).toEqual({
      changedPercent: 100,
      responded: true,
    });
  });
});
