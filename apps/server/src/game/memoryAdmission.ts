// Admission for work that needs free memory to start, where two starts at once
// are the normal case (both halves of a blind sample pair, and their bots).
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

/**
 * Runs `start` once there is room, else fails with `refuse` after `maxWaitMs`.
 * Memory is polled with no lock held, so a start waiting for memory never
 * blocks another; once a poll passes, `gate` is taken and memory checked
 * again, since the start that just held the gate may have taken the room.
 * `start` runs inside the gate, so its own peak (an import, a boot) lands
 * before the next start's check. `onWaited` gets the time from entry until
 * the check passed or refused, queueing behind the gate included and `start`
 * itself excluded: the wait a caller may give back to whoever was kept waiting.
 */
export const admitWithMemory = <A, E, R, E2>(options: {
  readonly gate: Semaphore.Semaphore;
  readonly shortfall: Effect.Effect<string | null>;
  readonly maxWaitMs: number;
  readonly poll: `${number} seconds`;
  readonly refuse: (shortfall: string, waitedMs: number) => E2;
  readonly onWaited: (waitedMs: number, refused: boolean) => void;
  readonly start: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | E2, R> =>
  Effect.gen(function* () {
    const enteredAt = yield* Clock.currentTimeMillis;
    const waited = Effect.map(Clock.currentTimeMillis, (now) => now - enteredAt);
    for (;;) {
      let short = yield* options.shortfall;
      if (short === null) {
        const admitted = yield* options.gate.withPermits(1)(
          Effect.gen(function* () {
            const inside = yield* options.shortfall;
            if (inside !== null) return { ok: false, short: inside } as const;
            options.onWaited(yield* waited, false);
            return { ok: true, value: yield* options.start } as const;
          }),
        );
        if (admitted.ok) return admitted.value;
        short = admitted.short;
      }
      const waitedMs = yield* waited;
      if (waitedMs >= options.maxWaitMs) {
        options.onWaited(waitedMs, true);
        return yield* Effect.fail(options.refuse(short, waitedMs));
      }
      yield* Effect.sleep(options.poll);
    }
  });
