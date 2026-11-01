import type { GameSummary } from "@t3tools/contracts";

export type GameProgressKind = "building" | "idle";

export interface GameProgress {
  readonly kind: GameProgressKind;
  /** Short text for a sidebar row or a library card badge. */
  readonly label: string;
  /** One sentence for a tooltip or aria description. */
  readonly detail: string;
}

/**
 * The library's status line. A running operation wins over everything else
 * because it is what the game is doing right now; otherwise the game is idle.
 */
export const gameProgress = (summary: Pick<GameSummary, "operation">): GameProgress => {
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
