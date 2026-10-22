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
 * Starts the repair loop after the builder turn that produced a playable
 * export ends, and wakes a parked loop when its child reaches a terminal
 * status. The reactor only translates committed events; the loop's own worker
 * owns every phase and decision.
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
    if (event.type === "run.created") {
      // A new top-level turn on a game supersedes any review, including one
      // started through MCP where the websocket pre-dispatch hook does not see
      // it. A round child's own run is skipped by its lineage below.
      return Effect.gen(function* () {
        const shell = yield* threads
          .getThreadShell(event.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.lineage.relationshipToParent === "subagent") return;
        yield* loop.supersede(
          event.threadId,
          "A new turn on this game superseded the review; its candidate was not selected.",
        );
      }).pipe(Effect.catchCause(() => Effect.void));
    }
    if (event.type !== "run.updated") return Effect.void;
    const run = event.payload;
    const terminal =
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "interrupted" ||
      run.status === "rolled_back";
    if (!terminal) return Effect.void;
    return Effect.gen(function* () {
      // A round child completing is what the parked worker is waiting for. The
      // loop matches the child id it recorded, so an unrelated subagent run
      // cannot advance it.
      yield* loop.noteChildTerminal(event.threadId).pipe(Effect.forkDetach);
      if (run.status !== "completed" || run.rootNodeId === null) return;
      const shell = yield* threads
        .getThreadShell(event.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      // A repair child completes on the same game project; only a top-level
      // game thread may start a new loop.
      if (shell === null || shell.lineage.relationshipToParent === "subagent") return;
      yield* loop
        .ensure({
          threadId: event.threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
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
      // Restart reconciliation runs before any event can start a worker: a
      // loop interrupted by the restart stays paused until Resume.
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
