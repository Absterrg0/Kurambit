import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { FastForwardIcon, GitCompareIcon, TriangleAlertIcon } from "lucide-react";
import type {
  GameBuild,
  GameBuildId,
  GameBuildRef,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";

import type { GameStageRequest } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill, GameNowPicture } from "./GameBuildStill";
import { GameReel } from "./GameReel";
import { useStageStill } from "./gameStageBridge";
import {
  buildCaption,
  buildName,
  checksLine,
  doesNotStart,
  factsSettled,
  formatBuildTime,
  passDelta,
} from "./gameBuilds.logic";
import { isUndone, stageBuildId, stepMark, timelineMarks } from "./gameBuildTimeline.logic";

/** How many older pages an "Open build" reads to find its build before it says so. */
const SEEK_PAGES = 10;

const sameRef = (ref: GameBuildRef, build: GameBuild) =>
  ref._tag === "build"
    ? ref.build === build.id
    : build.source._tag === "turn" &&
      build.source.threadId === ref.threadId &&
      build.source.runId === ref.runId;

/** The requests the history answers itself: play or open a build, step, start picking a compare. */
export type GameStripRequest = {
  readonly request: Extract<GameStageRequest, { kind: "play" | "detail" | "step" | "compare" }>;
  readonly n: number;
};

/** The build being made, as the history's top row shows it. */
export interface GameBuildSlot {
  /** What it says while it is made ("Making build 3"). */
  readonly label: string;
  /** Its name, as its row will be named once it lands ("Build 3"). */
  readonly name: string;
  /** What was asked for, when known. */
  readonly caption: string | null;
  /** Keep going is making it. */
  readonly keepGoing: boolean;
  /** The turn has ended and the build is being saved, a moment before its row replaces this. */
  readonly saving?: boolean;
}

/**
 * The game's builds as a history, newest first, the way a developer reads commits: each its
 * name, how its checks moved, what was asked for and when, with the one on the Stage marked.
 * A row plays its build and shows it in the Build tab; Compare picks two rows.
 */
export function GameBuildHistory({
  threadRef,
  gameName,
  playing,
  slot,
  request,
  reelOpen,
  onPlay,
  onPlayUnlisted,
  onLive,
  onCompare,
  onInspect,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  /** The build the Stage plays from a copy, if any. */
  playing: GameBuildId | null;
  slot: GameBuildSlot | null;
  request: GameStripRequest | null;
  reelOpen: boolean;
  /** Plays an earlier build from a copy. */
  onPlay: (build: GameBuild) => void;
  /** A build the loaded pages do not hold (an old round's row). */
  onPlayUnlisted: (ref: GameBuildRef) => void;
  /** Back to the folder's own game. */
  onLive: () => void;
  onCompare: (pair: readonly [GameBuildRef, GameBuildRef]) => void;
  /** Shows a build in the Build tab. */
  onInspect: (build: GameBuild) => void;
}) {
  const still = useStageStill(scopedThreadKey(threadRef));
  const first = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [olderCount, setOlderCount] = useState(0);
  const olderPages = useAtomValue(olderBuildPages(threadRef, olderCount));
  // The first side of a compare waiting for the row that picks the second.
  const [picking, setPicking] = useState<GameBuildRef | "any" | null>(null);
  // A build asked for by ref that no loaded page holds: pages back until it does.
  const [sought, setSought] = useState<GameBuildRef | null>(null);
  const [notFound, setNotFound] = useState(false);
  // The row a step from the keys or the palette last landed on; null is the newest.
  const [stepped, setStepped] = useState<GameBuildId | "now" | null>(null);
  // A request made before the history mounted was answered, or was for another one.
  const [mountRequest] = useState(request?.n ?? 0);
  const list = first.data;
  const seen = new Set<string>();
  const loaded: Array<GameBuild> = [];
  for (const build of [
    ...(list?.builds ?? []),
    ...olderPages.flatMap((page) => (AsyncResult.isSuccess(page) ? page.value.builds : [])),
  ])
    if (!seen.has(build.id)) {
      seen.add(build.id);
      loaded.push(build);
    }
  // Oldest first, as stepping reads them; shown newest first.
  const marks = timelineMarks(loaded, list?.current ?? null);
  const order = marks.map((build) => build.id);
  const lastPage = olderPages.at(-1);
  const olderNext =
    olderCount === 0
      ? (list?.next ?? null)
      : lastPage !== undefined && AsyncResult.isSuccess(lastPage)
        ? lastPage.value.next
        : null;
  // An older turn's "Open build": read pages back until it is a row, then show it.
  if (sought !== null) {
    const found = marks.find((entry) => sameRef(sought, entry));
    const waiting = lastPage !== undefined && !AsyncResult.isSuccess(lastPage);
    if (found !== undefined) {
      setSought(null);
      onInspect(found);
    } else if (list !== null && !waiting) {
      if (olderNext !== null && olderCount < SEEK_PAGES) setOlderCount(olderCount + 1);
      else {
        setSought(null);
        setNotFound(true);
      }
    }
  }

  // A compare with one possible other side needs no pick: it opens at once.
  const startCompare = (start: GameBuildRef | "any") => {
    const others = marks.filter(
      (entry) => entry.available && (start === "any" || !sameRef(start, entry)),
    );
    const only =
      start === "any" ? (others.length === 2 ? others : null) : others.length === 1 ? others : null;
    if (only === null) setPicking(start);
    else if (start === "any") onCompare([refOf(only[0]!), refOf(only[1]!)]);
    else onCompare([start, refOf(only[0]!)]);
  };
  const pick = (build: GameBuild) => {
    if (picking === "any") setPicking(refOf(build));
    else if (picking !== null && !sameRef(picking, build)) {
      onCompare([picking, refOf(build)]);
      setPicking(null);
    }
  };
  const play = (build: GameBuild) => {
    setStepped(build.id);
    onInspect(build);
    // The folder already is this build: its own game shows it, never a copy
    // (unless the list knows the folder was edited since).
    if (list !== null && list.current === build.id && list.folderEdited !== true) onLive();
    else onPlay(build);
  };
  // Answered after the render that received it: playing reaches the Stage's own state.
  const answer = useStableCallback((asked: GameStripRequest["request"]) => {
    if (asked.kind === "step") {
      const to = stepMark(order, stepped ?? playing, asked.by);
      const build = marks.find((entry) => entry.id === to);
      if (build === undefined) {
        setStepped("now");
        onLive();
      } else play(build);
    } else if (asked.kind === "play") {
      const build = marks.find((entry) => sameRef(asked.build, entry));
      if (build === undefined) onPlayUnlisted(asked.build);
      else play(build);
    } else if (asked.kind === "detail") {
      const build = marks.find((entry) => sameRef(asked.build, entry));
      if (build !== undefined) onInspect(build);
      else {
        setSought(asked.build);
        setNotFound(false);
      }
    } else
      startCompare(asked.first ?? (playing !== null ? { _tag: "build", build: playing } : "any"));
  });
  const requestN = request?.n ?? 0;
  const asked = request?.request ?? null;
  useEffect(() => {
    if (asked !== null && requestN !== mountRequest) answer(asked);
  }, [requestN, asked, mountRequest, answer]);

  // Escape gives a pick up.
  const firstPicked =
    picking === null || picking === "any"
      ? null
      : (marks.find((entry) => sameRef(picking, entry)) ?? null);
  const pickingNow = picking !== null;
  useEffect(() => {
    if (!pickingNow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickingNow]);

  // The build on the Stage: the copy it plays, else the build the folder holds.
  const onStage = stageBuildId(list, playing);
  const showNow =
    slot === null && list !== null && (list.folderEdited === true || playing !== null);
  return (
    <section aria-label="Builds" className="flex min-w-0 flex-col gap-1">
      {reelOpen ? (
        <GameReel
          threadRef={threadRef}
          marks={marks}
          onPlay={play}
          onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
        />
      ) : null}
      <div className="flex h-8 min-w-0 items-center gap-2 px-2">
        {picking !== null ? (
          <>
            <GitCompareIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Text variant="meta" tone="strong" render={<span className="min-w-0 flex-1" />}>
              {firstPicked === null
                ? "Pick the first build to compare"
                : `Pick a build to compare with ${buildName(firstPicked)}`}
            </Text>
            <Button size="xs" variant="ghost" onClick={() => setPicking(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Text variant="meta" tone="strong" emphasis render={<h3 className="flex-1" />}>
              Builds
            </Text>
            {marks.length < 2 ? null : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  startCompare(onStage === null ? "any" : { _tag: "build", build: onStage })
                }
              >
                <GitCompareIcon aria-hidden="true" />
                Compare
              </Button>
            )}
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        {slot === null ? null : <SlotRow slot={slot} />}
        {showNow && list !== null ? (
          <NowRow
            threadRef={threadRef}
            gameName={gameName}
            list={list}
            still={still}
            active={onStage === null}
            picking={picking !== null}
            onClick={onLive}
          />
        ) : null}
        {list === null ? (
          first.error !== null ? (
            <Text variant="caption" tone="muted" render={<p className="px-2 py-4" />}>
              {first.error}
            </Text>
          ) : (
            [0, 1, 2].map((n) => (
              <div key={n} className="flex items-center gap-3 px-2 py-1.5">
                <Skeleton shape="card" className="h-9 w-16" />
                <Skeleton className="h-3 w-40" />
              </div>
            ))
          )
        ) : marks.length === 0 && slot === null ? (
          <Row
            picture={
              <GameNowPicture
                still={still}
                gameName={gameName}
                fallback={null}
                threadRef={null}
                className="h-9 w-16 rounded"
              />
            }
            name="Now"
            strong
            meta="The game so far, before its first build"
          />
        ) : null}
        {marks.toReversed().map((build) => {
          const index = marks.indexOf(build);
          return (
            <BuildRow
              key={build.id}
              threadRef={threadRef}
              gameName={gameName}
              build={build}
              previous={index > 0 ? (marks[index - 1] ?? null) : null}
              onStage={onStage === build.id}
              copy={playing === build.id}
              undone={list !== null && isUndone(build, list)}
              picking={picking !== null}
              picked={picking !== null && picking !== "any" && sameRef(picking, build)}
              onClick={() => (picking !== null ? pick(build) : play(build))}
            />
          );
        })}
      </div>
      {olderNext !== null || sought !== null || notFound ? (
        <div className="flex items-center gap-2 px-2 pt-1">
          {sought !== null ? (
            <Text variant="caption" tone="muted">
              Finding that build…
            </Text>
          ) : notFound ? (
            <Text variant="caption" tone="muted">
              That build is older than the history reads.
            </Text>
          ) : null}
          <span className="flex-1" />
          {olderNext !== null ? (
            <Button size="xs" variant="ghost" onClick={() => setOlderCount(olderCount + 1)}>
              Older builds
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One history row's shape: a small picture, its name and state over one line of what it is. */
function Row({
  picture,
  name,
  strong = false,
  state = null,
  time = null,
  meta,
  current = false,
  disabled = false,
  dim = false,
  title,
  label,
  onClick,
}: {
  picture: ReactNode;
  name: ReactNode;
  strong?: boolean;
  state?: ReactNode;
  time?: string | null;
  meta: ReactNode;
  current?: boolean;
  disabled?: boolean;
  dim?: boolean;
  title?: string;
  label?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      {picture}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Text variant="meta" tone={strong ? "strong" : "default"} emphasis={strong} truncate>
            {name}
          </Text>
          {current ? (
            <Text variant="caption" tone="inherit" render={<span className="text-live" />}>
              On the Stage
            </Text>
          ) : null}
          <span className="flex-1" />
          {state === null ? null : (
            <Text variant="caption" tone="muted" numeric render={<span className="flex" />}>
              {state}
            </Text>
          )}
          {time === null ? null : (
            <Text variant="caption" tone="muted" numeric>
              {time}
            </Text>
          )}
        </span>
        <Text variant="caption" tone="muted" truncate>
          {meta}
        </Text>
      </span>
    </>
  );
  const shape = cn(
    "flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none",
    dim && "opacity-45",
  );
  if (onClick === undefined) return <div className={shape}>{body}</div>;
  const buttonProps = {
    type: "button" as const,
    "aria-current": current ? ("true" as const) : undefined,
    "aria-label": label,
    disabled,
    onClick,
    className: cn(
      shape,
      "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default",
      current && "bg-accent/60",
    ),
  };
  if (title === undefined) return <button {...buttonProps}>{body}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{body}</TooltipTrigger>
      {/* Beside the list, never over the game: the whole request and how it measured. */}
      <TooltipPopup side="left" align="start" className="max-w-sm">
        {title}
      </TooltipPopup>
    </Tooltip>
  );
}

function BuildRow({
  threadRef,
  gameName,
  build,
  previous,
  onStage,
  copy,
  undone,
  picking,
  picked,
  onClick,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  /** The build before it, which its checks are read against. */
  previous: GameBuild | null;
  onStage: boolean;
  /** It plays on the Stage from a copy, not the folder. */
  copy: boolean;
  undone: boolean;
  picking: boolean;
  /** The first side of a compare. */
  picked: boolean;
  onClick: () => void;
}) {
  const step = build.source._tag === "turn" ? build.source.step : null;
  const caption = buildCaption(build);
  const saved = build.source._tag === "saved";
  // A restore's parked folder has no number: its caption says what it is.
  const name = saved && build.number === null ? caption : buildName(build);
  const files = build.fileCount ?? build.files.length;
  // A saved build's caption is its name; what it touched says what it is.
  const meta = saved
    ? files === 0
      ? "No file changed"
      : build.files.map((file) => file.path.split("/").at(-1)).join(", ")
    : caption;
  return (
    <Row
      picture={
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          title={buildName(build)}
          mark="initial"
          className={cn("h-9 w-16 shrink-0 rounded", undone && "opacity-50 saturate-50")}
        >
          {picked ? (
            <Text
              variant="micro"
              tone="inherit"
              numeric
              render={
                <span className="absolute top-1 left-1 z-20 flex size-4 items-center justify-center rounded-full bg-strong-foreground text-background" />
              }
            >
              1
            </Text>
          ) : null}
        </GameBuildStill>
      }
      name={
        <span className={cn("flex items-center gap-1", undone && "line-through")}>
          {step === null ? null : <FastForwardIcon className="size-3" aria-hidden="true" />}
          {name}
        </span>
      }
      strong={onStage}
      current={onStage && !picking}
      state={undone ? "Undone" : copy ? "Playing" : checkDelta(build, previous)}
      time={formatBuildTime(build.at)}
      meta={meta}
      disabled={!build.available && !picking}
      dim={!build.available}
      title={`${caption}${checksLine(build.facts) === "" ? "" : ` · ${checksLine(build.facts)}`}`}
      label={`${buildName(build)}, ${formatBuildTime(build.at)}${onStage ? ", on the Stage" : ""}`}
      onClick={onClick}
    />
  );
}

/**
 * What changed in the checks since the build before: while it is measured it says only that;
 * a build with something to look at says so; one that only repeats the count before says nothing.
 */
function checkDelta(build: GameBuild, previous: GameBuild | null): ReactNode {
  const state = build.facts.state;
  if (state === "queued" || state === "measuring")
    return (
      <span className="flex shrink-0 items-center gap-1" aria-label="Being measured">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
        Measuring
      </span>
    );
  if (!factsSettled(build.facts)) return null;
  if (doesNotStart(build.facts))
    return (
      <span className="flex shrink-0 items-center gap-1 text-destructive-foreground">
        <TriangleAlertIcon aria-hidden="true" className="size-3 text-destructive" />
        Does not start
      </span>
    );
  const bad = build.facts.bad;
  const gained = passDelta(build, previous) ?? 0;
  if (bad > 0)
    return (
      <span className="flex shrink-0 items-center gap-1 text-warning-foreground">
        <TriangleAlertIcon aria-hidden="true" className="size-3 text-warning" />
        {bad} to look at
      </span>
    );
  if (gained === 0) return null;
  return (
    <span
      className={gained > 0 ? "text-success-foreground" : "text-warning-foreground"}
      aria-label={`${Math.abs(gained)} ${gained > 0 ? "more" : "fewer"} checks pass`}
    >
      {gained > 0 ? `+${gained}` : `−${Math.abs(gained)}`} pass
    </span>
  );
}

/** The build being made: its name and the working dot, over what was asked. */
function SlotRow({ slot }: { slot: GameBuildSlot }) {
  return (
    <Row
      picture={
        <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded border border-dashed border-foreground/30">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
        </span>
      }
      name={slot.name}
      state={slot.label}
      meta={slot.caption ?? ""}
    />
  );
}

/** The game folder when it is no build: edited since, or another build plays from a copy. */
function NowRow({
  threadRef,
  gameName,
  list,
  still,
  active,
  picking,
  onClick,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  list: GameBuildsResult;
  still: string | null;
  active: boolean;
  /** Now is no build, so a compare cannot pick it. */
  picking: boolean;
  onClick: () => void;
}) {
  const current = list.builds.find((build) => build.id === list.current) ?? null;
  const changed = list.folderEdited === true;
  return (
    <Row
      picture={
        <GameNowPicture
          still={still}
          gameName={gameName}
          fallback={changed ? current : null}
          threadRef={threadRef}
          className="h-9 w-16 shrink-0 rounded"
        />
      }
      name="Now"
      strong={active}
      current={active}
      state={changed ? "Not measured" : null}
      meta={
        changed
          ? `Changed since ${current === null ? "the last build" : buildName(current)}`
          : "The current game"
      }
      disabled={picking}
      dim={picking}
      label={changed ? "Now: changed since the last build, not measured" : "Now: the current game"}
      onClick={onClick}
    />
  );
}
