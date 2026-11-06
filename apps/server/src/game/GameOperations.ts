import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  GameOperationError,
  ThreadId,
  type GameOperationEvent,
  type GameStatus,
} from "@kurambit/contracts";
import { isGameRunOperationOwner } from "../orchestration-v2/gameRun/ids.ts";

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
      operation: Omit<GameOperation, "revision">,
      eventState: GameOperationEventState,
      owner?: string,
    ) => Effect.Effect<void>;
    /** Something of the game other than an operation changed (`name` says what): a push, no record. */
    readonly changed: (root: string, name: string, message: string) => Effect.Effect<void>;
    /**
     * The game's run moved (a step, a decision, its end): the push lets the
     * library and the Run view reread the run's records without polling. The
     * run itself lives in those records, never here.
     */
    readonly runChanged: (root: string, step: string | null) => Effect.Effect<void>;
    readonly events: Stream.Stream<GameOperationEvent>;
    /**
     * Runs `work` as the game's one operation, recorded and pushed as it runs
     * and ends; a second one while it runs fails `busy`, or with `waitUntil`
     * (epoch ms) queues behind it until then. `owner` is the thread whose
     * call started it.
     */
    readonly exclusive: <A, E = GameOperationError, R = never>(
      root: string,
      name: string,
      work: Effect.Effect<A, E, R>,
      owner: string,
      options?: { readonly waitUntil?: number },
    ) => Effect.Effect<A, E | GameOperationError, R>;
    /**
     * Cancels the game's operations, running or still queued; with `owner`,
     * only that owner's. Resolves once each has ended.
     */
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
/** A failed operation's message, whatever its error. */
const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
/** The thread an owner names; a run's or the system's own work has none. */
const ownerThread = (owner: string | undefined): ThreadId | undefined =>
  owner === undefined || isGameRunOperationOwner(owner) || !/^[\w.-]+$/.test(owner)
    ? undefined
    : ThreadId.make(owner);

/** One operation asked for on a game: queued or running. */
interface Entry {
  readonly name: string;
  readonly owner: string;
  readonly cancelled: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
  running: boolean;
}

export const layer = Layer.effect(
  GameOperations,
  Effect.gen(function* () {
    const operations = new Map<string, GameOperation>();
    const events = yield* PubSub.unbounded<GameOperationEvent>();
    const locks = yield* KeyedLock.make<string>();
    // Starts at the server's clock so a restarted server's revisions stay above
    // the ones a client still holds from before.
    let revision = DateTime.toEpochMillis(yield* DateTime.now);
    const record = (
      root: string,
      operation: Omit<GameOperation, "revision">,
      eventState: GameOperationEventState,
      owner?: string,
    ) =>
      Effect.gen(function* () {
        revision += 1;
        operations.set(root, { ...operation, revision });
        const ownerThreadId = ownerThread(owner);
        yield* PubSub.publish(events, {
          root,
          revision,
          name: operation.name,
          state: eventState,
          message: operation.message,
          at: DateTime.formatIso(yield* DateTime.now),
          ...(ownerThreadId === undefined ? {} : { ownerThreadId }),
        });
      }).pipe(Effect.withSpan("GameOperations.record"));
    // Every operation asked for on a game, queued ones too: a turn that ends
    // cancels only its own work, wherever it is. The production run runs boot
    // checks on the same game while role turns are being interrupted at their caps.
    const entries = new Map<string, Set<Entry>>();
    const cancel = Effect.fnUntraced(function* (root: string, owner?: string) {
      const matching = [...(entries.get(root) ?? [])].filter(
        (entry) => owner === undefined || entry.owner === owner,
      );
      for (const entry of matching) yield* Deferred.succeed(entry.cancelled, undefined);
      // The race interrupts work and awaits its finalizers, including native child exit.
      for (const entry of matching) yield* Deferred.await(entry.done);
    });
    const busy = (root: string, name: string) =>
      new GameOperationError({
        operation: name,
        path: root,
        reason: "busy",
        detail: `${[...(entries.get(root) ?? [])].find((entry) => entry.running)?.name ?? "Another operation"} is running on this game.`,
      });
    const exclusive = <A, E = GameOperationError, R = never>(
      root: string,
      name: string,
      work: Effect.Effect<A, E, R>,
      owner: string,
      options?: { readonly waitUntil?: number },
    ): Effect.Effect<A, E | GameOperationError, R> =>
      Effect.gen(function* () {
        const entry: Entry = {
          name,
          owner,
          cancelled: yield* Deferred.make<void>(),
          done: yield* Deferred.make<void>(),
          running: false,
        };
        const waitMs =
          options?.waitUntil === undefined
            ? 0
            : Math.max(0, options.waitUntil - (yield* Clock.currentTimeMillis));
        // Recorded and pushed only once it holds the game; the record of its end
        // is in the same uninterruptible release, so no interrupt leaves a game
        // busy with nothing running.
        const held = Effect.acquireUseRelease(
          Effect.gen(function* () {
            entry.running = true;
            const at = DateTime.formatIso(yield* DateTime.now);
            yield* record(
              root,
              { name, state: "running", message: `${name} is running.`, at },
              "running",
              owner,
            );
            return at;
          }),
          () => work,
          (at, exit) => {
            if (exit._tag === "Success") {
              const failed = operationFailed(exit.value);
              return record(
                root,
                {
                  name,
                  state: failed ? "failed" : "succeeded",
                  message: operationMessage(exit.value, name),
                  at,
                },
                failed ? "failed" : "succeeded",
                owner,
              );
            }
            return Effect.gen(function* () {
              const wasCancelled = yield* Deferred.isDone(entry.cancelled);
              const failure = Cause.findErrorOption(exit.cause);
              yield* record(
                root,
                {
                  name,
                  // The status field has no cancelled state; Stop reads as a
                  // failed run with an honest message.
                  state: "failed",
                  message:
                    Option.isSome(failure) && !wasCancelled
                      ? errorMessage(failure.value)
                      : `${name} was cancelled.`,
                  at,
                },
                wasCancelled || Option.isNone(failure) ? "cancelled" : "failed",
                owner,
              );
            });
          },
        );
        const locked = locks
          .tryWithLock(root, waitMs, held)
          .pipe(
            Effect.flatMap((ran) =>
              Option.isSome(ran) ? Effect.succeed(ran.value) : Effect.fail(busy(root, name)),
            ),
          );
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const set = entries.get(root) ?? new Set<Entry>();
            set.add(entry);
            entries.set(root, set);
          }),
          () =>
            locked.pipe(
              Effect.raceFirst(
                Deferred.await(entry.cancelled).pipe(
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
            ),
          () =>
            Effect.sync(() => {
              const set = entries.get(root);
              set?.delete(entry);
              if (set?.size === 0) entries.delete(root);
            }).pipe(Effect.andThen(Deferred.succeed(entry.done, undefined))),
        );
      });
    return GameOperations.of({
      changed: (root, name, message) =>
        Effect.gen(function* () {
          yield* PubSub.publish(events, {
            root,
            name,
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
