import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

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
   * The version an explicit restore preserved before rewriting the folder, so
   * the user can return to the state they had when they asked for the restore.
   */
  preRestoreSnapshotId: Schema.optionalKey(Schema.String),
  candidate: Schema.NullOr(GameReviewArtifact),
  defects: Schema.optionalKey(Schema.Array(GameReviewDefect)),
  doNotRegress: Schema.optionalKey(Schema.Array(GameReviewDoNotRegress)),
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
});
export type GameReviewState = typeof GameReviewState.Type;
