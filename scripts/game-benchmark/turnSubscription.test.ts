import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { runTurnSubscription } from "./turnSubscription.ts";

const textFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

it.effect("fails both waiters when the stream closes before its snapshot", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void, string>();
    const done = yield* Deferred.make<number, string>();
    yield* runTurnSubscription({
      entries: Stream.empty,
      onEntry: () => Effect.void,
      ready,
      done,
      failure: textFailure,
      closedBeforeReady: "closed before ready",
      closedBeforeDone: "closed before done",
    });
    assert.equal(yield* Effect.flip(Deferred.await(ready)), "closed before ready");
    assert.equal(yield* Effect.flip(Deferred.await(done)), "closed before ready");
  }),
);

it.effect("fails both waiters when the stream errors before its snapshot", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void, string>();
    const done = yield* Deferred.make<number, string>();
    yield* runTurnSubscription({
      entries: Stream.fail("socket died"),
      onEntry: () => Effect.void,
      ready,
      done,
      failure: textFailure,
      closedBeforeReady: "closed before ready",
      closedBeforeDone: "closed before done",
    });
    assert.equal(yield* Effect.flip(Deferred.await(ready)), "socket died");
    assert.equal(yield* Effect.flip(Deferred.await(done)), "socket died");
  }),
);

it.effect("fails both waiters when handling an entry fails before readiness", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void, string>();
    const done = yield* Deferred.make<number, string>();
    yield* runTurnSubscription({
      entries: Stream.make("snapshot"),
      onEntry: () => Effect.fail("snapshot failed"),
      ready,
      done,
      failure: textFailure,
      closedBeforeReady: "closed before ready",
      closedBeforeDone: "closed before done",
    });
    assert.equal(yield* Effect.flip(Deferred.await(ready)), "snapshot failed");
    assert.equal(yield* Effect.flip(Deferred.await(done)), "snapshot failed");
  }),
);

it.effect("fails the turn waiter when the stream closes after readiness", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void, string>();
    const done = yield* Deferred.make<number, string>();
    yield* runTurnSubscription({
      entries: Stream.make("snapshot"),
      onEntry: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      ready,
      done,
      failure: textFailure,
      closedBeforeReady: "closed before ready",
      closedBeforeDone: "closed before done",
    });
    assert.isUndefined(yield* Deferred.await(ready));
    assert.equal(yield* Effect.flip(Deferred.await(done)), "closed before done");
  }),
);

it.effect("does not overwrite a turn that finished before a late stream failure", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void, string>();
    const done = yield* Deferred.make<number, string>();
    yield* runTurnSubscription({
      entries: Stream.concat(Stream.make("snapshot", "terminal"), Stream.fail("late socket error")),
      onEntry: (entry) =>
        entry === "snapshot"
          ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
          : Deferred.succeed(done, 42).pipe(Effect.asVoid),
      ready,
      done,
      failure: textFailure,
      closedBeforeReady: "closed before ready",
      closedBeforeDone: "closed before done",
    });
    assert.isUndefined(yield* Deferred.await(ready));
    assert.equal(yield* Deferred.await(done), 42);
  }),
);
