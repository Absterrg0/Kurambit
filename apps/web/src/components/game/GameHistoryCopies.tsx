import type { GameCopy, GameCopyState, ScopedThreadRef } from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";

import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { GameBuildStill } from "./GameBuildStill";
import { checkingStep, useGameCopies } from "./useGameCopies";

/** A copy's state in a few words. */
const stateWords = (state: GameCopyState): string => {
  switch (state._tag) {
    case "working":
      return "working";
    case "checking":
      return `checking ${checkingStep(state) ?? ""}`.trim();
    case "ready":
      return "ready to bring in";
    case "same":
      return "nothing new";
    case "conflicts":
      return `${state.files.length} file${state.files.length === 1 ? "" : "s"} conflict${state.files.length === 1 ? "s" : ""}`;
    case "held":
      return "not brought in";
  }
};

/** Waiting on the person: the same amber mark the sidebar gives a chat that waits. */
const waitsForYou = (state: GameCopyState) => state._tag === "conflicts" || state._tag === "held";

/**
 * History's top section once the game has copies: each copy as a row, its chat's name, how many
 * builds it has that the game does not, its state, and those builds as small pictures. A row
 * opens its chat. A try's versions are left to their own group below.
 */
export function GameHistoryCopies({
  threadRef,
  gameName,
  hide,
  onOpenChat,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  /** Chats shown elsewhere in History: a try's versions. */
  hide: ReadonlySet<string>;
  onOpenChat?: () => void;
}) {
  const { copies } = useGameCopies(threadRef);
  const shown = copies.filter((copy) => !hide.has(copy.threadId));
  if (shown.length === 0) return null;
  return (
    <section
      aria-label="Not in the game yet"
      className="flex min-w-0 flex-col gap-2"
      data-game-history-copies=""
    >
      <Text variant="caption" tone="muted">
        Not in the game yet
      </Text>
      <ul className="flex min-w-0 flex-col gap-1">
        {shown.map((copy) => (
          <CopyRow
            key={copy.threadId}
            threadRef={threadRef}
            gameName={gameName}
            copy={copy}
            onOpenChat={onOpenChat}
          />
        ))}
      </ul>
    </section>
  );
}

function CopyRow({
  threadRef,
  gameName,
  copy,
  onOpenChat,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  copy: GameCopy;
  onOpenChat?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const copyRef = { environmentId: threadRef.environmentId, threadId: copy.threadId };
  const count = copy.place.builds;
  // Its own rail's newest builds are the ones not in the game.
  const builds = useEnvironmentQuery(
    count === 0
      ? null
      : gameEnvironment.builds({
          environmentId: copyRef.environmentId,
          input: { threadId: copy.threadId },
        }),
  )
    .data?.builds.filter(
      (build) => build.source._tag === "turn" && build.source.threadId === copy.threadId,
    )
    .slice(0, Math.min(count, 4));
  const here = copy.threadId === threadRef.threadId;
  return (
    <li>
      <button
        type="button"
        aria-current={here ? "true" : undefined}
        onClick={() => {
          onOpenChat?.();
          if (!here)
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: copyRef.environmentId, threadId: copyRef.threadId },
            });
        }}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <CopyIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <Text variant="label" truncate>
            {copy.title}
          </Text>
          <Text
            variant="caption"
            tone="muted"
            numeric
            truncate
            render={<span className="flex items-center gap-1.5" />}
          >
            {waitsForYou(copy.place.state) ? <StatusDot tone="warning" size="sm" /> : null}
            {`${count === 0 ? "No builds" : `${count} build${count === 1 ? "" : "s"}`} · ${stateWords(copy.place.state)}`}
          </Text>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {(builds ?? []).toReversed().map((build) => (
            <GameBuildStill
              key={build.id}
              threadRef={copyRef}
              gameName={gameName}
              build={build}
              title={build.name}
              mark="blank"
              className="h-6.75 w-12 rounded-sm"
            />
          ))}
        </span>
      </button>
    </li>
  );
}
