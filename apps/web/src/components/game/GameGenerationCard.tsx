import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { AsyncResult, Atom } from "effect/reactivity";
import { BoxIcon, CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import {
  EnvironmentId,
  ThreadId,
  type GameGeneration,
  type GameGenerationsResult,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useGameStageAccess } from "../../hooks/useGameStageAccess";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { cn } from "../../lib/utils";
import type { TimelineAnchoredCard } from "../../session-logic";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { GameElapsed } from "./GameElapsed";
import { GameFileActions } from "./GameSavedMedia";
import {
  GAME_ART_LANE_LABELS,
  chatGenerationCardKey,
  fileName,
  generationCostLine,
  generationResultImage,
  laneMedium,
  providerLabel,
  stepCandidate,
} from "./gameGeneration.logic";

type GenerationsResult = AsyncResult.AsyncResult<GameGenerationsResult, unknown>;

const generationsTarget = (threadRef: ScopedThreadRef) =>
  gameEnvironment.generations({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });

/** The game's generations, read once per game thread and reread on its art pushes. */
export const useGameGenerations = (threadRef: ScopedThreadRef | null) =>
  useEnvironmentQuery(threadRef === null ? null : generationsTarget(threadRef));

// The timeline compares its anchored cards by identity: one array per key.
const EMPTY_CARDS: ReadonlyArray<TimelineAnchoredCard> = [];
let lastCards: { readonly key: string; readonly cards: ReadonlyArray<TimelineAnchoredCard> } = {
  key: "",
  cards: EMPTY_CARDS,
};
const cardsOf = (key: string): ReadonlyArray<TimelineAnchoredCard> => {
  if (key === "") return EMPTY_CARDS;
  if (lastCards.key === key) return lastCards.cards;
  const cards = key.split("\u0002").map((part) => {
    const [generationId = "", createdAt = ""] = part.split("\u0001");
    return {
      kind: "game-generation" as const,
      id: `game-generation:${generationId}`,
      createdAt,
      generationId,
    };
  });
  lastCards = { key, cards };
  return cards;
};

const NO_KEY = Atom.make("");
const cardKeyAtom = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\0");
  return Atom.make((get) => {
    const result: GenerationsResult = get(
      gameEnvironment.generations({
        environmentId: EnvironmentId.make(environmentId),
        input: { threadId: ThreadId.make(threadId) },
      }),
    );
    return AsyncResult.isSuccess(result)
      ? chatGenerationCardKey(result.value.generations, threadId)
      : "";
  }).pipe(Atom.withLabel(`game:generation-cards:${key}`));
});

/**
 * One card per generation this chat's agent started, placed at its start.
 * Read from the game's generations, never from the tool calls' text, so a
 * pick from another client or the Generated art view shows here too.
 */
export function useGameGenerationCards(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelineAnchoredCard> {
  const key = useAtomValue(
    threadRef === null ? NO_KEY : cardKeyAtom(`${threadRef.environmentId}\0${threadRef.threadId}`),
  );
  return cardsOf(key);
}

/** Pick and Cancel for a game's generations, as the chat card and the Generated art view share them. */
export function useGenerationActions(threadRef: ScopedThreadRef) {
  const choose = useAtomCommand(gameEnvironment.chooseGeneration, { reportFailure: false });
  const cancel = useAtomCommand(gameEnvironment.cancelGeneration, { reportFailure: false });
  const canChoose = useAtomValue(
    gameEnvironment.chooseGeneration.permissionAtom(threadRef.environmentId),
  );
  const canCancel = useAtomValue(
    gameEnvironment.cancelGeneration.permissionAtom(threadRef.environmentId),
  );
  // A run's role thread never writes beside the run.
  const writer = useGameStageAccess(threadRef) === "writer";
  const generations = useGameGenerations(threadRef);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const run = async (
    id: string,
    send: () => Promise<Awaited<ReturnType<typeof choose>> | Awaited<ReturnType<typeof cancel>>>,
  ) => {
    if (pending !== null) return;
    setPending(id);
    setError(null);
    const result = await send();
    setPending(null);
    if (result._tag === "Failure") setError({ id, text: String(squashAtomCommandFailure(result)) });
    generations.refresh();
  };
  return {
    canChoose: canChoose && writer,
    canCancel: canCancel && writer,
    pending,
    errorFor: (id: string) => (error?.id === id ? error.text : null),
    choose: (id: string, candidate: number) =>
      run(id, () =>
        choose({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, id, candidate },
        }),
      ),
    cancel: (id: string) =>
      run(id, () =>
        cancel({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, id },
        }),
      ),
  };
}
export type GenerationActions = ReturnType<typeof useGenerationActions>;

/** A picture inside the game folder, in a box that keeps its size while it loads. */
export function GameImage({
  environmentId,
  root,
  path,
  alt,
  className,
}: {
  environmentId: EnvironmentId;
  root: string | null;
  /** Relative to the game root. */
  path: string;
  alt: string;
  className?: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    root === null ? null : { _tag: "draft-workspace-file", cwd: root, path },
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className={cn("block overflow-hidden rounded-md bg-muted/50", className)}>
      {state._tag === "Success" && state.url !== failedUrl ? (
        <img
          src={state.url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onError={() => setFailedUrl(state.url)}
        />
      ) : null}
    </span>
  );
}

function GameAudio({
  environmentId,
  root,
  path,
}: {
  environmentId: EnvironmentId;
  root: string | null;
  path: string;
}) {
  const state = useAssetUrlState(
    environmentId,
    root === null ? null : { _tag: "draft-workspace-file", cwd: root, path },
  );
  // A fixed-height slot, so the card does not jump when the URL arrives.
  return (
    <div className="h-10">
      {state._tag === "Success" ? (
        <audio controls preload="none" src={state.url} className="h-10 w-full" />
      ) : null}
    </div>
  );
}

const PICK_COLUMNS = 2;

/** The candidates as a grid: click or arrow to one, then Use this (or Enter). */
export function CandidatePicker({
  threadRef,
  root,
  generation,
  actions,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  generation: GameGeneration;
  actions: GenerationActions;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);
  const count = generation.candidates.length;
  const sending = actions.pending === generation.id;
  const disabled = !actions.canChoose || actions.pending !== null;
  const use = () => {
    if (selected === null || disabled) return;
    void actions.choose(generation.id, selected);
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={`Candidates for ${generation.name}`}
        className="grid grid-cols-2 gap-2"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            // Enter on a tile nobody picked yet picks it; the next Enter uses it.
            if (selected === null) setSelected(0);
            else use();
            return;
          }
          const stepped = stepCandidate(selected ?? 0, count, PICK_COLUMNS, event.key);
          if (stepped === null) return;
          // The first arrow lands on the focused first tile rather than past it.
          const next = selected === null ? 0 : stepped;
          event.preventDefault();
          setSelected(next);
          tiles.current[next]?.focus();
        }}
      >
        {generation.candidates.map((candidate, index) => (
          <button
            key={candidate.preview}
            ref={(node) => {
              tiles.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected === index}
            aria-label={candidate.label ?? `Candidate ${index + 1}`}
            tabIndex={(selected ?? 0) === index ? 0 : -1}
            disabled={disabled}
            onClick={() => setSelected(index)}
            onDoubleClick={() => {
              setSelected(index);
              if (!disabled) void actions.choose(generation.id, index);
            }}
            className={cn(
              "relative rounded-lg border-2 p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected === index ? "border-primary" : "border-transparent hover:border-border",
            )}
          >
            <GameImage
              environmentId={threadRef.environmentId}
              root={root}
              path={candidate.preview}
              alt=""
              // Key art and concepts are wide; a square tile would shrink them to a strip.
              className={
                generation.lane === "image" ? "aspect-video w-full" : "aspect-square w-full"
              }
            />
            {candidate.label === undefined ? null : (
              <span className="block truncate px-1 pt-1 pb-0.5 text-left text-xs">
                {candidate.label}
              </span>
            )}
            {selected === index ? (
              <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <CheckIcon className="size-3.5" aria-hidden="true" />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={disabled || selected === null} onClick={use}>
          {sending ? "Using…" : "Use this"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {actions.canChoose
            ? "Pick one; the agent goes on with it."
            : "The person directing this game picks one."}
        </span>
      </div>
    </div>
  );
}

/** What a settled generation made: its picture, its model or its sound. */
function GenerationResult({
  threadRef,
  root,
  generation,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  generation: GameGeneration;
}) {
  const image = generationResultImage(generation);
  const medium = laneMedium(generation.lane);
  if (image !== null)
    return (
      <GameImage
        environmentId={threadRef.environmentId}
        root={root}
        path={image}
        alt={generation.name}
        className="h-48 w-full"
      />
    );
  if (medium === "audio") {
    const sound = generation.files.find((file) => /\.(mp3|wav|ogg|m4a)$/i.test(file));
    return sound === undefined ? null : (
      <GameAudio environmentId={threadRef.environmentId} root={root} path={sound} />
    );
  }
  if (medium === "model")
    return (
      <Badge variant="outline" size="default">
        <BoxIcon aria-hidden="true" />
        3D model
      </Badge>
    );
  return null;
}

const STATE_BADGES = {
  making: { label: "Making", variant: "info" },
  choosing: { label: "Pick one", variant: "warning" },
  done: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "outline" },
} as const satisfies Record<
  GameGeneration["state"],
  { label: string; variant: "info" | "warning" | "success" | "error" | "outline" }
>;

/** The chosen-by note: only Keep going's pick says so, since nobody else saw the choice made. */
const chosenByNote = (generation: GameGeneration): string | null =>
  generation.chosenBy === "autopilot" ? "Keep going took the first candidate" : null;

/** One generation, in full: the chat card's body and the Generated art view's open row. */
export function GameGenerationBody({
  threadRef,
  root,
  generation,
  actions,
}: {
  threadRef: ScopedThreadRef;
  root: string | null;
  generation: GameGeneration;
  actions: GenerationActions;
}) {
  const cost = generationCostLine(generation);
  const error = actions.errorFor(generation.id);
  const settled = generation.state === "done";
  const meta = [
    settled ? `Made with ${providerLabel(generation.provider)}` : null,
    cost,
    settled ? chosenByNote(generation) : null,
  ].filter((part) => part !== null);
  return (
    <div className="flex flex-col gap-2">
      <p className="line-clamp-2 text-xs text-muted-foreground">{generation.prompt}</p>
      {generation.state === "making" ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            Making with {providerLabel(generation.provider)} ·{" "}
            <GameElapsed since={Date.parse(generation.createdAt)} />
          </span>
          {cost === null ? null : <span>· {cost}</span>}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={!actions.canCancel || actions.pending !== null}
            onClick={() => void actions.cancel(generation.id)}
          >
            <XIcon aria-hidden="true" />
            {actions.pending === generation.id ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
      ) : null}
      {generation.state === "choosing" ? (
        <>
          <CandidatePicker
            threadRef={threadRef}
            root={root}
            generation={generation}
            actions={actions}
          />
          {cost === null ? null : <p className="text-xs text-muted-foreground">{cost}</p>}
        </>
      ) : null}
      {settled ? (
        <>
          <GenerationResult threadRef={threadRef} root={root} generation={generation} />
          <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>
          {generation.files.length === 0 || root === null ? null : (
            <ul className="flex flex-col gap-0.5 text-xs">
              {generation.files.map((file) => (
                <li key={file} className="flex min-w-0 flex-wrap items-center gap-1">
                  <span className="min-w-0 truncate font-mono">{fileName(file)}</span>
                  <GameFileActions
                    threadRef={threadRef}
                    path={`${root}/${file}`}
                    relativePath={file}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {generation.state === "failed" || generation.state === "cancelled" ? (
        <p
          className={cn(
            "text-xs whitespace-pre-wrap",
            generation.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {generation.error ??
            (generation.state === "cancelled" ? "Cancelled before it finished." : "It failed.")}
          {cost === null ? "" : ` ${cost}.`}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs whitespace-pre-wrap text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

export function GenerationHeading({ generation }: { generation: GameGeneration }) {
  const badge = STATE_BADGES[generation.state];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">
        {GAME_ART_LANE_LABELS[generation.lane]}: {generation.name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {providerLabel(generation.provider)}
      </span>
      <Badge variant={badge.variant} size="sm" className="ml-auto shrink-0">
        {badge.label}
      </Badge>
    </div>
  );
}

const findGeneration = (generations: GameGenerationsResult | null, id: string) =>
  generations?.generations.find((generation) => generation.id === id) ?? null;

/** The chat's card for one generation its agent started. */
export function GameGenerationCard({
  threadRef,
  generationId,
}: {
  threadRef: ScopedThreadRef;
  generationId: string;
}) {
  const generation = findGeneration(useGameGenerations(threadRef).data, generationId);
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const actions = useGenerationActions(threadRef);
  if (generation === null) return null;
  return (
    <section
      aria-label={`${GAME_ART_LANE_LABELS[generation.lane]} ${generation.name}`}
      className="flex max-w-xl flex-col gap-2 rounded-lg border border-border/70 px-3 py-2.5 text-sm"
    >
      <GenerationHeading generation={generation} />
      <GameGenerationBody
        threadRef={threadRef}
        root={root}
        generation={generation}
        actions={actions}
      />
    </section>
  );
}

/** Whether any generation of the game waits on the person's pick, for the Stage's menu. */
export const selectChoosingCount = (result: GenerationsResult): number =>
  AsyncResult.isSuccess(result)
    ? result.value.generations.filter((generation) => generation.state === "choosing").length
    : 0;
export const useChoosingCount = (threadRef: ScopedThreadRef) =>
  useEnvironmentQuerySelector(generationsTarget(threadRef), selectChoosingCount);
