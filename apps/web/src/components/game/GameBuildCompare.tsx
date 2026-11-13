import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, PlayIcon, XIcon } from "lucide-react";
import {
  GameBuildId,
  gameChecksView,
  gameFactsView,
  type GameBuild,
  type GameBuildFacts,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameViewport,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { cn } from "../../lib/utils";
import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { CompareSideBadge, GameBuildFactsDiff } from "./GameBuildFacts";
import { GameBuildStill } from "./GameBuildStill";
import { refOf } from "./gameBuildRef";
import { GameFrame, GameFrameBox } from "./GamePlaySurface";
import { buildName, compareRows, formatBuildTime } from "./gameBuilds.logic";
import { isUndone } from "./gameBuildTimeline.logic";
import { useBuildPlay, useMeasureOnOpen } from "./useBuildActions";

const isBuildId = Schema.is(GameBuildId);
const allChecks = (facts: GameBuildFacts) => {
  const view = gameChecksView(facts);
  return [...view.checks, ...view.more];
};
const SIDES = ["A", "B"] as const;

/**
 * Two builds side by side, each playable from its own copy, with the diff of their facts. It
 * takes the Stage's and the strip's place in the column; its header (which build is A, which is
 * B, and Close) stays put while the facts scroll. Only one side runs, the one the Inspector
 * shows: the other is paused and muted.
 */
export function GameBuildCompare({
  threadRef,
  pair,
  viewport,
  gameName,
  hidden,
  inspectorOpen,
  onPair,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  pair: readonly [GameBuildRef, GameBuildRef];
  viewport: GameViewport;
  gameName: string;
  /** The Stage is not shown: both sides pause. */
  hidden: boolean;
  /** The Inspector is beside the compare, so its side can say "in the Inspector". */
  inspectorOpen: boolean;
  /** Another build picked for a side. */
  onPair: (pair: readonly [GameBuildRef, GameBuildRef]) => void;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.buildCompare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, a: pair[0], b: pair[1] },
    }),
  );
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const measure = useMeasureOnOpen(threadRef);
  // Only one side runs, and the Inspector shows it: the other is paused and muted.
  const [focused, setFocused] = useState<0 | 1>(0);
  const comparison = query.data;
  // Opening a compare measures a side that never was; the hook asks once per build.
  const unmeasuredKey =
    comparison === null
      ? ""
      : [
          comparison.a.available && comparison.factsA.state === "never" ? comparison.a.id : "",
          comparison.b.available && comparison.factsB.state === "never" ? comparison.b.id : "",
        ].join(" ");
  useEffect(() => {
    for (const id of unmeasuredKey.split(" ")) if (isBuildId(id)) void measure.send(id);
  }, [unmeasuredKey, measure]);
  // The Inspector follows the side picked here, named by its letter; closing hands it back.
  const threadKey = scopedThreadKey(threadRef);
  const inspectBuild = useGameWorkspaceStore((state) => state.inspectBuild);
  const shown = comparison === null ? null : focused === 0 ? comparison.a : comparison.b;
  useEffect(() => {
    if (shown === null) return;
    inspectBuild({ threadKey, build: shown.id, snapshot: shown, side: SIDES[focused] });
  }, [shown, focused, threadKey, inspectBuild]);
  useEffect(
    () => () => {
      const inspected = useGameWorkspaceStore.getState().inspectedBuild;
      if (inspected?.threadKey === threadKey && inspected.side !== undefined) inspectBuild(null);
    },
    [threadKey, inspectBuild],
  );
  const sides = comparison === null ? null : ([comparison.a, comparison.b] as const);
  const choices = (builds?.builds ?? []).filter((build) => build.available);
  const pick = (index: 0 | 1, build: GameBuild) => {
    const next: [GameBuildRef, GameBuildRef] = [pair[0], pair[1]];
    next[index] = refOf(build);
    setFocused(index);
    onPair(next);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The pair and the way out never scroll away. */}
      <header className="mx-auto flex w-full max-w-(--game-stage-column) shrink-0 items-center gap-2 px-3 pb-2">
        <Text variant="meta" tone="muted" render={<h2 className="shrink-0" />}>
          Compare
        </Text>
        {SIDES.map((side, index) => {
          const build = sides?.[index] ?? null;
          return (
            <Menu key={side}>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Side ${side}: ${build === null ? "loading" : buildName(build)}. Pick another build`}
                    className="min-w-0 shrink"
                  />
                }
              >
                <CompareSideBadge side={side} />
                <Text variant="meta" tone="strong" truncate>
                  {build === null ? "…" : buildName(build)}
                </Text>
                <ChevronDownIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="start" className="max-w-80">
                <MenuRadioGroup value={build?.id ?? ""}>
                  {choices.map((choice) => (
                    <MenuRadioItem
                      key={choice.id}
                      value={choice.id}
                      onClick={() => pick(index === 0 ? 0 : 1, choice)}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{buildName(choice)}</span>
                        <Text variant="caption" tone="muted">
                          {formatBuildTime(choice.at)}
                        </Text>
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          );
        })}
        <span className="min-w-2 flex-1" />
        <Button size="xs" variant="ghost" onClick={onClose}>
          <XIcon aria-hidden="true" />
          Close
        </Button>
      </header>
      {/* The facts scroll under a fade, so a cut row always reads as more below. */}
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-(--game-stage-column) flex-col gap-5 px-3 pb-4">
          {comparison === null || sides === null ? (
            query.error === null ? (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1].map((n) => (
                  <Skeleton key={n} shape="card" className="aspect-video w-full" />
                ))}
              </div>
            ) : (
              <Text variant="meta" tone="muted" render={<p />}>
                {query.error}
              </Text>
            )
          ) : (
            <>
              {/* Two panes side by side at every width: the column is never narrower than two
                  pictures a glance can read. */}
              <div className="grid grid-cols-2 gap-3">
                {sides.map((side, index) => (
                  <ComparePane
                    key={side.id}
                    threadRef={threadRef}
                    build={side}
                    side={SIDES[index] ?? "A"}
                    viewport={viewport}
                    gameName={gameName}
                    shown={focused === index}
                    inspectorOpen={inspectorOpen}
                    undone={builds !== null && isUndone(side, builds)}
                    playing={!hidden && focused === index}
                    onFocus={() => setFocused(index === 0 ? 0 : 1)}
                  />
                ))}
              </div>
              <GameBuildFactsDiff
                compared={compareRows(
                  comparison.deltas,
                  gameFactsView(comparison.factsA),
                  gameFactsView(comparison.factsB),
                  { a: allChecks(comparison.factsA), b: allChecks(comparison.factsB) },
                )}
              />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ComparePane({
  threadRef,
  build,
  side,
  viewport,
  gameName,
  shown,
  inspectorOpen,
  playing,
  undone,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  side: "A" | "B";
  viewport: GameViewport;
  gameName: string;
  /** The side the Inspector shows, outlined as the strip outlines the build on the Stage. */
  shown: boolean;
  inspectorOpen: boolean;
  /** Its copy plays; the other side's is paused and muted. */
  playing: boolean;
  /** An Undo took it out of the game; it is compared all the same. */
  undone: boolean;
  onFocus: () => void;
}) {
  const plays = useBuildPlay(threadRef);
  const [result, setResult] = useState<GameBuildPlayResult | null>(null);
  const ref = refOf(build);
  const play = async () => {
    onFocus();
    setResult(await plays.send(ref));
  };
  const url = result?._tag === "web" ? result.url : null;
  const label = `${side} · ${buildName(build)}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" onPointerDown={onFocus} onFocusCapture={onFocus}>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-stage-well [container-type:size]">
        {url !== null ? (
          <GameFrameBox viewport={viewport} gameName={gameName} playing>
            <GameFrame
              url={url}
              title={`${gameName}, ${label}`}
              gameName={gameName}
              hidden={!playing}
            />
          </GameFrameBox>
        ) : (
          <>
            {/* The build's own picture is its poster. */}
            <GameBuildStill
              threadRef={threadRef}
              gameName={gameName}
              build={build}
              // The Play pill sits where a title card's name would: a picture-less side is its
              // pigment only, and the caption under it names the build.
              mark="none"
              className="absolute inset-0"
            />
            {/* Play waits in a corner, off the picture being compared. */}
            <div className="absolute inset-0 flex flex-col items-start justify-end gap-2 p-2 text-left">
              {result?._tag === "window" ? (
                <Text
                  variant="meta"
                  tone="inherit"
                  render={<p className="rounded-md bg-black/70 px-2 py-1 text-stage-foreground" />}
                >
                  {result.message}
                </Text>
              ) : build.noPlay !== null ? (
                <Text
                  variant="meta"
                  tone="inherit"
                  render={<p className="rounded-md bg-black/70 px-2 py-1 text-stage-foreground" />}
                >
                  {build.noPlay}
                </Text>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!build.available || !plays.canPlay || plays.playing(ref)}
                  onClick={() => void play()}
                >
                  <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                  {plays.playing(ref) ? "Starting…" : `Play ${side}`}
                </Button>
              )}
              {plays.error(ref) ? (
                <Text
                  variant="caption"
                  tone="inherit"
                  render={
                    <p
                      role="alert"
                      className="rounded-md bg-black/70 px-2 py-1 text-stage-foreground"
                    />
                  }
                >
                  {plays.error(ref)}
                </Text>
              ) : null}
            </div>
          </>
        )}
        <span className="pointer-events-none absolute top-1.5 left-1.5 z-20">
          <CompareSideBadge side={side} />
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 rounded-md ring-inset",
            shown ? "ring-2 ring-strong-foreground" : "ring-1 ring-border",
          )}
        />
      </div>
      <Text variant="meta" tone="muted" numeric truncate render={<p />}>
        {/* Name, then its states, then its time: the same order on both sides. */}
        {[
          buildName(build),
          undone ? "undone" : null,
          shown && inspectorOpen ? "in the Inspector" : null,
          formatBuildTime(build.at),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </Text>
    </div>
  );
}
