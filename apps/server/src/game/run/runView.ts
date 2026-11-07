// How a run reads to people and tools. Phase 3's run core (builder R)
// rewrites this with the keep-going status, the step line and the stop wording
// of design §4.3 and §7.2.
import type { GameRun } from "@kurambit/contracts";

/** Why a run made by an earlier Kurambit is never continued (design §6.4). */
export const STAGE_ERA_SENTENCE =
  "This run was made by an earlier Kurambit whose stages (vision, prototypes, plan) no longer exist. Its builds stay on the timeline. Keep going starts from the game as it is now.";

/** What a live run is doing, in one line for the game's card. */
export const stepLine = (run: GameRun): string =>
  run.loop === "turns" ? "Keep going" : "Stopping: made by an earlier Kurambit";
