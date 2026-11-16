import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import {
  ChevronRightIcon,
  FastForwardIcon,
  GitCompareIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import type {
  GameBuild,
  GameBuildId,
  GameBuildRef,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";

import type { GameStageRequest } from "../../gameWorkspaceStore";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { cn, randomUUID } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { Tooltip, TooltipLabel, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

/** The requests the strip answers itself: play or open a build, step, start picking a compare. */
export type GameStripRequest = {
  readonly request: Extract<GameStageRequest, { kind: "play" | "detail" | "step" | "compare" }>;
  readonly n: number;
};

/** The build being made, as the strip's last picture shows it. */
export interface GameBuildSlot {
  /** What it says while it is made ("Making build 3"). */
  readonly label: string;
  /** Its name, as its picture will be named once it lands ("Build 3"). */
  readonly name: string;
  /** What was asked for, when known. */
  readonly caption: string | null;
  /** Keep going is making it. */
  readonly keepGoing: boolean;
  /** The turn has ended and the build is being saved, a moment before its picture replaces this. */
  readonly saving?: boolean;
}

/** Undo and Redo as the Stage resolves them: whether each is open, and what it says it does. */
export interface GameStripUndo {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string;
  readonly redoLabel: string;
  readonly undoDetail: string | null;
  readonly undoKey: string | null;
  readonly redoKey: string | null;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

/** A place in the strip: one build, or the versions one "try it N ways" message made. */
type StripItem =
  | { readonly kind: "build"; readonly build: GameBuild }
  | {
      readonly kind: "try";
      readonly runId: string;
      readonly request: string;
      readonly builds: ReadonlyArray<GameBuild>;
    };

/** The builds oldest first, a try's versions together under their request. */
const stripItems = (marks: ReadonlyArray<GameBuild>): ReadonlyArray<StripItem> => {
  const items: Array<StripItem> = [];
  for (const build of marks) {
    const source = build.source;
    const last = items.at(-1);
    if (source._tag !== "version") items.push({ kind: "build", build });
    else if (last?.kind === "try" && last.runId === source.runId)
      items[items.length - 1] = { ...last, builds: [...last.builds, build] };
    else items.push({ kind: "try", runId: source.runId, request: source.request, builds: [build] });
  }
  return items;
};

/** A build's short name under its picture; its tooltip has the whole one. */
const shortName = (build: GameBuild) => {
  const source = build.source;
  if (source._tag === "version") return `Version ${source.n}`;
  if (build.number === null) return buildName(build);
  return `Build ${build.number}`;
};

/**
 * The game's builds as a strip under the Stage's controls: small pictures in time order with the
 * one on the Stage marked, a try's versions grouped under what was asked with Keep, Undo and Redo,
 * and Compare any two. Folded, it is one line. A picture plays its build and shows it in Checks.
 * It is the one place the history lives: the chat's cards, the palette and the keys reach it
 * through the Stage's requests.
 */
export function GameBuildStrip({
  threadRef,
  gameName,
  playing,
  slot,
  request,
  reelOpen,
  undo,
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
  undo: GameStripUndo;
  /** Plays an earlier build from a copy. */
  onPlay: (build: GameBuild) => void;
  /** A build the loaded pages do not hold (an old round's row). */
  onPlayUnlisted: (ref: GameBuildRef) => void;
  /** Back to the folder's own game. */
  onLive: () => void;
  onCompare: (pair: readonly [GameBuildRef, GameBuildRef]) => void;
  /** Shows a build in Checks. */
  onInspect: (build: GameBuild) => void;
}) {
  const stripOpen = useGameWorkspaceStore((state) => state.buildStripOpen);
  const setStripOpen = useGameWorkspaceStore((state) => state.setBuildStripOpen);
  const still = useStageStill(scopedThreadKey(threadRef));
  const first = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [olderCount, setOlderCount] = useState(0);
  const olderPages = useAtomValue(olderBuildPages(threadRef, olderCount));
  // The first side of a compare waiting for the picture that picks the second.
  const [picking, setPicking] = useState<GameBuildRef | "any" | null>(null);
  // A build asked for by ref that no loaded page holds: pages back until it does.
  const [sought, setSought] = useState<GameBuildRef | null>(null);
  const [notFound, setNotFound] = useState(false);
  // The picture a step from the keys or the palette last landed on; null is the newest.
  const [stepped, setStepped] = useState<GameBuildId | "now" | null>(null);
  // A request made before the strip mounted was answered, or was for another one.
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
  // Oldest first, as stepping and the strip read them.
  const marks = timelineMarks(loaded, list?.current ?? null);
  const order = marks.map((build) => build.id);
  const lastPage = olderPages.at(-1);
  const olderNext =
    olderCount === 0
      ? (list?.next ?? null)
      : lastPage !== undefined && AsyncResult.isSuccess(lastPage)
        ? lastPage.value.next
        : null;
  // An older turn's "Open build": read pages back until it is in the strip, then show it.
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
    if (only === null) {
      setPicking(start);
      setStripOpen(true);
    } else if (start === "any") onCompare([refOf(only[0]!), refOf(only[1]!)]);
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
  const items = stripItems(marks);
  const open = stripOpen || pickingNow || reelOpen;
  const onStageBuild = marks.find((build) => build.id === onStage) ?? null;
  const thumb = (build: GameBuild, label: ReactNode = shortName(build)) => (
    <BuildThumb
      key={build.id}
      threadRef={threadRef}
      gameName={gameName}
      build={build}
      label={label}
      onStage={onStage === build.id && !pickingNow}
      copy={playing === build.id}
      undone={list !== null && isUndone(build, list)}
      picking={pickingNow}
      picked={picking !== null && picking !== "any" && sameRef(picking, build)}
      onClick={() => (pickingNow ? pick(build) : play(build))}
    />
  );
  return (
    <section aria-label="Builds" className="flex min-w-0 flex-col" data-game-build-strip="">
      <div className="flex h-8 min-w-0 items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          className="-ms-2 shrink-0"
          aria-expanded={open}
          onClick={() => {
            if (pickingNow) setPicking(null);
            setStripOpen(!open);
          }}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("motion-popup transition-transform", open && "rotate-90")}
          />
          Builds
        </Button>
        <Text variant="caption" tone="muted" numeric truncate render={<span className="flex-1" />}>
          {picking !== null
            ? firstPicked === null
              ? "Pick the first build to compare"
              : `Pick a build to compare with ${buildName(firstPicked)}`
            : sought !== null
              ? "Finding that build…"
              : notFound
                ? "That build is older than the strip reads"
                : slot !== null
                  ? slot.label
                  : onStageBuild !== null
                    ? `${buildName(onStageBuild)} on the Stage`
                    : list?.folderEdited === true
                      ? "Now: changed since the last build"
                      : list === null || marks.length === 0
                        ? "The game so far, before its first build"
                        : null}
        </Text>
        {picking !== null ? (
          <Button size="xs" variant="ghost" onClick={() => setPicking(null)}>
            Cancel
          </Button>
        ) : marks.length < 2 ? null : (
          <StripAction
            label="Compare two builds"
            detail="Pick two, then play them side by side with their checks"
            onClick={() =>
              startCompare(onStage === null ? "any" : { _tag: "build", build: onStage })
            }
          >
            <GitCompareIcon aria-hidden="true" />
          </StripAction>
        )}
        <StripAction
          label={undo.undoLabel}
          detail={undo.undoDetail}
          shortcut={undo.undoKey}
          disabled={!undo.canUndo}
          onClick={undo.onUndo}
        >
          <Undo2Icon aria-hidden="true" />
        </StripAction>
        <StripAction
          label={undo.redoLabel}
          shortcut={undo.redoKey}
          disabled={!undo.canRedo}
          onClick={undo.onRedo}
        >
          <Redo2Icon aria-hidden="true" />
        </StripAction>
      </div>
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 pb-2">
          {reelOpen ? (
            <GameReel
              threadRef={threadRef}
              marks={marks}
              onPlay={play}
              onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
            />
          ) : null}
          <StripRow count={items.length + (showNow ? 1 : 0) + (slot === null ? 0 : 1)}>
            {olderNext !== null ? (
              <Button
                size="xs"
                variant="ghost"
                className="mt-2.5 shrink-0 self-start"
                onClick={() => setOlderCount(olderCount + 1)}
              >
                Older
              </Button>
            ) : null}
            {list === null ? (
              first.error !== null ? (
                <Text variant="caption" tone="muted" render={<p className="py-3" />}>
                  {first.error}
                </Text>
              ) : (
                [0, 1, 2].map((n) => (
                  <Skeleton key={n} shape="card" className="h-10 w-18 shrink-0" />
                ))
              )
            ) : marks.length === 0 && slot === null ? (
              <NowThumb
                threadRef={null}
                gameName={gameName}
                still={still}
                fallback={null}
                label="Now"
                active
              />
            ) : null}
            {items.map((item) =>
              item.kind === "build" ? (
                thumb(item.build)
              ) : (
                <TryGroup
                  key={item.runId}
                  threadRef={threadRef}
                  item={item}
                  list={list}
                  playing={playing}
                >
                  {item.builds.map((build) => thumb(build))}
                </TryGroup>
              ),
            )}
            {showNow && list !== null ? (
              <NowThumb
                threadRef={threadRef}
                gameName={gameName}
                still={still}
                fallback={
                  list.folderEdited === true
                    ? (list.builds.find((build) => build.id === list.current) ?? null)
                    : null
                }
                label="Now"
                active={onStage === null}
                disabled={pickingNow}
                onClick={onLive}
              />
            ) : null}
            {slot === null ? null : <SlotThumb slot={slot} />}
          </StripRow>
        </div>
      ) : null}
    </section>
  );
}

/** The pictures in one scrolling row that starts at the newest, and stays there as builds land. */
function StripRow({ count, children }: { count: number; children: ReactNode }) {
  const row = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = row.current;
    if (node !== null && count > 0) node.scrollLeft = node.scrollWidth;
  }, [count]);
  return (
    <div
      ref={row}
      className="flex min-w-0 items-end gap-2 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
    >
      {children}
    </div>
  );
}

/** A header icon action with its name, what it does and its key in the tooltip. */
function StripAction({
  label,
  detail = null,
  shortcut = null,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  detail?: string | null;
  shortcut?: string | null;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-xs">
        <span className="flex flex-col gap-1">
          <TooltipLabel shortcut={shortcut}>{label}</TooltipLabel>
          {detail === null ? null : <span className="text-muted-foreground">{detail}</span>}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** One picture: the build, its short name under it, the one on the Stage ringed. */
function BuildThumb({
  threadRef,
  gameName,
  build,
  label,
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
  label: ReactNode;
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
  const checks = checksLine(build.facts);
  const state = thumbState(build);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-current={onStage ? "true" : undefined}
            aria-label={`${buildName(build)}, ${formatBuildTime(build.at)}${onStage ? ", on the Stage" : ""}`}
            disabled={!build.available && !picking}
            onClick={onClick}
            className="group/thumb flex w-18 shrink-0 cursor-pointer flex-col items-start gap-1 rounded-md text-left outline-none disabled:cursor-default"
          />
        }
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          title={buildName(build)}
          mark="initial"
          className={cn(
            "h-10 w-18 rounded-md",
            (undone || !build.available) && "opacity-50 saturate-50",
          )}
        >
          <ThumbEdge
            className={cn(
              "group-hover/thumb:ring-foreground/30 group-focus-visible/thumb:ring-2 group-focus-visible/thumb:ring-ring",
              onStage && "ring-2 ring-live group-hover/thumb:ring-live",
              picked && "ring-2 ring-strong-foreground",
            )}
          />
          {state === null ? null : (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1 right-1 size-1.5 rounded-full ring-1 ring-black/40",
                state === "measuring"
                  ? "bg-live"
                  : state === "failed"
                    ? "bg-destructive"
                    : "bg-warning",
              )}
            />
          )}
        </GameBuildStill>
        <Text
          variant="caption"
          tone={onStage ? "strong" : "muted"}
          numeric
          truncate
          render={
            <span className={cn("flex w-full items-center gap-0.5", undone && "line-through")} />
          }
        >
          {step === null ? null : (
            <FastForwardIcon className="size-2.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
        </Text>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm">
        <span className="flex flex-col gap-1">
          <span>
            {buildName(build)} · {formatBuildTime(build.at)}
            {undone ? " · undone" : copy ? " · playing a copy" : ""}
          </span>
          <span className="text-muted-foreground">{buildCaption(build)}</span>
          {checks === "" ? null : <span className="text-muted-foreground">{checks}</span>}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A picture's edge, drawn over it: an inset ring on the picture itself would sit under its image. */
function ThumbEdge({ className }: { className?: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 rounded-md ring-1 ring-border ring-inset transition-shadow",
        className,
      )}
    />
  );
}

/** The one mark a picture carries: being measured, does not start, or something to look at. */
const thumbState = (build: GameBuild): "measuring" | "failed" | "look" | null => {
  const state = build.facts.state;
  if (state === "queued" || state === "measuring") return "measuring";
  if (!factsSettled(build.facts)) return null;
  if (doesNotStart(build.facts)) return "failed";
  return build.facts.bad > 0 ? "look" : null;
};

/**
 * A try's versions under the message that asked for them, and Keep for the one on the Stage: it
 * becomes the game folder's through the same restore Undo takes back.
 */
function TryGroup({
  threadRef,
  item,
  list,
  playing,
  children,
}: {
  threadRef: ScopedThreadRef;
  item: Extract<StripItem, { kind: "try" }>;
  list: GameBuildsResult | null;
  playing: GameBuildId | null;
  children: ReactNode;
}) {
  const canKeep = useAtomValue(gameEnvironment.keepVersion.permissionAtom(threadRef.environmentId));
  const keepVersion = useAtomCommand(gameEnvironment.keepVersion, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shown = item.builds.find((build) => build.id === playing) ?? null;
  const kept = item.builds.find((build) => build.source._tag === "version" && build.source.kept);
  const inFolder = shown !== null && shown.id === list?.current;
  const keep = async (build: GameBuild) => {
    if (build.source._tag !== "version") return;
    setKeeping(true);
    setNote(null);
    const result = await keepVersion({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        runId: item.runId,
        n: build.source.n,
        commandId: randomUUID(),
      },
    });
    setKeeping(false);
    setNote(
      result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : result.value.message,
    );
  };
  return (
    <div
      role="group"
      aria-label={`Tried ${item.builds.length} ways: ${item.request}`}
      className="flex shrink-0 flex-col gap-1 border-s border-border ps-2"
    >
      <div className="flex h-6 max-w-full items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Text
                variant="caption"
                tone="default"
                truncate
                render={<span className="max-w-48 min-w-0" />}
              />
            }
          >
            {item.request}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-sm">
            {note ?? `Tried ${item.builds.length} ways: ${item.request}`}
          </TooltipPopup>
        </Tooltip>
        {shown !== null && shown.source._tag === "version" && !inFolder && canKeep ? (
          <Button size="xs" variant="outline" disabled={keeping} onClick={() => void keep(shown)}>
            {keeping ? "Keeping…" : `Keep ${shown.source.n}`}
          </Button>
        ) : kept !== undefined && kept.source._tag === "version" ? (
          <Text variant="caption" tone="muted" numeric>
            Kept {kept.source.n}
          </Text>
        ) : null}
      </div>
      <div className="flex items-end gap-2">{children}</div>
    </div>
  );
}

/** The game as it is now, when that is no build: edited since, or another build plays. */
function NowThumb({
  threadRef,
  gameName,
  still,
  fallback,
  label,
  active,
  disabled = false,
  onClick,
}: {
  threadRef: ScopedThreadRef | null;
  gameName: string;
  still: string | null;
  fallback: GameBuild | null;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <GameNowPicture
        still={still}
        gameName={gameName}
        fallback={fallback}
        threadRef={threadRef}
        className={cn("h-10 w-18 rounded-md", disabled && "opacity-50")}
      >
        <ThumbEdge className={active ? "ring-2 ring-live" : undefined} />
      </GameNowPicture>
      <Text variant="caption" tone={active ? "strong" : "muted"} truncate render={<span />}>
        {label}
      </Text>
    </>
  );
  if (onClick === undefined)
    return <div className="flex w-18 shrink-0 flex-col items-start gap-1">{body}</div>;
  return (
    <button
      type="button"
      aria-label="Now: the current game"
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      className="flex w-18 shrink-0 cursor-pointer flex-col items-start gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
    >
      {body}
    </button>
  );
}

/** The build being made: a dashed picture with the working dot, under its name. */
function SlotThumb({ slot }: { slot: GameBuildSlot }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex w-18 shrink-0 flex-col items-start gap-1" />}>
        <span className="flex h-10 w-18 items-center justify-center rounded-md border border-dashed border-foreground/25">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
        </span>
        <Text variant="caption" tone="muted" truncate render={<span className="w-full" />}>
          {slot.name}
        </Text>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm">
        <span className="flex flex-col gap-1">
          <span>{slot.label}</span>
          {slot.caption === null ? null : (
            <span className="text-muted-foreground">{slot.caption}</span>
          )}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
