import type { GameBuild, GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";
import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";

import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { Text } from "../ui/text";
import { GameElapsed } from "./GameElapsed";
import type { SidebarThreadSummary } from "../../types";
import { resolveWorkingStartedAt, type SidebarThreadStatus } from "../Sidebar.logic";
import { buildName } from "./gameBuilds.logic";
import { gameLibraryStatus, type GameLibraryStatus } from "./gameStatusLine.logic";
import type { GameLibraryEntry } from "./useGameLibrary";

/** The folder's build when the list names it, else the newest; null before any. */
const latestBuildOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const { builds, current } = result.value;
  return builds.find((build) => build.id === current) ?? builds[0] ?? null;
};

/**
 * A game's latest build, from the same first page of its Builds list the game
 * screen reads, so an open game and its library row share one read. Pass null
 * to read nothing (a row scrolled out of view).
 */
function useGameLatestBuild(threadRef: ScopedThreadRef | null): GameBuild | null {
  return useEnvironmentQuerySelector(
    threadRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    latestBuildOf,
  );
}

/**
 * A game's library line and latest build, for its sidebar row and Home card.
 * `read` false reads no builds (a row out of view) and keeps the rest.
 */
export function useGameLibraryLine(input: {
  readonly game: GameLibraryEntry;
  /** The chat the game opens on; its turn times the elapsed clock. */
  readonly main: Pick<SidebarThreadSummary, "id" | "latestRun" | "runtime"> | null;
  /** The most urgent state of the game's chats (resolveGameSidebarStatus). */
  readonly chats: SidebarThreadStatus | null;
  readonly read: boolean;
}): { readonly status: GameLibraryStatus; readonly build: GameBuild | null } {
  const { game, main, chats } = input;
  const build = useGameLatestBuild(
    input.read && main !== null ? scopeThreadRef(game.environmentId, main.id) : null,
  );
  const status = gameLibraryStatus({
    chats:
      chats === "approval" || chats === "input" || chats === "failed"
        ? chats
        : chats === "working" || chats === "waiting"
          ? "working"
          : "other",
    turnStartedAt: main === null ? null : resolveWorkingStartedAt(main),
    keepGoing: game.run?.step ?? null,
    operationRunning: game.operation?.state === "running",
    build: build === null ? null : { name: buildName(build), at: build.at },
  });
  return { status, build };
}

/** A game's one status line: a dot for live work, the words, then its time. */
export function GameLibraryStatusText({
  status,
  className,
}: {
  status: GameLibraryStatus;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status.tone === "live"
            ? "bg-primary"
            : status.tone === "failed"
              ? "bg-destructive"
              : "bg-dim-foreground",
        )}
      />
      <Text variant="meta" tone={status.tone === "live" ? "default" : "muted"} truncate>
        {status.text}
        {status.at === null ? null : (
          <>
            {" · "}
            <ShortRelativeTime timestamp={status.at} />
          </>
        )}
      </Text>
      {status.since === null ? null : (
        <Text variant="meta" tone="muted" numeric>
          <GameElapsed since={Date.parse(status.since)} prefix="· " />
        </Text>
      )}
    </span>
  );
}

/** "2m", "3d", "now": a library line has no room for "ago". */
function ShortRelativeTime({ timestamp }: { timestamp: string }) {
  const relative = useRelativeTimeState(timestamp);
  if (relative.status !== "relative") return null;
  return relative.suffix === null ? "now" : relative.value;
}
