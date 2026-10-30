// @effect-diagnostics globalTimers:off -- Real loopback WebSocket; no timers, only ownership.
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServer } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  makeOwnedObservationTransport,
  observationProtocolLayer,
} from "./observation-transport.ts";
import { retryObservationRead } from "./transport-recovery.ts";

const THREAD_ID = "thread:transport-protocol:test";

it.effect("concurrent reconnects retain only one owned client", () =>
  Effect.gen(function* () {
    const live = yield* Ref.make(0);
    const peak = yield* Ref.make(0);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeOwnedObservationTransport((scope) =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(live, (n) => n + 1);
            yield* Ref.update(peak, (n) => Math.max(n, count));
            yield* Scope.addFinalizer(
              scope,
              Ref.update(live, (n) => n - 1),
            );
            yield* Effect.yieldNow;
            return { connected: true };
          }),
        );
        yield* Effect.all([transport.reconnect, transport.reconnect], { concurrency: "unbounded" });
        assert.equal(yield* Ref.get(peak), 1);
        assert.equal(yield* Ref.get(live), 1);
      }),
    );
    assert.equal(yield* Ref.get(live), 0);
  }),
);
const RUN_ID = "run:transport-protocol:ordinal:1";
const LOOP_ID = "loop-transport-protocol";

it.effect("cancelling a reconnect releases the partial client without completing acquisition", () =>
  Effect.gen(function* () {
    const live = yield* Ref.make(0);
    const entered = yield* Deferred.make<void>();
    const releaseBuild = yield* Deferred.make<void>();
    const completed = yield* Ref.make(false);
    let builds = 0;
    const transport = yield* makeOwnedObservationTransport((scope) =>
      Effect.gen(function* () {
        yield* Ref.update(live, (n) => n + 1);
        yield* Scope.addFinalizer(
          scope,
          Ref.update(live, (n) => n - 1),
        );
        builds += 1;
        if (builds > 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(releaseBuild);
          yield* Ref.set(completed, true);
        }
        return { connected: true };
      }),
    );
    const reconnecting = yield* transport.reconnect.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    // Deliver cancellation before releasing acquisition, without waiting on it.
    yield* Effect.sync(() => reconnecting.interruptUnsafe());
    yield* Deferred.succeed(releaseBuild, undefined);
    yield* Fiber.await(reconnecting);
    assert.isFalse(yield* Ref.get(completed));
    assert.equal(yield* Ref.get(live), 0);
  }),
);

const StatusResult = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  loopId: Schema.String,
  mutations: Schema.Number,
});
const SubmitResult = Schema.Struct({ ok: Schema.Boolean, count: Schema.Number });

const TestGroup = RpcGroup.make(
  Rpc.make("status", { success: StatusResult }),
  Rpc.make("submit", { success: SubmitResult }),
  Rpc.make("boom", { success: Schema.String }),
);

const makeHandlers = (mutations: Ref.Ref<number>) =>
  TestGroup.toLayer({
    status: () =>
      Effect.gen(function* () {
        const count = yield* Ref.get(mutations);
        return { threadId: THREAD_ID, runId: RUN_ID, loopId: LOOP_ID, mutations: count };
      }),
    submit: () =>
      Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(mutations, (n) => n + 1);
        return { ok: true, count };
      }),
    boom: () => Effect.die(new Error("permanent transport-protocol boom")),
  });

const makeServerRunning = (mutations: Ref.Ref<number>) => {
  const rpcLive = RpcServer.layer(TestGroup, { disableFatalDefects: true }).pipe(
    Layer.provide(makeHandlers(mutations)),
    Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
    Layer.provideMerge(RpcSerialization.layerJson),
  );
  return HttpRouter.serve(rpcLive, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
};

const serverUrlOf = (ctx: Context.Context<HttpServer.HttpServer>) => {
  const server = Context.get(ctx, HttpServer.HttpServer);
  const port = (server.address as NetAddress.InetAddress).port;
  return `http://127.0.0.1:${port}/rpc`;
};

it.live(
  "real WebSocket reconnect keeps identity, mutation once, old transport closed promptly",
  () =>
    Effect.gen(function* () {
      const mutations = yield* Ref.make(0);
      const serverScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
      const serverCtx = yield* Layer.buildWithScope(makeServerRunning(mutations), serverScope);
      const url = serverUrlOf(serverCtx);

      const urlRef = yield* Ref.make(url);
      const live = yield* Ref.make(0);
      const oldClosed = yield* Deferred.make<void>();
      const firstScope = yield* Ref.make<Scope.Closeable | null>(null);
      yield* Effect.addFinalizer(() =>
        Ref.get(firstScope).pipe(
          Effect.flatMap((scope) => (scope === null ? Effect.void : Scope.close(scope, Exit.void))),
          Effect.ignore,
        ),
      );
      let firstBuild = true;
      const transport = yield* makeOwnedObservationTransport((scope: Scope.Scope) =>
        Effect.gen(function* () {
          yield* Ref.update(live, (n) => n + 1);
          yield* Scope.addFinalizer(
            scope,
            Ref.update(live, (n) => n - 1),
          );
          if (firstBuild) {
            firstBuild = false;
            yield* Ref.set(firstScope, scope as Scope.Closeable);
            yield* Scope.addFinalizer(scope, Deferred.succeed(oldClosed, undefined));
          }
          const url = yield* Ref.get(urlRef);
          const ctx = yield* Layer.buildWithScope(observationProtocolLayer(url), scope);
          return yield* RpcClient.make(TestGroup).pipe(Effect.provide(ctx));
        }),
      );

      let client = yield* transport.current;
      const submitted = yield* client.submit();
      assert.equal(submitted.count, 1);
      const before = yield* client.status();
      assert.equal(before.threadId, THREAD_ID);
      assert.equal(before.runId, RUN_ID);
      assert.equal(before.loopId, LOOP_ID);
      assert.equal(before.mutations, 1);
      assert.equal(yield* Ref.get(live), 1);

      const fakePingTimeout = () =>
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketReadError({ cause: new Error("ping timeout") }),
        });
      let failOnce = true;
      let reconnects = 0;
      const result = yield* retryObservationRead(
        () =>
          failOnce
            ? Effect.gen(function* () {
                failOnce = false;
                return yield* Effect.fail(fakePingTimeout());
              })
            : client.status(),
        () =>
          Effect.gen(function* () {
            reconnects += 1;
            yield* transport.reconnect;
            client = yield* transport.current;
          }),
        { maxAttempts: 4, retryDelayMs: 5 },
      );
      assert.equal(result.threadId, THREAD_ID);
      assert.equal(result.runId, RUN_ID);
      assert.equal(result.loopId, LOOP_ID);
      assert.equal(result.mutations, 1);
      assert.equal(reconnects, 1);
      assert.equal(yield* Ref.get(mutations), 1);
      assert.equal(yield* Ref.get(live), 1);
      assert.isTrue(
        yield* Deferred.poll(oldClosed).pipe(Effect.map((option) => option._tag === "Some")),
      );

      yield* transport.close;
      assert.equal(yield* Ref.get(live), 0);
      yield* Scope.close(serverScope, Exit.void);
    }),
);

it.effect("real WebSocket permanent error fails without reconnect", () =>
  Effect.gen(function* () {
    const mutations = yield* Ref.make(0);
    const serverScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
    const serverCtx = yield* Layer.buildWithScope(makeServerRunning(mutations), serverScope);
    const url = serverUrlOf(serverCtx);

    const transport = yield* makeOwnedObservationTransport((scope: Scope.Scope) =>
      Effect.gen(function* () {
        const ctx = yield* Layer.buildWithScope(observationProtocolLayer(url), scope);
        return yield* RpcClient.make(TestGroup).pipe(Effect.provide(ctx));
      }),
    );
    const client = yield* transport.current;

    let reconnects = 0;
    const calls = yield* Ref.make(0);
    const exit = yield* Effect.exit(
      retryObservationRead(
        () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(client.boom())),
        () =>
          Effect.sync(() => {
            reconnects += 1;
          }),
        { maxAttempts: 4, retryDelayMs: 5 },
      ),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
    assert.equal(reconnects, 0);

    yield* transport.close;
    yield* Scope.close(serverScope, Exit.void);
  }),
);

it.effect("owned transport cancellation closes the live socket", () =>
  Effect.gen(function* () {
    const mutations = yield* Ref.make(0);
    const serverScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
    const serverCtx = yield* Layer.buildWithScope(makeServerRunning(mutations), serverScope);
    const url = serverUrlOf(serverCtx);

    const live = yield* Ref.make(0);
    const released = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const running = yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeOwnedObservationTransport((scope: Scope.Scope) =>
          Effect.gen(function* () {
            yield* Ref.update(live, (n) => n + 1);
            yield* Scope.addFinalizer(
              scope,
              Ref.update(live, (n) => n - 1),
            );
            yield* Scope.addFinalizer(scope, Deferred.succeed(released, undefined));
            const ctx = yield* Layer.buildWithScope(observationProtocolLayer(url), scope);
            return yield* RpcClient.make(TestGroup).pipe(Effect.provide(ctx));
          }),
        );
        const client = yield* transport.current;
        const status = yield* client.status();
        assert.equal(status.threadId, THREAD_ID);
        assert.equal(yield* Ref.get(live), 1);
        yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(running);
    assert.equal(yield* Ref.get(live), 0);
    assert.isTrue(
      yield* Deferred.poll(released).pipe(Effect.map((option) => option._tag === "Some")),
    );

    yield* Scope.close(serverScope, Exit.void);
  }),
);
