// One game-run command planned against the records: the decider's events with
// their ids, its effects, and the timers a stop cancels. The orchestrator
// commits every game-run command through it, and a chat's deletion (one thread
// or a whole project's) plans the chat's run stop with it in its own commit,
// so there is one way a run stops.
import type {
  CommandId,
  GameRunRefusalReason,
  OrchestrationV2DomainEvent,
  OrchestrationV2GameRunCommand,
  ThreadId,
} from "@kurambit/contracts";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Result from "effect/Result";

import type * as EffectOutbox from "../EffectOutbox.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import * as GameRunDecide from "./decide.ts";

export interface GameRunPlan {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  readonly cancelUnsettledEffects?: {
    readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  };
}

/** Why a command was not planned: its chat is deleted, or the run refuses it. */
export type GameRunPlanRefusal =
  | { readonly kind: "deleted" }
  | { readonly kind: "refused"; readonly reason: GameRunRefusalReason; readonly message: string };

interface PlanDeps {
  readonly projections: ProjectionStore.ProjectionStoreV2Shape;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}

export const planGameRunCommand = (deps: PlanDeps, command: OrchestrationV2GameRunCommand) =>
  Effect.gen(function* () {
    const { projections, idAllocator } = deps;
    const threadId = command.threadId;
    const thread = yield* projections.getThread(threadId);
    // A deleted chat's run keeps only its ways out: a stop (recovery stops a
    // run an older server left live there), the records of the finish and
    // restore already under way, so nothing waits on it after a restart, and
    // the release of its copies.
    if (
      thread.deletedAt !== null &&
      command.type !== "game-run.stop" &&
      command.type !== "game-run.finished" &&
      command.type !== "game-run.restore" &&
      command.type !== "game-run.copies.spend"
    )
      return Result.fail<GameRunPlanRefusal>({ kind: "deleted" });
    // A resume writes what the run's last landings owe, so it reads every step.
    const resuming = command.type === "game-run.resume";
    const records = yield* projections.getGameRunRecords(
      threadId,
      resuming ? undefined : { steps: "in-flight" },
    );
    const latest = records.gameRuns.at(-1);
    const decided = GameRunDecide.decide(
      command,
      {
        projectId: thread.projectId,
        projectRun: yield* projections.getProjectGameRun(thread.projectId),
        runs: records.gameRuns,
        rounds: records.gameRunRounds,
        inFlight:
          records.gameRunSteps.find(
            (step) => step.runId === latest?.id && step.seq === latest.inFlight,
          ) ?? null,
        chatDeleted: thread.deletedAt !== null,
        steps: resuming ? records.gameRunSteps : [],
      },
      {
        at: yield* DateTime.now,
        coin: yield* Random.next,
        id: (yield* Random.nextIntBetween(0, 2 ** 48)).toString(36),
      },
    );
    if (Result.isFailure(decided))
      return Result.fail<GameRunPlanRefusal>({ kind: "refused", ...decided.failure });
    const events: OrchestrationV2DomainEvent[] = [];
    for (const event of decided.success.events) {
      const id = yield* idAllocator.allocate.event({
        threadId: event.threadId,
        commandId: command.commandId,
      });
      events.push({ ...event, id } as OrchestrationV2DomainEvent);
    }
    const effects = decided.success.effects.map(
      ({ request, availableAt }): EffectOutbox.PendingOrchestrationEffectV2 => ({
        id: `effect:${command.commandId}:${request.type}:${"stepId" in request ? request.stepId : request.runId}`,
        commandId: command.commandId,
        threadId,
        request,
        ...(availableAt === undefined ? {} : { availableAt: DateTime.makeUnsafe(availableAt) }),
      }),
    );
    return Result.succeed<GameRunPlan>({
      events,
      effects,
      ...(decided.success.cancelEffects
        ? {
            cancelUnsettledEffects: {
              effectTypes: GameRunDecide.GAME_RUN_EFFECT_TYPES,
              reason: "The game run was stopped.",
            },
          }
        : {}),
    });
  });

const NOTHING: GameRunPlan = { events: [], effects: [] };

/**
 * A chat's deletion stops the run it holds, in the deletion's own commit (its
 * command id), so its finish stops the roles and no run stays live where no
 * chat reaches it. A run that is not live, a stop the run refuses, or records
 * that cannot be read plan nothing: the chat is deleted as before.
 */
export const planDeletedChatRunStop = (
  deps: PlanDeps,
  input: { readonly threadId: ThreadId; readonly commandId: CommandId },
) =>
  Effect.gen(function* () {
    const records = yield* deps.projections.getGameRunRecords(input.threadId, {
      steps: "in-flight",
    });
    const run = records.gameRuns.at(-1);
    if (run === undefined || run.status === "ended") return NOTHING;
    const planned = yield* planGameRunCommand(deps, {
      type: "game-run.stop",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: run.id,
    });
    return Result.isSuccess(planned) ? planned.success : NOTHING;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("a deleted chat's game run could not be planned to stop", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(NOTHING)),
    ),
  );
