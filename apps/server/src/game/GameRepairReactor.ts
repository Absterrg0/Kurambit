import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";

/**
 * Starts the repair loop after the builder turn that produced the current
 * playable export ends. Supersession is not here: a new turn takes the game
 * before it commits, through TurnAdmission. The loop's own fiber owns every
 * phase and decision; this reactor never wakes a parked loop.
 */
export class GameRepairReactor extends Context.Service<
  GameRepairReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/game/GameRepairReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const loop = yield* GameRepairLoop.GameRepairLoop;

  const handle: GameRepairReactor["Service"]["handle"] = (event) => {
    if (event.type !== "run.updated") return Effect.void;
    const run = event.payload;
    if (run.status !== "completed" || run.rootNodeId === null) return Effect.void;
    const nodeId = run.rootNodeId;
    return Effect.gen(function* () {
      const shell = yield* threads
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      // A review child completes on the same game project; only a top-level
      // game thread may start a loop.
      if (shell === null || shell.lineage.relationshipToParent === "subagent") return;
      yield* loop
        .ensure({
          threadId: event.threadId,
          runId: run.id,
          nodeId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("starting a game repair loop failed", {
              threadId: event.threadId,
              runId: run.id,
              cause,
            }),
          ),
          Effect.forkDetach,
        );
    });
  };

  const start: GameRepairReactor["Service"]["start"] = () =>
    Effect.gen(function* () {
      // Restart reconciliation runs before any event can start a worker: a loop
      // the restart cut is interrupted, never resumed.
      yield* loop
        .recover()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("recovering game repair loops failed", { cause }),
          ),
        );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("game repair event stream failed", { cause }),
          ),
        ),
      );
    });

  return GameRepairReactor.of({ start, handle });
});

export const layer = Layer.effect(GameRepairReactor, make);
