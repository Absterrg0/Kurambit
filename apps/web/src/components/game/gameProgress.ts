import type { GameSummary } from "@kurambit/contracts";

export type GameProgressKind = "running" | "building" | "idle";

export interface GameProgress {
  readonly kind: GameProgressKind;
  /** Short text for a sidebar row or a library card badge. */
  readonly label: string;
  /** One sentence for a tooltip or aria description. */
  readonly detail: string;
}

/**
 * The library's status line. Live keep going wins: it is what the game is
 * doing for an hour or more, between turns too. Its line ("Keep going · step
 * 3") is the server's, and the server sends a run only while it is live: a
 * paused or finished one reads idle here and says why in its chat's banner.
 * A running operation comes next; otherwise the game is idle.
 */
export const gameProgress = (summary: Pick<GameSummary, "operation" | "run">): GameProgress => {
  if (summary.run !== null)
    return {
      kind: "running",
      label: summary.run.step,
      detail: `Keep going is working on this game: ${summary.run.step}.`,
    };
  const operation = summary.operation;
  if (operation?.state === "running")
    return {
      kind: "building",
      label: "Building",
      detail: `${operation.name} is running.`,
    };
  return {
    kind: "idle",
    label: "Idle",
    detail: "No operation is running for this game.",
  };
};
