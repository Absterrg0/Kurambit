import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { FastForwardIcon, Redo2Icon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import type {
  GameBuild,
  GameBuildId,
  GameBuildRef,
  GameBuildsResult,
  GameCopy,
  GameTryVersion,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { useNavigate } from "@tanstack/react-router";

import type { GameStageRequest } from "../../gameWorkspaceStore";
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
import { GameHistoryCopies } from "./GameHistoryCopies";
import { checkingStep, heldWords, useGameCopies } from "./useGameCopies";

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

/**
 * The builds oldest first, a try's versions together under their request at the place its first
 * version landed, in their own order (1, 2, 3), whichever finished first.
 */
const stripItems = (marks: ReadonlyArray<GameBuild>): ReadonlyArray<StripItem> => {
  const items: Array<StripItem> = [];
  const tries = new Map<string, number>();
  for (const build of marks) {
    const source = build.source;
    if (source._tag !== "version") {
      items.push({ kind: "build", build });
      continue;
    }
    const at = tries.get(source.runId);
    const group = at === undefined ? undefined : items[at];
    if (at !== undefined && group?.kind === "try")
      items[at] = { ...group, builds: [...group.builds, build] };
    else {
      tries.set(source.runId, items.length);
      items.push({ kind: "try", runId: source.runId, request: source.request, builds: [build] });
    }
  }
  const versionOf = (build: GameBuild) => (build.source._tag === "version" ? build.source.n : 0);
  return items.map((item) =>
    item.kind === "try"
      ? { ...item, builds: item.builds.toSorted((a, b) => versionOf(a) - versionOf(b)) }
      : item,
  );
};

/** A build's short name under its picture; its tooltip has the whole one. */
const shortName = (build: GameBuild) => {
  const source = build.source;
  if (source._tag === "version") return `Version ${source.n}`;
  if (build.number === null) return buildName(build);
  return `Build ${build.number}`;
};

/**
 * The game's History, in the popover under the header's build button: Undo, Redo and Compare,
 * then the builds as pictures in time order, oldest left, the one on the Stage ringed, a try's
 * versions grouped under what was asked with Keep. A picture plays its build and shows it in
 * Checks. It stays mounted while the popover is closed: the chat's cards, the palette and the keys
 * reach it through the Stage's requests, and a compare's pick opens it.
 */
export function GameHistory({
  threadRef,
  gameName,
  playing,
  slot,
  request,
  reelOpen,
  open,
  onOpen,
  undo,
  onPlay,
  onPlayUnlisted,
  onLive,
  onCompare,
  onInspect,
  onAskAgent,
  onGoBack,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  /** The build the Stage plays from a copy, if any. */
  playing: GameBuildId | null;
  slot: GameBuildSlot | null;
  request: GameStripRequest | null;
  reelOpen: boolean;
  /** The popover is open: the row scrolls to the newest when it opens. */
  open: boolean;
  /** Opens the popover, for a compare's pick. */
  onOpen: () => void;
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
  /** Puts a request for the agent in the composer. */
  onAskAgent: (text: string) => void;
  /** The whole folder back to a build: Go back, after it asks. */
  onGoBack: (build: GameBuild) => void;
}) {
  const { place, copies } = useGameCopies(threadRef);
  const tries = useEnvironmentQuery(
    gameEnvironment.tries({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const versionChats = new Set(
    (tries?.tries ?? []).flatMap((each) => each.versions.map((version) => version.childThreadId)),
  );
  const canUndo = useAtomValue(gameEnvironment.buildUndo.permissionAtom(threadRef.environmentId));
  const undoCommand = useAtomCommand(gameEnvironment.buildUndo, { reportFailure: false });
  // One build's change reversed with later builds kept, and what the server answered.
  const [undoing, setUndoing] = useState<GameBuildId | null>(null);
  const [undoAnswer, setUndoAnswer] = useState<UndoAnswer | null>(null);
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
      onOpen();
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

  const undoBuild = async (build: GameBuild) => {
    setUndoing(build.id);
    setUndoAnswer(null);
    const result = await undoCommand({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, build: build.id, commandId: randomUUID() },
    });
    setUndoing(null);
    if (result._tag === "Failure") {
      setUndoAnswer({ _tag: "failed", build, text: String(squashAtomCommandFailure(result)) });
      return;
    }
    const answer = result.value;
    if (answer._tag === "undone") setUndoAnswer({ _tag: "undone", build });
    else
      setUndoAnswer({
        _tag: "conflicts",
        build,
        paths: answer.files.map((file) => file.path),
        // The first later build that changed one of those files: the change Undo would undo too.
        later:
          marks
            .slice(marks.findIndex((entry) => entry.id === build.id) + 1)
            .find((entry) =>
              entry.files.some((file) => answer.files.some((each) => each.path === file.path)),
            ) ?? null,
      });
  };
  // Undo reaches a build of the game: its own folder's numbered builds, from a chat in the game.
  const undoable = (build: GameBuild) =>
    canUndo && place._tag === "game" && build.number !== null && build.available;

  // The build on the Stage: the copy it plays, else the build the folder holds.
  const onStage = stageBuildId(list, playing);
  const showNow =
    slot === null && list !== null && (list.folderEdited === true || playing !== null);
  const items = stripItems(marks);
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
      {...(undoable(build) && !pickingNow && (list === null || !isUndone(build, list))
        ? { onUndo: () => void undoBuild(build), undoing: undoing === build.id }
        : {})}
    />
  );
  const note =
    picking !== null
      ? firstPicked === null
        ? "Pick the first build to compare"
        : `Pick a build to compare with ${buildName(firstPicked)}`
      : sought !== null
        ? "Finding that build…"
        : notFound
          ? "That build is older than History reads"
          : slot !== null
            ? slot.label
            : null;
  return (
    <section aria-label="History" className="flex min-w-0 flex-col gap-3" data-game-history="">
      <div className="flex h-8 min-w-0 items-center gap-1">
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
        <Text variant="caption" tone="muted" truncate render={<span className="ms-2 flex-1" />}>
          {note}
        </Text>
        {picking !== null ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setPicking(null)}>
            Cancel
          </Button>
        ) : marks.length < 2 ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() =>
              startCompare(onStage === null ? "any" : { _tag: "build", build: onStage })
            }
          >
            Compare
          </Button>
        )}
      </div>
      {undoAnswer === null ? null : (
        <UndoAnswerRow
          answer={undoAnswer}
          marks={marks}
          onGoBack={(build) => {
            setUndoAnswer(null);
            onGoBack(build);
          }}
          onAskAgent={(text) => {
            setUndoAnswer(null);
            onAskAgent(text);
          }}
          onDismiss={() => setUndoAnswer(null)}
        />
      )}
      <GameHistoryCopies threadRef={threadRef} gameName={gameName} hide={versionChats} />
      {reelOpen ? (
        <GameReel
          threadRef={threadRef}
          marks={marks}
          onPlay={play}
          onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
        />
      ) : null}
      <StripRow open={open} count={items.length + (showNow ? 1 : 0) + (slot === null ? 0 : 1)}>
        {olderNext !== null ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="shrink-0 self-center"
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
            [0, 1, 2].map((n) => <Skeleton key={n} shape="card" className="h-13.5 w-24 shrink-0" />)
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
              versions={
                tries?.tries.find((each) => each.runId === item.runId)?.versions ?? NO_VERSIONS
              }
              copies={copies}
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
    </section>
  );
}

/** The pictures in one scrolling row that starts at the newest, and stays there as builds land. */
function StripRow({
  open,
  count,
  children,
}: {
  open: boolean;
  count: number;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement | null>(null);
  // The popover lays its content out a frame after it opens: the scroll waits for that frame.
  useLayoutEffect(() => {
    const node = row.current;
    if (node === null || !open || count === 0) return;
    const frame = requestAnimationFrame(() => {
      node.scrollLeft = node.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, count]);
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
  onUndo,
  undoing = false,
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
  /** Reverses this build's change, later builds kept; absent where Undo does not reach. */
  onUndo?: (() => void) | undefined;
  undoing?: boolean;
}) {
  const step = build.source._tag === "turn" ? build.source.step : null;
  const checks = checksLine(build.facts);
  const state = thumbState(build);
  const thumb = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-current={onStage ? "true" : undefined}
            aria-label={`${buildName(build)}, ${formatBuildTime(build.at)}${onStage ? ", on the Stage" : ""}`}
            disabled={!build.available && !picking}
            onClick={onClick}
            className="group/thumb flex w-24 shrink-0 cursor-pointer flex-col items-start gap-1.5 rounded-md text-left outline-none disabled:cursor-default"
          />
        }
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          title={buildName(build)}
          mark="blank"
          className={cn(
            "h-13.5 w-24 rounded-md",
            (undone || !build.available) && "opacity-50 saturate-50",
          )}
        >
          <ThumbEdge
            className={cn(
              "group-hover/thumb:ring-foreground/30 group-focus-visible/thumb:ring-2 group-focus-visible/thumb:ring-ring group-focus-visible/thumb:ring-inset",
              onStage && "ring-2 ring-live group-hover/thumb:ring-live",
              picked && "ring-2 ring-strong-foreground",
            )}
          />
          {state === "failed" ? (
            <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
              <TriangleAlertIcon className="size-4 text-muted-foreground" />
            </span>
          ) : null}
          {state === null ? null : (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-1.5 right-1.5 size-1.5 rounded-full",
                state === "measuring" ? "bg-muted-foreground" : "bg-destructive",
              )}
            />
          )}
        </GameBuildStill>
        <Text
          variant="caption"
          tone={onStage ? "default" : "muted"}
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
  if (onUndo === undefined) return thumb;
  // Undo sits on the picture's corner, shown on hover or keyboard focus: a button in a button
  // is not allowed, so it is the picture's sibling.
  return (
    <div className="group/undo relative shrink-0" data-build-undo-host="">
      {thumb}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "absolute top-1 left-1 z-20 flex opacity-0 group-hover/undo:opacity-100 has-focus-visible:opacity-100",
                undoing && "opacity-100",
              )}
            />
          }
        >
          <Button
            size="icon-xs"
            variant="overlay"
            aria-label={`Undo ${buildName(build)}`}
            disabled={undoing}
            onClick={onUndo}
          >
            <Undo2Icon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-xs">
          {`Undo ${buildName(build)}: take its change out, later builds stay`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** What the server answered an Undo of one build. */
type UndoAnswer =
  | { readonly _tag: "undone"; readonly build: GameBuild }
  | { readonly _tag: "failed"; readonly build: GameBuild; readonly text: string }
  | {
      readonly _tag: "conflicts";
      readonly build: GameBuild;
      readonly paths: ReadonlyArray<string>;
      readonly later: GameBuild | null;
    };

/** The answer under History's top row: done, or the later build it conflicts with and the ways on. */
function UndoAnswerRow({
  answer,
  marks,
  onGoBack,
  onAskAgent,
  onDismiss,
}: {
  answer: UndoAnswer;
  marks: ReadonlyArray<GameBuild>;
  onGoBack: (build: GameBuild) => void;
  onAskAgent: (text: string) => void;
  onDismiss: () => void;
}) {
  const name = shortName(answer.build);
  // Go back is the whole restore to the build before the undone one.
  const before = marks[marks.findIndex((entry) => entry.id === answer.build.id) - 1] ?? null;
  return (
    <div
      className="flex min-h-7 min-w-0 items-center gap-2"
      data-undo-answer={answer._tag}
      role="status"
    >
      <Text variant="caption" tone="muted" truncate render={<span className="min-w-0 flex-1" />}>
        {answer._tag === "undone"
          ? `Undid ${name}; later builds stay`
          : answer._tag === "failed"
            ? answer.text
            : `Undoing ${name} conflicts with ${answer.later === null ? "later changes" : `${shortName(answer.later)}'s changes`}`}
      </Text>
      {answer._tag === "conflicts" ? (
        <>
          {before === null ? null : (
            <Button size="xs" variant="ghost" onClick={() => onGoBack(before)}>
              {`Go back to ${shortName(before)}`}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onAskAgent(
                `Take out what ${name} changed (${buildCaption(answer.build)}), and keep what came after it. ${answer.paths.join(", ")} changed since.`,
              )
            }
          >
            Ask the agent
          </Button>
        </>
      ) : (
        <Button size="xs" variant="ghost-muted" onClick={onDismiss}>
          OK
        </Button>
      )}
    </div>
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

/** The one mark a picture carries: being measured, or does not start. */
const thumbState = (build: GameBuild): "measuring" | "failed" | null => {
  const state = build.facts.state;
  if (state === "queued" || state === "measuring") return "measuring";
  if (!factsSettled(build.facts)) return null;
  return doesNotStart(build.facts) ? "failed" : null;
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
  versions,
  copies,
  children,
}: {
  threadRef: ScopedThreadRef;
  item: Extract<StripItem, { kind: "try" }>;
  list: GameBuildsResult | null;
  playing: GameBuildId | null;
  /** The try's versions: the chat each works in. */
  versions: ReadonlyArray<GameTryVersion>;
  /** The game's copies: a version is one until it is kept, and Keep brings it in. */
  copies: ReadonlyArray<GameCopy>;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const canKeep = useAtomValue(gameEnvironment.keepVersion.permissionAtom(threadRef.environmentId));
  const keepVersion = useAtomCommand(gameEnvironment.keepVersion, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shown = item.builds.find((build) => build.id === playing) ?? null;
  const kept = item.builds.find((build) => build.source._tag === "version" && build.source.kept);
  const inFolder = shown !== null && shown.id === list?.current;
  const shownN = shown?.source._tag === "version" ? shown.source.n : null;
  const shownChat = versions.find((version) => version.n === shownN)?.childThreadId ?? null;
  const copyState = copies.find((copy) => copy.threadId === shownChat)?.place.state ?? null;
  const step = copyState === null ? null : checkingStep(copyState);
  const keep = async (build: GameBuild, anyway = false) => {
    if (build.source._tag !== "version") return;
    if (!anyway) setKeeping(true);
    setNote(null);
    const result = await keepVersion({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        runId: item.runId,
        n: build.source.n,
        commandId: randomUUID(),
        ...(anyway ? { anyway: true } : {}),
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
      className="flex shrink-0 flex-col gap-1.5"
    >
      <div className="flex h-6 max-w-full items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Text
                variant="caption"
                tone="muted"
                truncate
                render={<span className="max-w-60 min-w-0" />}
              />
            }
          >
            {item.request}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-sm">
            {note ?? `Tried ${item.builds.length} ways: ${item.request}`}
          </TooltipPopup>
        </Tooltip>
        {shown !== null &&
        shown.source._tag === "version" &&
        !inFolder &&
        canKeep &&
        step !== null ? (
          // Keep is a Bring in: its check plays the version first; Keep now ends the wait.
          <>
            <Button size="xs" variant="secondary" disabled>
              <span className="tabular-nums">{`Checking… ${step}`}</span>
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void keep(shown, true)}>
              Keep now
            </Button>
          </>
        ) : shown !== null && shown.source._tag === "version" && !inFolder && canKeep ? (
          <Button size="xs" variant="secondary" disabled={keeping} onClick={() => void keep(shown)}>
            {keeping ? "Keeping…" : `Keep version ${shown.source.n}`}
          </Button>
        ) : kept !== undefined && kept.source._tag === "version" ? (
          <Text variant="caption" tone="muted" numeric>
            Kept {kept.source.n}
          </Text>
        ) : null}
      </div>
      {shown !== null && copyState?._tag === "held" ? (
        <div className="flex h-6 max-w-full items-center gap-2" data-try-keep="held">
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <Text
            variant="caption"
            tone="muted"
            truncate
            render={<span className="max-w-72 min-w-0" />}
          >
            {`Not kept: ${heldWords(copyState.reason)}`}
          </Text>
          <Button size="xs" variant="ghost" onClick={() => void keep(shown, true)}>
            Keep anyway
          </Button>
        </div>
      ) : shown !== null && copyState?._tag === "conflicts" && shownChat !== null ? (
        <div className="flex h-6 max-w-full items-center gap-2" data-try-keep="conflicts">
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <Text
            variant="caption"
            tone="muted"
            truncate
            render={<span className="max-w-72 min-w-0" />}
          >
            {`${copyState.files.length} file${copyState.files.length === 1 ? "" : "s"} conflict${copyState.files.length === 1 ? "s" : ""} with the game`}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: threadRef.environmentId, threadId: shownChat },
              })
            }
          >
            {`Open version ${shownN}`}
          </Button>
        </div>
      ) : null}
      <div className="flex items-end gap-2">{children}</div>
    </div>
  );
}

const NO_VERSIONS: ReadonlyArray<GameTryVersion> = [];

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
        className={cn("h-13.5 w-24 rounded-md", disabled && "opacity-50")}
      >
        <ThumbEdge className={active ? "ring-2 ring-live" : undefined} />
      </GameNowPicture>
      <Text variant="caption" tone={active ? "strong" : "muted"} truncate render={<span />}>
        {label}
      </Text>
    </>
  );
  if (onClick === undefined)
    return <div className="flex w-24 shrink-0 flex-col items-start gap-1.5">{body}</div>;
  return (
    <button
      type="button"
      aria-label="Now: the current game"
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      className="flex w-24 shrink-0 cursor-pointer flex-col items-start gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
    >
      {body}
    </button>
  );
}

/** The build being made: a dashed picture with the working dot, under its name. */
function SlotThumb({ slot }: { slot: GameBuildSlot }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex w-24 shrink-0 flex-col items-start gap-1.5" />}>
        <span className="flex h-13.5 w-24 items-center justify-center rounded-md bg-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" />
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
