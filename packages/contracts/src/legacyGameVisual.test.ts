import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { GameQualificationRead } from "./game.ts";
import { LegacyGameQualificationRead } from "./legacyGameVisual.ts";

const decodeLegacy = Schema.decodeUnknownSync(LegacyGameQualificationRead);
const decodeLive = Schema.decodeUnknownSync(GameQualificationRead);

const mechanics = {
  stage: "playtest",
  status: "passed",
  sourceId: "source",
  buildId: "build",
  finishedAt: "2026-10-23T00:00:00Z",
};
const base = {
  state: "unqualified",
  completion: "complete",
  mechanicsQualified: false,
  sourceId: "source",
  buildId: "build",
  servedArtifactId: "build",
};
const oldStage = {
  ...mechanics,
  stage: "visual",
  status: "failed",
  visual: {
    status: "failed",
    judgedAt: "2026-10-23T00:00:00Z",
    model: "old/judge",
    sourceId: "source",
    buildId: "build",
    designHash: null,
    evidenceDirectory: "builds/playtests/old",
    frames: [{ id: "F1", label: "early", path: "frame.png", role: "early" }],
    dimensions: [{ dimension: "feedback", score: 2 }],
    repairRequests: [{ frame: "F1", fix: "Show feedback" }],
    roundsLeft: 0,
  },
};
describe("historical score data", () => {
  it("preserves old judgements and completion without fabricating a new review", () => {
    const read = decodeLegacy({
      ...base,
      stages: [mechanics, oldStage],
    });
    expect(read.completion).toBe("complete");
    expect(read.stages[1]).toEqual(oldStage);
    expect(read).not.toHaveProperty("review");
  });
  it("keeps current records readable without an old judgement", () => {
    const read = { ...base, stages: [mechanics] };
    expect(decodeLegacy(read)).toEqual(decodeLive(read));
  });
  it("rejects visual stages on the live contract", () => {
    expect(() => decodeLive({ ...base, stages: [oldStage] })).toThrow();
  });
});
