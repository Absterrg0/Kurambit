import {
  GAME_BUILDS_EVENT,
  GAME_FACTS_EVENT,
  GAME_LIVE_EVENT,
  GAME_SAVED_MEDIA_EVENT,
  type GameOperationEvent,
} from "@kurambit/contracts";

/**
 * Which reads one game push changes: a run event changes the run's status
 * and pick, a saved/ change the Saved list, a builds push the Builds list, a
 * facts push a build's facts (and the list's chips), anything else (an
 * operation's start, progress or end) the game's status. Each query rereads
 * only on its own scopes, so a run step does not reread the stage's status
 * and an export does not reread the run.
 */
export type GameEventScope = "run" | "saved" | "builds" | "facts" | "live" | "operation";

export const gameEventScope = (event: GameOperationEvent): GameEventScope =>
  event.name === "run"
    ? "run"
    : event.name === GAME_SAVED_MEDIA_EVENT
      ? "saved"
      : event.name === GAME_BUILDS_EVENT
        ? "builds"
        : event.name === GAME_FACTS_EVENT
          ? "facts"
          : event.name === GAME_LIVE_EVENT
            ? "live"
            : "operation";
