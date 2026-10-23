import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { GameOperationEvent, GameStatus } from "@t3tools/contracts";

/** The status-shaped operation the stage renders. */
export type GameOperation = NonNullable<GameStatus["operation"]>;
export type GameOperationEventState = GameOperationEvent["state"];

/**
 * The one in-memory record of what each game is doing, and the push clients
 * listen to. The stage used to learn about a build only by polling status, so a
 * stage opened while idle showed nothing until the whole turn ended. Recording
 * and publishing here keeps the status read and the push from disagreeing.
 */
export class GameOperations extends Context.Service<
  GameOperations,
  {
    /** The operation running now, or the last one this server ran. */
    readonly current: (root: string) => GameOperation | null;
    /**
     * Sets the status record and publishes the matching event. `eventState`
     * also carries "cancelled", which the status field does not.
     */
    readonly record: (
      root: string,
      operation: GameOperation,
      eventState: GameOperationEventState,
    ) => Effect.Effect<void>;
    readonly changed: (root: string, message: string) => Effect.Effect<void>;
    readonly events: Stream.Stream<GameOperationEvent>;
  }
>()("t3/game/GameOperations") {}

export const layer = Layer.effect(
  GameOperations,
  Effect.gen(function* () {
    const operations = new Map<string, GameOperation>();
    const events = yield* PubSub.unbounded<GameOperationEvent>();
    let revision = 0;
    return GameOperations.of({
      changed: (root, message) =>
        Effect.gen(function* () {
          yield* PubSub.publish(events, {
            root,
            name: "review",
            state: "succeeded",
            message,
            revision: ++revision,
            at: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      current: (root) => operations.get(root) ?? null,
      record: (root, operation, eventState) =>
        Effect.gen(function* () {
          operations.set(root, operation);
          yield* PubSub.publish(events, {
            root,
            revision: ++revision,
            name: operation.name,
            state: eventState,
            message: operation.message,
            at: DateTime.formatIso(yield* DateTime.now),
          });
        }).pipe(Effect.withSpan("GameOperations.record")),
      events: Stream.fromPubSub(events),
    });
  }),
);
