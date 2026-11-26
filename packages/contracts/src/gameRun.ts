import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId, GameFactDelta, GameStepVerdict } from "./gameBuilds.ts";

/**
 * Keep going as a Kurambit service: the agent takes the next step of a game
 * itself, in the person's chat, and the run keeps or undoes each step by its
 * facts.
 */

// The profile and the refusal reasons live in a leaf module: game.ts names them
// and sits under gameBuilds.ts's imports, which this module needs.
export { GameRunErrorReason, GameRunProfile, GameRunRefusalReason } from "./gameRunReasons.ts";

/** The caller's id for one request: a retry with the same id is the same command, applied once. */
export const GameRunCommandKey = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);

// "ready", "no-ladder", "incomplete", "low-memory" and "busy" are only on runs an
// earlier Kurambit wrote; stored records keep them, so they still decode.
export const GameRunEnding = Schema.Literals([
  "ready",
  "done",
  "stopped",
  "stalled",
  "no-ladder",
  "incomplete",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "low-memory",
  "busy",
  /** A program Kurambit runs kept failing while measuring a build: nothing was judged. */
  "tool-failed",
]);
export type GameRunEnding = typeof GameRunEnding.Type;

/** Keep going is on or off: on, it takes each step at once until steps stop gaining or it is stopped. */
export const GameKeepGoingMode = Schema.Literals(["off", "on"]);
export type GameKeepGoingMode = typeof GameKeepGoingMode.Type;

/**
 * Why the run chose a step, in the order it looks. "bot" is only on steps an
 * earlier Kurambit took, when it wrote a play bot.
 */
export const GameRunStepWhy = Schema.Literals([
  "steer",
  "blocker",
  "regression",
  "bot",
  "fact",
  "reference",
  "fresh",
  "next",
]);
export type GameRunStepWhy = typeof GameRunStepWhy.Type;

export const GameKeepGoingInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  mode: GameKeepGoingMode,
  /** For a start or resume; null is no limit; omitted keeps the run's own (a new run: 60). */
  budgetMinutes: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  /**
   * The person's words, sent with the start: its direction, kept until a step says it is done.
   * Given on a start or resume it replaces the direction left from before; while the run is on
   * here it is added to it.
   */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
export type GameKeepGoingInput = typeof GameKeepGoingInput.Type;

export const GameKeepGoingStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameKeepGoingStatusInput = typeof GameKeepGoingStatusInput.Type;

export const GameKeepGoingPhase = Schema.Literals([
  /** look: a turn is running or queued on the game. */
  "waiting",
  /** look: reading the current build's facts. */
  "looking",
  /** The step's turn is running. */
  "turn",
  /** judge */
  "measuring",
  /** undo */
  "undoing",
]);
export type GameKeepGoingPhase = typeof GameKeepGoingPhase.Type;

export const GameKeepGoingStepRef = Schema.Struct({
  n: PositiveInt,
  why: GameRunStepWhy,
  /** The step's first line, at most 140 characters. */
  text: Schema.String,
  build: Schema.NullOr(GameBuildId),
  /** Null while in flight. */
  verdict: Schema.NullOr(GameStepVerdict),
  reason: Schema.String,
  /** Kept, changed game files, and made no watched fact worse. */
  gain: Schema.Boolean,
  delta: Schema.Array(GameFactDelta).check(Schema.isMaxLength(3)),
  minutes: Schema.NullOr(Schema.Number),
  /** Input + output as the provider reported them; null when none was. */
  tokens: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(IsoDateTime),
});
export type GameKeepGoingStepRef = typeof GameKeepGoingStepRef.Type;

export const GameKeepGoingStatus = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  /** The chat it runs in: another chat's control says "on in <chat>". */
  chat: Schema.NullOr(ThreadId),
  /** "off" unless a run is live. */
  mode: GameKeepGoingMode,
  phase: Schema.NullOr(GameKeepGoingPhase),
  step: Schema.NullOr(PositiveInt),
  budgetMinutes: Schema.NullOr(PositiveInt),
  /**
   * Minutes of the budget left; null without one. The budget counts only the steps' own turns,
   * so time between steps and time the app was off never spend it.
   */
  budgetLeftMinutes: Schema.NullOr(NonNegativeInt),
  /** Newest first, at most 10: every push resends it. */
  steps: Schema.Array(GameKeepGoingStepRef).check(Schema.isMaxLength(10)),
  /** The run's first step's number, so its reel shows the whole run; null before it took one. */
  firstStep: Schema.NullOr(PositiveInt),
  /** The person's direction: each entry stays until a step that carried it says it is done. */
  steer: Schema.Array(Schema.String),
  setAside: Schema.Array(Schema.Struct({ text: Schema.String, why: Schema.String })),
  /** Why it last stopped; null while live or never run. */
  ending: Schema.NullOr(GameRunEnding),
  /** When it last stopped; null while live or never run. A turn in its chat since retires the line saying why. */
  endedAt: Schema.NullOr(IsoDateTime),
  resumable: Schema.Boolean,
  /** Why keep going cannot run on this game or chat ("Keep going needs an engine…", "Keep going is on in <chat>"); null when it can. */
  blocked: Schema.NullOr(Schema.String),
  /** The one plain line the control, the banner and the tool show. */
  message: Schema.String,
});
export type GameKeepGoingStatus = typeof GameKeepGoingStatus.Type;

export const GameKeepGoingSteerInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type GameKeepGoingSteerInput = typeof GameKeepGoingSteerInput.Type;
export const GameKeepGoingSteerResult = Schema.Struct({
  pending: NonNegativeInt,
  message: Schema.String,
});
export type GameKeepGoingSteerResult = typeof GameKeepGoingSteerResult.Type;
