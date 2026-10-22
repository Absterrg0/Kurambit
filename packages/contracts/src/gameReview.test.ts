import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameReviewArtifact,
  GameReviewBudget,
  GameReviewDefect,
  GameReviewDoNotRegress,
  GameReviewRound,
} from "./gameReview.ts";

const decodeDefect = Schema.decodeUnknownSync(GameReviewDefect);
const decodeArtifact = Schema.decodeUnknownSync(GameReviewArtifact);
const decodeBudget = Schema.decodeUnknownSync(GameReviewBudget);
const decodeRound = Schema.decodeUnknownSync(GameReviewRound);
const decodeItem = Schema.decodeUnknownSync(GameReviewDoNotRegress);

const buildId = "a".repeat(64);

describe("review vocabulary", () => {
  it("accepts the three defect severities and the concrete fix", () => {
    for (const severity of ["blocker", "visible", "nit"] as const)
      expect(
        decodeDefect({
          severity,
          what: "the jump arc overshoots",
          frameId: "F3",
          fix: "shorten it",
        }),
      ).toMatchObject({ severity });
    expect(() => decodeDefect({ severity: "fatal", what: "x", frameId: "F3", fix: "y" })).toThrow();
  });

  it("keeps preservation items bound to a frame and an optional existing check", () => {
    expect(decodeItem({ id: "double-jump", what: "the second jump works", frameId: "F4" })).toEqual(
      { id: "double-jump", what: "the second jump works", frameId: "F4" },
    );
    expect(
      decodeItem({
        id: "double-jump",
        what: "the second jump works",
        frameId: "F4",
        checkId: "check:main",
      }).checkId,
    ).toBe("check:main");
  });

  it("defaults to three repairs or twenty minutes and rejects negative work", () => {
    expect(decodeBudget(DEFAULT_GAME_REVIEW_BUDGET)).toEqual({
      repairs: 3,
      elapsedMs: 1_200_000,
    });
    expect(() => decodeBudget({ repairs: -1, elapsedMs: 1 })).toThrow();
    expect(() => decodeBudget({ repairs: 4, elapsedMs: 1 })).toThrow();
    expect(() => decodeBudget({ repairs: 1, elapsedMs: 0 })).toThrow();
  });
});

describe("build artifacts", () => {
  const artifact = {
    buildId,
    directory: `builds/candidates/${buildId}`,
    sourceId: "b".repeat(64),
    engine: "godot",
    target: "Web",
    entry: "index.html",
  };

  it("requires a content-addressed id and names its engine, target and entry", () => {
    expect(decodeArtifact(artifact)).toMatchObject({ target: "Web", entry: "index.html" });
    expect(() => decodeArtifact({ ...artifact, buildId: "not-a-hash" })).toThrow();
    expect(() => decodeArtifact({ ...artifact, engine: "unity" })).toThrow();
  });

  it("allows response headers for artifacts that need them", () => {
    expect(
      decodeArtifact({ ...artifact, headers: { "Cross-Origin-Opener-Policy": "same-origin" } })
        .headers,
    ).toEqual({ "Cross-Origin-Opener-Policy": "same-origin" });
  });
});

describe("round records", () => {
  const round = {
    schemaVersion: 1 as const,
    id: "round-1",
    threadId: null,
    status: "running" as const,
    startedAt: "2026-10-22T00:00:00.000Z",
    finishedAt: null,
    incumbentSnapshotId: "c".repeat(64),
    incumbentSourceId: "d".repeat(64),
    incumbentBuildId: null,
    postRepairSourceId: null,
    candidate: null,
    budget: DEFAULT_GAME_REVIEW_BUDGET,
  };

  it("opens before a repair with a snapshot identity and no candidate", () => {
    expect(decodeRound(round)).toMatchObject({ status: "running", candidate: null });
  });

  it("records the exact decision and reason, never a score", () => {
    const decided = decodeRound({
      ...round,
      status: "rejected",
      finishedAt: "2026-10-22T00:20:00.000Z",
      decision: "reject",
      reason: "The challenger lost the look facet.",
      defects: [{ severity: "visible", what: "the hud is clipped", frameId: "F5", fix: "move it" }],
      doNotRegress: [{ id: "jump", what: "jump works", frameId: "F2" }],
    });
    expect(decided.decision).toBe("reject");
    expect(decided.reason).toContain("look");
  });

  it("rejects unknown states rather than recording them", () => {
    expect(() => decodeRound({ ...round, status: "winning" })).toThrow();
  });
});
