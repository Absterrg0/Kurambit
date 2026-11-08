import type { OrchestrationV2DomainEvent, ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as GameBot from "./GameBot.ts";
import * as GameExplore from "./GameExplore.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";

const ENDED_WITHOUT_COMPLETING: ReadonlySet<string> = new Set([
  "interrupted",
  "cancelled",
  "failed",
  "rolled_back",
]);

export class GameTurnCancellationReactor extends Context.Service<
  GameTurnCancellationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/GameTurnCancellationReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  const explore = yield* GameExplore.GameExplore;
  const bots = yield* GameBot.GameBot;

  const cancelThread = Effect.fn("GameTurnCancellationReactor.cancelThread")(function* (
    threadId: ThreadId,
  ) {
    const root = yield* projects.resolve(threadId).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          error.reason === "project-not-found" || error.reason === "invalid-project"
            ? Effect.succeed(null)
            : Effect.fail(error),
      }),
    );
    if (root !== null) {
      yield* operations.cancel(root, String(threadId));
      yield* explore.release(threadId, root);
    }
    // Bot runs are keyed by their own checkout, which may be another one.
    yield* bots.stopOwned(threadId);
  });

  // A turn that ended without completing (capped, cancelled, failed, rolled
  // back, its thread deleted or recovered) leaves no game work behind: its
  // operations, queued or running, its explore session and its bot runs. A
  // completed turn has no tool call in flight, and its explore session may
  // idle out between turns.
  const handle: GameTurnCancellationReactor["Service"]["handle"] = (event) => {
    if (event.type !== "run.updated" || !ENDED_WITHOUT_COMPLETING.has(event.payload.status))
      return Effect.void;
    return cancelThread(event.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cancelling an ended turn's game work failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );
  };

  const start: GameTurnCancellationReactor["Service"]["start"] = () =>
    forkParked(
      // Each cancel waits for its work to end; one slow stop never holds the next event.
      engine.streamDomainEvents.pipe(
        Stream.mapEffect(handle, { concurrency: "unbounded" }),
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("game turn cancellation event stream failed", { cause }),
        ),
      ),
    );

  return GameTurnCancellationReactor.of({ start, handle });
});

export const layer = Layer.effect(GameTurnCancellationReactor, make);
