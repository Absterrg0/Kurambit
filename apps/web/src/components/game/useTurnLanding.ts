import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { useQuietThreadShell, useThreadCheckpointSummaries } from "../../state/entities";
import { turnBuild, turnsRead } from "../../state/game";

/**
 * Between a turn's end and its build being listed, the build is being saved: the Stage, the
 * strip, the top bar and the Inspector all say so, so nothing steps back to the build before or
 * says there is none. T3 holds a finished run at `waiting` (still active) until its checkpoint
 * commits, so once the turn is over its checkpoint is known; a ready one with changed files
 * lands until the builds list has read it, which then lists its build or shows it made none.
 */
export function useTurnLanding(threadRef: ScopedThreadRef | null, turnActive: boolean): boolean {
  const latestRun = useQuietThreadShell(threadRef)?.latestRun ?? null;
  const ended = latestRun !== null && !turnActive;
  const built =
    useAtomValue(turnBuild(ended ? threadRef : null, latestRun?.runId ?? null)) !== null;
  const checkpoints = useThreadCheckpointSummaries(threadRef);
  const checkpoint =
    latestRun === null ? undefined : checkpoints.find((entry) => entry.runId === latestRun.runId);
  const changed =
    ended &&
    checkpoint !== undefined &&
    checkpoint.status === "ready" &&
    checkpoint.files.length > 0;
  const read = useAtomValue(turnsRead(changed ? threadRef : null, checkpoint?.completedAt ?? null));
  // A list not loaded yet says nothing either way: a turn lands only once the list is in hand.
  return changed && !built && read === false;
}
