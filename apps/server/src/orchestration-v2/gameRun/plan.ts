// One game-run command planned against the records: the decider's events with
// their ids, its effects, and the timers a stop cancels. The orchestrator
// commits every game-run command through it, and a chat's deletion (one thread
// or a whole project's) plans the chat's run stop with it in its own commit,
// so there is one way a run stops.
import {
  type CommandId,
  type GameRunRefusalReason,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameRunCommand,
  type ThreadId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as IdAllocator from "@kurambit/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

const CYCLE_KINDS: ReadonlySet<string> = new Set(["propose", "turn", "judge", "undo"]);

export const planGameRunCommand = (deps: PlanDeps, command: OrchestrationV2GameRunCommand) =>
  Effect.gen(function* () {
    const { projections, idAllocator } = deps;
    const threadId = command.threadId;
    const thread = yield* projections.getThread(threadId);
    // A deleted chat's run keeps only its way out: a stop (recovery stops a
    // run an older server left live there).
    if (thread.deletedAt !== null && command.type !== "game-run.stop")
      return Result.fail<GameRunPlanRefusal>({ kind: "deleted" });
    const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
    const latest = records.gameRuns.at(-1);
    const inFlight =
      records.gameRunSteps.find(
        (step) => step.runId === latest?.id && step.seq === latest.inFlight,
      ) ?? null;
    // The policy reads the cycle the step in flight belongs to: a proposal's
    // look, a turn's look (and proposal), a judge's turn, an undo's judge and
    // turn. Each is planned right after the one before it.
    const cycle =
      latest === undefined ||
      inFlight === null ||
      inFlight.seq < 2 ||
      !CYCLE_KINDS.has(inFlight.step.kind)
        ? []
        : (yield* projections.getGameRunRecords(threadId, {
            steps: [inFlight.seq - 1, inFlight.seq - 2]
              .filter((seq) => seq > 0)
              .map((seq) => gameRunStepId(latest.id, seq)),
          })).gameRunSteps;
    const decided = GameRunDecide.decide(
      command,
      {
        projectId: thread.projectId,
        projectRun: yield* projections.getProjectGameRun(thread.projectId),
        runs: records.gameRuns,
        rounds: records.gameRunRounds,
        inFlight,
        chatDeleted: thread.deletedAt !== null,
        steps: cycle,
      },
      yield* DateTime.now,
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
 * command id), so no run stays live where no chat reaches it. A run that is not live, or a stop the run refuses, plans
 * nothing. Records that cannot be read fail the deletion: a chat deleted
 * over a run nothing then stops would leave the run working its folder.
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
  });
