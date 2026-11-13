import type { GameBuild, GameBuildsResult, ScopedThreadRef } from "@kurambit/contracts";
import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";

import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { Skeleton } from "../ui/skeleton";
import { StatusDot } from "../ui/status-dot";
import { Text } from "../ui/text";
import { GameElapsed } from "./GameElapsed";
import { GamePicture } from "./GameBuildStill";
import { useBuildFrame } from "./gameStageBridge";
import { useTurnLanding } from "./useTurnLanding";
import { useKeepGoing } from "./useKeepGoing";
import { clockTime } from "./keepGoing.logic";
import type { GameKeepGoingStatus } from "@kurambit/contracts";

/** When Keep going's proposed next step starts, while it only waits for that time. */
const keepGoingStartsAt = (status: GameKeepGoingStatus | null | undefined): string | null =>
  status?.phase === "proposed" && status.proposal?.deadline != null
    ? clockTime(status.proposal.deadline)
    : null;
import { derivePhase } from "../../session-logic";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { buildName, doesNotStart } from "./gameBuilds.logic";
import { gameLibraryStatus, type GameLibraryStatus } from "./gameStatusLine.logic";
import type { GameLibraryEntry } from "./useGameLibrary";

/** The folder's build when the list names it, else the newest; null before any, undefined unread. */
const latestBuildOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (AsyncResult.isInitial(result)) return undefined;
  if (!AsyncResult.isSuccess(result)) return null;
  const { builds, current } = result.value;
  return builds.find((build) => build.id === current) ?? builds[0] ?? null;
};

/** The number the next person build takes: one past the newest numbered one. */
export const nextBuildOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return 1;
  const numbered = result.value.builds.find((each) => each.number !== null);
  return (numbered?.number ?? 0) + 1;
};

/**
 * The picture a game's library row shows: its latest build's, else the newest build that has
 * one, so a new build with no picture yet never turns the row back into a letter.
 */
const latestStillOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) => {
  if (!AsyncResult.isSuccess(result)) return null;
  const latest = latestBuildOf(result);
  return latest?.still ?? result.value.builds.find((build) => build.still !== null)?.still ?? null;
};

/**
 * A game's latest build, from the same first page of its Builds list the game
 * screen reads, so an open game and its library row share one read. Pass null
 * to read nothing (a row scrolled out of view).
 */
export function useGameLatestBuild(
  threadRef: ScopedThreadRef | null,
): GameBuild | null | undefined {
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
}): {
  readonly status: GameLibraryStatus;
  readonly build: GameBuild | null;
  /** The builds are still being read: the picture and the line wait rather than guess. */
  readonly pending: boolean;
} {
  const { game, main, chats } = input;
  const mainRef = input.read && main !== null ? scopeThreadRef(game.environmentId, main.id) : null;
  const build = useGameLatestBuild(mainRef);
  const nextBuild = useEnvironmentQuerySelector(
    mainRef === null
      ? null
      : gameEnvironment.builds({
          environmentId: mainRef.environmentId,
          input: { threadId: mainRef.threadId },
        }),
    nextBuildOf,
  );
  // Between a turn's end and its build being listed, as the game screen says it.
  const saving = useTurnLanding(mainRef, derivePhase(main?.runtime ?? null) === "running");
  // A game Keep going runs on reads its run, so a step that only waits shows no working dot.
  const keepGoing = useKeepGoing(game.run !== null ? mainRef : null);
  const status = gameLibraryStatus({
    chats:
      chats === "approval" || chats === "input" || chats === "failed"
        ? chats
        : chats === "working" || chats === "waiting"
          ? "working"
          : "other",
    keepGoing: game.run?.step ?? null,
    keepGoingStartsAt: keepGoingStartsAt(keepGoing.status),
    operationRunning: game.operation?.state === "running",
    saving,
    nextBuild: nextBuild ?? 1,
    build:
      build == null
        ? null
        : { name: buildName(build), at: build.at, doesNotStart: doesNotStart(build.facts) },
    // A game with no chat has no builds to read; any other waits for its read.
    known: main === null || build !== undefined,
  });
  return { status, build: build ?? null, pending: main !== null && build === undefined };
}

/** A game's one status line: a dot for live work or a failure, the words, then its time. */
export function GameLibraryStatusText({
  status,
  className,
}: {
  status: GameLibraryStatus;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {/* A dot only when it says something: live work, or a failure. Idle needs none. */}
      {status.tone === "pending" ? (
        // Not read yet: a quiet bar where the line goes, never a fact nobody checked.
        <Skeleton className="my-0.5 h-3 w-24" />
      ) : status.tone === "live" ? (
        <StatusDot tone="live" pulse />
      ) : status.tone === "failed" ? (
        <StatusDot tone="danger" />
      ) : null}
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

/**
 * A game's picture as the sidebar shows it: its latest build's still, a quiet well while the
 * builds are read, and the game's colour and initial when it has none.
 */
export function GameLibraryPicture(props: {
  readonly game: GameLibraryEntry;
  readonly main: Pick<SidebarThreadSummary, "id" | "latestRun" | "runtime"> | null;
  readonly chats: SidebarThreadStatus | null;
  readonly gameName: string;
  /** Size and placement; the picture's own rounding matches the sidebar's. */
  readonly className: string;
  /** False reads nothing (a row scrolled out of view). */
  readonly read?: boolean;
}) {
  const read = props.read !== false;
  const { build, pending } = useGameLibraryLine({
    game: props.game,
    main: props.main,
    chats: props.chats,
    read,
  });
  const still = useEnvironmentQuerySelector(
    props.main === null || !read
      ? null
      : gameEnvironment.builds({
          environmentId: props.game.environmentId,
          input: { threadId: props.main.id },
        }),
    latestStillOf,
  );
  // The Stage's frame of the latest build, once taken, as its card and the Inspector show.
  const frame = useBuildFrame(build?.id ?? null);
  if (pending) return <Skeleton shape="card" className={props.className} />;
  if (frame !== null)
    return (
      <span className={cn("relative block overflow-hidden rounded-md", props.className)}>
        <img src={frame} alt="" className="absolute inset-0 size-full object-cover" />
      </span>
    );
  return (
    <GamePicture
      environmentId={props.game.environmentId}
      root={props.game.root}
      path={still ?? props.game.keyArt}
      gameName={props.gameName}
      className={cn(props.className, "rounded-md")}
    />
  );
}
