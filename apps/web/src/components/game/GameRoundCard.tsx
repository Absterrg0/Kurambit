import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ColumnsIcon, HistoryIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import {
  GameBuildId,
  type GameRunRoundRef,
  type GameRunStatusResult,
  type RunId,
  type ScopedThreadRef,
} from "@kurambit/contracts";

import { useGameWorkspaceStore } from "../../gameWorkspaceStore";
import type { TimelineAnchoredCard } from "../../session-logic";
import { gameEnvironment, setStagePlayTarget } from "../../state/game";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { GameBuildFactsDiff } from "./GameBuildFacts";
import { roundCardAction } from "./gameBuilds.logic";
import { formatRunDuration } from "./gameRunView.logic";
import { restoreQuestion, useBuildPlay, useBuildRestore } from "./useBuildActions";

const isBuildId = Schema.is(GameBuildId);

// A string, so a run status refetch that moved no round re-renders nothing.
const roundCardsKey = (
  threadId: string,
  result: AsyncResult.AsyncResult<GameRunStatusResult, unknown>,
): string => {
  if (!AsyncResult.isSuccess(result)) return "";
  const status = result.value;
  // Cards appear in the chat the run talks to, never in its role threads.
  if ((status.chat ?? null) !== threadId || status.runId === null) return "";
  return status.rounds
    .flatMap((round) =>
      round.endedAt == null ? [] : [`${status.runId}\u0001${round.round}\u0001${round.endedAt}`],
    )
    .join("\u0002");
};
const selectorFor = new Map<
  string,
  (result: AsyncResult.AsyncResult<GameRunStatusResult, unknown>) => string
>();
const selectRoundCards = (threadId: string) => {
  let select = selectorFor.get(threadId);
  if (select === undefined) {
    select = (result) => roundCardsKey(threadId, result);
    selectorFor.set(threadId, select);
  }
  return select;
};

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
    return { id: `game-round:${runId}:${round}`, createdAt: endedAt, round: Number(round) };
  });
  lastCards = { key, cards };
  return cards;
};

/**
 * The run's round cards for one chat, placed at each round's end. Derived from
 * the run status the game surfaces already read: no message, no agent turn.
 */
export function useGameRoundCards(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelineAnchoredCard> {
  const key = useEnvironmentQuerySelector(
    threadRef === null
      ? null
      : gameEnvironment.runStatus({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
    selectRoundCards(threadRef?.threadId ?? ""),
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

/** One round of the run, in the run's chat: what changed, its facts against its base, and Keep or Revert. */
export function GameRoundCard({ threadRef, round }: { threadRef: ScopedThreadRef; round: number }) {
  const status = useEnvironmentQuery(
    gameEnvironment.runStatus({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const ref = status?.rounds.find((entry) => entry.round === round) ?? null;
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
  if (status === null || ref === null) return null;
  const outcome = OUTCOME[ref.outcome];
  const action = roundCardAction(ref, { active: status.active, best: status.best ?? null });
  const comparison = compare.data;
  const changed = comparison?.deltas.filter((delta) => delta.change !== "same").slice(0, 3) ?? [];
  const measuring =
    comparison !== null &&
    (comparison.factsA.state !== "measured" || comparison.factsB.state !== "measured");
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
  const best = status.best != null && isBuildId(status.best) ? status.best : null;
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
          <p className="text-2xs text-muted-foreground">
            {measuring ? "Measuring…" : "No fact changed against the build before it."}
          </p>
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
                restoreQuestion(
                  action.kind === "revert"
                    ? `the build before round ${round}`
                    : `round ${round}'s build`,
                ),
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

/** A changing chat turn's link to its build on the Builds tab. */
export function GameTurnBuildLink({
  threadRef,
  runId,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() =>
        useGameWorkspaceStore.getState().showStageTab("builds", {
          open: { _tag: "turn", threadId: threadRef.threadId, runId },
        })
      }
    >
      <HistoryIcon aria-hidden="true" />
      Open build
    </Button>
  );
}
