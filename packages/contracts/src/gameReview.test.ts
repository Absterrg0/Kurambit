import { GameReviewHistoryInput } from "./gameReview.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameReviewArtifact,
  GameReviewBudget,
  GameReviewDefect,
  GameReviewDoNotRegress,
  GameReviewRound,
  GameReviewUsage,
  GameSubmission,
  GameSubmitInput,
} from "./gameReview.ts";

const decodeDefect = Schema.decodeUnknownSync(GameReviewDefect);
const decodeArtifact = Schema.decodeUnknownSync(GameReviewArtifact);
const decodeBudget = Schema.decodeUnknownSync(GameReviewBudget);
const decodeRound = Schema.decodeUnknownSync(GameReviewRound);
const decodeItem = Schema.decodeUnknownSync(GameReviewDoNotRegress);
const decodeSubmit = Schema.decodeUnknownSync(GameSubmitInput);
const decodeSubmission = Schema.decodeUnknownSync(GameSubmission);

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

  it("accepts a defect's optional recipe id, and old usage without a recipe count", () => {
    const base = {
      severity: "visible" as const,
      what: "the jump is late",
      frameId: "F3",
      fix: "buffer input",
    };
    expect(decodeDefect(base)).not.toHaveProperty("recipeId");
    expect(decodeDefect({ ...base, recipeId: "feel.buffer" }).recipeId).toBe("feel.buffer");
    expect(() => decodeDefect({ ...base, recipeId: "" })).toThrow();
    const decodeUsage = Schema.decodeUnknownSync(GameReviewUsage);
    const old = {
      status: "measured" as const,
      providerTurns: 1,
      usedTokens: 10,
      inputTokens: 8,
      outputTokens: 2,
    };
    expect(decodeUsage(old)).not.toHaveProperty("recipeCalls");
    expect(decodeUsage({ ...old, recipeCalls: 2 }).recipeCalls).toBe(2);
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

  it("defaults to three repairs or forty-five minutes and rejects negative work", () => {
    expect(decodeBudget(DEFAULT_GAME_REVIEW_BUDGET)).toEqual({
      repairs: 3,
      elapsedMs: 2_700_000,
    });
    expect(() => decodeBudget({ repairs: -1, elapsedMs: 1 })).toThrow();
    expect(() => decodeBudget({ repairs: 4, elapsedMs: 1 })).toThrow();
    expect(() => decodeBudget({ repairs: 1, elapsedMs: 0 })).toThrow();
  });
});

describe("submissions", () => {
  it("keeps a one-line note and an optional content-addressed build", () => {
    expect(decodeSubmit({ note: "A tiny lantern platformer." })).toEqual({
      note: "A tiny lantern platformer.",
    });
    expect(decodeSubmit({ note: "x", buildId }).buildId).toBe(buildId);
    expect(() => decodeSubmit({ note: "first line\nsecond line" })).toThrow();
    expect(() => decodeSubmit({ note: "" })).toThrow();
    expect(() => decodeSubmit({ note: "x", buildId: "not-a-hash" })).toThrow();
  });

  it("records the run, build, note and time, never an inferred playable state", () => {
    const submission = decodeSubmission({
      runId: "run:builder",
      buildId,
      note: "A tiny lantern platformer.",
      submittedAt: "2026-10-23T12:00:00.000Z",
    });
    expect(submission).toMatchObject({ buildId, note: "A tiny lantern platformer." });
    expect(() =>
      decodeSubmission({
        runId: "run:builder",
        buildId: "not-a-hash",
        note: "x",
        submittedAt: "2026-10-23T12:00:00.000Z",
      }),
    ).toThrow();
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

it("bounds history pages at the transport boundary", () => {
  const decode = Schema.decodeUnknownSync(GameReviewHistoryInput);
  expect(decode({ threadId: "game", limit: 20 }).limit).toBe(20);
  for (const limit of [0, 21, -1, 1.5]) expect(() => decode({ threadId: "game", limit })).toThrow();
});

it("truncates a long submission note with a marker and keeps build ids strict", () => {
  const input = decodeSubmit({ note: "n".repeat(501), buildId });
  expect(input.note).toHaveLength(500);
  expect(input.note).toMatch(/\[truncated\]$/);
  expect(() => decodeSubmit({ note: "n".repeat(501), buildId: "x".repeat(65) })).toThrow();
});
