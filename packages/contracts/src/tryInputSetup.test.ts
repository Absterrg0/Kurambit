import { describe, expect, it } from "vite-plus/test";

import { tryInputIssues } from "./playtestBounds.ts";

// RED: setupSteps prelude (uncaptured) + observed suffix must validate as one
// bounded route: 48 setup + 12 observed = 60 total, 30s total, 32 frames
// observed-only. Screenshots are forbidden in setup.
describe("tryInput setupSteps prelude", () => {
  it("accepts a >12-step but <30s setup+suffix replay within the 32-frame cap", () => {
    const setupSteps = Array.from({ length: 20 }, () => ({ press: "Enter" }));
    const steps = Array.from({ length: 8 }, () => ({ press: "Space" }));
    expect(tryInputIssues({ steps, setupSteps, captureEveryMs: 1000 })).toEqual([]);
  });

  it("rejects screenshots in setup before any browser or budget work", () => {
    expect(
      tryInputIssues({
        steps: [{ press: "Space" }],
        setupSteps: [{ screenshot: "reach-state" }],
      }).join("\n"),
    ).toContain("screenshot");
  });

  it("rejects combined duration over 30s and combined steps over 60", () => {
    expect(
      tryInputIssues({
        steps: [{ key: "w", holdMs: 2000 }],
        setupSteps: [{ key: "w", holdMs: 29_000 }],
      }).join("\n"),
    ).toContain("30000 ms");
    expect(
      tryInputIssues({
        steps: Array.from({ length: 12 }, () => ({ press: "w" })),
        setupSteps: Array.from({ length: 49 }, () => ({ press: "w" })),
      }).join("\n"),
    ).toMatch(/48|60/);
  });

  it("keeps default requests byte/behavior compatible (no setup field)", () => {
    expect(tryInputIssues({ steps: [{ press: "Space" }] })).toEqual([]);
  });
});
