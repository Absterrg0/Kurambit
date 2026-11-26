import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makePlayLane } from "./playLane.ts";

it.effect(
  "a more urgent play interrupts a lower one, which runs again from the start after it",
  () =>
    Effect.gen(function* () {
      const lane = makePlayLane();
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      let attempts = 0;
      const background = Effect.gen(function* () {
        attempts += 1;
        log.push(`measure ${attempts}`);
        if (attempts === 1) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() => Effect.sync(() => log.push("measure gave way"))),
          );
        }
        log.push("measure done");
        return attempts;
      });
      const measure = yield* Effect.forkChild(lane.hold("background", background));
      yield* Deferred.await(started);
      yield* lane.hold(
        "agent",
        Effect.sync(() => log.push("check")),
      );
      expect(yield* Fiber.join(measure)).toBe(2);
      expect(log).toEqual(["measure 1", "measure gave way", "check", "measure 2", "measure done"]);
    }),
);

it.effect("an equal never interrupts the holder, and a raised waiter goes before a lower one", () =>
  Effect.gen(function* () {
    const lane = makePlayLane();
    const log: Array<string> = [];
    const gate = yield* Deferred.make<void>();
    const holding = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      lane.hold(
        "person",
        Effect.gen(function* () {
          log.push("A start");
          yield* Deferred.succeed(holding, undefined);
          yield* Deferred.await(gate);
          log.push("A end");
        }),
      ),
    );
    yield* Deferred.await(holding);
    const second = yield* Effect.forkChild(
      lane.hold(
        "turn",
        Effect.sync(() => log.push("B")),
      ),
      { startImmediately: true },
    );
    const late = lane.ticket("background");
    const third = yield* Effect.forkChild(
      lane.hold(
        late,
        Effect.sync(() => log.push("C")),
      ),
      { startImmediately: true },
    );
    // A person asked for C's build: it now goes before B, and as A's equal it interrupts nobody.
    yield* lane.raise(late, "person");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Fiber.join(third);
    expect(log).toEqual(["A start", "A end", "C", "B"]);
  }),
);

it.effect("a wider lane holds plays side by side, and a full one stops its least urgent", () =>
  Effect.gen(function* () {
    const lane = makePlayLane();
    yield* lane.setWidth(2);
    const log: Array<string> = [];
    const holding = (name: string, started: Deferred.Deferred<void>) => {
      let attempts = 0;
      return Effect.gen(function* () {
        attempts += 1;
        log.push(`${name} ${attempts}`);
        if (attempts > 1) return;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(() => log.push(`${name} gave way`))),
        );
      });
    };
    const turnStarted = yield* Deferred.make<void>();
    const backgroundStarted = yield* Deferred.make<void>();
    const turn = yield* Effect.forkChild(lane.hold("turn", holding("turn", turnStarted)));
    yield* Deferred.await(turnStarted);
    const background = yield* Effect.forkChild(
      lane.hold("background", holding("background", backgroundStarted)),
    );
    // Both hold at once: the second never waited for the first.
    yield* Deferred.await(backgroundStarted);
    yield* lane.hold(
      "agent",
      Effect.sync(() => log.push("check")),
    );
    yield* Fiber.interrupt(turn);
    yield* Fiber.join(background);
    expect(log).toEqual([
      "turn 1",
      "background 1",
      "background gave way",
      "check",
      // Ended by the test: the turn play never gave way to the check.
      "turn gave way",
      "background 2",
    ]);
  }),
);
