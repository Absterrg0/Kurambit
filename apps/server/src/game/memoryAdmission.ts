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
 * The queue behind the gate counts against `maxWaitMs` too: a start that holds
 * the gate through a long import refuses the others rather than keeping them
 * waiting unseen, with a null shortfall, since that is contention: the memory
 * was never found short, so it is not a refusal for memory either.
 */
/** Time a start past its bound still gets to take a gate that is free. */
const GATE_GRACE_MS = 1_000;

export const admitWithMemory = <A, E, R, E2>(options: {
  readonly gate: Semaphore.Semaphore;
  readonly shortfall: Effect.Effect<string | null>;
  readonly maxWaitMs: number;
  readonly poll: `${number} seconds`;
  readonly refuse: (shortfall: string | null, waitedMs: number) => E2;
  readonly onWaited: (waitedMs: number, refused: boolean) => void;
  readonly start: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E | E2, R> =>
  Effect.gen(function* () {
    const enteredAt = yield* Clock.currentTimeMillis;
    const waited = Effect.map(Clock.currentTimeMillis, (now) => now - enteredAt);
    for (;;) {
      let short = yield* options.shortfall;
      if (short === null) {
        // Whichever settles the ticket first wins: an admitted start always
        // runs to its end, and one past its time never starts, so the timer
        // can never interrupt a start that is launching.
        const ticket = { state: "waiting" as "waiting" | "admitted" | "expired" };
        type Outcome =
          | { readonly ok: "expired" }
          | { readonly ok: false; readonly short: string }
          | { readonly ok: true; readonly value: A };
        const gated = options.gate.withPermits(1)(
          Effect.suspend((): Effect.Effect<Outcome, E, R> => {
            if (ticket.state === "expired") return Effect.succeed({ ok: "expired" });
            ticket.state = "admitted";
            return Effect.gen(function* () {
              const inside = yield* options.shortfall;
              if (inside !== null) return { ok: false, short: inside } satisfies Outcome;
              options.onWaited(yield* waited, false);
              return { ok: true, value: yield* options.start } satisfies Outcome;
            });
          }),
        );
        const remainingMs = Math.max(options.maxWaitMs - (yield* waited), GATE_GRACE_MS);
        const expiry = Effect.sleep(remainingMs).pipe(
          Effect.andThen(
            Effect.suspend((): Effect.Effect<Outcome> => {
              if (ticket.state === "admitted") return Effect.never;
              ticket.state = "expired";
              return Effect.succeed({ ok: "expired" });
            }),
          ),
        );
        const admitted = yield* Effect.raceFirst(gated, expiry);
        if (admitted.ok === "expired") {
          const waitedMs = yield* waited;
          options.onWaited(waitedMs, false);
          return yield* Effect.fail(options.refuse(null, waitedMs));
        }
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
