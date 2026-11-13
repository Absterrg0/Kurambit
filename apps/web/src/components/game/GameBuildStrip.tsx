import {
  createContext,
  Fragment,
  use,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { cn } from "../../lib/utils";
import { gameEnvironment, olderBuildPages } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { Button } from "../ui/button";
import { Separated } from "../ui/separated";
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
import {
  isUndone,
  stageBuildId,
  markLabels,
  stepMark,
  timelineMarks,
} from "./gameBuildTimeline.logic";

/** Below this picture height a card is compact: a shorter picture, and one line of its request
 * where a full card has two. */
const COMPACT_CARD_PICTURE = 80;
/** About how many characters a card's two request lines show. */
const CARD_REQUEST_FITS = 48;
/** About how wide a caption's character is, for the one request line of a compact card. */
const CAPTION_CHARACTER = 6.6;

/**
 * PURE. A request short enough for a card's caption (`fits` characters), ended at a word: a
 * deliberate short form rather than a line clamp's cut mid-word. The card's tooltip gives it whole.
 */
const cardRequest = (request: string, fits: number) => {
  if (request.length <= fits) return request;
  const cut = request.slice(0, fits - 1);
  const word = cut.lastIndexOf(" ");
  // Ended on a word that carries something: never on "a" or "the" with nothing after it.
  return `${(word > fits / 2 ? cut.slice(0, word) : cut)
    .replace(/(\s+(a|an|the|to|of|and|or))+$/i, "")
    .replace(/[\s,;:.]+$/, "")}…`;
};
/** How many characters of a request this strip's cards show. */
const CardRequestFits = createContext(CARD_REQUEST_FITS);
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
  /** What its picture says while it is made ("Making build 3"). */
  readonly label: string;
  /** Its name, as its card will be named once it lands ("Build 3"). */
  readonly name: string;
  /** What was asked for, when known. */
  readonly caption: string | null;
  /** Keep going is making it: the slot sits under the run's bracket. */
  readonly keepGoing: boolean;
  /** The turn has ended and the build is being saved, a moment before its card replaces this. */
  readonly saving?: boolean;
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
  cardPicture,
  onInspect,
  hidden = false,
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
  /** The cards' picture height: 16:9 of their width, or shorter on a short window. */
  cardPicture: number;
  /** Shows a build in the Inspector's Build tab. */
  onInspect: (build: GameBuild) => void;
  /** Something else (a compare) has the strip's place: it stays mounted, out of sight. */
  hidden?: boolean;
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
  // Which ends of the row have cards scrolled past them, for a fade on that edge only.
  const [clipped, setClipped] = useState<"none" | "start" | "end" | "both">("none");
  const readClipped = useStableCallback(() => {
    const row = cardsRef.current;
    if (row === null) return;
    const start = row.scrollLeft > 1;
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setClipped(start && end ? "both" : start ? "start" : end ? "end" : "none");
  });
  // The card a person is looking for is whole in view: the one being made while a turn runs,
  // else the one on the Stage. It is brought into view when a build lands or a turn starts,
  // and when the row's width changes, unless the person has scrolled the row themselves.
  const newest = marks.at(-1)?.id ?? "";
  const slotShown = slot !== null;
  const browsed = useRef(false);
  const placed = useRef<number | null>(null);
  const reveal = useStableCallback(() => {
    const row = cardsRef.current;
    if (row === null) return;
    const card =
      (slotShown ? row.querySelector<HTMLElement>("[data-game-build-slot]") : null) ??
      row.querySelector<HTMLElement>('[aria-current="true"]') ??
      (row.lastElementChild instanceof HTMLElement ? row.lastElementChild : null);
    if (card === null) return;
    const left = card.offsetLeft - row.offsetLeft;
    const right = left + card.offsetWidth;
    let next = row.scrollLeft;
    if (right > row.scrollLeft + row.clientWidth) next = right - row.clientWidth;
    if (left < next) next = left;
    row.scrollLeft = next;
    // Where the row actually is: the browser clamps past its end, and a clamped value read as
    // the person scrolling would stop the row being placed again.
    placed.current = row.scrollLeft;
    // The edge fades follow at once, not on the scroll event a frame later.
    readClipped();
  });
  const stageKey = stageBuildId(list, playing);
  useEffect(() => {
    browsed.current = false;
    reveal();
    // Again once a new card has its size (it grows in).
    const later = window.setTimeout(reveal, 400);
    return () => window.clearTimeout(later);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a landing, a new slot or the Stage's build changing is when the row is placed again.
  }, [newest, slotShown, stageKey, reveal]);
  useEffect(() => {
    const row = cardsRef.current;
    if (row === null) return;
    return observeResize([row], () => {
      if (!browsed.current) reveal();
    });
  }, [reveal]);
  const onRowScroll = () => {
    const row = cardsRef.current;
    // A scroll the row did not place itself is the person browsing: leave them where they are.
    if (row !== null && placed.current !== null && Math.abs(row.scrollLeft - placed.current) > 2)
      browsed.current = true;
    readClipped();
  };
  useEffect(() => {
    const row = cardsRef.current;
    if (row === null) return;
    readClipped();
    return observeResize([row, ...row.children], readClipped);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the cards in the row change its scroll width.
  }, [readClipped, newest, slotShown, cardWidth, marks.length]);

  // A compare with one possible other side needs no pick: it opens at once.
  const startCompare = (first: GameBuildRef | "any") => {
    const others = marks.filter(
      (entry) => entry.available && (first === "any" || !sameRef(first, entry)),
    );
    const only =
      first === "any" ? (others.length === 2 ? others : null) : others.length === 1 ? others : null;
    if (only === null) setPicking(first);
    else if (first === "any") onCompare([refOf(only[0]!), refOf(only[1]!)]);
    else onCompare([first, refOf(only[0]!)]);
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

  // Escape gives a pick up; the strip's own bar is the one place that says what it waits for.
  const firstPicked =
    picking === null || picking === "any"
      ? null
      : (marks.find((entry) => sameRef(picking, entry)) ?? null);
  const pickingFirstName = firstPicked === null ? null : buildName(firstPicked);
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
  const compact = cardPicture < COMPACT_CARD_PICTURE;
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
        copy={playing === build.id}
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
        threadRef={threadRef}
        gameName={gameName}
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
      hidden={hidden}
      className="group/strip mx-auto flex w-full max-w-(--game-stage-column) shrink-0 flex-col gap-1.5 px-3 pt-2.5 pb-1.5"
      // The Stage sizes the cards: wider pictures take the height the game's shape leaves over.
      style={
        {
          "--build-card-width": `${cardWidth}px`,
          "--build-card-picture": `${cardPicture}px`,
        } as CSSProperties
      }
      // Compact cards (a short window) have a shorter picture and one line of their request, so
      // the Stage keeps the height and a build is still told by what was asked.
      data-compact={compact ? "true" : undefined}
    >
      <CardRequestFits
        value={compact ? Math.floor(cardWidth / CAPTION_CHARACTER) : CARD_REQUEST_FITS}
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
          <div className="flex h-7 min-w-0 items-center gap-2 rounded-md bg-accent ps-2.5 pe-1 motion-popup transition-[opacity,translate] starting:-translate-y-1 starting:opacity-0">
            <GitCompareIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
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
            {/* How many builds the lane holds, so a row that scrolls says it has more. */}
            <Text variant="meta" tone="muted" numeric>
              {marks.length > 0 ? `Builds · ${marks.length}` : "Builds"}
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
                  startCompare(onStage === null ? "any" : { _tag: "build", build: onStage })
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
          onScroll={onRowScroll}
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
                  <Skeleton shape="card" className="h-(--build-card-picture) w-full" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))
            )
          ) : marks.length === 0 && slot === null ? (
            <FirstBuildSlot still={still} gameName={gameName} />
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
      </CardRequestFits>
    </section>
  );
}

/** A 40px fade on each edge the row has scrolled cards past, so a cut card reads as more. */
const edgeFade = (clipped: "start" | "end" | "both") =>
  `linear-gradient(to right, ${clipped === "end" ? "black" : "transparent"}, black 40px, black calc(100% - 40px), ${clipped === "start" ? "black" : "transparent"})`;

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
  copy,
  undone,
  picking,
  picked,
  onClick,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  build: GameBuild;
  /** It plays on the Stage from a copy, not the folder. */
  copy: boolean;
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
  const requestFits = use(CardRequestFits);
  const checks = checksLine(build.facts);
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
              // A pruned build has nothing to open and steps back; an undone one keeps its caption
              // readable, its word and strike saying what it is, and only its picture recedes.
              !build.available && "opacity-40",
            )}
          />
        }
      >
        <GameBuildStill
          threadRef={threadRef}
          gameName={gameName}
          build={build}
          title={buildName(build)}
          mark="name"
          className={cn(
            "h-(--build-card-picture) w-full rounded-md",
            undone && "opacity-50 saturate-50",
          )}
        >
          <CardRing
            on={picking ? false : onStage}
            pick={picked ? "picked" : picking ? "pickable" : null}
          />
          {picked ? <PickBadge /> : null}
          {/* Now stays Now; the build the Stage plays instead says so on its own picture. */}
          {copy && !picking ? <PictureChip>Playing</PictureChip> : null}
        </GameBuildStill>
        {/* Two lines, always both used: what it was, then which one (its name and time), so
            two cards with the same picture still tell apart and no caption line sits empty. */}
        {/* A person's or a step's build leads with its name, the one thing that tells two apart
            for good, and says "undone" in words; what was asked is its caption. A saved build's
            label already is its name, so its time is the caption. */}
        <CardCaption
          strong={onStage}
          title={
            <span className={cn(undone && "line-through")}>
              {name === null || build.source._tag === "saved" ? caption : name}
            </span>
          }
          // An undone build's state is that it is undone; its checks describe a game no longer
          // on the Stage, so they do not compete with the current build's.
          aside={undone ? "Undone" : checkDelta(build, previous)}
          meta={
            <>
              {step === null ? null : (
                <FastForwardIcon className="me-1 inline size-3 align-[-1px]" aria-hidden="true" />
              )}
              {name === null || build.source._tag === "saved"
                ? formatBuildTime(build.at)
                : cardRequest(caption, requestFits)}
            </>
          }
        />
      </TooltipTrigger>
      {/* Over the card, never across the composer; from the card's own left edge, so the first
          card's never crosses into the sidebar. */}
      <TooltipPopup side="top" align="start" className="max-w-xl">
        {/* One shape on every card: what it is in full, then how it measured. One line when it
            is short, so it sits in the gap under the Stage. Its time is in the caption or the
            Inspector. */}
        <Separated>
          <span>{caption}</span>
          {checks === null ? null : (
            <span className="whitespace-nowrap text-muted-foreground">{checks}</span>
          )}
        </Separated>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A card's two caption lines, at the size a person reads a build by. */
function CardCaption({
  title,
  aside = null,
  meta,
  strong,
}: {
  title: ReactNode;
  /** The card's state beside its name ("Being made", a check count, "Undone"), so every card
   * reads `name · state` over its request. */
  aside?: ReactNode;
  meta: ReactNode;
  strong: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <Text
          variant="meta"
          tone={strong ? "strong" : "default"}
          truncate
          render={<span className="max-w-full min-w-0" />}
        >
          {title}
        </Text>
        {aside === null ? null : (
          <Text
            variant="meta"
            tone="muted"
            numeric
            render={<span className="ms-auto flex shrink-0" />}
          >
            {aside}
          </Text>
        )}
      </span>
      {/* What was asked, wrapping at words, the same height on every card: two lines, or one on
          a compact card. A request is read, not cut to a fragment, and the strip keeps one
          height. */}
      <Text
        variant="meta"
        tone="muted"
        numeric
        render={
          <span className="line-clamp-2 min-h-[2lh] min-w-0 group-data-[compact=true]/strip:line-clamp-1 group-data-[compact=true]/strip:min-h-lh" />
        }
      >
        {meta}
      </Text>
    </span>
  );
}

// The base ring is inset, so both rings lie on the picture: 2px of ink at its edge over 4px of
// page colour, which shows as a 2px gap inside the ink.
const CHOSEN_RING = "inset-ring-2 inset-ring-strong-foreground ring-4 ring-background";

/** The outline of the card on the Stage, drawn over the picture so it is never covered. */
function CardRing({
  on,
  pick = null,
}: {
  on: boolean;
  /** While a compare is picked: the first build, or one that can be picked next. */
  pick?: "picked" | "pickable" | null;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 rounded-md ring-inset",
        // Keyboard focus: a white frame set in from the edge, with a dark hairline on each side
        // of it, so it reads on any picture in both themes and beside the chosen card's ring.
        // It is drawn here above the picture, inside the card, so the scrolling lane never
        // clips it and it never crosses the caption.
        "-outline-offset-6 group-focus-visible/card:outline-2 group-focus-visible/card:outline-white group-focus-visible/card:outline-solid",
        "before:pointer-events-none before:absolute before:inset-[3px] before:rounded-sm before:opacity-0 before:ring-1 before:ring-black/70 before:ring-inset group-focus-visible/card:before:opacity-100",
        "after:pointer-events-none after:absolute after:inset-[6px] after:rounded-xs after:opacity-0 after:ring-1 after:ring-black/70 after:ring-inset group-focus-visible/card:after:opacity-100",
        // The chosen card: an ink ring on the picture's edge and a page-colour one just inside
        // it, so the mark reads on any picture in both themes (a dark ring alone is lost on a
        // dark picture). Hover is one thin ring, always the weaker mark.
        pick === "picked"
          ? CHOSEN_RING
          : pick === "pickable"
            ? "ring-1 ring-foreground/35 group-hover/card:ring-2 group-hover/card:ring-foreground/70"
            : on
              ? CHOSEN_RING
              : "ring-1 ring-border group-hover/card:ring-foreground/45",
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
 * What changed in the checks since the build before, over the checks both measured: the thing
 * keep going decides on. While a build is being measured it says only that; a build with
 * something to look at says so, and only that; one that only repeats the count before it says
 * nothing.
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
  // A build that does not start is its own outcome, not one more check to look at.
  if (doesNotStart(build.facts))
    return (
      <span className="flex shrink-0 items-center gap-1 text-destructive-foreground">
        <TriangleAlertIcon aria-hidden="true" className="size-3 text-destructive" />
        Does not start
      </span>
    );
  const bad = build.facts.bad;
  const gained = passDelta(build, previous) ?? 0;
  if (bad === 0 && gained === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {bad > 0 ? (
        // The Inspector's mark and words for it, so the strip's verdict reads without a key.
        <span className="flex items-center gap-1 text-warning-foreground">
          <TriangleAlertIcon aria-hidden="true" className="size-3 text-warning" />
          {bad} to look at
        </span>
      ) : null}
      {/* One phrase beside the name: something to look at says it alone, and the count's
          change is in the card's tooltip. */}
      {gained !== 0 && bad === 0 ? (
        <span
          className={gained > 0 ? "text-success-foreground" : "text-warning-foreground"}
          aria-label={`${Math.abs(gained)} ${gained > 0 ? "more" : "fewer"} checks pass`}
        >
          {gained > 0 ? `+${gained}` : `−${Math.abs(gained)}`} pass
        </span>
      ) : null}
    </span>
  );
}

/**
 * Before the first build: the game as it looks so far (the Stage's last frame, else its name on
 * its pigment), at the smallest card size, so an empty slot is never the largest thing here.
 */
function FirstBuildSlot({ still, gameName }: { still: string | null; gameName: string }) {
  return (
    // A slot to the Stage's fit, which reads a card's picture height from it.
    <div data-game-build-slot="" className="flex w-(--build-card-width) shrink-0 flex-col gap-1.5">
      <GameNowPicture
        still={still}
        gameName={gameName}
        fallback={null}
        threadRef={null}
        className="h-(--build-card-picture) w-full rounded-md"
      >
        {/* It is what the Stage shows, marked as every card on the Stage is. */}
        <CardRing on />
      </GameNowPicture>
      <CardCaption strong title="Now" meta="The game so far" />
    </div>
  );
}

/** The build being made: a dashed slot with its elapsed time. */
function SlotCard({ slot }: { slot: GameBuildSlot }) {
  const requestFits = use(CardRequestFits);
  return (
    <div
      data-game-build-slot=""
      className={cn("flex w-(--build-card-width) shrink-0 flex-col gap-1.5", NEW_CARD_MOTION)}
    >
      <div className="flex h-(--build-card-picture) w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-live/60 bg-live/8">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
        <Text variant="meta" tone="default">
          {slot.label}
        </Text>
      </div>
      <CardCaption
        strong={false}
        // Its picture says what is happening to it, in the top bar's and the sidebar's words
        // ("Making build 3"), once: the caption is its name and what was asked.
        title={slot.name}
        meta={slot.caption === null ? "" : cardRequest(slot.caption, requestFits)}
      />
    </div>
  );
}

/** The game folder when it is no build: edited since, or another build plays from a copy. */
function NowCard({
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
  /** The folder's game's last frame on the Stage, once it has shown one. */
  still: string | null;
  active: boolean;
  /** Now is no build, so a compare cannot pick it: it steps back while one is picked. */
  picking: boolean;
  onClick: () => void;
}) {
  const current = list.builds.find((build) => build.id === list.current) ?? null;
  const changed = list.folderEdited === true;
  // The top bar names the build it changed since; the card says only what Now is.
  // Name and state, then what it is: "Now · Not measured", over "Changed since Values kept".
  const meta = changed
    ? `Changed since ${current === null ? "the last build" : buildName(current)}`
    : "The current game";
  const borrowed = changed && still === null && current !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-game-build-card="now"
            aria-current={active ? "true" : undefined}
            aria-label={`Now: ${
              changed
                ? `changed since ${current === null ? "the last build" : buildName(current)}, not measured`
                : "the current game"
            }`}
            disabled={picking}
            onClick={onClick}
            className={cn(
              "group/card flex w-(--build-card-width) shrink-0 flex-col gap-1.5 rounded-lg text-left outline-none disabled:cursor-default",
              NEW_CARD_MOTION,
              picking && "opacity-40",
            )}
          />
        }
      >
        <GameNowPicture
          still={still}
          gameName={gameName}
          fallback={changed ? current : null}
          threadRef={threadRef}
          className="group/now h-(--build-card-picture) w-full rounded-md"
        >
          {borrowed && current !== null ? (
            // The picture is that build's until the Stage shows the game: it says whose, in the
            // tooltip's words, once the picture it names is there.
            <Text
              variant="micro"
              tone="inherit"
              truncate
              render={
                <span className="absolute top-1.5 left-1.5 z-20 max-w-[calc(100%-0.75rem)] rounded-sm bg-black/55 px-1.5 py-px text-white/80 opacity-0 transition-opacity motion-surface group-has-[[data-picture-loaded]]/now:opacity-100" />
              }
            >
              Picture from {buildName(current)}
            </Text>
          ) : null}
          <CardRing on={active && !picking} />
        </GameNowPicture>
        <CardCaption
          strong={active}
          title="Now"
          aside={changed ? "Not measured" : null}
          meta={meta}
        />
      </TooltipTrigger>
      {/* The cards' tooltip shape: what it is, then what is true of it, on one line. */}
      <TooltipPopup side="top" align="end" className="max-w-xl">
        <Separated nowrap>
          <span>Now</span>
          <span className="text-muted-foreground">
            {changed
              ? `changed since ${current === null ? "the last build" : buildName(current)}`
              : "the game as it is"}
          </span>
          {borrowed && current !== null ? (
            <span className="text-muted-foreground">picture from {buildName(current)}</span>
          ) : null}
        </Separated>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A chip at a card picture's foot: what this card is (Now) or does (Playing). */
function PictureChip({ children }: { children: ReactNode }) {
  return (
    <Text
      variant="micro"
      tone="inherit"
      render={
        <span className="absolute bottom-1.5 left-1.5 z-20 flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-px text-white" />
      }
    >
      {children}
    </Text>
  );
}
