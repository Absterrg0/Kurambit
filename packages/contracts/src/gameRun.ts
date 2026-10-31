import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** Production loop as a T3 service: one game's run from vision to an ending. */

export const GameRunStartInput = Schema.Struct({
  threadId: ThreadId,
  brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Creator's choice. Omitted means no time limit. */
  budgetMinutes: Schema.optionalKey(Schema.Number),
  /** Default: the calling thread's own provider, model and options. */
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
});
export type GameRunStartInput = typeof GameRunStartInput.Type;

export const GameRunStartResult = Schema.Struct({
  runId: Schema.String,
  root: Schema.String,
  stage: Schema.String,
  resumed: Schema.Boolean,
});
export type GameRunStartResult = typeof GameRunStartResult.Type;

export const GameRunStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameRunStatusInput = typeof GameRunStatusInput.Type;

export const GameRunThreadRef = Schema.Struct({
  role: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type GameRunThreadRef = typeof GameRunThreadRef.Type;

export const GameRunRoundRef = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  kept: Schema.Boolean,
  verdicts: Schema.Array(
    Schema.Struct({
      order: Schema.String,
      verdict: Schema.String,
      reason: Schema.String,
    }),
  ),
  linesChanged: Schema.Number,
  testerNote: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  note: Schema.NullOr(Schema.String),
});
export type GameRunRoundRef = typeof GameRunRoundRef.Type;

export const GameRunStatusResult = Schema.Struct({
  active: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  stage: Schema.String,
  ending: Schema.NullOr(Schema.String),
  rounds: Schema.Array(GameRunRoundRef),
  threads: Schema.Array(GameRunThreadRef),
  message: Schema.String,
});
export type GameRunStatusResult = typeof GameRunStatusResult.Type;

export const GameRunStopInput = Schema.Struct({ threadId: ThreadId });
export type GameRunStopInput = typeof GameRunStopInput.Type;

export const GameRunStopResult = Schema.Struct({
  stopped: Schema.Boolean,
  message: Schema.String,
});
export type GameRunStopResult = typeof GameRunStopResult.Type;
