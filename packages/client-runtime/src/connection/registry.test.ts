import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@kurambit/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

import { runDesktopCommitWithReconnectObserver } from "../state/server.ts";
import { v2ShellSnapshot } from "../state/orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const CACHED_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

interface SessionControl {
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (options?: {
  readonly prepareError?: ConnectionBlockedError;
}) {
  const shellCache = yield* Ref.make(new Map([[TARGET.environmentId, CACHED_SNAPSHOT]]));
  const cacheClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const ownedDataClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const sessions = yield* Ref.make<ReadonlyArray<SessionControl>>([]);
  const releasedSessions = yield* Ref.make(0);

  const cacheStore = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) =>
      Ref.get(shellCache).pipe(
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId))),
      ),
    saveShell: (environmentId, snapshot) =>
      Ref.update(shellCache, (current) => new Map(current).set(environmentId, snapshot)),
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: (environmentId) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(cacheClears, (environmentIds) => [...environmentIds, environmentId]),
        ),
      ),
  });
  const ownedDataCleanup = Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Ref.update(ownedDataClears, (environmentIds) => [...environmentIds, environmentId]),
  });
  const networkStatus = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      Effect.gen(function* () {
        yield* reportProgress({ stage: "preparing" });
        if (options?.prepareError) return yield* options.prepareError;
        const prepared: PreparedConnection = {
          ...PREPARED,
          environmentId: entry.target.environmentId,
          label: entry.target.label,
          target: entry.target,
        };
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        yield* Ref.update(sessions, (current) => [...current, { closed }]);
        const session = yield* Effect.acquireRelease(
          Effect.succeed({
            client: {} as RpcSession.RpcSession["client"],
            initialConfig: Effect.die(new Error("Config is not used by registry tests.")),
            subscribeServerConfig: () =>
              Stream.die(new Error("Config is not used by registry tests.")),
            ready: Effect.void,
            probe: Effect.void,
            closed: Deferred.await(closed),
          } satisfies RpcSession.RpcSession),
          () => Ref.update(releasedSessions, (count) => count + 1),
        );
        return { prepared, session };
      }),
  });

  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore),
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, ownedDataCleanup),
      ),
    ),
  );

  return {
    layer,
    shellCache,
    cacheClears,
    ownedDataClears,
    sessions,
    releasedSessions,
    networkStatus,
  };
});

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

const connectPrimary = (registry: EnvironmentRegistry.EnvironmentRegistry["Service"]) =>
  registry
    .setPrimary(Option.some(TARGET))
    .pipe(
      Effect.andThen(
        awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        ),
      ),
    );

describe("EnvironmentRegistry", () => {
  it.effect("replays connected state when arming a desktop commit observer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);

        const commits = yield* Ref.make(0);
        const result = yield* runDesktopCommitWithReconnectObserver(
          registry.stateChanges(TARGET.environmentId),
          Ref.update(commits, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail("commit refused")),
          ),
        ).pipe(Effect.flip, Effect.timeout("1 second"));

        expect(result).toBe("commit refused");
        expect(yield* Ref.get(commits)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not acquire a session after the registry scope has already closed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registryScope = yield* Scope.make();
      const context = yield* Layer.build(harness.layer).pipe(Scope.provide(registryScope));
      const registry = Context.get(context, EnvironmentRegistry.EnvironmentRegistry);
      const dispatcher = new Scheduler.MixedScheduler("sync", () => () => {}).makeDispatcher();
      const scheduler: Scheduler.Scheduler = {
        executionMode: "sync",
        shouldYield: () => false,
        makeDispatcher: () => dispatcher,
      };

      yield* Scope.close(registryScope, Exit.void);
      yield* registry
        .setPrimary(Option.some(TARGET))
        .pipe(Effect.exit, Effect.provideService(Scheduler.Scheduler, scheduler));
      dispatcher.flush();

      expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
    }),
  );

  it.effect("publishes network status changes independently of connection state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const offline = yield* Effect.forkChild(
          SubscriptionRef.changes(registry.networkStatus).pipe(
            Stream.filter((status) => status === "offline"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );

        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        expect(yield* Fiber.join(offline)).toBe("offline");
        expect(yield* SubscriptionRef.get(registry.networkStatus)).toBe("offline");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("exposes the current RPC generation to late query subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);

        const generation = yield* registry
          .runStream(
            TARGET.environmentId,
            Stream.unwrap(
              EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.concat(
                    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(
                    Stream.filterMap((state) =>
                      state.phase === "connected"
                        ? Result.succeed(state.generation)
                        : Result.failVoid,
                    ),
                    Stream.changes,
                  ),
                ),
              ),
            ),
          )
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        expect(generation).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves cached data on connection failure and clears it when the server goes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);
        const controls = yield* Ref.get(harness.sessions);
        expect(controls).toHaveLength(1);

        const retryFiber = yield* Effect.forkChild(
          awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.fail(
          controls[0]!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        );
        yield* Fiber.join(retryFiber);
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        yield* registry.setPrimary(Option.none());
        expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([TARGET.environmentId]);
        expect((yield* SubscriptionRef.get(registry.entries)).size).toBe(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the previous server's data when a different server takes its place", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const next = new PrimaryConnectionTarget({
        ...TARGET,
        environmentId: EnvironmentId.make("environment-2"),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);

        yield* registry.setPrimary(Option.some(next));
        yield* awaitConnectionState(
          registry,
          next.environmentId,
          (state) => state.phase === "connected",
        );

        expect([...(yield* SubscriptionRef.get(registry.entries)).keys()]).toEqual([
          next.environmentId,
        ]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("an unsupported verdict switches the server off and releases its session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Use a compatible client.",
          serverUpdateRequired: true,
        });
        yield* registry.setUnsupported(TARGET.environmentId, error);
        expect((yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)).toEqual({
          target: TARGET,
          enabled: false,
          unsupportedReason: error.message,
          serverUpdateRequired: true,
        });
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "available",
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a socket preflight rejection switches the connection off", () =>
    Effect.gen(function* () {
      const error = new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Use a compatible client.",
      });
      const harness = yield* makeHarness({ prepareError: error });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.setPrimary(Option.some(TARGET));
        yield* SubscriptionRef.changes(registry.entries).pipe(
          Stream.filter((entries) => entries.get(TARGET.environmentId)?.enabled === false),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)
            ?.unsupportedReason,
        ).toBe(error.message);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("moves durable streams to a replacement supervisor", () =>
    Effect.gen(function* () {
      const replacement = new PrimaryConnectionTarget({ ...TARGET, label: "Renamed environment" });
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstObserved = yield* Deferred.make<void>();
        const secondObserved = yield* Deferred.make<void>();
        const labels = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* connectPrimary(registry);

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              TARGET.environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) =>
                    Stream.concat(Stream.succeed(supervisor.target.label), Stream.never),
                  ),
                ),
              ),
            )
            .pipe(
              Stream.tap((label) =>
                Ref.updateAndGet(labels, (current) => [...current, label]).pipe(
                  Effect.flatMap((current) =>
                    current.length === 1
                      ? Deferred.succeed(firstObserved, undefined)
                      : Deferred.succeed(secondObserved, undefined),
                  ),
                ),
              ),
              Stream.runDrain,
            ),
        );

        yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));
        yield* registry.setPrimary(Option.some(replacement));
        yield* Deferred.await(secondObserved).pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(labels)).toEqual([TARGET.label, replacement.label]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores retry signals for environments that are no longer registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.retryNow(EnvironmentId.make("removed-environment"));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("platform refreshes preserve unsupported state for the same endpoint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* connectPrimary(registry);
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Use a compatible client.",
        });
        yield* registry.setUnsupported(TARGET.environmentId, error);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "available",
        );
        yield* registry.setPrimary(Option.some(TARGET));
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId),
        ).toMatchObject({ enabled: false, unsupportedReason: error.message });
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        yield* registry.setPrimary(
          Option.some(
            new PrimaryConnectionTarget({ ...TARGET, httpBaseUrl: "https://changed.example.test" }),
          ),
        );
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)
            ?.unsupportedReason,
        ).toBeUndefined();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps one session across concurrent platform refreshes and retries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* Effect.all(
          Array.from({ length: 5 }, () => registry.setPrimary(Option.some(TARGET))),
          { concurrency: "unbounded", discard: true },
        );
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        yield* Effect.all(
          [
            ...Array.from({ length: 5 }, () => registry.setPrimary(Option.some(TARGET))),
            ...Array.from({ length: 5 }, () => registry.retryNow(TARGET.environmentId)),
          ],
          { concurrency: "unbounded", discard: true },
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          yield* Effect.yieldNow;
        }

        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect(yield* registry.state(TARGET.environmentId)).toMatchObject({
          phase: "connected",
          generation: 1,
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
