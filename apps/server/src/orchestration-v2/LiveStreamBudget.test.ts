import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  bufferLiveStream,
  makeLiveStreamBudget,
  type RetainedLiveItem,
} from "./LiveStreamBudget.ts";

describe("LiveStreamBudget", () => {
  it.effect("closes the source without releasing a batch still waiting for an ACK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const budget = yield* makeLiveStreamBudget({ maxItems: 3 });
        const queue = yield* Queue.unbounded<RetainedLiveItem<{ text: string }>>();
        const sourceClosed = yield* Deferred.make<void>();
        const first = yield* budget.retain({ text: "first" });
        const second = yield* budget.retain({ text: "second" });
        const third = yield* budget.retain({ text: "third" });
        yield* Queue.offerAll(queue, [first, second, third]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(
              budget.deliver(
                Stream.fromQueue(queue).pipe(
                  Stream.rechunk(1),
                  Stream.ensuring(Deferred.succeed(sourceClosed, undefined)),
                ),
              ),
            );
            expect(yield* pull).toEqual([{ text: "first" }]);
            expect(yield* Queue.size(queue)).toBe(0);
            expect((yield* budget.usage).retainedItems).toBe(3);
            const overflow = yield* budget.retain({ text: "fourth" }).pipe(Effect.result);
            expect(overflow._tag).toBe("Failure");
            yield* Deferred.await(sourceClosed);
            yield* budget.closed;
            expect((yield* budget.usage).retainedItems).toBe(1);
          }),
        );
        expect(yield* budget.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});

it.effect("stops draining a slow subscriber when its unacknowledged tail fills", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<{ text: string }>();
      const sourceClosed = yield* Deferred.make<void>();
      const pull = yield* Stream.toPull(
        bufferLiveStream(
          Stream.fromQueue(input).pipe(Stream.ensuring(Deferred.succeed(sourceClosed, undefined))),
          { maxItems: 2 },
        ),
      );
      yield* Queue.offer(input, { text: "first" });
      expect(yield* pull).toEqual([{ text: "first" }]);
      yield* Queue.offerAll(input, [{ text: "second" }, { text: "third" }]);
      yield* Deferred.await(sourceClosed);
      const next = yield* pull.pipe(Effect.result);
      expect(next._tag).toBe("Failure");
      if (next._tag === "Failure") expect(next.failure._tag).toBe("LiveStreamBufferError");
    }),
  ),
);
