import type { ScopedThreadRef } from "@kurambit/contracts";

import { useQuietThreadShell } from "../state/entities";

/**
 * Who may act on a game from this thread's view. A production run's role
 * thread is the run's own hand: a person looking at its chat sees the game and
 * may play an existing build, but never writes beside the run (Rebuild,
 * Export, Stop game, packaging). The server refuses those too; this keeps the
 * stage, the Builds panel and the palette from offering them.
 */
export type GameStageAccess = "writer" | "run-role";

export function useGameStageAccess(threadRef: ScopedThreadRef | null): GameStageAccess {
  const shell = useQuietThreadShell(threadRef);
  return shell?.lineage.relationshipToParent === "role" ? "run-role" : "writer";
}
