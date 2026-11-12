import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { GitCompareIcon, PlayIcon, XIcon } from "lucide-react";
import {
  GameBuildId,
  type GameBuild,
  type GameBuildPlayResult,
  type GameBuildRef,
  type GameViewport,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { GameBuildFactsDiff } from "./GameBuildFacts";
import { refOf } from "./gameBuildRef";
import { GameFrame, GameFrameBox } from "./GamePlaySurface";
import { buildName, formatBuildTime } from "./gameBuilds.logic";
import { useBuildPlay, useMeasureOnOpen } from "./useBuildActions";

const isBuildId = Schema.is(GameBuildId);

/**
 * Two builds side by side, each playable from its own copy, with the diff of
 * their facts. Only one side runs: the other is paused and muted.
 */
export function GameBuildCompare({
  threadRef,
  pair,
  viewport,
  gameName,
  compact,
  hidden,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  pair: readonly [GameBuildRef, GameBuildRef];
  viewport: GameViewport;
  gameName: string;
  compact: boolean;
  /** The Stage is not shown: both sides pause. */
  hidden: boolean;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    gameEnvironment.buildCompare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, a: pair[0], b: pair[1] },
    }),
  );
  const measure = useMeasureOnOpen(threadRef);
  // Only one side runs: the other is paused and muted, so two engines never draw at once.
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
  if (comparison === null)
    return <p className="text-xs text-muted-foreground">{query.error ?? "Reading both builds…"}</p>;
  const sides = [comparison.a, comparison.b] as const;
  const labels = [`A · ${buildName(comparison.a)}`, `B · ${buildName(comparison.b)}`] as const;
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <GitCompareIcon className="size-4 shrink-0" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          {labels[0]} against {labels[1]}
        </h3>
        <Button size="xs" variant="ghost" onClick={onClose}>
          <XIcon aria-hidden="true" />
          Close
        </Button>
      </header>
      {compact ? (
        <div className="flex gap-1">
          {sides.map((side, index) => (
            <Button
              key={side.id}
              size="xs"
              variant={focused === index ? "secondary" : "ghost"}
              aria-pressed={focused === index}
              onClick={() => setFocused(index === 0 ? 0 : 1)}
            >
              {index === 0 ? "A" : "B"}
            </Button>
          ))}
        </div>
      ) : null}
      <div className={cn("grid gap-3", compact ? "grid-cols-1" : "grid-cols-2")}>
        {sides.map((side, index) =>
          compact && focused !== index ? null : (
            <ComparePane
              key={side.id}
              threadRef={threadRef}
              build={side}
              label={labels[index] ?? ""}
              viewport={viewport}
              gameName={gameName}
              focused={!hidden && focused === index}
              onFocus={() => setFocused(index === 0 ? 0 : 1)}
            />
          ),
        )}
      </div>
      <GameBuildFactsDiff deltas={comparison.deltas} labels={["A", "B"]} />
    </div>
  );
}

function ComparePane({
  threadRef,
  build,
  label,
  viewport,
  gameName,
  focused,
  onFocus,
}: {
  threadRef: ScopedThreadRef;
  build: GameBuild;
  label: string;
  viewport: GameViewport;
  gameName: string;
  focused: boolean;
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
  return (
    <div className="space-y-1.5" onPointerDown={onFocus} onFocusCapture={onFocus}>
      <p className="truncate text-2xs text-muted-foreground">
        {label} · {formatBuildTime(build.at)}
      </p>
      <div className="flex aspect-video items-center justify-center [container-type:size]">
        <GameFrameBox viewport={viewport} gameName={gameName} playing={url !== null}>
          {url !== null ? (
            <GameFrame
              url={url}
              title={`${gameName}, ${label}`}
              gameName={gameName}
              hidden={!focused}
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
              {result?._tag === "window" ? (
                <p className="text-xs text-washi/90">{result.message}</p>
              ) : build.noPlay !== null ? (
                <p className="text-xs text-washi/90">{build.noPlay}</p>
              ) : (
                <Button
                  size="sm"
                  disabled={!build.available || !plays.canPlay || plays.playing(ref)}
                  onClick={() => void play()}
                >
                  <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                  {plays.playing(ref) ? "Starting…" : "Play"}
                </Button>
              )}
              {plays.error(ref) ? (
                <p role="alert" className="text-2xs text-washi/90">
                  {plays.error(ref)}
                </p>
              ) : null}
            </div>
          )}
        </GameFrameBox>
      </div>
    </div>
  );
}
