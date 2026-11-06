import { GAME_BUILDS_EVENT, type OrchestrationV2DomainEvent } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";

/**
 * Keeps the Builds rail current without polling: a turn's checkpoint, a
 * run's round and a run's restore each push "builds" to the game's clients.
 * A run's round is measured as it lands, so its card
 * has facts without anyone opening it; Unity builds are left to an open, as
 * a measurement would take the one editor from the run.
 */
export class GameBuildsReactor extends Context.Service<
  GameBuildsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBuildsReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const builds = yield* GameBuilds.GameBuilds;
  const operations = yield* GameOperations.GameOperations;
  const projects = yield* GameProjectService.GameProjectService;
  const announced = new Set<string>();

  const pushTo = (event: OrchestrationV2DomainEvent, message: string) =>
    projects
      .resolve(event.threadId)
      .pipe(
        Effect.flatMap((root) =>
          operations.changed(root, GAME_BUILDS_EVENT, message).pipe(Effect.as(root)),
        ),
      );

  const handle: GameBuildsReactor["Service"]["handle"] = (event) => {
    switch (event.type) {
      case "checkpoint.captured":
        return event.payload.status !== "ready" || event.payload.files.length === 0
          ? Effect.void
          : pushTo(event, "A turn changed the game.").pipe(Effect.ignore);
      case "game-run-round.recorded": {
        const record = event.payload.round;
        return pushTo(event, `Round ${record.round} landed.`).pipe(
          Effect.flatMap((root) =>
            Effect.gen(function* () {
              const manifest = yield* projects.read(root);
              if (manifest.engine.name === "unity") return;
              if (record.build !== undefined) yield* builds.measureIn(root, record.build);
            }),
          ),
          Effect.ignore,
        );
      }
      case "game-run.updated": {
        const restore = event.payload.restore;
        if (restore === null || restore.outcome === null || announced.has(restore.requestId))
          return Effect.void;
        if (announced.size > 1000) announced.clear();
        announced.add(restore.requestId);
        return pushTo(event, restore.outcome.message).pipe(Effect.ignore);
      }
      default:
        return Effect.void;
    }
  };

  const start: GameBuildsReactor["Service"]["start"] = () =>
    forkParked(
      engine.streamDomainEvents.pipe(
        Stream.mapEffect(handle, { concurrency: 4 }),
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("game builds event stream failed", { cause }),
        ),
      ),
    );

  return GameBuildsReactor.of({ start, handle });
});

export const layer = Layer.effect(GameBuildsReactor, make);
