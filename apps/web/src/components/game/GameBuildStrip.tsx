import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";
import { FastForwardIcon, GitCompareIcon } from "lucide-react";
import type {
  GameBuild,
  GameBuildId,
  GameBuildRef,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";

import { useGameWorkspaceStore, type GameStageRequest } from "../../gameWorkspaceStore";
import { cn } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { refOf } from "./gameBuildRef";
import { GameBuildStill } from "./GameBuildStill";
import { GameElapsed } from "./GameElapsed";
import { GameReel } from "./GameReel";
import { useStageStill } from "./gameStageBridge";
import { buildCaption, buildName, checksPhrase, formatBuildTime } from "./gameBuilds.logic";
import {
  isUndone,
  stageBuildId,
  markLabels,
  stepMark,
  timelineMarks,
} from "./gameBuildTimeline.logic";

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
// Cards present when the strip first paints are simply there; a card that arrives
// later (a build made, the slot that makes it, Now) slides in from the right. The
// strip turns this on a frame after its first paint, like the Tabs indicator.
function settleAfterFirstPaint(strip: HTMLElement | null) {
  if (!strip) return;
  const frame = requestAnimationFrame(() => strip.setAttribute("data-settled", ""));
  return () => cancelAnimationFrame(frame);
}
const NEW_CARD_MOTION =
  "motion-surface transition-[opacity,translate] in-data-settled:starting:translate-x-3 in-data-settled:starting:opacity-0";

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
  cardWidth,
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
  /** Each card's width, which the Stage sets from the height its game's shape leaves over. */
  cardWidth: number;
  /** Shows a build in the Inspector's Build tab. */
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
  // Which ends of the row have cards scrolled past them, for a fade on that edge only.
  const [clipped, setClipped] = useState<"none" | "start" | "end" | "both">("none");
  const readClipped = useStableCallback(() => {
    const row = cardsRef.current;
    if (row === null) return;
    const start = row.scrollLeft > 1;
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setClipped(start && end ? "both" : start ? "start" : end ? "end" : "none");
  });
  useEffect(() => {
    const row = cardsRef.current;
    if (row === null) return;
    readClipped();
    return observeResize([row, ...row.children], readClipped);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the cards in the row change its scroll width.
  }, [readClipped, newest, slotShown, cardWidth, marks.length]);

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
      setPicking(asked.first ?? (playing !== null ? { _tag: "build", build: playing } : "any"));
  });
  const requestN = request?.n ?? 0;
  const asked = request?.request ?? null;
  useEffect(() => {
    if (asked !== null && requestN !== mountRequest) answer(asked);
  }, [requestN, asked, mountRequest, answer]);

  // The tray under the composer narrates picking, and Escape gives it up.
  const threadKey = scopedThreadKey(threadRef);
  const firstPicked =
    picking === null || picking === "any"
      ? null
      : (marks.find((entry) => sameRef(picking, entry)) ?? null);
  const pickingFirstName = firstPicked === null ? null : buildName(firstPicked);
  const pickingNow = picking !== null;
  useEffect(() => {
    if (!pickingNow) return;
    const store = useGameWorkspaceStore.getState();
    store.setComparePicking({ threadKey, first: pickingFirstName });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setPicking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (useGameWorkspaceStore.getState().comparePicking?.threadKey === threadKey)
        useGameWorkspaceStore.getState().setComparePicking(null);
    };
  }, [pickingNow, pickingFirstName, threadKey]);

  // The build on the Stage: the copy it plays, else the build the folder holds.
  const onStage = stageBuildId(list, playing);
  const card = (build: GameBuild) => {
    const index = marks.indexOf(build);
    return (
      <BuildCard
        key={build.id}
        threadRef={threadRef}
        gameName={gameName}
        build={build}
        previous={index > 0 ? (marks[index - 1] ?? null) : null}
        label={labels.get(build.id) ?? ""}
        onStage={onStage === build.id}
        undone={list !== null && isUndone(build, list)}
        picking={picking !== null}
        picked={picking !== null && picking !== "any" && sameRef(picking, build)}
        onClick={() => (picking !== null ? pick(build) : play(build))}
      />
    );
  };
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
      <NowCard
        list={list}
        still={still}
        active={onStage === null}
        picking={picking !== null}
        onClick={onLive}
      />
    ) : null;
  return (
    <section
      ref={settleAfterFirstPaint}
      aria-label="Builds"
      data-game-build-strip=""
      // Composer menus (the model picker) stop at the strip's top rather than cover the Stage.
      data-composer-menu-ceiling=""
      className="flex max-w-(--game-stage-column) shrink-0 flex-col gap-1.5 px-3 pt-2.5 pb-1.5"
      // The Stage sizes the cards: wider pictures take the height the game's shape leaves over.
      style={{ "--build-card-width": `${cardWidth}px` } as CSSProperties}
    >
      {reelOpen ? (
        <GameReel
          threadRef={threadRef}
          marks={marks}
          onPlay={play}
          onCompare={([a, b]) => onCompare([refOf(a), refOf(b)])}
        />
      ) : null}
      {picking !== null ? (
        // Picking turns the header into one clear instruction, so the strip reads as a picker.
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-md bg-accent ps-2.5 pe-1">
          <GitCompareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Text variant="meta" tone="strong" render={<span className="min-w-0 flex-1" />}>
            {pickingFirstName === null
              ? "Pick the first build to compare"
              : `Pick a build to compare with ${pickingFirstName}`}
          </Text>
          <Button size="xs" variant="ghost" onClick={() => setPicking(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex h-7 min-w-0 items-center gap-2">
          <Text variant="meta" tone="muted">
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
          {marks.length < 2 ? null : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                setPicking(onStage === null ? "any" : { _tag: "build", build: onStage })
              }
            >
              <GitCompareIcon aria-hidden="true" />
              Compare
            </Button>
          )}
        </div>
      )}
      {/* A fixed height (a picture and two caption lines), so the Stage above never jumps
          between games whose captions wrap differently. */}
      <div
        ref={cardsRef}
        onScroll={readClipped}
        className="flex min-w-0 items-start gap-3 overflow-x-auto pb-1"
        style={clipped === "none" ? undefined : { maskImage: edgeFade(clipped) }}
      >
        {list === null ? (
          first.error !== null ? (
            <Text variant="caption" tone="muted" render={<p className="py-6" />}>
              {first.error}
            </Text>
          ) : (
            // Cards at their final size, so the strip does not jump when the builds arrive.
            [0, 1, 2].map((n) => (
              <div key={n} className="flex w-(--build-card-width) shrink-0 flex-col gap-1.5">
                <Skeleton shape="card" className="aspect-video w-full" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))
          )
        ) : marks.length === 0 && slot === null ? (
          <FirstBuildSlot />
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
        {marks.length === 0 ? null : nowCard}
      </div>
    </section>
  );
}

/** A 24px fade on each edge the row has scrolled cards past, so a cut card reads as more. */
const edgeFade = (clipped: "start" | "end" | "both") =>
  `linear-gradient(to right, ${clipped === "end" ? "black" : "transparent"}, black 24px, black calc(100% - 24px), ${clipped === "start" ? "black" : "transparent"})`;

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
  previous,
  label,
  onStage,
  undone,
  picking,
  picked,
  onClick,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  /** The build before it on the strip, which its checks are read against. */
  previous: GameBuild | null;
  label: string;
  onStage: boolean;
  undone: boolean;
  picking: boolean;
  /** The first side of a compare. */
  picked: boolean;
  onClick: () => void;
}) {
  const step = build.source._tag === "turn" ? build.source.step : null;
  const caption = buildCaption(build);
  // A saved build's caption already starts with its name.
  const name =
    build.source._tag === "saved"
      ? caption.toLowerCase().includes(label.toLowerCase())
        ? null
        : label
      : step !== null
        ? `Step ${label}`
        : `Build ${label}`;
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
              "group/card flex w-(--build-card-width) shrink-0 flex-col gap-1.5 rounded-lg text-left outline-none disabled:cursor-default",
              NEW_CARD_MOTION,
              (undone || !build.available) && "opacity-40",
            )}
          />
        }
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          className="aspect-video w-full rounded-md"
        >
          <CardRing
            on={picking ? false : onStage}
            pick={picked ? "picked" : picking ? "pickable" : null}
          />
          {picked ? <PickBadge /> : null}
        </GameBuildStill>
        <span className="flex min-h-12 min-w-0 flex-col gap-0.5 px-0.5">
          <Text
            variant="caption"
            tone={onStage ? "strong" : "default"}
            render={<span className={cn("line-clamp-2", undone && "line-through")} />}
          >
            {caption}
          </Text>
          <span className="flex min-w-0 items-center gap-1.5">
            {name === null ? null : (
              <Text variant="micro" tone="muted" numeric>
                {step === null ? null : (
                  <FastForwardIcon className="me-0.5 inline size-2.5" aria-hidden="true" />
                )}
                {name}
              </Text>
            )}
            <CheckDelta build={build} previous={previous} />
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-xs">
        {/* What the card doesn't already say: when, and how it measured. */}
        {formatBuildTime(build.at)}
        {checksPhrase(build.facts) === null ? "" : ` · ${checksPhrase(build.facts)}`}
        {undone ? " · undone" : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The outline of the card on the Stage, drawn over the picture so it is never covered. Over an
 * empty well it is `quiet`: on a blank it would otherwise be the strongest line in the strip.
 */
function CardRing({
  on,
  quiet = false,
  pick = null,
}: {
  on: boolean;
  quiet?: boolean;
  /** While a compare is picked: the first build, or one that can be picked next. */
  pick?: "picked" | "pickable" | null;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 rounded-md ring-inset",
        pick === "picked"
          ? "ring-2 ring-strong-foreground"
          : pick === "pickable"
            ? "ring-1 ring-foreground/35 group-hover/card:ring-2 group-hover/card:ring-foreground/70 group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring"
            : on
              ? quiet
                ? "ring-1 ring-foreground/20"
                : "ring-1 ring-foreground/45"
              : "ring-1 ring-border group-hover/card:ring-foreground/30 group-focus-visible/card:ring-2 group-focus-visible/card:ring-ring",
      )}
    />
  );
}

function PickBadge() {
  return (
    <Text
      variant="micro"
      tone="inherit"
      numeric
      render={
        <span className="absolute top-1.5 left-1.5 z-20 flex size-5 items-center justify-center rounded-full bg-strong-foreground text-background" />
      }
    >
      1
    </Text>
  );
}

/**
 * What changed in the checks since the build before: the thing keep going
 * decides on. A build with something to look at says so; one that only
 * repeats the count before it says nothing.
 */
function CheckDelta({ build, previous }: { build: GameBuild; previous: GameBuild | null }) {
  const { good, bad } = build.facts;
  const gained = previous === null ? 0 : good - previous.facts.good;
  if (bad === 0 && gained === 0) return null;
  return (
    <Text
      variant="micro"
      tone="muted"
      numeric
      render={<span className="flex items-center gap-1.5" />}
    >
      {bad > 0 ? (
        <span
          className="flex items-center gap-1 text-warning-foreground"
          aria-label={`${bad} to look at`}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {bad}
        </span>
      ) : null}
      {gained !== 0 ? (
        <span
          className={gained > 0 ? "text-success-foreground" : "text-warning-foreground"}
          aria-label={`${Math.abs(gained)} ${gained > 0 ? "more" : "fewer"} checks pass`}
        >
          {gained > 0 ? `+${gained}` : `−${Math.abs(gained)}`} pass
        </span>
      ) : null}
    </Text>
  );
}

/** Before the first build: the shape it will take, said once, at the smallest card size so an
 *  empty well is never the largest thing under the Stage. */
function FirstBuildSlot() {
  return (
    <div className="flex w-40 shrink-0 flex-col gap-1.5">
      <div className="surface-well aspect-video w-full rounded-md" />
      <Text variant="caption" tone="muted" render={<span className="px-0.5" />}>
        Not measured yet
      </Text>
    </div>
  );
}

/** The build being made: a dashed slot with its elapsed time. */
function SlotCard({ slot }: { slot: GameBuildSlot }) {
  return (
    <div
      data-game-build-slot=""
      className={cn("flex w-(--build-card-width) shrink-0 flex-col gap-1.5", NEW_CARD_MOTION)}
    >
      <div className="flex aspect-video w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-live/60 bg-live/8">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
        <Text variant="caption" tone="default">
          {slot.label}
        </Text>
      </div>
      <span className="flex min-h-12 min-w-0 flex-col gap-0.5 px-0.5">
        <Text variant="caption" tone="default" render={<span className="line-clamp-2" />}>
          {slot.caption ?? "\u00a0"}
        </Text>
        {slot.since === null ? null : (
          <Text variant="micro" tone="muted">
            <GameElapsed since={slot.since} />
          </Text>
        )}
      </span>
    </div>
  );
}

/** The game folder when it is no build: edited since, or another build plays from a copy. */
function NowCard({
  list,
  still,
  active,
  picking,
  onClick,
}: {
  list: GameBuildsResult;
  /** The folder's game's last frame on the Stage, once it has shown one. */
  still: string | null;
  active: boolean;
  /** Now is no build, so a compare cannot pick it: it steps back while one is picked. */
  picking: boolean;
  onClick: () => void;
}) {
  const current = list.builds.find((build) => build.id === list.current);
  const since =
    list.folderEdited === true
      ? `Changed since ${current === undefined ? "an earlier build" : buildName(current)}`
      : "Back to the current game";
  return (
    <button
      type="button"
      data-game-build-card="now"
      aria-current={active ? "true" : undefined}
      disabled={picking}
      onClick={onClick}
      className={cn(
        "group/card flex w-(--build-card-width) shrink-0 flex-col gap-1.5 rounded-lg text-left outline-none disabled:cursor-default",
        NEW_CARD_MOTION,
        picking && "opacity-40",
      )}
    >
      {/* The frame the Stage last showed, taken from the game itself; before it has shown
          one, a quiet well, never another build's still. */}
      <span className="surface-well relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md">
        {still === null ? (
          <Text variant="caption" tone="muted">
            Now
          </Text>
        ) : (
          <>
            <img src={still} alt="" className="absolute inset-0 size-full object-cover" />
            <Text
              variant="micro"
              tone="inherit"
              render={
                <span className="absolute bottom-1.5 left-1.5 z-20 rounded-sm bg-black/65 px-1.5 py-px text-white" />
              }
            >
              Now
            </Text>
          </>
        )}
        <CardRing on={active && !picking} quiet={still === null} />
      </span>
      <Text
        variant="caption"
        tone={active ? "strong" : "default"}
        render={<span className="line-clamp-2 px-0.5" />}
      >
        {since}
      </Text>
    </button>
  );
}
