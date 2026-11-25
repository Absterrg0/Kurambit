import type {
  GameBuild,
  GameBuildId,
  GameBuildsResult,
  ScopedThreadRef,
} from "@kurambit/contracts";
import { AsyncResult } from "effect/reactivity";

import { cn } from "../../lib/utils";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuerySelector } from "../../state/query";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GameBuildStill } from "./GameBuildStill";

/** As many as fit on one line at the narrowest Stage; the rest wait in History. */
const STRIP_BUILDS = 10;

const stripOf = (result: AsyncResult.AsyncResult<GameBuildsResult, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : null;

/**
 * The game's builds under the Stage, as a filmstrip: each build's frame (or its number when it
 * has none), oldest to newest, the one on the Stage marked. A press does what History's row
 * does; past the strip's room, "+N" opens History. The same first page History reads.
 */
export function GameBuildStrip({
  threadRef,
  gameName,
  playing,
  onPlay,
  onMore,
}: {
  threadRef: ScopedThreadRef;
  gameName: string;
  /** The build on the Stage, when one is picked; else the folder's current build is marked. */
  playing: GameBuildId | null;
  onPlay: (build: GameBuild) => void;
  onMore: () => void;
}) {
  const list = useEnvironmentQuerySelector(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    stripOf,
  );
  if (list == null) return null;
  const numbered = list.builds.filter((build) => build.number !== null);
  if (numbered.length === 0) return null;
  const overflow = numbered.length > STRIP_BUILDS;
  const shown = numbered.slice(0, overflow ? STRIP_BUILDS - 1 : STRIP_BUILDS).toReversed();
  const marked = playing ?? list.current;
  return (
    <div data-game-build-strip="" className="flex h-12 min-w-0 items-center gap-1.5">
      {overflow ? (
        <button
          type="button"
          onClick={onMore}
          className="flex h-9 shrink-0 items-center rounded-md px-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Text variant="caption" tone="inherit" numeric>
            +{numbered.length - shown.length}
          </Text>
        </button>
      ) : null}
      {shown.map((build) => {
        const on = build.id === marked;
        return (
          <Tooltip key={build.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Play ${build.name}`}
                  aria-current={on ? "true" : undefined}
                  disabled={!build.available}
                  onClick={() => onPlay(build)}
                  className={cn(
                    "relative h-9 w-16 shrink-0 cursor-pointer overflow-hidden rounded-md outline-none transition-shadow focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50",
                    on ? "ring-2 ring-foreground" : "ring-1 ring-border hover:ring-foreground/40",
                  )}
                />
              }
            >
              <GameBuildStill
                threadRef={threadRef}
                gameName={gameName}
                build={build}
                mark="blank"
                className="absolute inset-0 size-full"
              />
              {/* The number stays readable over any frame. */}
              <span className="absolute start-1 bottom-0.5 rounded-sm bg-black/60 px-1 text-white">
                <Text variant="micro" tone="inherit" numeric>
                  {build.number}
                </Text>
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">{build.name}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
