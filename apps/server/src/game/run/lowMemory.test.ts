import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { GameOperationError } from "@kurambit/contracts";
import { MEMORY_WAITS, memoryEnded, replayRefusedTurn, waitOutLowMemory } from "./lowMemory.ts";

const refusal = (reason: "low-memory" | "busy") =>
  new GameOperationError({ operation: "Bot run", path: "/g", reason, detail: "needs 1.5 GB" });

it.effect("waits out a low-memory refusal and then runs", () =>
  Effect.gen(function* () {
    let calls = 0;
    const attempt = Effect.suspend(() =>
      ++calls < 3 ? Effect.fail(refusal("low-memory")) : Effect.succeed("ran"),
    );
    const fiber = yield* Effect.forkChild(waitOutLowMemory(attempt, "bot run", () => Effect.void));
    yield* TestClock.adjust("4 minutes");
    expect(yield* Fiber.join(fiber)).toBe("ran");
    expect(calls).toBe(3);
  }),
);

it.effect("fails through after its waits, and never retries other refusals", () =>
  Effect.gen(function* () {
    let calls = 0;
    const short = Effect.suspend(() => (calls++, Effect.fail(refusal("low-memory"))));
    const fiber = yield* Effect.forkChild(
      Effect.flip(waitOutLowMemory(short, "bot run", () => Effect.void)),
    );
    yield* TestClock.adjust("20 minutes");
    expect((yield* Fiber.join(fiber)).reason).toBe("low-memory");
    expect(calls).toBe(MEMORY_WAITS + 1);
    let busyCalls = 0;
    const busy = Effect.suspend(() => (busyCalls++, Effect.fail(refusal("busy"))));
    const busyError = yield* Effect.flip(waitOutLowMemory(busy, "bot run", () => Effect.void));
    expect([busyError.reason, busyCalls]).toEqual(["busy", 1]);
    expect(memoryEnded(refusal("low-memory"))).toEqual({
      kind: "ended",
      ending: "low-memory",
      reason: "memory short: needs 1.5 GB",
    });
  }),
);

it("replays a play turn only when it did not play and its own last start was refused", () => {
  const start = { refusals: 0, refused: false, executedInputSteps: 0 };
  expect(replayRefusedTurn(start, { refusals: 1, refused: true, executedInputSteps: 0 })).toBe(
    true,
  );
  // It played before or after the refusal: its result stands.
  expect(replayRefusedTurn(start, { refusals: 1, refused: true, executedInputSteps: 4 })).toBe(
    false,
  );
  // A later start went through.
  expect(replayRefusedTurn(start, { refusals: 1, refused: false, executedInputSteps: 0 })).toBe(
    false,
  );
  // A retried turn whose agent never tried again: the old refusal is not this turn's.
  const retried = { refusals: 1, refused: true, executedInputSteps: 0 };
  expect(replayRefusedTurn(retried, retried)).toBe(false);
});
