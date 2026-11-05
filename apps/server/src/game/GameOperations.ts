import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { GameOperationError, type GameOperationEvent, type GameStatus } from "@kurambit/contracts";

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
    /**
     * The game's run moved (a step, a decision, its end): the push lets the
     * library and the Run view reread the run's records without polling. The
     * run itself lives in those records, never here.
     */
    readonly runChanged: (root: string, step: string | null) => Effect.Effect<void>;
    readonly events: Stream.Stream<GameOperationEvent>;
    /**
     * Runs `work` as the game's one operation, recorded and pushed as it runs
     * and ends; a second one while it runs fails `busy`. `owner` is the thread
     * whose call started it.
     */
    readonly exclusive: <A>(
      root: string,
      name: string,
      work: Effect.Effect<A, GameOperationError>,
      owner: string,
    ) => Effect.Effect<A, GameOperationError>;
    /** Cancels the game's running operation; with `owner`, only that thread's. */
    readonly cancel: (root: string, owner?: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameOperations") {}

/**
 * Operations report failure in more than one shape: action results use
 * `success` and the Godot check uses `ok`. The shared operation state has
 * to see both, or a failed build announces success to the stage.
 */
const operationFailed = (result: unknown): boolean => {
  if (typeof result !== "object" || result === null) return false;
  if ("success" in result && result.success === false) return true;
  if ("ok" in result && result.ok === false) return true;
  return false;
};
/** The honest message for a finished operation. */
const operationMessage = (result: unknown, name: string): string => {
  if (typeof result !== "object" || result === null) return `${name} completed.`;
  return "message" in result ? String(result.message) : `${name} completed.`;
};

export const layer = Layer.effect(
  GameOperations,
  Effect.gen(function* () {
    const operations = new Map<string, GameOperation>();
    const events = yield* PubSub.unbounded<GameOperationEvent>();
    let revision = 0;
    const record = (root: string, operation: GameOperation, eventState: GameOperationEventState) =>
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
      }).pipe(Effect.withSpan("GameOperations.record"));
    // A turn that ends cancels only its own work: the production run runs
    // boot checks on the same game while role turns are being interrupted at
    // their caps.
    const active = new Map<
      string,
      { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void>; owner: string }
    >();
    const cancel = Effect.fnUntraced(function* (root: string, owner?: string) {
      const operation = active.get(root);
      if (operation === undefined) return;
      if (owner !== undefined && operation.owner !== owner) return;
      yield* Deferred.succeed(operation.cancelled, undefined);
      // The race interrupts work and awaits its finalizers, including native child exit.
      yield* Deferred.await(operation.done);
    });
    const exclusive = <A>(
      root: string,
      name: string,
      work: Effect.Effect<A, GameOperationError>,
      owner: string,
    ) =>
      Effect.gen(function* () {
        if (active.has(root))
          return yield* new GameOperationError({ operation: name, path: root, reason: "busy" });
        const cancelled = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const at = DateTime.formatIso(yield* DateTime.now);
        active.set(root, { cancelled, done, owner });
        yield* record(
          root,
          { name, state: "running", message: `${name} is running.`, at },
          "running",
        );
        const stopped = Deferred.isDone(cancelled);
        return yield* work.pipe(
          Effect.raceFirst(
            Deferred.await(cancelled).pipe(
              Effect.andThen(
                Effect.fail(
                  new GameOperationError({
                    operation: name,
                    path: root,
                    reason: "cancelled",
                    detail: "Operation cancelled.",
                  }),
                ),
              ),
            ),
          ),
          Effect.tap((result) =>
            Effect.gen(function* () {
              const failed = operationFailed(result);
              yield* record(
                root,
                {
                  name,
                  state: failed ? "failed" : "succeeded",
                  message: operationMessage(result, name),
                  at,
                },
                failed ? "failed" : "succeeded",
              );
            }),
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const wasCancelled = yield* stopped;
              yield* record(
                root,
                {
                  name,
                  // The status field has no cancelled state; Stop reads as a
                  // failed run with an honest message.
                  state: "failed",
                  message: error.message,
                  at,
                },
                wasCancelled ? "cancelled" : "failed",
              );
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* record(
                root,
                { name, state: "failed", message: `${name} was cancelled.`, at },
                "cancelled",
              );
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              active.delete(root);
            }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
          ),
        );
      });
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
      runChanged: (root, step) =>
        Effect.gen(function* () {
          yield* PubSub.publish(events, {
            root,
            revision: ++revision,
            name: "run",
            state: step === null ? "succeeded" : "running",
            message: step ?? "The production run ended.",
            at: DateTime.formatIso(yield* DateTime.now),
          });
        }),
      record,
      events: Stream.fromPubSub(events),
      exclusive,
      cancel,
    });
  }),
);
