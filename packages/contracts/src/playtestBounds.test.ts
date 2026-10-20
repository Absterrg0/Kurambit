import { describe, expect, it } from "vite-plus/test";

import {
  GAME_PLAYTEST_BOUNDS,
  base64ByteLength,
  fitScreenshotsToBudget,
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
