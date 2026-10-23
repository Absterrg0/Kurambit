import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { RunId, ThreadId } from "./baseSchemas.ts";
import {
  GamePlaytestStep,
  GamePlaytestState,
  GamePlaytestInputPair,
  GameViewport,
} from "./game.ts";
import { ModelSelection } from "./modelSelection.ts";

// Prose length must not discard a model's otherwise valid decision.
const reviewText = (cap: number) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap)), {
      decode: SchemaGetter.transform((text) =>
        text.length > cap ? `${text.slice(0, cap - " [truncated]".length)} [truncated]` : text,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  );

/**
 * The review loop's judgement vocabulary. A defect is something the critic saw
 * in a frame, at one of three severities; a preservation item is behaviour the
 * creator already has and a repair must not take away. Both are frozen into the
 * round that produced them, so a later edit of the game cannot rewrite its own
 * review.
 */
export const GAME_REVIEW_SEVERITIES = ["blocker", "visible", "nit"] as const;
export const GameReviewSeverity = Schema.Literals(GAME_REVIEW_SEVERITIES);
export type GameReviewSeverity = typeof GameReviewSeverity.Type;

export const GameReviewDefect = Schema.Struct({
  severity: GameReviewSeverity,
  /** One observed fault, in the critic's words. */
  what: reviewText(400),
  /** A frame id from the evidence manifest, never a caption the critic invented. */
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** A concrete change with a yes/no completion test. */
  fix: reviewText(400),
});
export type GameReviewDefect = typeof GameReviewDefect.Type;

export const GameReviewDoNotRegress = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  what: reviewText(400),
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /**
   * An existing factual check associated with this behaviour, when one exists.
   * Ballots still judge preservation separately for each build.
   */
  checkId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
});
export type GameReviewDoNotRegress = typeof GameReviewDoNotRegress.Type;

/**
 * One frame from an experiment the critic cited, frozen with the round so the
 * route can be replayed on both builds after the repair.
 */
export const GameReviewExperimentFrame = Schema.Struct({
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  stepIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Elapsed within the step for a cited interval observation. */
  observationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type GameReviewExperimentFrame = typeof GameReviewExperimentFrame.Type;

/**
 * A critic experiment route, not its outcome: the exact inputs and capture
 * cadence are replayed on the incumbent and the candidate for the ballots.
 */
export const GameReviewExperimentRoute = Schema.Struct({
  /** The critic's call id, e.g. try-1. */
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** The build the critic actually played when it recorded the route. */
  buildId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  steps: Schema.Array(GamePlaytestStep),
  captureEveryMs: Schema.Number,
  viewport: Schema.NullOr(GameViewport),
  /** Only the frames the critic cited; the route replays all of its steps. */
  frames: Schema.Array(GameReviewExperimentFrame),
});
export type GameReviewExperimentRoute = typeof GameReviewExperimentRoute.Type;

/** The four pairwise facets a ballot must answer for each comparison. */
export const GAME_REVIEW_FACETS = ["works", "look", "feel", "play"] as const;
export const GameReviewFacet = Schema.Literals(GAME_REVIEW_FACETS);
export type GameReviewFacet = typeof GameReviewFacet.Type;

export const GAME_REVIEW_CHOICES = ["A", "B", "tie"] as const;
export const GameReviewChoice = Schema.Literals(GAME_REVIEW_CHOICES);
export type GameReviewChoice = typeof GameReviewChoice.Type;

export const GAME_REVIEW_PRESERVATION_VERDICTS = ["preserved", "lost", "unknown"] as const;
export const GameReviewPreservationVerdict = Schema.Literals(GAME_REVIEW_PRESERVATION_VERDICTS);
export type GameReviewPreservationVerdict = typeof GameReviewPreservationVerdict.Type;

/** Every facet is required; an omitted facet is an incomplete ballot. */
export const GameReviewFacetVerdicts = Schema.Struct({
  works: GameReviewChoice,
  look: GameReviewChoice,
  feel: GameReviewChoice,
  play: GameReviewChoice,
});
export type GameReviewFacetVerdicts = typeof GameReviewFacetVerdicts.Type;

/**
 * One preservation item judged on both sides of a ballot. `frameIds` are the
 * manifest frames the verdict cites, so a bare claim cannot pass as evidence.
 */
export const GameReviewPreservationEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  A: GameReviewPreservationVerdict,
  B: GameReviewPreservationVerdict,
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});
export type GameReviewPreservationEntry = typeof GameReviewPreservationEntry.Type;

export const GameReviewFundamental = Schema.Struct({
  verdict: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(8),
  ),
  note: reviewText(400),
});
export const GameReviewFundamentals = Schema.Struct({
  boots: GameReviewFundamental,
  respondsToInput: GameReviewFundamental,
  coreActionVisible: GameReviewFundamental,
  stateReadable: GameReviewFundamental,
});
export type GameReviewFundamentals = typeof GameReviewFundamentals.Type;

/**
 * The critic's whole answer. The loop caps the lists in the prompt; the parser
 * enforces the same caps so a model cannot hand back more than it was asked
 * for.
 */
export const GameReviewCriticAnswer = Schema.Struct({
  fundamentals: GameReviewFundamentals,
  defects: Schema.Array(GameReviewDefect).check(Schema.isMaxLength(5)),
  doNotRegress: Schema.Array(GameReviewDoNotRegress).check(Schema.isMaxLength(8)),
});
export type GameReviewCriticAnswer = typeof GameReviewCriticAnswer.Type;

const GameReviewFixJudgment = Schema.Struct({
  fixed: Schema.Literals(["yes", "no", "cannot-tell"]),
  frameIds: GameReviewPreservationEntry.fields.frameIds,
});
const GameReviewDefectJudgment = Schema.Struct({
  id: GameReviewPreservationEntry.fields.id,
  A: GameReviewFixJudgment,
  B: GameReviewFixJudgment,
});
const GameReviewRegression = Schema.Struct({
  what: reviewText(600),
  frameIds: GameReviewPreservationEntry.fields.frameIds,
});

/**
 * The overall choice decides quality; facets explain tradeoffs. Preservation
 * is assessed per build, with identical-build controls and cited evidence.
 */
export const GameReviewBallotAnswer = Schema.Struct({
  overall: GameReviewChoice,
  overallReason: reviewText(600),
  main: GameReviewFacetVerdicts,
  defects: Schema.Array(GameReviewDefectJudgment).check(Schema.isMaxLength(5)),
  regressions: Schema.Struct({
    A: Schema.Array(GameReviewRegression).check(Schema.isMaxLength(8)),
    B: Schema.Array(GameReviewRegression).check(Schema.isMaxLength(8)),
  }),
  preservation: Schema.Array(GameReviewPreservationEntry),
  control: GameReviewFacetVerdicts,
  reason: reviewText(2_000),
});
export type GameReviewBallotAnswer = typeof GameReviewBallotAnswer.Type;

/** The ballot tool exposes the four choices directly; storage keeps `main`. */
export const GameReviewBallotInput = Schema.Struct({
  overall: GameReviewBallotAnswer.fields.overall,
  overallReason: GameReviewBallotAnswer.fields.overallReason,
  ...GameReviewFacetVerdicts.fields,
  defects: GameReviewBallotAnswer.fields.defects,
  regressions: GameReviewBallotAnswer.fields.regressions,
  preservation: GameReviewBallotAnswer.fields.preservation,
  control: GameReviewBallotAnswer.fields.control,
  reason: GameReviewBallotAnswer.fields.reason,
});
export type GameReviewBallotInput = typeof GameReviewBallotInput.Type;

export const GameReviewReportResult = Schema.Struct({
  accepted: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  attemptsRemaining: Schema.Number,
  ended: Schema.Boolean,
});
export type GameReviewReportResult = typeof GameReviewReportResult.Type;

/** One model answer is at most this many bytes of text, before parsing. */
export const GAME_REVIEW_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * The loop's spend. The default is three repairs or forty-five elapsed minutes,
 * whichever runs out first, and includes the checks and reviews those repairs
 * caused. Zero repairs is a valid budget: it ends without opening a review round.
 */
export const GameReviewBudget = Schema.Struct({
  repairs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  elapsedMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type GameReviewBudget = typeof GameReviewBudget.Type;

export const DEFAULT_GAME_REVIEW_BUDGET: GameReviewBudget = {
  repairs: 3,
  elapsedMs: 45 * 60_000,
};

/** Builds are engine- and target-tagged so an artifact is never played as another kind. */
export const GameReviewTarget = Schema.Literals(["Web", "Linux"]);
export type GameReviewTarget = typeof GameReviewTarget.Type;

/**
 * The immutable bytes a round selected or rejected. `buildId` is the SHA-256
 * of the artifact's sorted path/content hashes; `directory` is the
 * build-addressed directory under the game's builds/ tree, never a mutable
 * staging path.
 */
export const GameReviewArtifact = Schema.Struct({
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  /** Game-relative directory, e.g. builds/candidates/<buildId>. */
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  /** The source manifest identity the export started from, when known. */
  sourceId: Schema.NullOr(Schema.String),
  engine: Schema.Literal("godot"),
  target: GameReviewTarget,
  /** Game-relative entry file inside `directory`. */
  entry: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Response headers the artifact needs served, when it needs any. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type GameReviewArtifact = typeof GameReviewArtifact.Type;

/** The build Play and preview serve. Switching it is the only promotion. */
export const GameSelectedBuild = Schema.Struct({
  ...GameReviewArtifact.fields,
  promotedAt: Schema.String,
  /** The round that won the build its place, or null for a direct publish. */
  roundId: Schema.NullOr(Schema.String),
});
export type GameSelectedBuild = typeof GameSelectedBuild.Type;

/**
 * Server-owned execution facts and raw observations frozen from a playtest.
 * Only factual checks can veto promotion; measurements belong to the critic.
 */
export const GameReviewCheck = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  status: Schema.Literals(["passed", "failed", "unmeasured"]),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  /** Raw observations for the critic, never regression gates. */
  measurements: Schema.optionalKey(
    Schema.Struct({
      steps: Schema.Array(GamePlaytestStep),
      changedPercent: Schema.Number,
      state: Schema.NullOr(GamePlaytestState),
      designObservations: Schema.Array(Schema.String),
    }),
  ),
});
export type GameReviewCheck = typeof GameReviewCheck.Type;

/**
 * The builder's own declaration that it stands behind one exact export, with a
 * one-line note on what the game is (repair children name what they believe
 * they fixed). It is recorded only after the server's factual checks pass, so
 * the review starts on a build someone named and the code vouched for, never
 * on a playable state inferred from whatever was last written.
 */
export const GameSubmission = Schema.Struct({
  /** The turn whose tool call declared it. */
  runId: RunId,
  /** The build-addressed export the builder stands behind. */
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  note: reviewText(500),
  submittedAt: Schema.String,
});
export type GameSubmission = typeof GameSubmission.Type;

export const GameSubmitInput = Schema.Struct({
  /**
   * The export to stand behind; omitted means this game's latest export. The
   * server refuses a build that is not the current export, because the repair
   * edits the folder the current sources live in.
   */
  buildId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  /** One line: what the game is, or which defects a repair fixed. */
  note: Schema.String.check(Schema.isPattern(/^[^\r\n]+$/)).pipe(Schema.decodeTo(reviewText(500))),
});
export type GameSubmitInput = typeof GameSubmitInput.Type;

/**
 * The submit tool's answer. A refusal is a value, not a thrown error: the agent
 * must read exactly which fact failed and fix the game, then submit again.
 */
export const GameSubmitResult = Schema.Struct({
  accepted: Schema.Boolean,
  message: Schema.String,
  buildId: Schema.NullOr(Schema.String),
  submission: Schema.NullOr(GameSubmission),
  /** Every fact the server checked, passed or not. */
  checks: Schema.Array(GameReviewCheck),
});
export type GameSubmitResult = typeof GameSubmitResult.Type;

/** Which artifact an anonymous ballot slot held. */
export const GameRepairBallotSide = Schema.Literals(["incumbent", "challenger"]);
export type GameRepairBallotSide = typeof GameRepairBallotSide.Type;

/**
 * One pairwise session's anonymous mapping. It is persisted before the child
 * starts, so a ballot's A/B (and C/D control) labels can always be translated
 * back to builds, and a restarted server cannot re-shuffle a ballot it already
 * asked about.
 */
export const GameReviewBallotPlan = Schema.Struct({
  /** 0 or 1; the two sessions see opposite A/B and independently shuffled C/D. */
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  main: Schema.Struct({
    A: GameRepairBallotSide,
    B: GameRepairBallotSide,
  }),
  /** Both slots are the same build; only a position-biased answer prefers one. */
  control: Schema.Struct({
    C: GameRepairBallotSide,
    D: GameRepairBallotSide,
  }),
  /** The evidence directory hash at dispatch, when one exists. */
  evidenceHash: Schema.NullOr(Schema.String),
});
export type GameReviewBallotPlan = typeof GameReviewBallotPlan.Type;

/** The validated ballots (or why one was unusable) the decision was made on. */
export const GameReviewBallotRecord = Schema.Struct({
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  outcome: Schema.Literals(["valid", "invalid"]),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  // Old history has facets without an overall judgment. Never invent a decision on read.
  answer: Schema.optionalKey(
    Schema.Struct({
      ...GameReviewBallotAnswer.fields,
      defects: Schema.optionalKey(GameReviewBallotAnswer.fields.defects),
      regressions: Schema.optionalKey(GameReviewBallotAnswer.fields.regressions),
      overall: Schema.optionalKey(GameReviewChoice),
      overallReason: Schema.optionalKey(GameReviewBallotAnswer.fields.overallReason),
    }),
  ),
  raw: Schema.optionalKey(Schema.String),
});
export type GameReviewBallotRecord = typeof GameReviewBallotRecord.Type;

/**
 * One repair loop's durable state. It is created once, when the builder run
 * that produced the current playable export ends, and owns the immutable
 * origin, both frozen selections and the spend. Everything a round learns
 * (checks, critic answer, candidate, ballots) lives in the round store; the
 * loop keeps only what outlives a round: where it came from, what it may spend
 * and how it ended.
 */
export const GAME_REPAIR_LOOP_STATUSES = ["running", "interrupted", "stopped"] as const;
export const GameRepairLoopStatus = Schema.Literals(GAME_REPAIR_LOOP_STATUSES);
export type GameRepairLoopStatus = typeof GameRepairLoopStatus.Type;

/**
 * The exact play inputs every candidate of this loop is checked with. They are
 * read from the builder's own playtest once, when the loop opens, so a repair
 * child's demonstration can never substitute an easier route for the one the
 * incumbent is judged on.
 */
export const GameReviewFrozenInputs = Schema.Struct({
  /** The ordinary-input route the builder played. */
  steps: Schema.Array(GamePlaytestStep),
  /** The viewport the route was recorded at, when the evidence had one. */
  viewport: Schema.NullOr(GameViewport),
  /**
   * The seed the route was recorded with. Godot playtests record none, so it
   * is "unknown"; that is honest and never blocks promotion. Loops written
   * before this field was recorded read null.
   */
  seed: Schema.NullOr(Schema.Union([Schema.Number, Schema.Literal("unknown")])),
});
export type GameReviewFrozenInputs = typeof GameReviewFrozenInputs.Type;

/**
 * What this loop spent. `measured` only when every child it started reported
 * provider-turn usage; a child that did not makes the whole loop `unknown`
 * rather than under-reporting as zero.
 */
export const GameReviewUsage = Schema.Struct({
  status: Schema.Literals(["measured", "unknown"]),
  providerTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  usedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GameReviewUsage = typeof GameReviewUsage.Type;

export const EMPTY_GAME_REVIEW_USAGE: GameReviewUsage = {
  status: "unknown",
  providerTurns: 0,
  usedTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export const GameReviewChildUsage = Schema.Struct({
  role: Schema.Literals(["critic", "repair", "ballot"]),
  order: Schema.Int,
  childThreadId: ThreadId,
  runId: Schema.NullOr(RunId),
  tryInputCalls: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  usage: GameReviewUsage,
});
export type GameReviewChildUsage = typeof GameReviewChildUsage.Type;

export const GameReviewUsageByRole = Schema.Struct({
  critic: GameReviewUsage,
  repair: GameReviewUsage,
  ballot: GameReviewUsage,
  /** Subset of child usage with at least one try_input call, not an added cost. */
  "try_input-heavy": GameReviewUsage,
});

/** One captured frame a review child is shown, stored outside the game. */
export const GameRepairFrame = Schema.Struct({
  inputPair: Schema.optionalKey(GamePlaytestInputPair),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Absolute path in server state; never inside the game. */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
});
export type GameRepairFrame = typeof GameRepairFrame.Type;

export const GameRepairLoop = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  id: Schema.String,
  /** Canonical game root; the record is keyed by its digest. */
  root: Schema.String,
  threadId: ThreadId,
  originatingRunId: RunId,
  originatingNodeId: Schema.String,
  /** The build the originating run exported; the loop repairs these bytes. */
  exportBuildId: Schema.String,
  /**
   * What the builder said this game is, when it submitted before the turn ended.
   * It is the origin note the review status shows, frozen with the loop.
   */
  submissionNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  status: GameRepairLoopStatus,
  /** Attempted repairs, counted when a repair starts. */
  repairsUsed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budget: GameReviewBudget,
  builderSelection: ModelSelection,
  reviewSelection: ModelSelection,
  inputs: GameReviewFrozenInputs,
  /**
   * The admission generation at creation. A user action bumps it, so a loop
   * that lost its game never dispatches or promotes afterwards.
   */
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  promotedRounds: Schema.Array(Schema.String),
  decision: Schema.NullOr(Schema.Literals(["promote", "stop", "interrupt"])),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  usage: GameReviewUsage,
});
export type GameRepairLoop = typeof GameRepairLoop.Type;

export const GAME_REVIEW_ROUND_STATUSES = [
  "running",
  "promoted",
  "rejected",
  "stopped",
  "interrupted",
] as const;
export const GameReviewRoundStatus = Schema.Literals(GAME_REVIEW_ROUND_STATUSES);
export type GameReviewRoundStatus = typeof GameReviewRoundStatus.Type;

export const GameReviewDecision = Schema.Literals(["promote", "reject", "stop", "interrupt"]);
export type GameReviewDecision = typeof GameReviewDecision.Type;

/**
 * One repair round's durable record. A round is opened before the repair child
 * writes, and names the snapshot that restore falls back to. The review loop
 * session extends this record with frozen checks, ballots and model selection;
 * the lifecycle here is what makes a worse build impossible to keep.
 */
export const GameReviewRound = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  status: GameReviewRoundStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  /** The stored pre-repair snapshot whose source identity is the fallback. */
  incumbentSnapshotId: Schema.String,
  /** The source identity Play's selected build was exported from. */
  incumbentSourceId: Schema.String,
  incumbentBuildId: Schema.NullOr(Schema.String),
  /**
   * The source identity the server read after the repair child stopped
   * writing. A folder that no longer matches it was changed by someone else,
   * so restoring would discard a user edit.
   */
  postRepairSourceId: Schema.NullOr(Schema.String),
  /**
   * When a repair child was dispatched for this round. A review that stops
   * before dispatch (zero defects, an invalid critic) never touched the folder,
   * so there is nothing to restore.
   */
  repairStartedAt: Schema.optionalKey(Schema.String),
  /**
   * The version an explicit restore preserved before rewriting the folder, so
   * the user can return to the state they had when they asked for the restore.
   */
  preRestoreSnapshotId: Schema.optionalKey(Schema.String),
  candidate: Schema.NullOr(GameReviewArtifact),
  /** The loop this round belongs to, when a loop opened it. */
  loopId: Schema.optionalKey(Schema.String),
  /**
   * The model selections frozen when the round opened. The review session
   * reads these instead of the thread's current composer, so changing the
   * model after the builder finished cannot change who reviews or repairs.
   */
  builderSelection: Schema.optionalKey(ModelSelection),
  reviewSelection: Schema.optionalKey(ModelSelection),
  childUsage: Schema.optionalKey(Schema.Array(GameReviewChildUsage)),
  usageByRole: Schema.optionalKey(GameReviewUsageByRole),
  fundamentals: Schema.optionalKey(GameReviewFundamentals),
  defects: Schema.optionalKey(Schema.Array(GameReviewDefect)),
  doNotRegress: Schema.optionalKey(Schema.Array(GameReviewDoNotRegress)),
  /** The frozen check run the round was reviewed against. */
  checks: Schema.optionalKey(Schema.Array(GameReviewCheck)),
  /**
   * Routes of the experiments the critic cited, replayed on both builds so a
   * behaviour discovered outside the original check route is judged.
   */
  experiments: Schema.optionalKey(Schema.Array(GameReviewExperimentRoute)),
  /** The challenger's check run and the mechanical veto reason, when it ran. */
  candidateChecks: Schema.optionalKey(Schema.Array(GameReviewCheck)),
  mechanicalVeto: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  /**
   * The repair child's own `game_submit` note: which defects it believes it
   * fixed. It is testimony for the history; the ballots and checks still decide.
   */
  submissionNote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  /** Anonymous mappings persisted before either ballot was dispatched. */
  ballots: Schema.optionalKey(Schema.Array(GameReviewBallotPlan)),
  /** The ballots' validated answers (or invalidity) at decision time. */
  ballotAnswers: Schema.optionalKey(Schema.Array(GameReviewBallotRecord)),
  budget: GameReviewBudget,
  decision: Schema.optionalKey(GameReviewDecision),
  /** The exact reason, never a score. */
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});
export type GameReviewRound = typeof GameReviewRound.Type;

/** What a game's record says about selection and its round history. */

export const GameReviewState = Schema.Struct({
  selected: Schema.NullOr(GameSelectedBuild),
  rounds: Schema.Array(GameReviewRound),
  /** Builders' and repair children's submissions, newest last. */
  submissions: Schema.optionalKey(Schema.Array(GameSubmission)),
});
export type GameReviewState = typeof GameReviewState.Type;

export const GameReviewHistoryInput = Schema.Struct({
  threadId: ThreadId,
  before: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type GameReviewHistoryInput = typeof GameReviewHistoryInput.Type;
export const GameReviewEvidenceRef = Schema.Struct({
  role: Schema.Literals(["critic", "ballot"]),
  order: Schema.Number,
  directory: Schema.String,
  childThreadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(Schema.String),
  frames: Schema.Array(GameRepairFrame),
});
export const GameReviewHistory = Schema.Struct({
  rounds: Schema.Array(
    Schema.Struct({ round: GameReviewRound, evidence: Schema.Array(GameReviewEvidenceRef) }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type GameReviewHistory = typeof GameReviewHistory.Type;
export const GameSubmissionFacts = Schema.Struct({
  buildId: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  checks: Schema.Array(GameReviewCheck),
  passed: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type GameSubmissionFacts = typeof GameSubmissionFacts.Type;

export const GameReviewStatus = Schema.Struct({
  loop: Schema.NullOr(GameRepairLoop),
  phase: Schema.String,
  held: Schema.Boolean,
  repairsLeft: Schema.Number,
  timeLeftMs: Schema.Number,
  budget: GameReviewBudget,
  restoreOffered: Schema.Boolean,
  /** Only computed when requested: hashes and checks Play's selected artifact. */
  selectedBuildFacts: Schema.optionalKey(Schema.NullOr(GameSubmissionFacts)),
});
export type GameReviewStatus = typeof GameReviewStatus.Type;
export const GameReviewRestoreResult = Schema.Struct({
  kind: Schema.Literals(["restored", "blocked", "busy"]),
  message: Schema.String,
});

export type GameReviewRestoreResult = typeof GameReviewRestoreResult.Type;
