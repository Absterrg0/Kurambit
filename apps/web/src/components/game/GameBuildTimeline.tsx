import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FastForwardIcon,
  GitCompareIcon,
  HistoryIcon,
  PlayIcon,
  Redo2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  ownsUndo,
  type GameBuild,
  type GameBuildId,
  type GameBuildRef,
  type GameBuildsResult,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import type { GameStageRequest } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildDetail, refOf } from "./GameBuildDetail";
import { GameBuildFactChips } from "./GameBuildFacts";
import { GameReel } from "./GameReel";
import { buildName, formatBuildTime } from "./gameBuilds.logic";
import { isUndone, markLabel, markTone, stepMark, timelineMarks } from "./gameBuildTimeline.logic";
import { turnStripRestore } from "./gameTurnBuild.logic";
import { stepVerdictText } from "./keepGoing.logic";
import { restoreQuestion, useBuildRestore } from "./useBuildActions";

/** How many older pages an "Open build" reads to find its build before it says so. */
const SEEK_PAGES = 10;

const TONE_BAR = {
  good: "bg-success",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/50",
} as const;

const RESTORE = {
  undo: { label: "Undo", Icon: Undo2Icon },
  redo: { label: "Redo", Icon: Redo2Icon },
  "go-back": { label: "Go back", Icon: HistoryIcon },
} as const;

const sameRef = (ref: GameBuildRef, build: GameBuild) =>
  ref._tag === "build"
    ? ref.build === build.id
    : build.source._tag === "turn" &&
      build.source.threadId === ref.threadId &&
      build.source.runId === ref.runId;

/** The requests the timeline answers itself: play or open a build, step, start picking a compare. */
export type GameTimelineRequest = {
  readonly request: Extract<GameStageRequest, { kind: "play" | "detail" | "step" | "compare" }>;
  readonly n: number;
};

/**
 * The game's builds under the Stage: one mark per build, oldest to
 * newest, then Now, the live folder. The selected mark's line holds Play and
 * its one restore; its popover holds the full detail. Reads only the builds
 * list and its chips; a build's facts load only in an open popover.
 */
export function GameBuildTimeline({
  threadRef,
  writer,
  turnRunning,
  live,
  playing,
  request,
  onPlay,
  onPlayUnlisted,
  onLive,
  onCompare,
}: {
  threadRef: ScopedThreadRef;
  /** It may change the folder (not a run's role thread). */
  writer: boolean;
  turnRunning: boolean;
  /** "Now" is the folder served live (an engine that plays its folder). */
  live: boolean;
  /** The build the Stage plays from a copy, if any. */
  playing: GameBuild["id"] | null;
  request: GameTimelineRequest | null;
  /** Plays an earlier build from a copy. */
  onPlay: (build: GameBuild) => void;
  /** A build the loaded pages do not hold (an old round's card). */
  onPlayUnlisted: (ref: GameBuildRef) => void;
  /** Back to the folder's own game. */
  onLive: () => void;
  onCompare: (pair: readonly [GameBuildRef, GameBuildRef]) => void;
}) {
  const first = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [olderCount, setOlderCount] = useState(0);
  const olderPages = useAtomValue(olderBuildPages(threadRef, olderCount));
  // null: the newest build. "now": the live folder.
  const [selected, setSelected] = useState<GameBuildId | "now" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The first side of a compare waiting for the mark that picks the second.
  const [picking, setPicking] = useState<GameBuildRef | "any" | null>(null);
  // A build asked for by ref that no loaded page holds: pages back until it does.
  const [sought, setSought] = useState<GameBuildRef | null>(null);
  const [notFound, setNotFound] = useState(false);
  // The strip opened as Keep going's reel.
  const [reelOpen, setReelOpen] = useState(false);
  // A request made before the timeline mounted was answered, or was for another one.
  const [mountRequest] = useState(request?.n ?? 0);
  const restores = useBuildRestore(threadRef, first.data?.restore ?? null);
  const marksRef = useRef<HTMLDivElement | null>(null);
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
  const marks = timelineMarks(loaded, list?.current ?? null);
  const order = marks.map((build) => build.id);
  const lastPage = olderPages.at(-1);
  const olderNext =
    olderCount === 0
      ? (list?.next ?? null)
      : lastPage !== undefined && AsyncResult.isSuccess(lastPage)
        ? lastPage.value.next
        : null;
  // An older turn's "Open build": read pages back until it is a mark, then open it.
  if (sought !== null) {
    const found = marks.find((entry) => sameRef(sought, entry));
    const waiting = lastPage !== undefined && !AsyncResult.isSuccess(lastPage);
    if (found !== undefined) {
      setSought(null);
      setSelected(found.id);
      setOpen(found.id);
    } else if (list !== null && !waiting) {
      if (olderNext !== null && olderCount < SEEK_PAGES) setOlderCount(olderCount + 1);
      else {
        setSought(null);
        setNotFound(true);
      }
    }
  }
  // The newest marks are the ones a person wants: a new build scrolls to them,
  // while Older adds marks at the left and leaves the row where it is.
  const newest = marks.at(-1)?.id ?? "";
  useEffect(() => {
    const row = marksRef.current;
    if (row !== null && newest !== "") row.scrollLeft = row.scrollWidth;
  }, [newest]);

  const pick = (build: GameBuild) => {
    if (picking === "any") setPicking(refOf(build));
    else if (picking !== null && !sameRef(picking, build)) {
      onCompare([picking, refOf(build)]);
      setPicking(null);
    }
  };
  const play = (build: GameBuild) => {
    setSelected(build.id);
    // The folder already is this build: its own game shows it, never a copy
    // (unless the list knows the folder was edited since).
    if (list !== null && list.current === build.id && list.folderEdited !== true) onLive();
    else onPlay(build);
  };
  // Answered after the render that received it: playing reaches the Stage's own state.
  const answer = useStableCallback((asked: GameTimelineRequest["request"]) => {
    if (asked.kind === "step") {
      const to = stepMark(order, selected, asked.by);
      const build = marks.find((entry) => entry.id === to);
      if (build === undefined) {
        setSelected("now");
        onLive();
      } else play(build);
    } else if (asked.kind === "play") {
      const build = marks.find((entry) => sameRef(asked.build, entry));
      if (build === undefined) onPlayUnlisted(asked.build);
      else play(build);
    } else if (asked.kind === "detail") {
      const build = marks.find((entry) => sameRef(asked.build, entry));
      if (build !== undefined) {
        setSelected(build.id);
        setOpen(build.id);
      } else {
        setSought(asked.build);
        setNotFound(false);
      }
    } else
      setPicking(
        selected !== null && selected !== "now" ? { _tag: "build", build: selected } : "any",
      );
  });
  const requestN = request?.n ?? 0;
  const asked = request?.request ?? null;
  useEffect(() => {
    if (asked !== null && requestN !== mountRequest) answer(asked);
  }, [requestN, asked, mountRequest, answer]);

  const latestUndoable = loaded.find((build) => ownsUndo(build.source)) ?? null;
  const shown =
    selected === "now"
      ? null
      : (marks.find((build) => build.id === selected) ?? marks.at(-1) ?? null);
  const action =
    shown === null || list === null || !writer
      ? null
      : turnStripRestore(
          {
            build: shown,
            latest: shown.id === latestUndoable?.id,
            restore: list.restore,
            current: list.current,
            folderEdited: list.folderEdited,
          },
          turnRunning,
        );
  const restoreKind = action === null ? null : RESTORE[action.kind];
  const restoreButton =
    action === null || restoreKind === null ? null : (
      <Button
        size="xs"
        variant="ghost"
        disabled={action.blocked !== null || !restores.canRestore || restores.pending}
        onClick={() =>
          void restores.send(
            action.target,
            action.kind === "go-back" && shown !== null ? restoreQuestion(buildName(shown)) : null,
          )
        }
      >
        <restoreKind.Icon aria-hidden="true" />
        {restores.restoring(action.target) ? `${restoreKind.label}…` : restoreKind.label}
      </Button>
    );

  return (
    <section
      aria-label="Builds"
      data-game-build-timeline=""
      className="flex shrink-0 flex-col gap-1 border-t border-border bg-background px-3 py-2"
    >
      {reelOpen ? (
        <GameReel
          threadRef={threadRef}
          marks={marks}
          onPlay={play}
          onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        {olderNext !== null ? (
          <Button size="xs" variant="ghost" onClick={() => setOlderCount(olderCount + 1)}>
            Older
          </Button>
        ) : null}
        <div ref={marksRef} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {list === null ? (
            <span className="text-2xs text-muted-foreground">
              {first.error ?? "Reading the builds…"}
            </span>
          ) : marks.length === 0 ? (
            <span className="text-2xs text-muted-foreground">
              No builds yet. Each turn that changes the game becomes one.
            </span>
          ) : null}
          {marks.map((build) => {
            const undone = list !== null && isUndone(build, list);
            const step = build.source._tag === "turn" ? build.source.step : null;
            return (
              <Popover
                key={build.id}
                open={open === build.id}
                onOpenChange={(next) => {
                  if (picking !== null) {
                    pick(build);
                    return;
                  }
                  setSelected(build.id);
                  setOpen(next ? build.id : null);
                }}
              >
                <PopoverTrigger
                  render={
                    // A mark is its own control: a tick on the line, not a button's look.
                    <button
                      type="button"
                      data-game-build-mark={build.id}
                      data-step={step === null ? undefined : step.n}
                      aria-current={shown?.id === build.id ? "true" : undefined}
                      aria-label={`${buildName(build)}, ${formatBuildTime(build.at)}`}
                      className={cn(
                        "relative flex h-9 min-w-8 shrink-0 flex-col items-center justify-center gap-1 rounded-md px-1.5 hover:bg-accent/60",
                        shown?.id === build.id && "bg-accent",
                        (undone || !build.available) && "opacity-50",
                      )}
                    />
                  }
                >
                  <span
                    className={cn(
                      "flex items-center gap-px font-mono text-2xs leading-none",
                      undone && "line-through",
                      playing === build.id && "text-primary",
                    )}
                  >
                    {/* A keep-going step, told apart from a person's turn. */}
                    {step === null ? null : (
                      <FastForwardIcon className="size-2.5" aria-hidden="true" />
                    )}
                    {markLabel(build)}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn("h-0.75 w-4 rounded-full", TONE_BAR[markTone(build)])}
                  />
                  {list?.current === build.id ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1 right-1 size-1.5 rounded-full bg-success"
                    />
                  ) : null}
                </PopoverTrigger>
                <PopoverPopup width="lg" side="top" align="start">
                  {open === build.id ? (
                    <div className="max-h-[60vh] overflow-y-auto">
                      <GameBuildDetail
                        threadRef={threadRef}
                        build={build}
                        list={list}
                        loaded={loaded}
                        writer={writer}
                        turnRunning={turnRunning}
                        onCompare={(other) => {
                          setOpen(null);
                          if (other === null) setPicking(refOf(build));
                          else onCompare([refOf(build), other]);
                        }}
                        onPlay={(target) => {
                          setOpen(null);
                          play(target);
                        }}
                      />
                    </div>
                  ) : null}
                </PopoverPopup>
              </Popover>
            );
          })}
          <button
            type="button"
            data-game-build-mark="now"
            aria-current={selected === "now" ? "true" : undefined}
            className={cn(
              "flex h-9 shrink-0 flex-col items-center justify-center gap-1 rounded-md px-2 hover:bg-accent/60",
              selected === "now" && "bg-accent",
            )}
            onClick={() => {
              setSelected("now");
              if (playing !== null) onLive();
            }}
          >
            <span className="text-2xs leading-none">Now</span>
            <span aria-hidden="true" className="h-0.75 w-4 rounded-full bg-muted-foreground/50" />
          </button>
        </div>
        {marks.some((build) => build.source._tag === "turn" && build.source.step !== null) ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={reelOpen}
            onClick={() => setReelOpen(!reelOpen)}
          >
            {reelOpen ? (
              <ChevronDownIcon aria-hidden="true" />
            ) : (
              <ChevronUpIcon aria-hidden="true" />
            )}
            {reelOpen ? "Close reel" : "Reel"}
          </Button>
        ) : null}
        {picking !== null ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            {picking === "any" ? "Pick the first build" : "Pick the build to compare with"}
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label="Stop picking"
              onClick={() => setPicking(null)}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </Button>
          </span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={marks.length < 2}
            onClick={() => setPicking(shown === null ? "any" : refOf(shown))}
          >
            <GitCompareIcon aria-hidden="true" />
            Compare
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {shown === null ? (
          <>
            <span className="font-medium">Now</span>
            <span className="text-muted-foreground">{nowLine(list, live)}</span>
            {playing !== null ? (
              <Button size="xs" variant="ghost" onClick={onLive}>
                <PlayIcon className="fill-current" aria-hidden="true" />
                Back to the current game
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <span className="min-w-0 max-w-full truncate font-medium">
              {buildName(shown) === shown.summary
                ? shown.summary
                : `${buildName(shown)} · ${shown.summary}`}
            </span>
            {shown.source._tag === "turn" && shown.source.step !== null ? (
              <span className="shrink-0 text-muted-foreground">
                {stepVerdictText(shown.source.step)}
              </span>
            ) : null}
            <span className="shrink-0 text-muted-foreground">
              {shown.fileCount === null
                ? ""
                : `${shown.fileCount === 1 ? "1 file" : `${shown.fileCount} files`} · `}
              {formatBuildTime(shown.at)}
            </span>
            <span className="flex-1">
              <GameBuildFactChips summary={shown.facts} />
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!shown.available || shown.noPlay !== null}
              onClick={() => play(shown)}
            >
              <PlayIcon className="fill-current" aria-hidden="true" />
              Play
            </Button>
            {action === null ? null : action.blocked === null ? (
              restoreButton
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span />}>{restoreButton}</TooltipTrigger>
                <TooltipPopup side="top">{action.blocked}</TooltipPopup>
              </Tooltip>
            )}
          </>
        )}
      </div>
      {sought !== null ? (
        <p className="text-2xs text-muted-foreground">Finding that build…</p>
      ) : notFound ? (
        <p className="text-2xs text-muted-foreground">
          That build is older than the timeline reads; Older pages back to it.
        </p>
      ) : null}
      {action !== null && restores.error(action.target) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {restores.error(action.target)}
        </p>
      ) : null}
    </section>
  );
}

/** What "Now" is against the folder's build. */
const nowLine = (list: GameBuildsResult | null, live: boolean): string => {
  const what = live ? "The game folder, live" : "The game folder";
  if (list === null || list.current === null) return what;
  const current = list.builds.find((build) => build.id === list.current);
  const name =
    current === undefined ? "an earlier build" : buildName(current).replace(/'s build$/, "");
  return list.folderEdited === true
    ? `${what} · changed since ${name}`
    : list.folderEdited === false
      ? `${what} · same as ${name}`
      : `${what} · made from ${name}`;
};
