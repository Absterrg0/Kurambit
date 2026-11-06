import { GAME_SAVED_MEDIA_EVENT, type GameOperationEvent } from "@kurambit/contracts";

/**
 * Which reads one game push changes: a run event changes the run's status
 * and pick, a saved/ change the Saved list, anything else (an operation's
 * start, progress or end) the game's status. Each query rereads only on its
 * own scope, so a run step does not reread the stage's status and an export
 * does not reread the run.
 */
export type GameEventScope = "run" | "saved" | "operation";

export const gameEventScope = (event: GameOperationEvent): GameEventScope =>
  event.name === "run" ? "run" : event.name === GAME_SAVED_MEDIA_EVENT ? "saved" : "operation";
