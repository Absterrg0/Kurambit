import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import { admitWithMemory } from "./memoryAdmission.ts";

// Memory is short for the first 60 s; each start (import plus boot) takes 10 s.
const pair = Effect.gen(function* () {
  const gate = Semaphore.makeUnsafe(1);
  const credited: Record<string, [number, boolean]> = {};
  const half = (name: string) =>
    admitWithMemory({
      gate,
      shortfall: Effect.map(Clock.currentTimeMillis, (now) => (now < 60_000 ? "short" : null)),
      maxWaitMs: 75_000,
      poll: "5 seconds",
      refuse: (short, waitedMs) => ({ short, waitedMs }),
      onWaited: (waitedMs, refused) => {
        credited[name] = [waitedMs, refused];
      },
      start: Effect.sleep("10 seconds").pipe(Effect.as(name)),
    });
  const a = yield* Effect.forkChild(half("a"));
  const b = yield* Effect.forkChild(half("b"));
  yield* TestClock.adjust("2 minutes");
  return { a: yield* Fiber.join(a), b: yield* Fiber.join(b), credited };
});

it.effect(
  "credits each half its memory wait plus its queue behind the gate, not its own start",
  () =>
    Effect.gen(function* () {
      const { a, b, credited } = yield* pair;
      expect([a, b]).toEqual(["a", "b"]);
      // a waited 60 s for memory; b waited the same and then queued behind a's 10 s start.
      expect(credited).toEqual({ a: [60_000, false], b: [70_000, false] });
    }),
);

it.effect("refuses after the bound, with the time it waited", () =>
  Effect.gen(function* () {
    const credited: Array<[number, boolean]> = [];
    const fiber = yield* Effect.forkChild(
      Effect.flip(
        admitWithMemory({
          gate: Semaphore.makeUnsafe(1),
          shortfall: Effect.succeed("needs 1.3 GB"),
          maxWaitMs: 75_000,
          poll: "5 seconds",
          refuse: (short, waitedMs) => ({ short, waitedMs }),
          onWaited: (waitedMs, refused) => credited.push([waitedMs, refused]),
          start: Effect.succeed("started"),
        }),
      ),
    );
    yield* TestClock.adjust("2 minutes");
    expect(yield* Fiber.join(fiber)).toEqual({ short: "needs 1.3 GB", waitedMs: 75_000 });
    expect(credited).toEqual([[75_000, true]]);
  }),
);

it.effect(
  "refuses a start queued behind a long hold once its bound passes, never interrupting the holder",
  () =>
    Effect.gen(function* () {
      const gate = Semaphore.makeUnsafe(1);
      const admit = (start: Effect.Effect<string>) =>
        admitWithMemory({
          gate,
          shortfall: Effect.succeed(null),
          maxWaitMs: 75_000,
          poll: "5 seconds",
          refuse: (short, waitedMs) => ({ short, waitedMs }),
          onWaited: () => {},
          start,
        });
      const holder = yield* Effect.forkChild(
        admit(Effect.sleep("15 minutes").pipe(Effect.as("held"))),
      );
      const queued = yield* Effect.forkChild(Effect.flip(admit(Effect.succeed("ran"))));
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(queued)).toMatchObject({ waitedMs: 75_000 });
      yield* TestClock.adjust("15 minutes");
      expect(yield* Fiber.join(holder)).toBe("held");
    }),
);
