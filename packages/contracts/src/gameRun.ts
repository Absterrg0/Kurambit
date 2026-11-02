import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** Production loop as a Kurambit service: one game's run from vision to an ending. */

export const GameRunStartInput = Schema.Struct({
  threadId: ThreadId,
  /** Required for a new run; empty resumes a stopped run with its own brief. */
  brief: Schema.String.check(Schema.isMaxLength(8000)),
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
  /** The creator's steering notes this round started from. */
  steer: Schema.Array(Schema.String),
});
export type GameRunRoundRef = typeof GameRunRoundRef.Type;

export const GameRunStatusResult = Schema.Struct({
  active: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  stage: Schema.String,
  /** What the run is doing now (the role or phase in flight), null when no run is recorded. */
  step: Schema.NullOr(Schema.String),
  ending: Schema.NullOr(Schema.String),
  rounds: Schema.Array(GameRunRoundRef),
  /** Creator notes waiting for the next round. */
  steer: Schema.Array(Schema.String),
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

export const GameRunSteerInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type GameRunSteerInput = typeof GameRunSteerInput.Type;

export const GameRunSteerResult = Schema.Struct({
  /** Notes now waiting for the next round, this one included. */
  pending: Schema.Number,
  message: Schema.String,
});
export type GameRunSteerResult = typeof GameRunSteerResult.Type;

/**
 * A readable name for a run role thread ("tester-3" is "Tester, round 3").
 * Blind samples and comparators carry random ids, which say nothing to a reader.
 */
export const gameRunRoleLabel = (role: string): string => {
  const [head = role, ...rest] = role.split("-");
  const tail = rest.join("-");
  const round = /^\d+$/.test(tail) ? Number(tail) : null;
  switch (head) {
    case "vision":
      return "Vision";
    case "plan":
      return "Plan";
    case "art":
      return "Art";
    case "proto":
      return round === null ? "Prototype" : `Prototype ${round + 1}`;
    case "builder":
      if (tail === "build") return "First full build";
      if (/^\d+b$/.test(tail)) return `Builder retry, round ${tail.slice(0, -1)}`;
      return round === null ? "Builder" : `Builder, round ${round}`;
    case "tester":
      return round === null ? "Tester" : `Tester, round ${round}`;
    case "reviewer":
      return round === null ? "Reviewer" : `Reviewer, round ${round}`;
    case "ship":
      return round === null ? "Ship review" : `Ship review after round ${round}`;
    case "sample":
      return "Blind play sample";
    case "compare":
      return "Blind comparison";
    default:
      return role;
  }
};
