import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as GameOperations from "./GameOperations.ts";

// A game must never stay busy with nothing running: every later operation and
// every Stop would refuse or wait on it forever.
it.effect("no interrupt or cancel, waiting or running, leaves a game busy", () =>
  Effect.gen(function* () {
    const operations = yield* GameOperations.GameOperations;
    const entered = yield* Deferred.make<void>();
    const holder = yield* operations
      .exclusive(
        "/g",
        "Export Linux",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        "thread-a",
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);

    const refused = yield* operations
      .exclusive("/g", "Import", Effect.succeed("ran"), "thread-b")
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "busy");
    assert.include(refused.detail ?? "", "Export Linux");

    // A queued operation of another owner, then a cancel of that owner: the
    // queued one ends without running, and the running one is untouched.
    const queued = yield* operations
      .exclusive("/g", "Check", Effect.succeed("ran"), "thread-b", { waitUntil: 60_000 })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* operations.cancel("/g", "thread-b");
    assert.strictEqual((yield* Fiber.join(queued).pipe(Effect.flip)).reason, "cancelled");

    // A waiter past its deadline refuses busy.
    const late = yield* operations
      .exclusive("/g", "Check", Effect.succeed("ran"), "thread-c", { waitUntil: 1_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    assert.strictEqual((yield* Fiber.join(late).pipe(Effect.flip)).reason, "busy");

    // Interrupting the holder frees the game, and its end is recorded.
    yield* Fiber.interrupt(holder);
    assert.strictEqual(operations.current("/g")?.state, "failed");
    assert.strictEqual(
      yield* operations.exclusive("/g", "Import", Effect.succeed("ran"), "thread-b"),
      "ran",
    );

    // Interrupting a waiter frees nothing it never held, and leaves no entry.
    const gate = yield* Deferred.make<void>();
    const second = yield* operations
      .exclusive("/g", "Export Web", Deferred.await(gate), "thread-a")
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const waiter = yield* operations
      .exclusive("/g", "Check", Effect.succeed("ran"), "thread-d", { waitUntil: 60_000 })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(second);
    // cancel resolves at once: nothing of the game is queued or running.
    yield* operations.cancel("/g");
    assert.strictEqual(
      yield* operations.exclusive("/g", "Import", Effect.succeed("free"), "thread-d"),
      "free",
    );
  }).pipe(Effect.provide(GameOperations.layer)),
);
