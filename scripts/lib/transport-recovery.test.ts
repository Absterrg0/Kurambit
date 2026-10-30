// @effect-diagnostics globalTimers:off -- Delays are injected fake sleeps; no real timers.
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import { isTransientTransportError, retryObservationRead } from "./transport-recovery.ts";

const pingTimeout = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketReadError({ cause: new Error("ping timeout") }),
  });

const closeError = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({ code: 1006 }),
  });

const permanentDefect = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "Error decoding message",
      cause: new Error("bad frame"),
    }),
  });

const fakeClock = (start: number) =>
  Effect.gen(function* () {
    const now = yield* Ref.make(start);
    return {
      now: Ref.get(now),
      sleep: Ref.update(now, (value) => value + 5_000).pipe(Effect.asVoid),
      current: Ref.get(now),
    };
  });

it.effect("transient read disconnect followed by same-identity success", () =>
  Effect.gen(function* () {
    const threadId = "thread:project:abc:123";
    const runId = "run:thread:abc:ordinal:1";
    const loopId = "loop-aeb4f1c0";
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const outages: Array<number> = [];
    const clock = yield* fakeClock(1_000_000);
    const read = () =>
      Effect.gen(function* () {
        const attempt = (yield* Ref.updateAndGet(calls, (value) => value + 1)) - 1;
        if (attempt === 0) return yield* Effect.fail(pingTimeout());
        return { threadId, runId, loop: { id: loopId, originatingRunId: runId } };
      });
    const result = yield* retryObservationRead(read, () => Ref.update(reconnects, (v) => v + 1), {
      maxAttempts: 4,
      now: clock.now,
      sleep: clock.sleep,
      onOutage: (info) => Effect.sync(() => outages.push(info.attempt)),
    });
    assert.equal(result.threadId, threadId);
    assert.equal(result.runId, runId);
    assert.equal(result.loop.id, loopId);
    assert.equal(result.loop.originatingRunId, runId);
    assert.equal(yield* Ref.get(calls), 2);
    assert.equal(yield* Ref.get(reconnects), 1);
    assert.deepEqual(outages, [1]);
    assert.isTrue(isTransientTransportError(pingTimeout()));
    assert.isTrue(isTransientTransportError(closeError()));
  }),
);

it.effect("finite exhaustion stops after the bound", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const clock = yield* fakeClock(2_000_000);
    const read = () =>
      Ref.updateAndGet(calls, (value) => value + 1).pipe(
        Effect.flatMap(() => Effect.fail(pingTimeout())),
      );
    const exit = yield* Effect.exit(
      retryObservationRead(read, () => Ref.update(reconnects, (value) => value + 1), {
        maxAttempts: 3,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 3);
    assert.equal(yield* Ref.get(reconnects), 2);
  }),
);

it.effect("stops without another attempt past the caller deadline", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const clock = yield* fakeClock(10_000_000);
    const read = () =>
      Ref.updateAndGet(calls, (value) => value + 1).pipe(
        Effect.flatMap(() => Effect.fail(pingTimeout())),
      );
    const exit = yield* Effect.exit(
      retryObservationRead(read, () => Ref.update(reconnects, (value) => value + 1), {
        maxAttempts: 4,
        deadlineMs: 10_000_000,
        deadlineReserveMs: 60_000,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
    assert.equal(yield* Ref.get(reconnects), 0);
  }),
);

it.effect("an interrupted wait aborts without another attempt", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const read = () =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (value) => value + 1);
        yield* Deferred.succeed(started, undefined);
        // Never completes on its own; the interrupt below must win.
        return yield* Effect.never;
      });
    const fiber = yield* retryObservationRead(read, () => Effect.void, {
      maxAttempts: 4,
      // Real sleep here: interruption must cut it short.
      retryDelayMs: 60_000,
    }).pipe(Effect.forkDetach);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
  }),
);

it.effect("does not reconnect when the retry delay crosses the deadline", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const clock = yield* fakeClock(1_000);
    const result = yield* Effect.exit(
      retryObservationRead(
        () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.fail(pingTimeout()))),
        () => Ref.update(reconnects, (n) => n + 1),
        { now: clock.now, sleep: clock.sleep, deadlineMs: 3_000 },
      ),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
    assert.equal(yield* Ref.get(reconnects), 0);
  }),
);

it.effect("a nontransport refusal fails immediately without reconnect", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const clock = yield* fakeClock(3_000_000);
    const read = () =>
      Ref.updateAndGet(calls, (value) => value + 1).pipe(
        Effect.flatMap(() => Effect.fail(permanentDefect())),
      );
    const exit = yield* Effect.exit(
      retryObservationRead(read, () => Ref.update(reconnects, (value) => value + 1), {
        maxAttempts: 4,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
    assert.equal(yield* Ref.get(reconnects), 0);
    assert.isFalse(isTransientTransportError(permanentDefect()));
  }),
);

it.effect("a mutation runs exactly once even on transport loss", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const reconnects = yield* Ref.make(0);
    const clock = yield* fakeClock(4_000_000);
    // A submit-like mutation: transient loss must not replay it.
    const submit = () =>
      Ref.updateAndGet(calls, (value) => value + 1).pipe(
        Effect.flatMap(() => Effect.fail(pingTimeout())),
      );
    const exit = yield* Effect.exit(
      retryObservationRead(submit, () => Ref.update(reconnects, (value) => value + 1), {
        maxAttempts: 4,
        idempotent: false,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    assert.equal(exit._tag, "Failure");
    assert.equal(yield* Ref.get(calls), 1);
    assert.equal(yield* Ref.get(reconnects), 0);
  }),
);
