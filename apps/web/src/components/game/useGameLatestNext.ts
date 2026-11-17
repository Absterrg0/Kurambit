import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { ThreadId, type GameBuildsResult, type ScopedThreadRef } from "@kurambit/contracts";
import { readNextLine } from "@kurambit/shared/gameNextLine";
import { AsyncResult } from "effect/reactivity";

import { useThreadProjection } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";

/**
 * The build on the Stage, or the newest before it, that a chat's turn made, as its chat and run:
 * "threadId\0runId", a string so the selection compares by value.
 */
const latestTurnOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const { builds, current } = result.value;
  const from = Math.max(
    0,
    builds.findIndex((build) => build.id === current),
  );
  for (const build of builds.slice(from))
    if (build.source._tag === "turn") return `${build.source.threadId}\0${build.source.runId}`;
  return null;
};

/**
 * For a game chat with no messages yet (pass null otherwise): the reply that made the build on the
 * Stage, when it ends in a `Next:` line, so the empty chat's composer offers what the agent
 * suggested in whichever chat it was. Its chat is read only while this one is empty.
 */
export function useGameLatestNext(
  threadRef: ScopedThreadRef | null,
): { readonly key: string; readonly text: string } | null {
  const latest = useEnvironmentQuerySelector(
    threadRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    latestTurnOf,
  );
  const [sourceThread, runId] = latest == null ? [null, null] : latest.split("\0");
  const source = useThreadProjection(
    threadRef === null || sourceThread == null
      ? null
      : scopeThreadRef(threadRef.environmentId, ThreadId.make(sourceThread)),
  );
  if (source === null || sourceThread == null) return null;
  const reply = source.projection.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming && message.runId === runId,
  );
  return reply === undefined || readNextLine(reply.text) === null
    ? null
    : { key: `${sourceThread}:${reply.id}`, text: reply.text };
}
