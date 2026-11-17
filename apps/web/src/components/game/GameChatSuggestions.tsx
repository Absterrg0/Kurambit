import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { ThreadId, type GameBuildsResult, type ScopedThreadRef } from "@kurambit/contracts";
import { gameNextLine } from "@kurambit/shared/gameNextLine";
import { AsyncResult } from "effect/reactivity";

import { useThreadProjection } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { Button } from "../ui/button";

const MAX_CHIPS = 3;

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
 * Under an empty chat's composer, what the agent last suggested for the game: the `Next:` line of
 * the reply that made the build on the Stage, and of the replies just before it with no message
 * from the person between (keep going's steps), at most three. A suggestion the person answered
 * with a message of their own is spent. Nothing when the agent suggested nothing.
 */
export function GameChatSuggestions({
  threadRef,
  onPick,
}: {
  threadRef: ScopedThreadRef;
  onPick: (text: string) => void;
}) {
  const latest = useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    latestTurnOf,
  );
  const [sourceThread, runId] = latest == null ? [null, null] : latest.split("\0");
  const source = useThreadProjection(
    sourceThread == null
      ? null
      : scopeThreadRef(threadRef.environmentId, ThreadId.make(sourceThread)),
  );
  if (source === null) return null;
  const messages = source.projection.messages;
  const made = messages.findLastIndex(
    (message) => message.role === "assistant" && message.runId === runId,
  );
  const chips: string[] = [];
  for (let i = made; i >= 0 && chips.length < MAX_CHIPS; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role === "user") break;
    if (message.role !== "assistant" || message.streaming) continue;
    const next = gameNextLine(message.text);
    if (next !== null && !chips.includes(next)) chips.push(next);
  }
  if (chips.length === 0) return null;
  return (
    <div className="pointer-events-auto flex flex-wrap gap-2" data-game-chat-suggestions="">
      {chips.map((text) => (
        <Button
          key={text}
          size="sm"
          variant="outline"
          className="max-w-full min-w-0"
          onClick={() => onPick(text)}
        >
          <span className="truncate">{text}</span>
        </Button>
      ))}
    </div>
  );
}
