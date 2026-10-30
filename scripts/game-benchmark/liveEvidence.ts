import type {
  GameRepairLoop,
  GameReviewQuality,
  GameReviewQualityCoverage,
  GameReviewRound,
  GameSubmissionFacts,
} from "../../packages/contracts/src/index.ts";

/**
 * How a loop ended. "game" means the loop reached a decision from its recorded
 * checks and ballots; the rest name why it could not, so a harness never
 * reports an infrastructure failure as a game result.
 */
export type LiveReviewOutcome =
  | "game"
  | "infrastructure"
  | "review-invalid"
  | "timeout"
  | "budget"
  | "no-loop"
  | "incomplete";

export interface LiveEvidenceModel {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export interface LiveEvidenceBuilder {
  readonly runId: string | null;
  readonly status: string | null;
  readonly durationMs: number | null;
  /** The run's frozen selection is the exact provider/model/variant requested. */
  readonly selectionMatches: boolean;
  readonly toolCalls: ReadonlyArray<{ readonly name: string }>;
  /** Did the builder turn change the git status/diff snapshot? */
  readonly sourceChanged: boolean | null;
  /** Byte comparison includes untracked files; git status alone cannot detect their edits. */
  readonly sourceBytesChanged?: boolean | undefined;
  readonly sourceDelta: {
    readonly added: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
  } | null;
}

export interface LiveEvidenceRoundRole {
  readonly roundId: string;
  readonly role: "critic" | "ballot";
  readonly order: number;
}

/** Compact facts for one `--exercise-lifecycle` phase; null when not run. */
export interface LiveEvidenceLifecycleStaleSubmit {
  readonly buildId: string | null;
  readonly accepted: boolean | null;
  readonly reason: string | null;
  readonly checks: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly selectedBefore: string | null;
  readonly selectedAfter: string | null;
  readonly artifactUsableAfter: boolean | null;
  readonly exportStageAfter: string | null;
  readonly editRestored: boolean;
}

export interface LiveEvidenceLifecycleSyntax {
  readonly script: string;
  readonly failedStage: string | null;
  readonly checkErrors: number;
  readonly firstError: string | null;
  /** True when the broken verify claimed success; the harness fails on this. */
  readonly falsePass: boolean;
  readonly selectedHeld: boolean;
  readonly repaired: boolean;
  readonly submittedBuildId: string | null;
  readonly recovery: {
    readonly loopId: string;
    readonly decision: string | null;
    readonly reason: string | null;
    readonly outcome: LiveReviewOutcome;
    readonly selectedBuildId: string | null;
  } | null;
}

export interface LiveEvidenceLifecycleCancel {
  readonly tool: string | null;
  readonly processObserved: { readonly pid: number; readonly operation: string } | null;
  readonly runInterrupted: boolean;
  readonly processesEmptyAfter: boolean | null;
  readonly selectedUnchanged: boolean;
}

export interface LiveEvidenceLifecycle {
  readonly staleSubmit: LiveEvidenceLifecycleStaleSubmit | null;
  readonly syntaxFailure: LiveEvidenceLifecycleSyntax | null;
  readonly cancellation: LiveEvidenceLifecycleCancel | null;
}

export interface LiveEvidenceInput {
  readonly source: string;
  readonly copy: string;
  readonly sourceHome: string;
  readonly gameName: string;
  readonly model: LiveEvidenceModel;
  readonly startedAt: string;
  readonly capturedAt: string;
  readonly durationMs: number;
  readonly copyDurationMs: number | null;
  readonly phase: string;
  readonly timedOut: boolean;
  readonly error: string | null;
  readonly routeSteps: number;
  readonly builder: LiveEvidenceBuilder;
  readonly loop: GameRepairLoop | null;
  readonly rounds: ReadonlyArray<GameReviewRound>;
  readonly evidence: ReadonlyArray<LiveEvidenceRoundRole>;
  readonly selectedBuildFacts: GameSubmissionFacts | null;
  readonly selectedBuildId: string | null;
  readonly reviewPhase: string | null;
  /** Present only when the run passed `--exercise-lifecycle`; null otherwise. */
  readonly lifecycle?: LiveEvidenceLifecycle | null;
}

export interface LiveEvidenceRound {
  readonly id: string;
  readonly status: GameReviewRound["status"];
  readonly judged: boolean;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly decision: GameReviewRound["decision"] | null;
  readonly reason: string | null;
  readonly defects: number;
  readonly doNotRegress: number;
  readonly criticEvidence: number;
  readonly ballotEvidence: number;
  readonly repairStarted: boolean;
  readonly candidateBuildId: string | null;
  readonly candidateDirectory: string | null;
  readonly candidateChecks: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly candidateVerified: boolean;
  readonly mechanicalVeto: string | null;
  readonly ballots: {
    readonly planned: number;
    readonly valid: number;
    readonly invalid: number;
    readonly overall: ReadonlyArray<string | null>;
  };
  readonly promoted: boolean;
  /**
   * Absolute quality frozen with the round, when the critic assessed it.
   * Absent on rounds that predate the rubric; unknown there, never met.
   */
  readonly quality?: GameReviewQuality | undefined;
  readonly qualityCoverage?: GameReviewQualityCoverage | undefined;
}

export interface LiveEvidenceRead {
  readonly schemaVersion: 1;
  readonly mode: "existing-game";
  readonly source: string;
  readonly copy: string;
  readonly sourceHome: string;
  readonly gameName: string;
  readonly model: LiveEvidenceModel;
  readonly startedAt: string;
  readonly capturedAt: string;
  readonly durationMs: number;
  readonly copyDurationMs: number | null;
  readonly phase: string;
  readonly timedOut: boolean;
  readonly error: string | null;
  readonly builder: LiveEvidenceBuilder & { readonly routeSteps: number };
  /** Wall time by phase; review is the loop's own elapsed time. */
  readonly phases: {
    readonly copyMs: number | null;
    readonly builderMs: number | null;
    readonly reviewMs: number | null;
    readonly totalMs: number;
  };
  /** The copy deliberately starts a new build/review record. */
  readonly records: {
    readonly retained: ReadonlyArray<string>;
    readonly lost: ReadonlyArray<string>;
  };
  readonly review: {
    readonly loopId: string;
    readonly status: GameRepairLoop["status"];
    readonly decision: GameRepairLoop["decision"];
    readonly reason: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly elapsedMs: number;
    readonly outcome: LiveReviewOutcome;
    readonly phase: string | null;
    readonly attempts: {
      readonly rounds: number;
      readonly repairsUsed: number;
      readonly repairsBudget: number;
      readonly repairsLeft: number;
    };
    readonly coverage: {
      readonly judgedRounds: number;
      readonly roundsWithCritic: number;
      readonly roundsWithRepairDispatch: number;
      readonly roundsWithCandidateCheck: number;
      readonly roundsWithBallots: number;
      readonly promotedRounds: ReadonlyArray<string>;
      readonly vetoedRounds: ReadonlyArray<string>;
    };
    /** A judged round carried every record its outcome needs. */
    readonly evidenceComplete: boolean;
    readonly rounds: ReadonlyArray<LiveEvidenceRound>;
  } | null;
  readonly selectedBuild: {
    readonly buildId: string | null;
    readonly directory: string | null;
    readonly passed: boolean | null;
    readonly checks: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  };
  readonly selectedBuildId: string | null;
  readonly lifecycle: LiveEvidenceLifecycle | null;
}

const elapsedBetween = (start: string, end: string | null): number | null => {
  const started = Date.parse(start);
  const finished = end === null ? Number.NaN : Date.parse(end);
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : null;
};

/** A loop can be stopped or interrupted for many reasons; only these are game verdicts. */
export const classifyLiveReviewOutcome = (
  loop: { readonly decision: string | null; readonly reason: string | null } | null,
  timedOut: boolean,
): LiveReviewOutcome => {
  if (loop === null) return "no-loop";
  if (timedOut) return "timeout";
  const reason = loop.reason ?? "";
  if (reason.includes("review-infrastructure:") || reason.startsWith("review-error:"))
    return "infrastructure";
  if (reason.startsWith("promotion-blocked:") || reason.startsWith("reject-blocked:"))
    return "infrastructure";
  if (reason.startsWith("superseded:") || reason.startsWith("invalid-state:"))
    return "infrastructure";
  if (reason.startsWith("deadline:") || reason.startsWith("repair-phase-capped:")) return "timeout";
  if (/^budget-(admission|exhausted|pacing):/.test(reason)) return "budget";
  if (reason.startsWith("invalid-critic:") || reason.startsWith("invalid-ballot:"))
    return "review-invalid";
  if (
    loop.decision !== null &&
    /^(zero-defects|tie|worse-build|regression|preservation-lost|mechanical-veto|unchanged|no-output|export-failed):/.test(
      reason,
    )
  )
    return "game";
  return "incomplete";
};

const roundRead = (
  round: GameReviewRound,
  evidence: ReadonlyArray<LiveEvidenceRoundRole>,
): LiveEvidenceRound => {
  const candidateChecks = (round.candidateChecks ?? []).map((check) => ({
    id: check.id,
    status: check.status,
  }));
  const answers = round.ballotAnswers ?? [];
  const planned = round.ballots ?? [];
  const veto =
    round.mechanicalVeto ??
    (round.reason?.startsWith("mechanical-veto:") === true ? round.reason : null);
  return {
    id: round.id,
    status: round.status,
    judged:
      round.finishedAt !== null &&
      round.fundamentals !== undefined &&
      (round.status === "promoted" ||
        round.status === "rejected" ||
        (round.status === "stopped" && round.reason?.startsWith("zero-defects:") === true)),
    durationMs: elapsedBetween(round.startedAt, round.finishedAt),
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    decision: round.decision ?? null,
    reason: round.reason ?? null,
    defects: round.defects?.length ?? 0,
    doNotRegress: round.doNotRegress?.length ?? 0,
    criticEvidence: evidence.filter(
      (entry) => entry.roundId === round.id && entry.role === "critic",
    ).length,
    ballotEvidence: evidence.filter(
      (entry) => entry.roundId === round.id && entry.role === "ballot",
    ).length,
    repairStarted: round.repairStartedAt !== undefined,
    candidateBuildId: round.candidate?.buildId ?? null,
    candidateDirectory: round.candidate?.directory ?? null,
    candidateChecks,
    candidateVerified:
      round.candidate !== null &&
      candidateChecks.length > 0 &&
      candidateChecks.every((check) => check.status === "passed"),
    mechanicalVeto: veto,
    ballots: {
      planned: planned.length,
      valid: answers.filter((answer) => answer.outcome === "valid").length,
      invalid: answers.filter((answer) => answer.outcome === "invalid").length,
      overall: answers.map((answer) => answer.answer?.overall ?? null),
    },
    promoted: round.status === "promoted",
    ...(round.quality === undefined ? {} : { quality: round.quality }),
    ...(round.qualityCoverage === undefined ? {} : { qualityCoverage: round.qualityCoverage }),
  };
};

/**
 * Whether the recorded round carries the evidence its outcome claims. A
 * zero-defect round needs only its critic; a round that found defects must
 * show the repair dispatch, the candidate's exact build check, and — unless
 * the check vetoed it — both opposite-order ballots.
 */
const hasCompleteEvidence = (rounds: ReadonlyArray<LiveEvidenceRound>): boolean => {
  const judged = rounds.filter((round) => round.judged);
  if (judged.length === 0 || judged.length !== rounds.length) return false;
  if (judged.some((round) => round.criticEvidence === 0)) return false;
  return judged.every((round) => {
    if (round.defects === 0) return true;
    if (!round.repairStarted) return false;
    if (round.candidateBuildId === null) return false;
    if (round.candidateChecks.length === 0) return false;
    if (round.mechanicalVeto !== null) return true;
    return round.ballots.planned === 2 && round.ballots.valid === 2 && round.ballotEvidence >= 2;
  });
};

export const hasCompleteReviewEvidence = (
  rounds: ReadonlyArray<GameReviewRound>,
  evidence: ReadonlyArray<LiveEvidenceRoundRole>,
): boolean => hasCompleteEvidence(rounds.map((round) => roundRead(round, evidence)));

/** A compact, durable record of one existing-game review run for the operator. */
export const buildLiveEvidence = (input: LiveEvidenceInput): LiveEvidenceRead => {
  const rounds = input.rounds.map((round) => roundRead(round, input.evidence));
  const judged = rounds.filter((round) => round.judged);
  const loop = input.loop;
  const elapsed =
    loop === null
      ? 0
      : Math.max(0, Date.parse(loop.finishedAt ?? input.capturedAt) - Date.parse(loop.startedAt));
  return {
    schemaVersion: 1,
    mode: "existing-game",
    source: input.source,
    copy: input.copy,
    sourceHome: input.sourceHome,
    gameName: input.gameName,
    model: input.model,
    startedAt: input.startedAt,
    capturedAt: input.capturedAt,
    durationMs: input.durationMs,
    copyDurationMs: input.copyDurationMs,
    phase: input.phase,
    timedOut: input.timedOut,
    error: input.error,
    builder: { ...input.builder, routeSteps: input.routeSteps },
    phases: {
      copyMs: input.copyDurationMs,
      builderMs: input.builder.durationMs,
      reviewMs: loop === null ? null : Number.isFinite(elapsed) ? elapsed : 0,
      totalMs: input.durationMs,
    },
    records: {
      retained: ["game-design intent", "game-design approval when the source has one"],
      lost: [
        "selected build",
        "game-rounds export/submission records",
        "game-qualification stage records",
        "game-snapshots source snapshots",
        "game-repair-loops and prior rounds",
        "game-review sessions and evidence",
      ],
    },
    review:
      loop === null
        ? null
        : {
            loopId: loop.id,
            status: loop.status,
            decision: loop.decision,
            reason: loop.reason,
            startedAt: loop.startedAt,
            finishedAt: loop.finishedAt,
            elapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
            outcome: classifyLiveReviewOutcome(loop, input.timedOut),
            phase: input.reviewPhase,
            attempts: {
              rounds: rounds.length,
              repairsUsed: loop.repairsUsed,
              repairsBudget: loop.budget.repairs,
              repairsLeft: Math.max(0, loop.budget.repairs - loop.repairsUsed),
            },
            coverage: {
              judgedRounds: judged.length,
              roundsWithCritic: judged.filter((round) => round.criticEvidence > 0).length,
              roundsWithRepairDispatch: rounds.filter((round) => round.repairStarted).length,
              roundsWithCandidateCheck: rounds.filter((round) => round.candidateChecks.length > 0)
                .length,
              roundsWithBallots: rounds.filter(
                (round) => round.ballots.valid === 2 && round.ballotEvidence >= 2,
              ).length,
              promotedRounds: rounds.filter((round) => round.promoted).map((round) => round.id),
              vetoedRounds: rounds
                .filter((round) => round.mechanicalVeto !== null)
                .map((round) => round.id),
            },
            evidenceComplete: hasCompleteReviewEvidence(input.rounds, input.evidence),
            rounds,
          },
    selectedBuild: {
      buildId: input.selectedBuildFacts?.buildId ?? null,
      directory: input.selectedBuildFacts?.directory ?? null,
      passed: input.selectedBuildFacts?.passed ?? null,
      checks: (input.selectedBuildFacts?.checks ?? []).map((check) => ({
        id: check.id,
        status: check.status,
      })),
    },
    selectedBuildId: input.selectedBuildId,
    lifecycle: input.lifecycle ?? null,
  };
};
