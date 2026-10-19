import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as GameService from "./GameService.ts";

export class GameTurnCancellationReactor extends Context.Service<
  GameTurnCancellationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/game/GameTurnCancellationReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const game = yield* GameService.GameService;

  const handle: GameTurnCancellationReactor["Service"]["handle"] = (event) => {
    if (event.type !== "run.updated" || event.payload.status !== "interrupted") return Effect.void;
    return game.cancelThread(event.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("cancelling an interrupted turn's game operation failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );
  };

  const start: GameTurnCancellationReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("game turn cancellation event stream failed", { cause }),
        ),
      ),
    );

  return GameTurnCancellationReactor.of({ start, handle });
});

export const layer = Layer.effect(GameTurnCancellationReactor, make);
