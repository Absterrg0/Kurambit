import { describe, expect, it } from "vite-plus/test";

import {
  GAME_PLAYTEST_BOUNDS,
  PLAYTEST_DEFAULT_CAPTURE,
  base64ByteLength,
  fitScreenshotsToBudget,
  integerScaledCapture,
  playtestInputIssues,
  tryInputIssues,
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

  it("rejects unsafe interval captures through the existing playtest entry point", () => {
    expect(playtestInputIssues({ captureEveryMs: 0 })).toContain(
      "captureEveryMs must be at least 100 ms.",
    );
    expect(
      playtestInputIssues({
        captureEveryMs: 100,
        captureAllSteps: true,
        steps: [{ waitMs: 10_000 }],
      }).join(),
    ).toContain("limit is 32");
  });

  it("replays T115's interval route: 400 ms requests 33 frames, 500 ms is legal", () => {
    const steps = [
      { press: "Enter" },
      { waitMs: 500 },
      { hold: "ArrowRight", holdMs: 1800 },
      { screenshot: "gap-ahead" },
      { hold: "ArrowRight", holdMs: 600 },
      { screenshot: "at-the-mouth" },
      { hold: "ArrowRight", holdMs: 400 },
      { screenshot: "falling" },
      { waitMs: 600 },
      { screenshot: "in-the-dark" },
      { hold: "ArrowRight", holdMs: 1000 },
      { screenshot: "respawned" },
      { press: "Space" },
      { screenshot: "jump-works" },
    ];
    expect(playtestInputIssues({ steps, captureEveryMs: 400, captureAllSteps: true })).toContain(
      "Interval capture requests 33 frames; limit is 32. The plan is 2 setup frames + 2 per input step (1 per screenshot; a wait adds 2 only with captureAllSteps) + max(0, ceil(stepMs / captureEveryMs) - 1) per step. Increase captureEveryMs or shorten the steps.",
    );
    expect(playtestInputIssues({ steps, captureEveryMs: 500, captureAllSteps: true })).toEqual([]);
    // Exactly 32 planned frames: 2 setup frames + 15 input pairs.
    expect(
      playtestInputIssues({
        steps: Array.from({ length: 15 }, () => ({ press: "Space" })),
        captureEveryMs: 1000,
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

  it("an exact window needs both sides", () => {
    expect(playtestInputIssues({ exactSize: true, width: 900 })).toContain(
      "exactSize requires both width and height.",
    );
    expect(playtestInputIssues({ exactSize: true, width: 900, height: 900 })).toEqual([]);
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

describe("tryInputIssues", () => {
  it("replays T115's 13-step rejection and its 12-step route", () => {
    const steps = [
      { press: "Enter" },
      { waitMs: 400 },
      { hold: "ArrowRight", holdMs: 1800 },
      { screenshot: "mouth-ahead" },
      { hold: "ArrowRight", holdMs: 700 },
      { screenshot: "at-the-lip" },
      { hold: "ArrowRight", holdMs: 400 },
      { screenshot: "dropping" },
      { waitMs: 700 },
      { screenshot: "fallen-lives-2" },
      { hold: "ArrowRight", holdMs: 900 },
      { press: "Space" },
      { screenshot: "jump-ok" },
    ];
    expect(tryInputIssues({ steps, captureEveryMs: 700 })).toContain(
      "game_try_input requires 1–12 steps; received 13.",
    );
    expect(tryInputIssues({ steps: steps.slice(0, 12), captureEveryMs: 700 })).toEqual([]);
  });

  it("bounds steps, total duration, capture interval and planned frame count exactly", () => {
    expect(tryInputIssues({ steps: [] })).toContain(
      "game_try_input requires 1–12 steps; received 0.",
    );
    expect(
      tryInputIssues({ steps: Array.from({ length: 13 }, () => ({ press: "Space" })) }),
    ).toContain("game_try_input requires 1–12 steps; received 13.");
    expect(
      tryInputIssues({ steps: Array.from({ length: 4 }, () => ({ hold: "w", holdMs: 10_000 })) }),
    ).toContain("game_try_input steps take 40000 ms; limit is 30000 ms.");
    expect(tryInputIssues({ steps: [{ waitMs: 1000 }], captureEveryMs: 99 })).toContain(
      "captureEveryMs must be at least 100 ms.",
    );
    expect(
      tryInputIssues({ steps: [{ hold: "w", holdMs: 10_000 }], captureEveryMs: 100 }),
    ).toContain(
      "game_try_input requests 103 frames; limit is 32. Increase captureEveryMs or shorten the steps.",
    );
    expect(
      tryInputIssues({
        steps: [
          { press: "Space" },
          { click: "left", x: 30, y: 40 },
          { drag: { from: { x: 0, y: 0 }, to: { x: 300, y: 200 } }, holdMs: 1000 },
          { waitMs: 300 },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects unbounded input payloads and invalid pointer values", () => {
    expect(tryInputIssues({ steps: [{ keys: Array(9).fill("w"), holdMs: 1 }] }).join()).toContain(
      "1–8 keys",
    );
    expect(tryInputIssues({ steps: [{ press: "" }] }).join()).toContain("1–80 characters");
    expect(tryInputIssues({ steps: [{ click: "left", x: 10 }] }).join()).toContain("both x and y");
    expect(tryInputIssues({ steps: [{ mouseMove: { dx: Infinity, dy: 0 } }] }).join()).toContain(
      "finite",
    );
    expect(tryInputIssues({ steps: [{ waitMs: -1 }] }).join()).toContain("invalid duration");
  });
});
