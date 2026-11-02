import type { GameRunStatusResult, ScopedThreadRef } from "@kurambit/contracts";
import { WorkflowIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";

// A string, so a status refetch with the same run re-renders nothing. The run's
// own role threads are listed so their chats do not get the notice.
const liveRunThreads = (result: AsyncResult.AsyncResult<GameRunStatusResult, unknown>) =>
  AsyncResult.isSuccess(result) && result.value.active
    ? ` ${result.value.threads.map((thread) => thread.threadId).join(" ")} `
    : null;

/**
 * While a production run works on the game, the creator's agent passes their
 * messages to the run (the game's AGENTS.md says so) instead of editing the
 * files the run is changing. This notice says that next to the composer; it
 * never reroutes what is sent. Pass `null` for threads that are not games.
 */
export function useGameRunComposerNotice(
  threadRef: ScopedThreadRef | null,
): ComposerBannerStackItem | null {
  const runThreads = useEnvironmentQuerySelector(
    threadRef === null
      ? null
      : gameEnvironment.runStatus({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    liveRunThreads,
  );
  if (runThreads === null || threadRef === null || runThreads.includes(` ${threadRef.threadId} `))
    return null;
  return {
    id: `game-run-live:${threadRef.threadId}`,
    variant: "info",
    priority: "notice",
    icon: <WorkflowIcon />,
    title: "A production run is live: messages go to its next round, not straight into the game.",
  };
}
