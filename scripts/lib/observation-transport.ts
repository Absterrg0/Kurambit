// @effect-diagnostics globalTimers:off -- Scope ownership only; no timers or sleeps.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";

/**
 * Production observation transport glue.
 *
 * Single place that builds the RpcClient.Protocol layer used for harness
 * observation reads. `pingTimeout: "30 seconds"`, `retryTransientErrors:
 * false`, `retryPolicy: Schedule.recurs(0)` is deliberate: the protocol never
 * replays in-flight opens and a dead mid-stream protocol stays dead
 * (`currentError` set). Recovery is a bounded harness-level reconnect for
 * idempotent observation reads only; mutations are never replayed.
 */
export const OBSERVATION_PING_TIMEOUT = "30 seconds" as const;

export const observationProtocolLayer = (
  url: string,
): Layer.Layer<RpcClient.Protocol, never, Scope.Scope> =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      pingTimeout: OBSERVATION_PING_TIMEOUT,
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(
    Layer.provide(
      Layer.merge(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );

export interface OwnedObservationTransport<Client, E> {
  /** Current live client. Dies (defect) only if the transport was closed. */
  readonly current: Effect.Effect<Client>;
  /** Close the live transport promptly, then open a fresh one. At most one live. */
  readonly reconnect: Effect.Effect<void, E>;
  /** Close the live transport promptly. Safe to call more than once. */
  readonly close: Effect.Effect<void>;
}

/**
 * Owns at most one live socket/protocol/client.
 *
 * Each transport lives in its own closeable child scope built with
 * `Layer.buildWithScope`. `reconnect` closes the old scope promptly before
 * opening the next, so a replaced broken transport never lingers until the
 * parent scope ends. Leaving the parent scope (or interrupting it) closes
 * whatever is live via an outer finalizer, so cancellation closes current.
 *
 * `build` runs for the initial transport and for every reconnect, so callers
 * that need a fresh URL (re-authenticate) fetch it inside `build`.
 */
export const makeOwnedObservationTransport = <Client, E>(
  build: (scope: Scope.Scope) => Effect.Effect<Client, E, Scope.Scope>,
): Effect.Effect<OwnedObservationTransport<Client, E>, E, Scope.Scope> =>
  Effect.gen(function* () {
    const gate = Semaphore.makeUnsafe(1);
    const holder = yield* Ref.make<{
      readonly scope: Scope.Closeable;
      readonly client: Client;
    } | null>(null);

    const closeCurrent: Effect.Effect<void> = Effect.gen(function* () {
      const prev = yield* Ref.getAndSet(holder, null);
      if (prev !== null) {
        yield* Scope.close(prev.scope, Exit.void);
      }
    }).pipe(Effect.uninterruptible);

    const openOne: Effect.Effect<void, E> = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const client = yield* restore(Effect.provideService(build(scope), Scope.Scope, scope)).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void,
          ),
        );
        yield* Ref.set(holder, { scope, client });
      }),
    );

    const close = gate.withPermits(1)(closeCurrent);
    yield* Effect.addFinalizer(() => close);
    yield* openOne;

    const current: Effect.Effect<Client> = Effect.gen(function* () {
      const state = yield* Ref.get(holder);
      if (state === null) {
        return yield* Effect.die(new Error("observation transport is closed"));
      }
      return state.client;
    }).pipe(gate.withPermits(1));

    const reconnect: Effect.Effect<void, E> = Effect.gen(function* () {
      yield* closeCurrent;
      yield* openOne;
    }).pipe(gate.withPermits(1));

    return { current, reconnect, close };
  });
