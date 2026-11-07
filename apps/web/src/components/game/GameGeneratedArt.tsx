import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, ChevronDownIcon, ChevronRightIcon, MusicIcon } from "lucide-react";
import type { GameGeneration, ScopedThreadRef } from "@kurambit/contracts";

import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { Button } from "../ui/button";
import {
  GameGenerationBody,
  GameImage,
  GenerationHeading,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import {
  formatUsd,
  generationCostLine,
  generationResultImage,
  laneMedium,
} from "./gameGeneration.logic";

function Thumbnail({
  threadRef,
  root,
  generation,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  generation: GameGeneration;
}) {
  const image = generationResultImage(generation) ?? generation.candidates[0]?.preview ?? null;
  if (image !== null)
    return (
      <GameImage
        environmentId={threadRef.environmentId}
        root={root}
        path={image}
        alt=""
        className="size-12 shrink-0"
      />
    );
  const Icon = laneMedium(generation.lane) === "audio" ? MusicIcon : BoxIcon;
  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

/**
 * Every generation of the game, newest first: pick, cancel and find its files
 * here as in the chat's cards, and today's spend against the daily limit.
 */
export function GameGeneratedArt({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useGameGenerations(threadRef);
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const actions = useGenerationActions(threadRef);
  const navigate = useNavigate();
  // Waiting on a pick opens by default: that row needs the person.
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  const data = query.data;
  if (data === null)
    return (
      <p className="text-sm text-muted-foreground">
        {query.error ?? "Reading the game's generated art…"}
      </p>
    );
  const generations = data.generations.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const opened =
    open ??
    new Set(generations.filter((generation) => generation.state === "choosing").map((g) => g.id));
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Spent today {formatUsd(data.spentTodayUsd)} of your {formatUsd(data.dailyLimitUsd)} daily
          limit, across every game.
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => void navigate({ to: "/settings/general", hash: "art-providers" })}
        >
          Art providers settings
        </Button>
      </div>
      {generations.length === 0 ? (
        <p className="text-muted-foreground">
          Nothing generated yet. Ask the agent for key art, a character or a sound; it uses the art
          providers set up in Settings.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/70">
          {generations.map((generation) => {
            const expanded = opened.has(generation.id);
            const cost = generationCostLine(generation);
            return (
              <li key={generation.id} className="flex flex-col gap-2 px-3 py-2">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggle(generation.id)}
                  className="flex min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <Thumbnail threadRef={threadRef} root={root} generation={generation} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <GenerationHeading generation={generation} />
                    <span className="truncate text-xs text-muted-foreground">
                      {[
                        cost,
                        generation.files.length === 1
                          ? "1 file"
                          : generation.files.length > 1
                            ? `${generation.files.length} files`
                            : null,
                        new Date(generation.createdAt).toLocaleString(),
                      ]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                  </span>
                  {expanded ? (
                    <ChevronDownIcon className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </button>
                {expanded ? (
                  <GameGenerationBody
                    threadRef={threadRef}
                    root={root}
                    generation={generation}
                    actions={actions}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
