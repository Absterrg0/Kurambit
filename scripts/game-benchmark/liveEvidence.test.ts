import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";
import type {
  GameRepairLoop,
  GameReviewBallotPlan,
  GameReviewBallotRecord,
  GameReviewRound,
  GameSubmissionFacts,
} from "../../packages/contracts/src/index.ts";
import {
  buildLiveEvidence,
  classifyLiveReviewOutcome,
  type LiveEvidenceInput,
} from "./liveEvidence.ts";

const BUILD = "a".repeat(64);
const OTHER_BUILD = "b".repeat(64);
const START = "2026-10-27T10:00:00.000Z";
const at = (milliseconds: number) =>
  DateTime.formatIso(
    DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.makeUnsafe(START)) + milliseconds),
  );

const loop = (overrides: Partial<GameRepairLoop> = {}): GameRepairLoop =>
  ({
    schemaVersion: 2,
    id: "loop-1",
    root: "/tmp/game",
    threadId: "thread:test",
    originatingRunId: "run-1",
    originatingNodeId: "node-1",
    exportBuildId: BUILD,
    status: "stopped",
    repairsUsed: 1,
    budget: { repairs: 3, elapsedMs: 45 * 60_000 },
    builderSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
    reviewSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
    inputs: { steps: [{ waitMs: 1 }], viewport: null, seed: "unknown" },
    generation: 1,
    startedAt: at(0),
    updatedAt: at(60_000),
    finishedAt: at(60_000),
    promotedRounds: [],
    decision: "stop",
    reason: "tie: ballot 0 found no overall improvement.",
    usage: {
      status: "unmeasured",
      providerTurns: 0,
      usedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      recipeCalls: 0,
    },
    ...overrides,
  }) as GameRepairLoop;

const round = (overrides: Partial<GameReviewRound> = {}): GameReviewRound =>
  ({
    schemaVersion: 1,
    id: "round-1",
    threadId: "thread:test",
    status: "rejected",
    startedAt: at(0),
    finishedAt: at(60_000),
    incumbentSnapshotId: "snapshot-1",
    incumbentSourceId: "source-1",
    incumbentBuildId: BUILD,
    postRepairSourceId: "source-2",
    fundamentals: {
      boots: { verdict: "yes", frameIds: ["f1"], note: "boots" },
      respondsToInput: { verdict: "yes", frameIds: ["f2"], note: "responds" },
      coreActionVisible: { verdict: "yes", frameIds: ["f2"], note: "action visible" },
      stateReadable: { verdict: "yes", frameIds: ["f2"], note: "state readable" },
    },
    candidate: {
      buildId: OTHER_BUILD,
      directory: `builds/candidates/${OTHER_BUILD}`,
      sourceId: "source-2",
      engine: "godot",
      target: "Web",
      entry: "index.html",
    },
    budget: { repairs: 3, elapsedMs: 45 * 60_000 },
    ...overrides,
  }) as GameReviewRound;

const facts = (overrides: Partial<GameSubmissionFacts> = {}): GameSubmissionFacts => ({
  buildId: OTHER_BUILD,
  directory: `builds/candidates/${OTHER_BUILD}`,
  checks: [{ id: "build", status: "passed" }],
  passed: true,
  reason: null,
  ...overrides,
});

const ballotPlan = (order: 0 | 1): GameReviewBallotPlan => ({
  order,
  main: { A: "challenger", B: "incumbent" },
  control: { C: "incumbent", D: "challenger" },
  evidenceHash: null,
});

const ballotAnswer = (order: 0 | 1, overall: "A" | "B"): GameReviewBallotRecord =>
  ({ order, outcome: "valid", answer: { overall } }) as unknown as GameReviewBallotRecord;

const input = (overrides: Partial<LiveEvidenceInput> = {}): LiveEvidenceInput => ({
  source: "/games/source",
  copy: "/scratch/copy",
  sourceHome: "/scratch/source-home",
  gameName: "Copper Rooftops",
  model: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
  startedAt: START,
  capturedAt: at(120_000),
  durationMs: 120_000,
  copyDurationMs: 8_000,
  phase: "done",
  timedOut: false,
  error: null,
  routeSteps: 7,
  builder: {
    runId: "run-1",
    status: "completed",
    durationMs: 90_000,
    selectionMatches: true,
    toolCalls: [{ name: "game_verify" }, { name: "game_submit" }],
    sourceChanged: false,
    sourceDelta: { added: [], removed: [] },
  },
  loop: loop(),
  rounds: [round()],
  evidence: [
    { roundId: "round-1", role: "critic", order: 0 },
    { roundId: "round-1", role: "ballot", order: 0 },
    { roundId: "round-1", role: "ballot", order: 1 },
  ],
  selectedBuildFacts: facts(),
  selectedBuildId: OTHER_BUILD,
  reviewPhase: "review",
  ...overrides,
});

describe("classifyLiveReviewOutcome", () => {
  it("calls a decided loop a game result", () => {
    assert.strictEqual(classifyLiveReviewOutcome(loop(), false), "game");
  });

  it("separates infrastructure, timeouts and budget stops from game results", () => {
    assert.strictEqual(
      classifyLiveReviewOutcome(
        loop({ reason: "review-infrastructure: provider died; the selected build is kept." }),
        false,
      ),
      "infrastructure",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(loop({ reason: "deadline: critic expired." }), false),
      "timeout",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(loop({ reason: "budget-exhausted: no repairs left." }), false),
      "budget",
    );
    assert.strictEqual(classifyLiveReviewOutcome(loop(), true), "timeout");
  });

  it("distinguishes a malformed review answer from a game verdict", () => {
    assert.strictEqual(
      classifyLiveReviewOutcome(
        loop({ reason: "invalid-ballot: the answer did not parse." }),
        false,
      ),
      "review-invalid",
    );
  });

  it("does not count interruption, an unknown stop or an error as a game verdict", () => {
    assert.strictEqual(
      classifyLiveReviewOutcome(
        loop({ reason: "interrupted: the critic ended interrupted before it was judged." }),
        false,
      ),
      "incomplete",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(loop({ reason: "unknown stop" }), false),
      "incomplete",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(loop({ reason: "review-error: failed to read the round" }), false),
      "infrastructure",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(
        loop({ reason: "repair-phase-capped: candidate source changed" }),
        false,
      ),
      "timeout",
    );
    assert.strictEqual(
      classifyLiveReviewOutcome(loop({ reason: "budget-pacing: another round cannot fit" }), false),
      "budget",
    );
  });
});

describe("buildLiveEvidence", () => {
  it("records a repaired, checked and debated candidate as complete evidence", () => {
    const evidence = buildLiveEvidence(
      input({
        rounds: [
          round({
            defects: [
              { severity: "visible", what: "coin reads flat", frameId: "f2", fix: "add shine" },
            ],
            repairStartedAt: at(10_000),
            candidateChecks: [{ id: "build", status: "passed" }],
            ballots: [ballotPlan(0), ballotPlan(1)],
            ballotAnswers: [ballotAnswer(0, "A"), ballotAnswer(1, "B")],
          }),
        ],
      }),
    );
    const review = evidence.review;
    assert.isNotNull(review);
    assert.isTrue(review!.evidenceComplete);
    assert.strictEqual(review!.outcome, "game");
    assert.strictEqual(review!.coverage.judgedRounds, 1);
    assert.strictEqual(review!.coverage.roundsWithRepairDispatch, 1);
    assert.strictEqual(review!.coverage.roundsWithCandidateCheck, 1);
    assert.strictEqual(review!.coverage.roundsWithBallots, 1);
    assert.isTrue(review!.rounds[0]!.candidateVerified);
    assert.strictEqual(review!.rounds[0]!.durationMs, 60_000);
    assert.strictEqual(review!.elapsedMs, 60_000);
  });

  it("records a mechanical veto without demanding ballots", () => {
    const evidence = buildLiveEvidence(
      input({
        rounds: [
          round({
            status: "rejected",
            defects: [{ severity: "blocker", what: "no boot", frameId: "f1", fix: "fix boot" }],
            repairStartedAt: at(10_000),
            candidateChecks: [{ id: "boot", status: "failed" }],
            mechanicalVeto: "boot: the challenger did not boot",
            ballots: [],
            ballotAnswers: [],
          }),
        ],
      }),
    );
    const review = evidence.review;
    assert.isNotNull(review);
    assert.isTrue(review!.evidenceComplete);
    assert.deepStrictEqual(review!.coverage.vetoedRounds, ["round-1"]);
    assert.isFalse(review!.rounds[0]!.candidateVerified);
    assert.strictEqual(review!.rounds[0]!.mechanicalVeto, "boot: the challenger did not boot");
  });

  it("accepts a zero-defect round without inventing a repair", () => {
    const evidence = buildLiveEvidence(
      input({
        rounds: [
          round({
            status: "stopped",
            reason: "zero-defects: the critic found nothing to repair; the incumbent is kept.",
            defects: [],
            candidate: null,
            candidateChecks: [],
          }),
        ],
      }),
    );
    assert.isTrue(evidence.review!.evidenceComplete);
    assert.strictEqual(evidence.review!.coverage.roundsWithRepairDispatch, 0);
  });

  it("refuses to call a round complete when its critic evidence is missing", () => {
    const evidence = buildLiveEvidence(input({ evidence: [] }));
    assert.isFalse(evidence.review!.evidenceComplete);
  });

  it("keeps a timed-out in-flight round out of the judged coverage", () => {
    const evidence = buildLiveEvidence(
      input({
        timedOut: true,
        rounds: [round({ status: "running", finishedAt: null, candidate: null })],
      }),
    );
    const review = evidence.review;
    assert.isNotNull(review);
    assert.strictEqual(review!.outcome, "timeout");
    assert.strictEqual(review!.coverage.judgedRounds, 0);
    assert.isFalse(review!.evidenceComplete);
    assert.isNull(review!.rounds[0]!.durationMs);
  });

  it("does not mistake an evidence directory for a consumed critic judgment", () => {
    const reason = "interrupted: the critic ended interrupted before it was judged.";
    const evidence = buildLiveEvidence(
      input({
        loop: loop({ reason }),
        rounds: [round({ status: "stopped", reason, candidate: null, defects: [] })],
        evidence: [{ roundId: "round-1", role: "critic", order: 0 }],
      }),
    );
    assert.strictEqual(evidence.review!.outcome, "incomplete");
    assert.strictEqual(evidence.review!.coverage.judgedRounds, 0);
    assert.isFalse(evidence.review!.evidenceComplete);
  });

  it("leaves lifecycle null when the flag was off", () => {
    assert.isNull(buildLiveEvidence(input()).lifecycle);
  });

  it("carries compact lifecycle facts without touching the main review", () => {
    const lifecycle = {
      staleSubmit: {
        buildId: OTHER_BUILD,
        accepted: false,
        reason: "Submission refused: sources: the current sources differ",
        checks: [{ id: "sources", status: "failed" }],
        selectedBefore: OTHER_BUILD,
        selectedAfter: OTHER_BUILD,
        artifactUsableAfter: true,
        exportStageAfter: "stale",
        editRestored: true,
      },
      syntaxFailure: {
        script: "godot/scripts/player.gd",
        failedStage: "check",
        checkErrors: 1,
        firstError: "godot/scripts/player.gd:42 Unexpected token",
        falsePass: false,
        selectedHeld: true,
        repaired: true,
        submittedBuildId: OTHER_BUILD,
        recovery: {
          loopId: "loop-2",
          decision: "stop",
          reason: "zero-defects: the critic found nothing to repair.",
          outcome: "game" as const,
          selectedBuildId: OTHER_BUILD,
        },
      },
      cancellation: {
        tool: "game_blender_run",
        processObserved: { pid: 4242, operation: "blender" },
        runInterrupted: true,
        processesEmptyAfter: true,
        selectedUnchanged: true,
      },
    };
    const evidence = buildLiveEvidence(input({ lifecycle }));
    assert.deepEqual(evidence.lifecycle, lifecycle);
    assert.strictEqual(evidence.review!.loopId, "loop-1");
  });
});
