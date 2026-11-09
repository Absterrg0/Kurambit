import { EnvironmentId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Connectivity from "./connectivity.ts";
import type {
  ConnectionCatalogEntry,
  NetworkStatus,
  PrimaryConnectionTarget,
  SupervisorConnectionState,
} from "./model.ts";
import { ConnectionBlockedError } from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";

export class EnvironmentNotRegisteredError extends Schema.TaggedError<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

/**
 * Holds the connection to the client's one local server. Threads and projects
 * still name it by environment id, so `entries` is keyed by id and holds at
 * most that one server.
 */
export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly setPrimary: (target: Option.Option<PrimaryConnectionTarget>) => Effect.Effect<void>;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /**
     * Switches the connection off with the server's verdict. It stays off until
     * the platform reports the server at a different address.
     */
    readonly setUnsupported: (
      environmentId: EnvironmentId,
      error: ConnectionBlockedError,
    ) => Effect.Effect<void>;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@kurambit/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: ConnectionCatalogEntry;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

function sameAddress(left: PrimaryConnectionTarget, right: PrimaryConnectionTarget): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registryScope = yield* Scope.Scope;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScope = yield* SubscriptionRef.make(Option.none<EnvironmentServiceScope>());
  // Serializes changes to the entry and its supervisor scope.
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);

  const currentEntry = SubscriptionRef.get(entries).pipe(
    Effect.map((current) => Option.fromUndefinedOr(current.values().next().value)),
  );

  const getEntry = Effect.fn("EnvironmentRegistry.getEntry")(function* (
    environmentId: EnvironmentId,
  ) {
    const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({ environmentId });
    }
    return entry;
  });

  const closeServiceScope = Effect.gen(function* () {
    const current = yield* SubscriptionRef.getAndSet(serviceScope, Option.none());
    if (Option.isSome(current)) {
      yield* Scope.close(current.value.scope, Exit.void);
    }
  });

  const setEntry = (entry: ConnectionCatalogEntry | undefined) =>
    SubscriptionRef.set(
      entries,
      entry === undefined ? new Map() : new Map([[entry.target.environmentId, entry]]),
    );

  const createServiceScope = Effect.fn("EnvironmentRegistry.createServiceScope")(
    (entry: ConnectionCatalogEntry) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const environmentId = entry.target.environmentId;
          const scope = yield* Scope.fork(registryScope);
          const supervisor = yield* EnvironmentSupervisor.make(entry, {
            initiallyDesired: false,
          }).pipe(
            Effect.provideService(Connectivity.Connectivity, connectivity),
            Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
            Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          if (entry.enabled) {
            yield* supervisor.connect;
          }
          yield* SubscriptionRef.set(serviceScope, Option.some({ entry, supervisor, scope }));
          yield* SubscriptionRef.changes(supervisor.state).pipe(
            Stream.runForEach((state) =>
              state.phase === "blocked" && state.lastFailure?.reason === "unsupported"
                ? setUnsupported(environmentId, state.lastFailure)
                : Effect.void,
            ),
            Effect.forkIn(scope),
          );
          return supervisor;
        }),
      ),
  );

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* locked(
      Effect.gen(function* () {
        const entry = yield* getEntry(environmentId);
        const existing = yield* SubscriptionRef.get(serviceScope);
        if (Option.isSome(existing)) {
          if (Equal.equals(existing.value.entry, entry)) {
            return existing.value.supervisor;
          }
          yield* closeServiceScope;
        }
        return yield* createServiceScope(entry);
      }),
    );
  });

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn("EnvironmentRegistry.run")(
    function* <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
      const supervisor = yield* acquireSupervisor(environmentId);
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
    },
  );

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(entries)),
      SubscriptionRef.changes(entries),
    ).pipe(
      Stream.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      Stream.changesWith(
        (previous, current) => Option.getOrNull(previous) === Option.getOrNull(current),
      ),
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: () =>
            Stream.unwrap(
              acquireSupervisor(environmentId).pipe(
                Effect.match({
                  onFailure: () => Stream.empty,
                  onSuccess: (supervisor) =>
                    Stream.provideService(
                      stream,
                      EnvironmentSupervisor.EnvironmentSupervisor,
                      supervisor,
                    ),
                }),
              ),
            ),
        }),
      ),
    );

  const clearEnvironmentData = (environmentId: EnvironmentId) =>
    Effect.all(
      [
        cache.clear(environmentId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not clear cached environment data after removal.", {
              environmentId,
              error,
            }),
          ),
        ),
        ownedDataCleanup.clear(environmentId),
      ],
      { concurrency: "unbounded", discard: true },
    );

  const setPrimary = Effect.fn("EnvironmentRegistry.setPrimary")(function* (
    target: Option.Option<PrimaryConnectionTarget>,
  ) {
    yield* locked(
      Effect.gen(function* () {
        const previous = yield* currentEntry;
        if (Option.isNone(target)) {
          if (Option.isNone(previous)) return;
          yield* closeServiceScope;
          yield* setEntry(undefined);
          yield* clearEnvironmentData(previous.value.target.environmentId);
          return;
        }
        // An unsupported verdict belongs to the address that earned it.
        const entry: ConnectionCatalogEntry =
          Option.isSome(previous) &&
          previous.value.unsupportedReason !== undefined &&
          sameAddress(previous.value.target, target.value)
            ? {
                target: target.value,
                enabled: false,
                unsupportedReason: previous.value.unsupportedReason,
                ...(previous.value.serverUpdateRequired === true
                  ? { serverUpdateRequired: true }
                  : {}),
              }
            : { target: target.value, enabled: true };
        const existingScope = yield* SubscriptionRef.get(serviceScope);
        if (
          Option.isSome(previous) &&
          Equal.equals(previous.value, entry) &&
          Option.isSome(existingScope) &&
          Equal.equals(existingScope.value.entry, entry)
        ) {
          return;
        }
        yield* closeServiceScope;
        yield* setEntry(entry);
        yield* createServiceScope(entry);
        if (
          Option.isSome(previous) &&
          previous.value.target.environmentId !== entry.target.environmentId
        ) {
          yield* clearEnvironmentData(previous.value.target.environmentId);
        }
      }),
    );
  });

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
      Effect.withSpan("EnvironmentRegistry.retryNow"),
    );

  const setUnsupported = Effect.fn("EnvironmentRegistry.setUnsupported")(function* (
    environmentId: EnvironmentId,
    error: ConnectionBlockedError,
  ) {
    yield* locked(
      Effect.gen(function* () {
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (
          entry === undefined ||
          (entry.unsupportedReason === error.message &&
            entry.serverUpdateRequired === error.serverUpdateRequired)
        )
          return;
        const { serverUpdateRequired: _previousUpdateRequired, ...rest } = entry;
        const next: ConnectionCatalogEntry = {
          ...rest,
          enabled: false,
          unsupportedReason: error.message,
          ...(error.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
        };
        // Update the scope in place so the supervisor keeps its generation and
        // durable streams; replacing it would tear them down.
        const lease = yield* SubscriptionRef.get(serviceScope);
        if (Option.isSome(lease)) {
          yield* SubscriptionRef.set(serviceScope, Option.some({ ...lease.value, entry: next }));
          yield* lease.value.supervisor.disconnect;
        }
        yield* setEntry(next);
      }),
    );
  });

  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* SubscriptionRef.get(supervisor.state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() => closeServiceScope);
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );

  return EnvironmentRegistry.of({
    entries,
    networkStatus,
    setPrimary,
    retryNow,
    setUnsupported,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make);
