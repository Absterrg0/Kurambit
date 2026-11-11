import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { FastForwardIcon, GitCompareIcon, XIcon } from "lucide-react";
import type {
  GameBuild,
  GameBuildId,
  GameBuildRef,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";

import type { GameStageRequest } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useStableCallback } from "../../hooks/useStableCallback";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill } from "./GameBuildStill";
import { GameElapsed } from "./GameElapsed";
import { GameReel } from "./GameReel";
import { buildCaption, buildName, formatBuildTime } from "./gameBuilds.logic";
import { isUndone, markLabels, stepMark, timelineMarks } from "./gameBuildTimeline.logic";

/** How many older pages an "Open build" reads to find its build before it says so. */
const SEEK_PAGES = 10;

const sameRef = (ref: GameBuildRef, build: GameBuild) =>
  ref._tag === "build"
    ? ref.build === build.id
    : build.source._tag === "turn" &&
      build.source.threadId === ref.threadId &&
      build.source.runId === ref.runId;

const isStep = (build: GameBuild) => build.source._tag === "turn" && build.source.step !== null;

/** The requests the strip answers itself: play or open a build, step, start picking a compare. */
export type GameStripRequest = {
  readonly request: Extract<GameStageRequest, { kind: "play" | "detail" | "step" | "compare" }>;
  readonly n: number;
};

/** The build being made, as the strip's last slot shows it. */
export interface GameBuildSlot {
  readonly label: string;
  /** What was asked for, when known. */
  readonly caption: string | null;
  readonly since: number | null;
  /** Keep going is making it: the slot sits under the run's bracket. */
  readonly keepGoing: boolean;
}

/**
 * The game's builds under the Stage, as pictures, oldest to newest. The build
 * on the Stage is outlined; a click plays one and shows it in the Inspector.
 * Keep going's builds sit under one bracket; undone ones are dimmed and struck.
 */
export function GameBuildStrip({
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
  actions,
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
  /** A build the loaded pages do not hold (an old round's card). */
  onPlayUnlisted: (ref: GameBuildRef) => void;
  /** Back to the folder's own game. */
  onLive: () => void;
  onCompare: (pair: readonly [GameBuildRef, GameBuildRef]) => void;
  /** What makes the next builds (keep going), at the end of the strip's header. */
  actions?: ReactNode;
  /** Shows a build in the Inspector's Build tab. */
  onInspect: (build: GameBuild) => void;
}) {
  const first = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const [olderCount, setOlderCount] = useState(0);
  const olderPages = useAtomValue(olderBuildPages(threadRef, olderCount));
  // The first side of a compare waiting for the card that picks the second.
  const [picking, setPicking] = useState<GameBuildRef | "any" | null>(null);
  // A build asked for by ref that no loaded page holds: pages back until it does.
  const [sought, setSought] = useState<GameBuildRef | null>(null);
  const [notFound, setNotFound] = useState(false);
  // The card a step from the keys or the palette last landed on; null is the newest.
  const [stepped, setStepped] = useState<GameBuildId | "now" | null>(null);
  // A request made before the strip mounted was answered, or was for another one.
  const [mountRequest] = useState(request?.n ?? 0);
  const cardsRef = useRef<HTMLDivElement | null>(null);
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
  const labels = markLabels(marks);
  const order = marks.map((build) => build.id);
  const lastPage = olderPages.at(-1);
  const olderNext =
    olderCount === 0
      ? (list?.next ?? null)
      : lastPage !== undefined && AsyncResult.isSuccess(lastPage)
        ? lastPage.value.next
        : null;
  // An older turn's "Open build": read pages back until it is a card, then show it.
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
  // The newest builds are the ones a person wants: a new build scrolls to them,
  // while Older adds cards at the left and leaves the row where it is.
  const newest = marks.at(-1)?.id ?? "";
  const slotShown = slot !== null;
  useEffect(() => {
    const row = cardsRef.current;
    if (row !== null && newest !== "") row.scrollLeft = row.scrollWidth;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the slot appearing adds a card at the end, which must scroll into view too.
  }, [newest, slotShown]);

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
    } else setPicking(playing !== null ? { _tag: "build", build: playing } : "any");
  });
  const requestN = request?.n ?? 0;
  const asked = request?.request ?? null;
  useEffect(() => {
    if (asked !== null && requestN !== mountRequest) answer(asked);
  }, [requestN, asked, mountRequest, answer]);

  // The build on the Stage: the copy it plays, else the build the folder holds.
  const onStage = playing ?? (list?.folderEdited === true ? null : (list?.current ?? null));
  const card = (build: GameBuild) => (
    <BuildCard
      key={build.id}
      threadRef={threadRef}
      gameName={gameName}
      build={build}
      label={labels.get(build.id) ?? ""}
      onStage={onStage === build.id}
      undone={list !== null && isUndone(build, list)}
      picking={picking !== null}
      onClick={() => (picking !== null ? pick(build) : play(build))}
    />
  );
  // Consecutive keep-going steps share one bracket; the slot joins it while the run makes it.
  const groups: Array<{ readonly steps: boolean; readonly builds: GameBuild[] }> = [];
  for (const build of marks) {
    const last = groups.at(-1);
    if (last !== undefined && last.steps === isStep(build)) last.builds.push(build);
    else groups.push({ steps: isStep(build), builds: [build] });
  }
  const slotCard = slot === null ? null : <SlotCard slot={slot} />;
  const slotInBracket = slot?.keepGoing === true && groups.at(-1)?.steps === true;
  const nowCard =
    slot === null && list !== null && (list.folderEdited === true || playing !== null) ? (
      <NowCard list={list} active={onStage === null} onClick={onLive} />
    ) : null;
  return (
    <section
      aria-label="Builds"
      data-game-build-strip=""
      className="flex shrink-0 flex-col gap-1.5 px-3 pt-2.5 pb-1.5"
    >
      {reelOpen ? (
        <GameReel
          threadRef={threadRef}
          marks={marks}
          onPlay={play}
          onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
        />
      ) : null}
      <div className="flex h-6 min-w-0 items-center gap-2">
        <Text variant="meta" tone="dim">
          Builds
        </Text>
        {olderNext !== null ? (
          <Button size="xs" variant="ghost" onClick={() => setOlderCount(olderCount + 1)}>
            Older
          </Button>
        ) : null}
        <span className="min-w-0 flex-1">
          {sought !== null ? (
            <Text variant="caption" tone="muted">
              Finding that build…
            </Text>
          ) : notFound ? (
            <Text variant="caption" tone="muted">
              That build is older than the strip reads; Older pages back to it.
            </Text>
          ) : null}
        </span>
        {picking !== null ? (
          <span className="flex shrink-0 items-center gap-1">
            <Text variant="caption" tone="muted">
              {picking === "any" ? "Pick the first build" : "Pick the build to compare with"}
            </Text>
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
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={marks.length < 2}
              onClick={() =>
                setPicking(onStage === null ? "any" : { _tag: "build", build: onStage })
              }
            >
              <GitCompareIcon aria-hidden="true" />
              Compare
            </Button>
            {actions}
          </>
        )}
      </div>
      <div ref={cardsRef} className="flex min-w-0 items-end gap-2 overflow-x-auto pb-1">
        {list === null ? (
          <Text variant="caption" tone="muted" render={<p className="py-6" />}>
            {first.error ?? "Reading the builds…"}
          </Text>
        ) : marks.length === 0 && slot === null ? (
          <Text variant="caption" tone="muted" render={<p className="py-6" />}>
            No builds yet. Each change your agent makes to the game becomes one.
          </Text>
        ) : null}
        {groups.map((group, index) =>
          group.steps ? (
            <KeepGoingBracket key={group.builds[0]?.id ?? index}>
              {group.builds.map(card)}
              {slotInBracket && index === groups.length - 1 ? slotCard : null}
            </KeepGoingBracket>
          ) : (
            <Fragment key={group.builds[0]?.id ?? index}>{group.builds.map(card)}</Fragment>
          ),
        )}
        {slotInBracket ? null : slot?.keepGoing === true ? (
          <KeepGoingBracket>{slotCard}</KeepGoingBracket>
        ) : (
          slotCard
        )}
        {nowCard}
      </div>
    </section>
  );
}

/** One run of keep going: its builds under a labelled bracket. */
function KeepGoingBracket({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex shrink-0 items-end gap-2 pt-5">
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-2 h-3 rounded-t-md border-x border-t border-foreground/20"
      />
      <Text
        variant="caption"
        tone="inherit"
        render={
          <span className="absolute top-0 left-2 bg-background px-1.5 text-muted-foreground" />
        }
      >
        Keep going
      </Text>
      {children}
    </div>
  );
}

function BuildCard({
  threadRef,
  gameName,
  build,
  label,
  onStage,
  undone,
  picking,
  onClick,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  label: string;
  onStage: boolean;
  undone: boolean;
  picking: boolean;
  onClick: () => void;
}) {
  const step = build.source._tag === "turn" ? build.source.step : null;
  const caption = buildCaption(build);
  const { good, bad } = build.facts;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // A card is a picture with a caption, not a button's look.
          <button
            type="button"
            data-game-build-card={build.id}
            aria-current={onStage ? "true" : undefined}
            aria-label={`${buildName(build)}, ${formatBuildTime(build.at)}${onStage ? ", on the Stage" : ""}`}
            disabled={!build.available && !picking}
            onClick={onClick}
            className={cn(
              "group/card flex w-32 shrink-0 flex-col gap-1 rounded-lg text-left outline-none disabled:cursor-default",
              (undone || !build.available) && "opacity-40",
            )}
          />
        }
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          className="h-18 w-full rounded-md"
        >
          {/* Over the picture, so the frame never covers the outline. */}
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-10 rounded-md ring-inset",
              onStage
                ? "ring-2 ring-primary"
                : "ring-1 ring-border group-hover/card:ring-foreground/25 group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring group-focus-visible/card:ring-inset",
            )}
          />
          {/* A saved build's caption already starts with its name. */}
          {caption.toLowerCase().startsWith(label.toLowerCase()) ? null : (
            <Text
              variant="micro"
              tone="inherit"
              numeric
              render={
                <span className="absolute top-1.5 left-1.5 z-10 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-stage-foreground" />
              }
            >
              {step === null ? null : <FastForwardIcon className="size-2.5" aria-hidden="true" />}
              {label}
            </Text>
          )}
          {good > 0 || bad > 0 ? (
            <span className="absolute right-1.5 bottom-1.5 z-10 flex gap-1">
              {good > 0 ? <CheckMark tone="good" count={good} /> : null}
              {bad > 0 ? <CheckMark tone="bad" count={bad} /> : null}
            </span>
          ) : null}
        </GameBuildStill>
        <Text
          variant="caption"
          tone={onStage ? "strong" : "default"}
          truncate
          render={<span className={cn("block", undone && "line-through")} />}
        >
          {caption}
        </Text>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-xs">
        {buildName(build)} · {formatBuildTime(build.at)}
        {undone ? " · undone" : ""}
        <br />
        {caption}
      </TooltipPopup>
    </Tooltip>
  );
}

function CheckMark({ tone, count }: { tone: "good" | "bad"; count: number }) {
  return (
    <Text
      variant="micro"
      tone="inherit"
      numeric
      aria-label={tone === "good" ? `${count} checks pass` : `${count} to look at`}
      render={
        <span className="flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-stage-foreground" />
      }
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", tone === "good" ? "bg-success" : "bg-warning")}
      />
      {count}
    </Text>
  );
}

/** The build being made: a dashed slot with its elapsed time. */
function SlotCard({ slot }: { slot: GameBuildSlot }) {
  return (
    <div data-game-build-slot="" className="flex w-32 shrink-0 flex-col gap-1">
      <div className="flex h-18 w-full items-center justify-center rounded-md border border-dashed border-live/60 bg-live/8">
        <Text variant="caption" tone="default">
          {slot.label}
        </Text>
      </div>
      <Text variant="caption" tone="default" truncate render={<span className="block" />}>
        {slot.caption ?? "\u00a0"}
      </Text>
      {slot.since === null ? null : (
        <Text variant="micro" tone="dim">
          <GameElapsed since={slot.since} />
        </Text>
      )}
    </div>
  );
}

/** The game folder when it is no build: edited since, or another build plays from a copy. */
function NowCard({
  list,
  active,
  onClick,
}: {
  list: GameBuildsResult;
  active: boolean;
  onClick: () => void;
}) {
  const current = list.builds.find((build) => build.id === list.current);
  const since =
    list.folderEdited === true
      ? `changed since ${current === undefined ? "an earlier build" : buildName(current)}`
      : "back to the current game";
  return (
    <button
      type="button"
      data-game-build-card="now"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className="group/card flex w-32 shrink-0 flex-col gap-1 rounded-lg text-left outline-none"
    >
      <span
        className={cn(
          "flex h-18 w-full items-center justify-center rounded-md bg-muted ring-inset",
          active
            ? "ring-2 ring-primary"
            : "ring-1 ring-border group-hover/card:ring-foreground/25 group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring group-focus-visible/card:ring-inset",
        )}
      >
        <Text variant="caption" tone="muted">
          Now
        </Text>
      </span>
      <Text variant="caption" tone="muted" truncate render={<span className="block" />}>
        {since}
      </Text>
    </button>
  );
}
