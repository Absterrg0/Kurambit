import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@kurambit/contracts";

import { useQuietThreadShell, useThreadCheckpointSummaries } from "../../state/entities";
import { turnBuild } from "../../state/game";

/** How long a turn's build may take to be listed before nothing says it is being saved. */
const LANDING_CAP_MS = 30_000;

/**
 * Between a turn's end and its build being listed, the build is being saved: the Stage, the
 * strip, the top bar and the Inspector all say so, so nothing steps back to the build before or
 * says there is none. The turn's checkpoint settles it: one with no changed files makes no
 * build. Capped, so a save that never reports cannot hold the screen for ever.
 */
export function useTurnLanding(threadRef: ScopedThreadRef | null, turnActive: boolean): boolean {
  const latestRun = useQuietThreadShell(threadRef)?.latestRun ?? null;
  const built =
    useAtomValue(
      turnBuild(latestRun !== null && !turnActive ? threadRef : null, latestRun?.runId ?? null),
    ) !== null;
  const checkpoints = useThreadCheckpointSummaries(threadRef);
  const checkpoint =
    latestRun === null ? undefined : checkpoints.find((entry) => entry.runId === latestRun.runId);
  const buildComing =
    checkpoint === undefined || (checkpoint.status === "ready" && checkpoint.files.length > 0);
  const completedAt = latestRun?.completedAt == null ? null : Date.parse(latestRun.completedAt);
  // The moment last checked against the cap; a timeout moves it on when the cap passes.
  const [now, setNow] = useState(() => Date.now());
  const landing =
    !turnActive &&
    completedAt !== null &&
    !built &&
    buildComing &&
    now - completedAt < LANDING_CAP_MS;
  useEffect(() => {
    if (!landing || completedAt === null) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, completedAt + LANDING_CAP_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [landing, completedAt]);
  return landing;
}
