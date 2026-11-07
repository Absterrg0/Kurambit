import { ColumnsIcon, PlayIcon } from "lucide-react";
import { gameFactsView, type GameBuild, type ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { refOf } from "./GameBuildDetail";
import { GameImage } from "./GameGenerationCard";
import { buildName } from "./gameBuilds.logic";
import { stepVerdictText } from "./keepGoing.logic";

/** The reel shows this many of Keep going's newest steps. */
const REEL_STEPS = 6;

/**
 * The build strip opened as a reel: Keep going's newest steps, each as the
 * build it started from and the build it made (the last frame of their
 * measured play), with its verdict. Play plays the step; Compare puts the two
 * side by side, playable, with their facts diffed.
 */
export function GameReel({
  threadRef,
  marks,
  onPlay,
  onCompare,
}: {
  threadRef: ScopedThreadRef;
  /** The strip's builds, oldest to newest. */
  marks: ReadonlyArray<GameBuild>;
  onPlay: (build: GameBuild) => void;
  onCompare: (pair: readonly [GameBuild, GameBuild]) => void;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const steps = marks
    .map((build, index) => ({ build, before: index > 0 ? (marks[index - 1] ?? null) : null }))
    .filter(({ build }) => build.source._tag === "turn" && build.source.step !== null)
    .slice(-REEL_STEPS);
  if (steps.length === 0)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Keep going's steps show here, each beside the build it started from.
      </p>
    );
  return (
    <div className="flex min-w-0 overflow-x-auto pb-1" aria-label="Keep going's steps">
      {steps.map(({ build, before }) => {
        const step = build.source._tag === "turn" ? build.source.step : null;
        const undone = step?.verdict === "undone";
        return (
          <section
            key={build.id}
            aria-label={buildName(build)}
            className="flex w-64 shrink-0 flex-col gap-1.5 border-border px-3 first:ps-0 [&+&]:border-l"
          >
            <div className="grid grid-cols-2 gap-1.5">
              <StepFrame threadRef={threadRef} root={root} build={before} label="Before" />
              <StepFrame
                threadRef={threadRef}
                root={root}
                build={build}
                label="After"
                dim={undone}
              />
            </div>
            <p className="truncate text-xs font-medium">
              <span className="me-1.5 font-mono font-normal text-muted-foreground">{step?.n}</span>
              {build.summary}
            </p>
            <p
              className={cn(
                "line-clamp-2 text-xs",
                step?.verdict === "kept" ? "text-success-foreground" : "text-muted-foreground",
              )}
            >
              {step === null ? "" : stepVerdictText(step)}
            </p>
            <div className="-ms-2 flex gap-0.5">
              <Button
                size="xs"
                variant="ghost"
                disabled={!build.available || build.noPlay !== null}
                onClick={() => onPlay(build)}
              >
                <PlayIcon className="fill-current" aria-hidden="true" />
                Play
              </Button>
              {before === null ? null : (
                <Button size="xs" variant="ghost" onClick={() => onCompare([before, build])}>
                  <ColumnsIcon aria-hidden="true" />
                  Compare
                </Button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A build's picture: the last frame of its measured random-input (or idle) play. */
function StepFrame({
  threadRef,
  root,
  build,
  label,
  dim = false,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  build: GameBuild | null;
  label: string;
  dim?: boolean;
}) {
  const facts = useEnvironmentQuery(
    build === null || !build.available
      ? null
      : gameEnvironment.buildFacts({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, build: refOf(build) },
        }),
  ).data;
  const frame =
    facts === null || facts === undefined
      ? null
      : (gameFactsView(facts)
          .flatMap((view) => view.evidence)
          .find((item) => item.kind === "frame")?.path ?? null);
  return (
    <figure className="flex min-w-0 flex-col gap-0.5">
      {frame === null ? (
        <span className="flex aspect-video items-center justify-center rounded-md bg-muted/60 text-2xs text-muted-foreground">
          {build === null ? "—" : "No frame yet"}
        </span>
      ) : (
        <GameImage
          environmentId={threadRef.environmentId}
          root={root}
          path={frame}
          alt={`${label}: ${build === null ? "" : buildName(build)}`}
          className={cn("aspect-video", dim && "opacity-55 saturate-50")}
        />
      )}
      <figcaption className="truncate text-2xs text-muted-foreground">
        {label} · {build === null ? "none" : buildName(build)}
      </figcaption>
    </figure>
  );
}
