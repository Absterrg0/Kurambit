import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { GameEngineId } from "./game.ts";
import {
  GameBuildFacts,
  GameBuildId,
  GameFactDelta,
  GameFactId,
  GameStepVerdict,
} from "./gameBuilds.ts";
import { GameRunEnding, GameRunProfile, GameRunStepWhy } from "./gameRun.ts";

/**
 * Keep going as records of the chat it runs in: the run, its steps and its
 * rounds (one per step). Each event carries the new full record of one entity.
 * Records an earlier Kurambit's production runs wrote are still in event logs,
 * so the shapes below keep decoding them; nothing reads their extra fields.
 */

export const GameRunId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunId"));
export type GameRunId = typeof GameRunId.Type;
export const GameRunStepId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunStepId"));
export type GameRunStepId = typeof GameRunStepId.Type;
const GameRunRoundId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunRoundId"));
export type GameRunRoundId = typeof GameRunRoundId.Type;

/** A step's id: its number within the run. */
export const gameRunStepId = (runId: GameRunId, seq: number): GameRunStepId =>
  GameRunStepId.make(`${runId}:step:${seq}`);
export const gameRunRoundId = (runId: GameRunId, round: number): GameRunRoundId =>
  GameRunRoundId.make(`${runId}:round:${round}`);
/**
 * The command id that reports a step's work. A step that runs again after a
 * resume is a new attempt, so its report never meets the receipt of an earlier one.
 */
export const gameRunStepCommandId = (
  stepId: GameRunStepId,
  attempt: number,
  action: "start" | "complete" | "fail",
): CommandId => CommandId.make(`game-run:${stepId}:attempt:${attempt}:${action}`);

// ── Rounds: a keep-going step's record, or a stage-era round. ───────────────
export const GameRunVerdict = Schema.Struct({
  order: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
});
export type GameRunVerdict = typeof GameRunVerdict.Type;

const CheckVerdict = Schema.Struct({
  what: Schema.String,
  pass: Schema.Boolean,
  evidence: Schema.String,
});

/** What a stage-era round did with its ladder rung, check by check; the round cards read it. */
export const GameRunRungRecord = Schema.Struct({
  rung: Schema.Number,
  is: Schema.String,
  checks: Schema.Array(CheckVerdict),
  outcome: Schema.Literals(["landed", "failed", "set-aside"]),
  why: Schema.String,
  /** The rung's checks as this round built them (a hash of their full form); absent on older records. */
  checksKey: Schema.optionalKey(Schema.String),
});
export type GameRunRungRecord = typeof GameRunRungRecord.Type;

/**
 * One round. A keep-going step fills the stage-era fields this way: `round`
 * is its number, `move` its text's first line, `branch` "", `verdicts` [],
 * `kept` whether it was not undone, and `steer` the entries it carried.
 */
export const GameRunRoundRecord = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  verdicts: Schema.Array(GameRunVerdict),
  kept: Schema.Boolean,
  unjudged: Schema.optionalKey(Schema.Boolean),
  inconclusive: Schema.optionalKey(Schema.Boolean),
  // A creator's restore of another round dropped this one mid-way.
  abandoned: Schema.optionalKey(Schema.Boolean),
  // Why a round or step failed: the game's, the harness's (its measure could
  // not judge), a stage-era check's (it cannot be verified in play), or a turn
  // that changed no game files.
  failure: Schema.optionalKey(Schema.Literals(["game", "harness", "check", "no-change"])),
  durationMs: Schema.Number,
  linesChanged: Schema.Number,
  testerNote: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  steer: Schema.optionalKey(Schema.Array(Schema.String)),
  rung: Schema.optionalKey(GameRunRungRecord),
  // A finish round: the old fix-the-flaw shape, after the ladder.
  finish: Schema.optionalKey(Schema.Boolean),
  // The round's build (checkpoint oid).
  build: Schema.optionalKey(Schema.String),
  // A stage-era round's comparison record id ("" before or without one).
  comparison: Schema.optionalKey(Schema.String),
  /** A keep-going step's record (absent on stage-era rounds): round cards skip these. */
  step: Schema.optionalKey(
    Schema.Struct({
      why: GameRunStepWhy,
      key: Schema.String,
      turn: Schema.NullOr(RunId),
      base: Schema.NullOr(GameBuildId),
      verdict: GameStepVerdict,
      reason: Schema.String,
      gain: Schema.Boolean,
      delta: Schema.Array(GameFactDelta).check(Schema.isMaxLength(3)),
      tokens: Schema.NullOr(Schema.Number),
      /** The cap in minutes, when Kurambit's time cap stopped the step's turn. */
      capped: Schema.optionalKey(Schema.Number),
    }),
  ),
});
export type GameRunRoundRecord = typeof GameRunRoundRecord.Type;

// ── Steps the decider plans. ───────────────────────────────────────────────
export const GameRunProposal = Schema.Struct({
  why: GameRunStepWhy,
  /** The body the step message carries, without its header and tail. */
  text: Schema.String.check(Schema.isMaxLength(8000)),
  /** The fact a blocker or fact step targets; null otherwise. */
  target: Schema.NullOr(GameFactId),
  /** Never-repeat identity: fact:<id>, bot, steer:<fnv>, next:<fnv>; a regression carries the undone step's key. */
  key: Schema.String,
});
export type GameRunProposal = typeof GameRunProposal.Type;

export const GameRunLookStep = Schema.Struct({
  kind: Schema.Literal("look"),
  id: Schema.Number,
  /**
   * The step number of the look before it, which measured `build`, when no
   * step landed since: a look that finds the folder still holds `build`
   * takes that look's facts and measures nothing.
   */
  known: Schema.optionalKey(Schema.Struct({ build: GameBuildId, look: Schema.Number })),
});
export type GameRunLookStep = typeof GameRunLookStep.Type;
export const GameRunProposeStep = Schema.Struct({
  kind: Schema.Literal("propose"),
  id: Schema.Number,
  proposal: GameRunProposal,
  /** Epoch ms the default (start) fires; null while held. */
  deadline: Schema.NullOr(Schema.Number),
});
export type GameRunProposeStep = typeof GameRunProposeStep.Type;
export const GameRunTurnStep = Schema.Struct({
  kind: Schema.Literal("turn"),
  id: Schema.Number,
  proposal: GameRunProposal,
  /** The steer entries this message carries: the captured prefix of GameRun.steer. */
  steer: Schema.Array(Schema.String),
  /** The folder's build at the look; the reactor compares nothing against it, it is for the record. */
  base: Schema.NullOr(GameBuildId),
  capMs: Schema.Number,
  /** How the step started: the person's Start now, the Guided default, or Autopilot. */
  startedBy: Schema.Literals(["creator", "default", "autopilot"]),
});
export type GameRunTurnStep = typeof GameRunTurnStep.Type;
export const GameRunJudgeStep = Schema.Struct({
  kind: Schema.Literal("judge"),
  id: Schema.Number,
  build: GameBuildId,
  /** The turn build's recorded base (GameBuilds.recordTurn). */
  base: Schema.NullOr(GameBuildId),
});
export type GameRunJudgeStep = typeof GameRunJudgeStep.Type;
export const GameRunUndoStep = Schema.Struct({
  kind: Schema.Literal("undo"),
  id: Schema.Number,
  target: GameBuildId,
  expect: GameBuildId,
});
export type GameRunUndoStep = typeof GameRunUndoStep.Type;
/** A stage-era step: decoded with its own keys kept (StructWithRest), never planned again. */
export const GameRunLegacyStep = Schema.StructWithRest(
  Schema.Struct({
    kind: Schema.Literals([
      "role",
      "build",
      "git",
      "boot",
      "facts",
      "checks",
      "bot",
      "note",
      "pair",
      "decide",
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type GameRunLegacyStep = typeof GameRunLegacyStep.Type;
export const GameRunPlannedStep = Schema.Union([
  GameRunLookStep,
  GameRunProposeStep,
  GameRunTurnStep,
  GameRunJudgeStep,
  GameRunUndoStep,
  GameRunLegacyStep,
]);
export type GameRunPlannedStep = typeof GameRunPlannedStep.Type;

// ── What a step's execution hands back. ────────────────────────────────────
const FailedResult = Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String });

// Usage limits, a provider that stays down and a tool of Kurambit's that keeps
// failing end the run resumably: nothing was measured, so nothing is judged.
// "low-memory" and "busy" are stage era only.
const EndedResult = Schema.Struct({
  kind: Schema.Literal("ended"),
  ending: Schema.Literals(["usage-limit", "provider-down", "low-memory", "busy", "tool-failed"]),
  reason: Schema.String,
});

/** The `Next:` line of the chat's latest settled reply: its text, "none", or null when it had none. */
const NextLine = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Literal("none"),
  Schema.Null,
]);

export const GameRunStepResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("look"),
    current: Schema.NullOr(GameBuildId),
    /** Null when the current build could not be measured. */
    facts: Schema.NullOr(GameBuildFacts),
    /** The chat's latest settled reply's line (packages/shared readNextLine). */
    next: NextLine,
    /** A play bot exists (GameBot.latestPlayBot). */
    bot: Schema.Boolean,
    /** The folder's game files are not `current`'s: edited outside any build. */
    edited: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  }),
  Schema.Struct({
    kind: Schema.Literal("decided"),
    answer: Schema.Literals(["start", "skip", "superseded"]),
    by: Schema.Literals(["creator", "default", "server"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn"),
    /** The step's T3 run (the last of its restart continuations). */
    runId: Schema.NullOr(RunId),
    outcome: Schema.Literals(["completed", "capped", "stopped-by-person", "superseded", "failed"]),
    build: Schema.NullOr(GameBuildId),
    /**
     * The build the folder held when the step's turn started (the turn build's
     * recorded base): the judge and the undo measure against it. Null when
     * unknown; absent on records written before it.
     */
    startBuild: Schema.NullOr(GameBuildId).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
    ),
    /** Files the turn changed in the lane, art/ and ASSETS.md, since `startBuild`. */
    files: NonNegativeInt,
    tokens: Schema.NullOr(Schema.Number),
    elapsedMs: Schema.Number,
    /** The person steered this turn (steer_active into it). */
    personSteered: Schema.Boolean,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("judge"),
    base: Schema.NullOr(GameBuildFacts),
    build: Schema.NullOr(GameBuildFacts),
  }),
  Schema.Struct({
    kind: Schema.Literal("undo"),
    restored: Schema.Boolean,
    why: Schema.Literals(["restored", "moved-on", "undone-by-person", "refused"]),
    message: Schema.String,
  }),
  EndedResult,
  FailedResult,
  /** A stage-era step's result, kept as it was. */
  Schema.StructWithRest(Schema.Struct({ kind: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
]);
export type GameRunStepResult = typeof GameRunStepResult.Type;

// ── The three records. ─────────────────────────────────────────────────────
/** `waiting`: the step in flight waits for the person (a stage-era decision). */
const GameRunStatus = Schema.Literals(["running", "waiting", "ended"]);
export type GameRunStatus = typeof GameRunStatus.Type;

export const GameRun = Schema.Struct({
  id: GameRunId,
  /** The chat the run lives on: its stream holds the run's records. */
  threadId: ThreadId,
  projectId: ProjectId,
  /** The engine project directory the manifest names (`godot`, `web`, `unity`). */
  lane: Schema.String,
  /** The game's engine; absent on runs started before it was recorded (read through runEngine). */
  engine: Schema.optionalKey(GameEngineId),
  profile: GameRunProfile,
  budgetMinutes: Schema.NullOr(Schema.Number),
  /** Epoch ms; null without a budget. */
  budgetEndsAt: Schema.NullOr(Schema.Number),
  status: GameRunStatus,
  ending: Schema.NullOr(GameRunEnding),
  /** The person's notes for the next step. */
  steer: Schema.Array(Schema.String),
  /** Never-repeat: proposals the run will not make again, with why. */
  setAside: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String, why: Schema.String })),
  ),
  /** The quiet streak: steps in a row that gained nothing. */
  stallStreak: Schema.Number,
  /** Steps in a row that never landed (superseded, or started on another build); absent is 0. */
  supersededStreak: Schema.optionalKey(NonNegativeInt),
  lastFailure: Schema.String,
  /** The number of the last step planned. */
  seq: NonNegativeInt,
  /** The number of the step the run holds in flight; null between steps and once ended. */
  inFlight: Schema.NullOr(Schema.Number),
  /** When the run last ended. */
  endedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GameRun = typeof GameRun.Type;

const GameRunStepStatus = Schema.Literals([
  "planned",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type GameRunStepStatus = typeof GameRunStepStatus.Type;

export const GameRunStep = Schema.Struct({
  id: GameRunStepId,
  runId: GameRunId,
  threadId: ThreadId,
  seq: PositiveInt,
  /** Counts the times the step was planned: a resume runs an unfinished step again. */
  attempt: PositiveInt,
  kind: Schema.Literals([
    "look",
    "propose",
    "turn",
    "judge",
    "undo",
    // Stage era.
    "role",
    "build",
    "git",
    "boot",
    "facts",
    "checks",
    "bot",
    "note",
    "pair",
    "decide",
  ]),
  step: GameRunPlannedStep,
  status: GameRunStepStatus,
  result: Schema.NullOr(GameRunStepResult),
  /** The run's decisions about this step, in order, for the run log. */
  logs: Schema.Array(Schema.String),
  /** Times this attempt's work was handed back to wait for memory; bounds the waits across restarts. */
  memoryWaits: Schema.optionalKey(NonNegativeInt),
  /** Times this attempt's work was handed back because another operation held the game. */
  busyWaits: Schema.optionalKey(NonNegativeInt),
  /** Times this attempt's work was handed back because a tool of Kurambit's failed in a way waiting may clear. */
  toolWaits: Schema.optionalKey(NonNegativeInt),
  plannedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GameRunStep = typeof GameRunStep.Type;

export const GameRunRound = Schema.Struct({
  id: GameRunRoundId,
  runId: GameRunId,
  threadId: ThreadId,
  round: GameRunRoundRecord,
  recordedAt: IsoDateTime,
});
export type GameRunRound = typeof GameRunRound.Type;
