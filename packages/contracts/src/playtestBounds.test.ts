import { describe, expect, it } from "vite-plus/test";

import {
  GAME_PLAYTEST_BOUNDS,
  PLAYTEST_DEFAULT_CAPTURE,
  base64ByteLength,
  fitScreenshotsToBudget,
  integerScaledCapture,
  playtestInputIssues,
} from "./playtestBounds.ts";

describe("playtestInputIssues", () => {
  it("accepts the defaults and a normal capture", () => {
    expect(
      playtestInputIssues({
        steps: [{ click: "left" }, { key: "w", holdMs: 1_000 }, { waitMs: 500 }],
        width: 960,
        height: 540,
      }),
    ).toEqual([]);
  });

  it("rejects dimensions outside 320-1920", () => {
    expect(playtestInputIssues({ width: 319 })).toContain(
      `width must be between ${GAME_PLAYTEST_BOUNDS.minDimension} and ${GAME_PLAYTEST_BOUNDS.maxDimension} pixels.`,
    );
    expect(playtestInputIssues({ height: 4_000 })).toContain(
      `height must be between ${GAME_PLAYTEST_BOUNDS.minDimension} and ${GAME_PLAYTEST_BOUNDS.maxDimension} pixels.`,
    );
  });

  it("rejects one step longer than ten seconds and a sequence longer than two minutes", () => {
    expect(playtestInputIssues({ steps: [{ waitMs: 10_001 }] })).toContain(
      "Step 1 lasts 10001 ms; one step may last at most 10000 ms.",
    );
    const long = Array.from({ length: 13 }, () => ({ key: "w", holdMs: 10_000 }));
    expect(playtestInputIssues({ steps: long })).toContain(
      "The steps take 130000 ms; a playtest may run at most 120000 ms of steps.",
    );
  });

  it("rejects too many steps, too many screenshots and a long boot timeout", () => {
    expect(
      playtestInputIssues({ steps: Array.from({ length: 61 }, () => ({ waitMs: 1 })) }),
    ).toContain("Use at most 60 steps; this request has 61.");
    expect(
      playtestInputIssues({
        steps: Array.from({ length: 13 }, (_, index) => ({ screenshot: `frame-${index}` })),
      }),
    ).toContain("Capture at most 12 screenshots; this request asks for 13.");
    expect(playtestInputIssues({ bootTimeoutMs: 120_001 })).toContain(
      "bootTimeoutMs must be at most 120000 ms.",
    );
  });

  it("rejects non-positive and non-finite values instead of launching with them", () => {
    expect(playtestInputIssues({ width: 0 })).toContain("width must be a positive number.");
    expect(playtestInputIssues({ bootTimeoutMs: Number.POSITIVE_INFINITY })).toContain(
      "bootTimeoutMs must be a positive number.",
    );
  });
});

describe("fitScreenshotsToBudget", () => {
  const frame = (size: number) => ({ label: `${size}`, data: "A".repeat(size) });

  it("keeps decoded PNG bytes under the aggregate budget and reports the rest as dropped", () => {
    const { kept, dropped } = fitScreenshotsToBudget([frame(8), frame(8), frame(8)], 12);
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual([frame(8)]);
    expect(kept.reduce((sum, shot) => sum + base64ByteLength(shot.data), 0)).toBeLessThanOrEqual(
      12,
    );
  });

  it("keeps the first frames in capture order", () => {
    const shots = [frame(4), frame(4), frame(4)];
    expect(fitScreenshotsToBudget(shots, 6).kept.map((shot) => shot.label)).toEqual(["4", "4"]);
  });
});

describe("integerScaledCapture", () => {
  it("targets a whole-number multiple of the game's own viewport", () => {
    // A 640×360 game fills a 1280×720 window at exactly 2×, no letterbox.
    expect(integerScaledCapture({ width: 640, height: 360 }, PLAYTEST_DEFAULT_CAPTURE)).toEqual({
      width: 1280,
      height: 720,
      scale: 2,
    });
    // A 1280×720 game already fills the default box at 1×.
    expect(integerScaledCapture({ width: 1280, height: 720 }, PLAYTEST_DEFAULT_CAPTURE)).toEqual({
      width: 1280,
      height: 720,
      scale: 1,
    });
  });

  it("scales down to the largest whole multiple that fits a smaller box, never up", () => {
    expect(integerScaledCapture({ width: 640, height: 360 }, { width: 640, height: 360 })).toEqual({
      width: 640,
      height: 360,
      scale: 1,
    });
    expect(integerScaledCapture({ width: 640, height: 360 }, { width: 960, height: 540 })).toEqual({
      width: 640,
      height: 360,
      scale: 1,
    });
  });

  it("respects the result bounds and keeps non-16:9 games whole", () => {
    expect(integerScaledCapture({ width: 480, height: 360 }, PLAYTEST_DEFAULT_CAPTURE)).toEqual({
      width: 960,
      height: 720,
      scale: 2,
    });
    // A base already at the 1920 bound cannot scale again.
    expect(integerScaledCapture({ width: 1920, height: 1080 }, PLAYTEST_DEFAULT_CAPTURE)).toEqual({
      width: 1920,
      height: 1080,
      scale: 1,
    });
  });

  it("rejects a base viewport the capture bounds cannot hold", () => {
    expect(
      integerScaledCapture({ width: 2000, height: 1000 }, PLAYTEST_DEFAULT_CAPTURE),
    ).toBeNull();
    expect(integerScaledCapture({ width: 100, height: 100 }, PLAYTEST_DEFAULT_CAPTURE)).toBeNull();
    expect(integerScaledCapture({ width: 0, height: 0 }, PLAYTEST_DEFAULT_CAPTURE)).toBeNull();
  });
});
