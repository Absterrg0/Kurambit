import { describe, expect, it } from "@effect/vitest";
import type { GameStatus } from "../../packages/contracts/src/index.ts";
import { assertSelectedBuildComplete } from "./completion.ts";

const selected = "a".repeat(64);
const qualification: GameStatus["qualification"] = {
  state: "unqualified",
  completion: "incomplete",
  mechanicsQualified: false,
  sourceId: "repaired-folder",
  buildId: null,
  servedArtifactId: null,
  stages: [],
};
const status = { selectedBuildId: selected, selectedArtifactUsable: true, qualification };
const facts = {
  buildId: selected,
  passed: true,
  directory: `builds/candidates/${selected}`,
  checks: [{ id: "boot", status: "passed" as const }],
  reason: null,
};

describe("selected build completion", () => {
  it("passes a verified selected artifact even when folder qualification is stale", () => {
    expect(() => assertSelectedBuildComplete("build", status, facts)).not.toThrow();
  });
  it("refuses a missing selected artifact even if the folder is qualified", () => {
    const qualified = {
      ...status,
      selectedArtifactUsable: false,
      qualification: { ...qualification, completion: "complete" as const },
    };
    expect(() => assertSelectedBuildComplete("build", qualified, facts)).toThrow(/artifact/);
  });
  it("requires facts for the selected build, rather than a newer candidate", () => {
    expect(() =>
      assertSelectedBuildComplete("build", status, { ...facts, buildId: "b".repeat(64) }),
    ).toThrow(/selected/);
    expect(() => assertSelectedBuildComplete("build", status, null)).toThrow(/facts/);
  });
  it("rejects failed submission facts on a usable artifact", () => {
    expect(() =>
      assertSelectedBuildComplete("build", status, {
        ...facts,
        passed: false,
        reason: "console: 1 error",
      }),
    ).toThrow(/console: 1 error/);
  });
});
