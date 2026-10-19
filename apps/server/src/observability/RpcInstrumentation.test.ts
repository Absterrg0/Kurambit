import { assert, describe, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  ScheduledTaskId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./RpcInstrumentation.ts";

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

const groupOf = <const Tags extends ReadonlyArray<WsRpcMethod>>(...tags: Tags) =>
  WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsRpcMethod, Tags[number]> =>
        !(tags as ReadonlyArray<string>).includes(tag),
    ),
  ).middleware(RpcInstrumentation);

const connectionMiddleware = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.merge(RpcAuthorization.layer(scopes), rpcInstrumentationLayer);
const readOnlyConnection = connectionMiddleware([AuthOrchestrationReadScope]);
const taskId = ScheduledTaskId.make("scheduled-task:instrumented");
const rpcSpanDefaults = { "rpc.transport": "websocket", "rpc.system": "effect-rpc" };

const withTelemetry = <A, E, R>(
  test: (ended: ReadonlyArray<Tracer.NativeSpan>) => Effect.Effect<A, E, R>,
) => {
  const ended: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        ended.push(span);
      };
      return span;
    },
  });
  return test(ended).pipe(
    Effect.scoped,
    Effect.withTracer(tracer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
};

const rpcSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => span.name.startsWith("ws.rpc."));

// RpcTest keeps Effect's own RpcServer/RpcClient spans, which ws.ts turns off with
// `disableTracing: true`.
const appSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => span.attributes.get("rpc.system.name") !== "effect_rpc");

const exitTag = (span: Tracer.NativeSpan | undefined) =>
  span?.status._tag === "Ended" ? span.status.exit._tag : undefined;

const parentSpanId = (span: Tracer.NativeSpan | undefined) =>
  span?.parent._tag === "Some" ? span.parent.value.spanId : undefined;

const requestCount = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  method: string,
  outcome: string,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Counter" }> =>
      snapshot.type === "Counter" &&
      snapshot.id === "t3_rpc_requests_total" &&
      snapshot.attributes?.["method"] === method &&
      snapshot.attributes?.["outcome"] === outcome,
  )?.state;

const requestDuration = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, method: string) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }> =>
      snapshot.type === "Histogram" &&
      snapshot.id === "t3_rpc_request_duration" &&
      snapshot.attributes?.["method"] === method,
  )?.state;

describe("WS RPC instrumentation middleware", () => {
  it.effect("keeps a stream's span and duration open until the subscription is interrupted", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const group = groupOf(WS_METHODS.pullRequestsSubscribeRefreshes);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.pullRequestsSubscribeRefreshes, () =>
                Stream.concat(
                  Stream.make(1),
                  Stream.fromEffect(
                    Deferred.succeed(waiting, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.withSpan("refreshes.wait"),
                    ),
                  ),
                ),
              ),
              readOnlyConnection,
            ),
          ),
        );

        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.setTime(0);
        const consumer = yield* Stream.runDrain(
          client[WS_METHODS.pullRequestsSubscribeRefreshes]({}),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust(Duration.millis(250));
        yield* TestClock.setTime(0);
        assert.deepStrictEqual(appSpans(ended), []);

        yield* Fiber.interrupt(consumer);

        const [rpcSpan] = rpcSpans(ended);
        assert.equal(rpcSpan?.name, "ws.rpc.pullRequests.subscribeRefreshes");
        assert.equal(exitTag(rpcSpan), "Failure");
        const waitSpan = ended.find((span) => span.name === "refreshes.wait");
        assert.equal(parentSpanId(waitSpan), rpcSpan?.spanId);

        const snapshots = yield* Metric.snapshot;
        assert.equal(
          requestCount(snapshots, WS_METHODS.pullRequestsSubscribeRefreshes, "interrupt")?.count,
          1,
        );
        const duration = requestDuration(snapshots, WS_METHODS.pullRequestsSubscribeRefreshes);
        assert.equal(duration?.count, 1);
        assert.equal(duration?.sum, 250);
      }),
    ),
  );

  it.effect("records metrics but no spans for methods with tracing disabled", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const group = groupOf(WS_METHODS.serverSignalProcess);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverSignalProcess, (input) =>
                Effect.succeed({
                  pid: input.pid,
                  signal: input.signal,
                  signaled: true,
                  message: Option.none(),
                }).pipe(Effect.withSpan("signalProcess.child")),
              ),
              connectionMiddleware([AuthOrchestrationReadScope, AuthEnvironmentMaintainScope]),
            ),
          ),
        );

        const input = { pid: 4242, startTimeMs: 0, signal: "SIGINT" } as const;
        assert.equal((yield* client[WS_METHODS.serverSignalProcess](input)).signaled, true);

        assert.deepStrictEqual(appSpans(ended), []);
        const snapshots = yield* Metric.snapshot;
        assert.equal(requestCount(snapshots, WS_METHODS.serverSignalProcess, "success")?.count, 1);
      }),
    ),
  );
});
