import { GameReviewHistoryInput } from "./gameReview.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GAME_REVIEW_BUDGET,
  END_STATE_EVIDENCE_POLICY_VERSION,
  endStateEligibleRequirements,
  GameReviewArtifact,
  GameReviewBallotAnswer,
  GameReviewBallotInput,
  GameReviewBudget,
  GameReviewCriticAnswer,
  GameReviewDefect,
  GameReviewDoNotRegress,
  GameReviewRequirementAssessment,
  GameReviewRequirementDowngrade,
  GameReviewRound,
  GameReviewUsage,
  GameSubmission,
  GameSubmitInput,
  pickEndStateObservations,
  satisfiesEndStateExpect,
} from "./gameReview.ts";

const decodeDefect = Schema.decodeUnknownSync(GameReviewDefect);
const decodeArtifact = Schema.decodeUnknownSync(GameReviewArtifact);
const decodeBudget = Schema.decodeUnknownSync(GameReviewBudget);
const decodeRound = Schema.decodeUnknownSync(GameReviewRound);
const decodeItem = Schema.decodeUnknownSync(GameReviewDoNotRegress);
const decodeSubmit = Schema.decodeUnknownSync(GameSubmitInput);
const decodeSubmission = Schema.decodeUnknownSync(GameSubmission);
const decodeBallotInput = Schema.decodeUnknownSync(GameReviewBallotInput);
const decodeBallotAnswer = Schema.decodeUnknownSync(GameReviewBallotAnswer);

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

it("a ballot answers the control pair in C and D, never in the main A/B", () => {
  const ballot = {
    overall: "tie",
    overallReason: "Both builds read the same.",
    works: "tie",
    look: "tie",
    feel: "tie",
    play: "tie",
    defects: [],
    regressions: { A: [], B: [] },
    preservation: [],
    reason: "The pairs move alike.",
  };
  expect(
    decodeBallotInput({ ...ballot, control: { works: "C", look: "tie", feel: "D", play: "tie" } })
      .control,
  ).toEqual({ works: "C", look: "tie", feel: "D", play: "tie" });
  expect(() =>
    decodeBallotInput({
      ...ballot,
      control: { works: "A", look: "tie", feel: "tie", play: "tie" },
    }),
  ).toThrow();
  // Stored answers from before the vocabulary keep decoding, so old rounds
  // still render their recorded judgment.
  const legacy = decodeBallotAnswer({
    overall: "A",
    overallReason: "A is clearer.",
    main: { works: "A", look: "A", feel: "tie", play: "tie" },
    defects: [],
    regressions: { A: [], B: [] },
    preservation: [],
    control: { works: "A", look: "B", feel: "tie", play: "tie" },
    reason: "Legacy control vocabulary.",
  });
  expect(legacy.control).toEqual({ works: "A", look: "B", feel: "tie", play: "tie" });
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

describe("end-state requirements", () => {
  const decodeRequirement = Schema.decodeUnknownSync(GameReviewRequirementAssessment);
  const base = { id: "park-in-bay", verdict: "yes" as const, frameIds: ["f3", "f4"], note: "Win." };

  it("keeps the challenge optional so old records still decode", () => {
    expect(decodeRequirement(base)).not.toHaveProperty("challenge");
    expect(
      decodeRequirement({
        ...base,
        challenge: { frameIds: ["try1f1", "try1f2"], note: "Drove without parking." },
      }).challenge,
    ).toEqual({ frameIds: ["try1f1", "try1f2"], note: "Drove without parking." });
    expect(() =>
      decodeRequirement({ ...base, challenge: { frameIds: [], note: "Empty." } }),
    ).toThrow();
  });

  it("freezes only win/lose with numeric expects, never presentation or no-lose", () => {
    expect(
      endStateEligibleRequirements([
        { id: "win-bay", kind: "win", text: "Win", observe: { key: "won", expect: "==1" } },
        { id: "lose-wall", kind: "lose", text: "Lose", observe: { key: "lives", expect: "<=0" } },
        {
          id: "drive",
          kind: "control",
          text: "Drive",
          observe: { key: "collected", expect: ">=1" },
        },
        { id: "look", kind: "presentation", text: "Look" },
        { id: "free", kind: "lose", text: "No lose state" },
        { id: "win-changes", kind: "win", text: "Win", observe: { key: "won", expect: "changes" } },
      ]),
    ).toEqual([
      { id: "win-bay", kind: "win", key: "won", expect: "==1" },
      { id: "lose-wall", kind: "lose", key: "lives", expect: "<=0" },
    ]);
    expect(END_STATE_EVIDENCE_POLICY_VERSION).toBe(2);
  });

  it("satisfies ==, >= and <= on numbers and booleans, never on missing values", () => {
    expect(satisfiesEndStateExpect("==1", 1)).toBe(true);
    expect(satisfiesEndStateExpect("==1", true)).toBe(true);
    expect(satisfiesEndStateExpect("==1", 0)).toBe(false);
    expect(satisfiesEndStateExpect(">=2", 2)).toBe(true);
    expect(satisfiesEndStateExpect("<=0", 0)).toBe(true);
    expect(satisfiesEndStateExpect("==1", null)).toBe(false);
    expect(satisfiesEndStateExpect("==1", undefined)).toBe(false);
  });

  it("keeps only approved numeric/boolean scalars, bounded and without invention", () => {
    expect(
      pickEndStateObservations(
        { won: 1, collected: 2, label: "win", missing: null },
        new Set(["won", "collected", "absent"]),
      ),
    ).toEqual({ won: 1, collected: 2 });
    expect(pickEndStateObservations({ won: "1" as unknown as number }, ["won"])).toEqual({});
    expect(pickEndStateObservations(null, ["won"])).toEqual({});
  });
});

describe("server downgraded requirements", () => {
  const decodeAnswer = Schema.decodeUnknownSync(GameReviewCriticAnswer);
  const minimalRound = () => ({
    schemaVersion: 1 as const,
    id: "round-1",
    threadId: null,
    status: "running" as const,
    startedAt: "2026-10-30T00:00:00.000Z",
    finishedAt: null,
    incumbentSnapshotId: "source-incumbent",
    incumbentSourceId: "source-incumbent",
    incumbentBuildId: null,
    postRepairSourceId: null,
    candidate: null,
    budget: DEFAULT_GAME_REVIEW_BUDGET,
  });
  const fundamental = (verdict: "yes" | "no" | "cannot-tell" = "yes") => ({
    verdict,
    frameIds: verdict === "cannot-tell" ? [] : ["f1"],
    note: "Observed.",
  });
  const base = {
    fundamentals: {
      boots: fundamental(),
      respondsToInput: fundamental(),
      coreActionVisible: fundamental(),
      stateReadable: fundamental(),
    },
    defects: [],
    doNotRegress: [],
    requirements: [
      { id: "reach-roof", verdict: "cannot-tell" as const, frameIds: [], note: "Unseen." },
    ],
  };

  it("reads legacy answers without the server-applied list", () => {
    expect(decodeAnswer(base)).not.toHaveProperty("downgradedRequirements");
  });

  it("keeps the server-applied downgrade list with its reasons", () => {
    const downgradedRequirements = [
      { id: "reach-roof", reason: "Requirement reach-roof=yes needs a matched witness." },
    ];
    expect(decodeAnswer({ ...base, downgradedRequirements }).downgradedRequirements).toEqual(
      downgradedRequirements,
    );
  });

  it("reads legacy rounds without the server-applied list", () => {
    expect(decodeRound(minimalRound())).not.toHaveProperty("downgradedRequirements");
  });

  it("keeps the server-applied downgrade list on the round", () => {
    const downgradedRequirements = [{ id: "reach-roof", reason: "No matched witness." }];
    expect(
      decodeRound({ ...minimalRound(), downgradedRequirements }).downgradedRequirements,
    ).toEqual(downgradedRequirements);
  });

  it("rejects a downgrade entry without an id or reason", () => {
    const decodeDowngrade = Schema.decodeUnknownSync(GameReviewRequirementDowngrade);
    expect(() => decodeDowngrade({ id: "", reason: "No matched witness." })).toThrow();
    expect(() => decodeDowngrade({ id: "reach-roof", reason: "" })).toThrow();
  });
});
