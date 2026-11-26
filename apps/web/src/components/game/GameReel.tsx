import { PlayIcon } from "lucide-react";
import { gameFactsView, type GameBuild, type ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { refOf } from "./gameBuildRef";
import { GameImage } from "./GameImage";
import { reelHeading, reelSteps, stepVerdictText } from "./keepGoing.logic";

/**
 * The build strip opened as a reel: Keep going's run, step by step, each as the
 * build it started from and the build it made (the last frame of their measured
 * play), what it changed and its verdict, so a run left going overnight reads in
 * the morning. Play plays the step.
 */
export function GameReel({
  threadRef,
  marks,
  firstStep,
  onPlay,
}: {
  threadRef: ScopedThreadRef;
  /** The strip's builds, oldest to newest. */
  marks: ReadonlyArray<GameBuild>;
  /** The game's latest run's first step; null shows the newest few. */
  firstStep: number | null;
  onPlay: (build: GameBuild) => void;
}) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const steps = reelSteps(marks, firstStep);
  if (steps.length === 0)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Keep going's steps show here, each beside the build it started from.
      </p>
    );
  return (
    <section aria-label="Keep going's steps" className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted-foreground">{reelHeading(marks, firstStep)}</p>
      <ol className="flex max-h-[26rem] min-w-0 flex-col overflow-y-auto">
        {steps.map(({ build, before }) => {
          const step = build.source._tag === "turn" ? build.source.step : null;
          const undone = step?.verdict === "undone";
          return (
            <li
              key={build.id}
              aria-label={build.name}
              className="grid grid-cols-[13rem_minmax(0,1fr)] gap-3 border-border py-2 first:pt-0 [&+&]:border-t"
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
              <div className="flex min-w-0 flex-col gap-1">
                <p className="line-clamp-2 text-xs font-medium">
                  <span className="me-1.5 font-mono font-normal text-muted-foreground">
                    {step?.n}
                  </span>
                  {step?.move || build.summary}
                </p>
                {step?.move && build.summary !== "" ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{build.summary}</p>
                ) : null}
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
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * A build's picture: a frame of its measured play, else the still its strip card shows. Without
 * either it says whether one may still come (its measure is queued or running) or never will.
 */
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
    (facts === null || facts === undefined
      ? null
      : (gameFactsView(facts)
          .flatMap((view) => view.evidence)
          .find((item) => item.kind === "frame")?.path ?? null)) ??
    build?.still ??
    null;
  const coming = build?.facts.state === "queued" || build?.facts.state === "measuring";
  return (
    <figure className="flex min-w-0 flex-col gap-0.5">
      {frame === null ? (
        <span className="flex aspect-video items-center justify-center rounded-md bg-muted/60 text-micro text-muted-foreground">
          {build === null ? "—" : coming ? "No frame yet" : "No frame was made"}
        </span>
      ) : (
        <GameImage
          environmentId={threadRef.environmentId}
          root={root}
          path={frame}
          alt={`${label}: ${build === null ? "" : build.name}`}
          className={cn("aspect-video", dim && "opacity-55 saturate-50")}
        />
      )}
      <figcaption className="truncate text-micro text-muted-foreground">
        {label} · {build === null ? "none" : build.name}
      </figcaption>
    </figure>
  );
}
