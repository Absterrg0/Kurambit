import { AsyncResult } from "effect/reactivity";
import { threadRuntimeIsActive } from "@kurambit/client-runtime/state/models";
import * as Schema from "effect/Schema";
import { ColumnsIcon, HistoryIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { GameBuildId, type GameRunRoundRef, type ScopedThreadRef } from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import type { TimelineAnchoredCard } from "../../session-logic";
import { chatRuns, gameEnvironment, setStagePlayTarget, type GameChatRun } from "../../state/game";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { GameBuildFactsDiff } from "./GameBuildFacts";
import { roundCardAction } from "./gameBuilds.logic";
import { formatRunDuration } from "./gameRunView.logic";
import { restoreQuestion, useBuildPlay, useBuildRestore } from "./useBuildActions";

const isBuildId = Schema.is(GameBuildId);

type ChatRunsResult = AsyncResult.AsyncResult<ReadonlyArray<GameChatRun>, unknown>;

// A string, so a refetch that moved no round re-renders nothing. Cards come
// from every run whose chat this is, never in its role threads.
const selectRoundCards = (result: ChatRunsResult): string =>
  AsyncResult.isSuccess(result)
    ? result.value
        .flatMap((run) =>
          run.rounds.flatMap((round) =>
            round.endedAt == null ? [] : [`${run.runId}\u0001${round.round}\u0001${round.endedAt}`],
          ),
        )
        .join("\u0002")
    : "";

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
    const [runId = "", round = "0", endedAt = ""] = part.split("\u0001");
    return {
      id: `game-round:${runId}:${round}`,
      createdAt: endedAt,
      runId,
      round: Number(round),
    };
  });
  lastCards = { key, cards };
  return cards;
};

/**
 * The round cards of every run this chat directs, placed at each round's end.
 * Derived from records the client reads anyway: no message, no agent turn.
 */
export function useGameRoundCards(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelineAnchoredCard> {
  const key = useEnvironmentQuerySelector(
    threadRef === null ? null : chatRuns(threadRef),
    selectRoundCards,
  );
  return cardsOf(key);
}

const OUTCOME: Record<
  GameRunRoundRef["outcome"],
  { label: string; variant: "success" | "outline" }
> = {
  kept: { label: "Kept", variant: "success" },
  inconclusive: { label: "Not kept · inconclusive", variant: "outline" },
  rejected: { label: "Not kept", variant: "outline" },
  unjudged: { label: "Not kept · unjudged", variant: "outline" },
  abandoned: { label: "Abandoned", variant: "outline" },
};

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? text.trim();

const tokensLine = (tokens: number | null | undefined): string =>
  tokens == null
    ? "tokens not reported"
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k tokens`
      : `${tokens} tokens`;

/** One round of a run, in the run's chat: what changed, its facts against its base, and Keep or Revert. */
export function GameRoundCard({
  threadRef,
  runId,
  round,
}: {
  threadRef: ScopedThreadRef;
  runId: string;
  round: number;
}) {
  const run = useEnvironmentQuery(chatRuns(threadRef)).data?.find((entry) => entry.runId === runId);
  const ref = run?.rounds.find((entry) => entry.round === round) ?? null;
  // A turn in this chat may be writing the folder: no restore under it.
  const turnRunning = threadRuntimeIsActive(useThreadShell(threadRef)?.runtime);
  const build = ref?.build != null && isBuildId(ref.build) ? ref.build : null;
  const base = ref?.base != null && isBuildId(ref.base) ? ref.base : null;
  const compare = useEnvironmentQuery(
    build !== null && base !== null
      ? gameEnvironment.buildCompare({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            a: { _tag: "build", build: base },
            b: { _tag: "build", build },
          },
        })
      : null,
  );
  const builds = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const restores = useBuildRestore(threadRef, builds.data?.restore ?? null);
  const plays = useBuildPlay(threadRef);
  if (run === undefined || ref === null) return null;
  const outcome = OUTCOME[ref.outcome];
  const action = roundCardAction(ref, { active: run.active, best: run.best }, turnRunning);
  const comparison = compare.data;
  const changed = comparison?.deltas.filter((delta) => delta.change !== "same").slice(0, 3) ?? [];
  const states = comparison === null ? [] : [comparison.factsA.state, comparison.factsB.state];
  const factsLine = states.some((state) => state === "queued" || state === "measuring")
    ? "Measuring…"
    : states.some((state) => state !== "measured")
      ? "Not every fact is measured on both builds; none measured changed."
      : "No fact changed against the build before it.";
  const play = async () => {
    if (build === null) return;
    const result = await plays.send({ _tag: "build", build });
    if (result === null) return;
    setStagePlayTarget(threadRef, {
      build,
      label: `Round ${round}'s build`,
      result,
    });
    useGameWorkspaceStore.getState().showStageTab("play");
  };
  const best = run.best !== null && isBuildId(run.best) ? run.best : null;
  const against = best !== null && best !== build ? best : base;
  return (
    <section
      data-game-round-card={round}
      className="space-y-2 rounded-lg border border-border bg-card px-3 py-2.5"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium">Round {round}</span>
        <Badge size="sm" variant={outcome.variant}>
          {outcome.label}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {ref.rung?.is ?? firstLine(ref.move)}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {formatRunDuration(ref.durationMs)} · {tokensLine(ref.tokens)}
        </span>
      </header>
      <p className="text-2xs text-muted-foreground">
        {ref.linesChanged === 1 ? "1 line changed" : `${ref.linesChanged} lines changed`}
        {ref.rung !== null
          ? ` · checks ${ref.rung.checks.filter((check) => check.pass).length}/${ref.rung.checks.length}`
          : ""}
      </p>
      {build !== null && base !== null ? (
        comparison === null ? (
          <p className="text-2xs text-muted-foreground">{compare.error ?? "Reading the facts…"}</p>
        ) : changed.length > 0 ? (
          <GameBuildFactsDiff deltas={changed} labels={["Before", "This round"]} />
        ) : (
          <p className="text-2xs text-muted-foreground">{factsLine}</p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {build !== null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!plays.canPlay || plays.playing({ _tag: "build", build })}
            onClick={() => void play()}
          >
            <PlayIcon className="fill-current" aria-hidden="true" />
            Play
          </Button>
        ) : null}
        {build !== null && against !== null ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              useGameWorkspaceStore.getState().showStageTab("builds", {
                compare: [
                  { _tag: "build", build: against },
                  { _tag: "build", build },
                ],
              })
            }
          >
            <ColumnsIcon aria-hidden="true" />
            {against === best ? "Compare with best" : "Compare with before"}
          </Button>
        ) : null}
        {action !== null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={action.blocked !== null || !restores.canRestore || restores.pending}
            onClick={() =>
              void restores.send(
                action.target,
                action.kind === "revert"
                  ? restoreQuestion(`the build before round ${round}`)
                  : `Keep round ${round}'s build as the run's best?\nIt goes into the game folder and the run's best becomes it, so a resume continues from it. What the folder holds now is saved as a build first, so you can undo this.`,
                action.asBest,
              )
            }
          >
            <HistoryIcon aria-hidden="true" />
            {restores.restoring(action.target) ? "Going back…" : action.label}
          </Button>
        ) : null}
      </div>
      {action?.blocked != null ? (
        <p className="text-2xs text-muted-foreground">{action.blocked}</p>
      ) : null}
      {action !== null && restores.error(action.target) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {restores.error(action.target)}
        </p>
      ) : null}
      {build !== null && plays.error({ _tag: "build", build }) ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          {plays.error({ _tag: "build", build })}
        </p>
      ) : null}
    </section>
  );
}
