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
import { GameRunProfile } from "./gameRunReasons.ts";
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

export const GameKeepGoingMode = Schema.Literals(["off", "guided", "autopilot"]);
export type GameKeepGoingMode = typeof GameKeepGoingMode.Type;

/**
 * Why the run chose a step, in the order it looks. "bot" is only on steps an
 * earlier Kurambit took: the play bot is now written once, as setup, outside
 * the steps (GameKeepGoingBotSetup).
 */
export const GameRunStepWhy = Schema.Literals([
  "steer",
  "blocker",
  "regression",
  "bot",
  "fact",
  "next",
]);
export type GameRunStepWhy = typeof GameRunStepWhy.Type;

export const GameKeepGoingInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  mode: GameKeepGoingMode,
  /** For a start or resume; null is no limit; omitted keeps the run's own (a new run: 60). */
  budgetMinutes: Schema.optionalKey(Schema.NullOr(PositiveInt)),
});
export type GameKeepGoingInput = typeof GameKeepGoingInput.Type;

export const GameKeepGoingStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameKeepGoingStatusInput = typeof GameKeepGoingStatusInput.Type;

export const GameKeepGoingPhase = Schema.Literals([
  /** look: a turn is running or queued on the game. */
  "waiting",
  /** look: reading the current build's facts. */
  "looking",
  /** Guided: a proposal with a deadline. */
  "proposed",
  /** Guided: a proposal the person is editing (no deadline). */
  "held",
  /** The step's turn is running. */
  "turn",
  /** judge */
  "measuring",
  /** undo */
  "undoing",
]);
export type GameKeepGoingPhase = typeof GameKeepGoingPhase.Type;

/**
 * The play bot keep going writes once per run, in a session of its own (a
 * subagent of the chat) so it never re-reads the game chat: the harness's
 * measuring instrument for the skilled fact, never a step.
 */
export const GameKeepGoingBotSetup = Schema.Struct({
  /** The setup's child thread (its last one, after a fix-up). */
  thread: ThreadId,
  state: Schema.Literals(["running", "written", "failed"]),
  /** Input + output of its sessions as the provider reported them; null when none was. */
  tokens: Schema.NullOr(Schema.Number),
  minutes: Schema.NullOr(Schema.Number),
  /** Why it failed, so keep going goes on without the skilled fact and says so; "" otherwise. */
  reason: Schema.String,
});
export type GameKeepGoingBotSetup = typeof GameKeepGoingBotSetup.Type;

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
  /** The run's last mode, kept while paused or ended (a resume sends it); null when the game never ran keep going. */
  profile: Schema.NullOr(GameRunProfile),
  phase: Schema.NullOr(GameKeepGoingPhase),
  step: Schema.NullOr(PositiveInt),
  proposal: Schema.NullOr(
    Schema.Struct({
      stepId: Schema.String,
      why: GameRunStepWhy,
      /** One line for the person, from the step's why and target. */
      summary: Schema.String,
      /** The agent's full prompt, shown on Edit. */
      text: Schema.String,
      /** Null while held. */
      deadline: Schema.NullOr(IsoDateTime),
    }),
  ),
  budgetMinutes: Schema.NullOr(PositiveInt),
  endsAt: Schema.NullOr(IsoDateTime),
  /** Newest first, at most 10: every push resends it. */
  steps: Schema.Array(GameKeepGoingStepRef).check(Schema.isMaxLength(10)),
  steer: Schema.Array(Schema.String),
  setAside: Schema.Array(Schema.Struct({ text: Schema.String, why: Schema.String })),
  /** Why it last stopped; null while live or never run. */
  ending: Schema.NullOr(GameRunEnding),
  resumable: Schema.Boolean,
  /** Why keep going cannot run on this game or chat ("Keep going needs an engine…", "Keep going is on in <chat>"); null when it can. */
  blocked: Schema.NullOr(Schema.String),
  /** The one plain line the control, the banner and the tool show. */
  message: Schema.String,
  /** The run's play bot setup; absent when it needed none. */
  botSetup: Schema.optionalKey(GameKeepGoingBotSetup),
});
export type GameKeepGoingStatus = typeof GameKeepGoingStatus.Type;

export const GameKeepGoingDecideInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  stepId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  answer: Schema.Literals(["start", "skip", "hold"]),
});
export type GameKeepGoingDecideInput = typeof GameKeepGoingDecideInput.Type;
export const GameKeepGoingDecideResult = Schema.Struct({ message: Schema.String });
export type GameKeepGoingDecideResult = typeof GameKeepGoingDecideResult.Type;

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
