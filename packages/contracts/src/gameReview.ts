import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";
import { GamePlaytestStep, GameViewport } from "./game.ts";
import { ModelSelection } from "./modelSelection.ts";

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
  what: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  /** A frame id from the evidence manifest, never a caption the critic invented. */
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** A concrete change with a yes/no completion test. */
  fix: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
});
export type GameReviewDefect = typeof GameReviewDefect.Type;

export const GameReviewDoNotRegress = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  what: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  frameId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /**
   * The existing check that measures this behaviour, when one does. Ballots
   * only judge items the code checks cannot measure.
   */
  checkId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
});
export type GameReviewDoNotRegress = typeof GameReviewDoNotRegress.Type;

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

/**
 * The critic's whole answer. The loop caps the lists in the prompt; the parser
 * enforces the same caps so a model cannot hand back more than it was asked
 * for.
 */
export const GameReviewCriticAnswer = Schema.Struct({
  defects: Schema.Array(GameReviewDefect).check(Schema.isMaxLength(5)),
  doNotRegress: Schema.Array(GameReviewDoNotRegress).check(Schema.isMaxLength(8)),
});
export type GameReviewCriticAnswer = typeof GameReviewCriticAnswer.Type;

/**
 * One pairwise ballot: main A/B facets, every preservation item, the
 * identical-build control, and the evidence behind it. The reason is prose with
 * frame IDs, never a score.
 */
export const GameReviewBallotAnswer = Schema.Struct({
  main: GameReviewFacetVerdicts,
  preservation: Schema.Array(GameReviewPreservationEntry),
  control: GameReviewFacetVerdicts,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
export type GameReviewBallotAnswer = typeof GameReviewBallotAnswer.Type;

/** One model answer is at most this many bytes of text, before parsing. */
export const GAME_REVIEW_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * The loop's spend. The default is three repairs or twenty elapsed minutes,
 * whichever runs out first, and includes the checks and reviews those repairs
 * caused. Zero repairs is a valid budget: it reviews once and never repairs.
 */
export const GameReviewBudget = Schema.Struct({
  repairs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  elapsedMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type GameReviewBudget = typeof GameReviewBudget.Type;

export const DEFAULT_GAME_REVIEW_BUDGET: GameReviewBudget = {
  repairs: 3,
  elapsedMs: 20 * 60_000,
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
 * One code check the loop froze from the incumbent's playtest. The id is
 * server-owned (boot, input, state...) so a repair cannot rename or drop the
 * checks it is judged by.
 */
export const GameReviewCheck = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  status: Schema.Literals(["passed", "failed", "unmeasured"]),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
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
  note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
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
  /** One line; the builder's answer to "what is this game what did you fix". */
  note: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
    Schema.isPattern(/^[^\r\n]+$/),
  ),
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
  answer: Schema.optionalKey(GameReviewBallotAnswer),
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

/** One captured frame a review child is shown, stored outside the game. */
export const GameRepairFrame = Schema.Struct({
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
  defects: Schema.optionalKey(Schema.Array(GameReviewDefect)),
  doNotRegress: Schema.optionalKey(Schema.Array(GameReviewDoNotRegress)),
  /** The frozen check run the round was reviewed against. */
  checks: Schema.optionalKey(Schema.Array(GameReviewCheck)),
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
export const GameReviewStatus = Schema.Struct({
  loop: Schema.NullOr(GameRepairLoop),
  phase: Schema.String,
  held: Schema.Boolean,
  repairsLeft: Schema.Number,
  timeLeftMs: Schema.Number,
  budget: GameReviewBudget,
  restoreOffered: Schema.Boolean,
});
export type GameReviewStatus = typeof GameReviewStatus.Type;
export const GameReviewRestoreResult = Schema.Struct({
  kind: Schema.Literals(["restored", "blocked", "busy"]),
  message: Schema.String,
});

export type GameReviewRestoreResult = typeof GameReviewRestoreResult.Type;
