import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameOperationError,
  type GameReviewHistory,
  type GameReviewHistoryInput,
  type GameReviewRestoreResult,
  type GameReviewStatus,
  type GameSubmitInput,
  type GameSubmitResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";

export class GameReviewApi extends Context.Service<
  GameReviewApi,
  {
    readonly status: (
      threadId: ThreadId,
      checkSelectedBuild?: boolean,
    ) => Effect.Effect<GameReviewStatus, GameOperationError>;
    /**
     * The builder's declaration of the build it stands behind. The server
     * verifies facts and records it; the review starts from it when the turn ends.
     */
    readonly submit: (
      threadId: ThreadId,
      input: GameSubmitInput,
    ) => Effect.Effect<GameSubmitResult, GameOperationError>;
    readonly history: (
      input: GameReviewHistoryInput,
    ) => Effect.Effect<GameReviewHistory, GameOperationError>;
    readonly stop: (threadId: ThreadId) => Effect.Effect<GameReviewStatus, GameOperationError>;
    readonly restore: (
      threadId: ThreadId,
    ) => Effect.Effect<GameReviewRestoreResult, GameOperationError>;
  }
>()("t3/game/GameReviewApi") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const loops = yield* GameRepairLoop.GameRepairLoop;
  const rounds = yield* GameRoundStore.GameRoundStore;
  const sessions = yield* GameReviewSessions.GameReviewSessions;
  const studio = yield* GameRepairStudio.GameRepairStudio;
  const status: GameReviewApi["Service"]["status"] = (threadId, checkSelectedBuild = false) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const loop = yield* loops.read(threadId);
      const activity = yield* loops.activity(threadId);
      const state = yield* rounds.read(root);
      const budget = loop?.budget ?? DEFAULT_GAME_REVIEW_BUDGET;
      const end = loop?.finishedAt ?? DateTime.formatIso(yield* DateTime.now);
      const elapsed = loop === null ? 0 : Math.max(0, Date.parse(end) - Date.parse(loop.startedAt));
      return {
        ...(checkSelectedBuild
          ? {
              selectedBuildFacts:
                state.selected === null
                  ? null
                  : yield* studio.submissionFacts(root, state.selected.buildId),
            }
          : {}),
        loop,
        held: activity.held,
        phase:
          activity.held && loop?.status !== "running"
            ? "held: waiting for a review session to stop"
            : (activity.phase ?? loop?.status ?? "No review yet"),
        repairsLeft: Math.max(0, budget.repairs - (loop?.repairsUsed ?? 0)),
        timeLeftMs: Math.max(0, budget.elapsedMs - elapsed),
        budget,
        restoreOffered:
          loop !== null &&
          state.rounds.some(
            (round) => round.loopId === loop.id && GameRoundStore.isRestorableRound(round),
          ),
      };
    });
  const history: GameReviewApi["Service"]["history"] = (input) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(input.threadId);
      const state = yield* rounds.read(root);
      const ordered = state.rounds;
      const index =
        input.before === undefined
          ? 0
          : ordered.findIndex((round) => round.id === input.before) + 1;
      if (input.before !== undefined && index === 0)
        return yield* new GameOperationError({
          operation: "read game review history",
          path: root,
          reason: "invalid-input",
          detail: "The history cursor is no longer available. Refresh the history.",
        });
      const limit = Math.min(20, Math.max(1, input.limit ?? 5));
      const page = ordered.slice(index, index + limit);
      const entries: GameReviewHistory["rounds"][number][] = [];
      for (const round of page) {
        const evidence: GameReviewHistory["rounds"][number]["evidence"][number][] = [];
        if (round.loopId !== undefined) {
          for (const [role, order] of [
            ["critic", 0],
            ["ballot", 0],
            ["ballot", 1],
          ] as const) {
            const ref = yield* sessions.describe({
              threadId: input.threadId,
              loopId: round.loopId,
              roundId: round.id,
              role,
              order,
            });
            if (ref !== null) evidence.push(ref);
          }
        }
        entries.push({ round, evidence });
      }
      return {
        rounds: entries,
        nextCursor: index + page.length < ordered.length ? page.at(-1)!.id : null,
      };
    });
  return GameReviewApi.of({
    status,
    submit: (threadId, input) => loops.submit(threadId, input),
    history,
    stop: (threadId) =>
      loops
        .interrupt(threadId, "The creator stopped the review; the selected build stays playable.")
        .pipe(Effect.andThen(status(threadId))),
    restore: (threadId) =>
      loops.restore(threadId).pipe(
        Effect.map((result) => ({
          kind: result.kind,
          message:
            result.kind === "restored"
              ? "Previous version restored. The version present before restore was saved."
              : result.kind === "busy"
                ? "held: waiting for a review session to stop"
                : result.detail,
        })),
      ),
  });
});
export const layer = Layer.effect(GameReviewApi, make);
