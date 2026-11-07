import * as Schema from "effect/Schema";

/** Guided proposes each step and starts it after a minute; Autopilot starts it at once. */
export const GameRunProfile = Schema.Literals(["guided", "autopilot"]);
export type GameRunProfile = typeof GameRunProfile.Type;

/** Why a game-run command was refused; a tool hands the message back in-turn. */
export const GameRunRefusalReason = Schema.Literals([
  "no-run",
  "run-live",
  "run-ended",
  "not-resumable",
  "stale-run",
  "stale-step",
  "wrong-thread",
  "wrong-kind",
  "stale-attempt",
  "no-decision",
  "stale-decision",
  "invalid-answer",
  "not-due",
  /** The engine has no turn loop: keep going runs only where Kurambit plays every turn. */
  "no-turn-loop",
  /** The chat is archived or deleted. */
  "chat-unavailable",
]);
export type GameRunRefusalReason = typeof GameRunRefusalReason.Type;

/**
 * Why a run tool or RPC failed, typed for agents and the UI: the run's own
 * refusal, or what the transport found before the run was asked.
 */
export const GameRunErrorReason = Schema.Union([
  GameRunRefusalReason,
  Schema.Literals([
    "project-not-found",
    "no-live-run",
    "empty-note",
    "records-unreadable",
    "thread-read",
    "command-failed",
  ]),
]);
export type GameRunErrorReason = typeof GameRunErrorReason.Type;
