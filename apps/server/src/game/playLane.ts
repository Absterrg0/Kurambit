// One lane for every headless play this server draws (a build's measure, game_check), so no
// two of them share the GPU and every timing a play reads is its own. A build's no-input and
// random-input lanes (GameFacts) are one hold: their sharing is deliberate and re-checked.
//
// Holds are granted by who waits on them, then first asked. A holder that a more urgent waiter
// outranks is interrupted and its work is run again from the start once the lane is its turn
// again, so a measure's half-played tier is never stored: GameFacts plans again from its row.
// Nothing ranks above an agent's check, so its play is never interrupted and never runs twice.
//
// Built on Effect's transactional refs: a waiter's turn and a holder's being outranked are each
// one transaction that retries until true, so no wake-up is ever lost between a check and a wait.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TxRef from "effect/TxRef";

/** Who waits on a play, most urgent first. */
const PRIORITIES = ["agent", "person", "turn", "background"] as const;
export type PlayPriority = (typeof PRIORITIES)[number];
const rankOf = (priority: PlayPriority) => PRIORITIES.indexOf(priority);

/** One asker's place in the lane, kept across the times it gives way. */
export interface LaneTicket {
  readonly seq: number;
  readonly rank: TxRef.TxRef<number>;
}

/** Set inside a hold: a play nested in it (a measure's boot check) is already in the lane. */
class Holding extends Context.Reference<boolean>("kurambit/game/playLane/Holding", {
  defaultValue: () => false,
}) {}

interface LaneState {
  readonly holder: LaneTicket | null;
  readonly waiting: ReadonlyArray<LaneTicket>;
}

export const makePlayLane = () => {
  let next = 0;
  const state = TxRef.makeUnsafe<LaneState>({ holder: null, waiting: [] });

  const ticket = (priority: PlayPriority): LaneTicket => ({
    seq: next++,
    rank: TxRef.makeUnsafe(rankOf(priority)),
  });
  /** Someone more urgent asked for the same work: it goes at their priority from now on. */
  const raise = (asker: LaneTicket, priority: PlayPriority) =>
    Effect.tx(TxRef.update(asker.rank, (rank) => Math.min(rank, rankOf(priority))));

  /** The waiter that goes next, read inside a transaction so a change of rank retries it. */
  const first = (waiting: ReadonlyArray<LaneTicket>) =>
    Effect.gen(function* () {
      let best: { readonly asker: LaneTicket; readonly rank: number } | null = null;
      for (const asker of waiting) {
        const rank = yield* TxRef.get(asker.rank);
        if (best === null || rank < best.rank || (rank === best.rank && asker.seq < best.asker.seq))
          best = { asker, rank };
      }
      return best;
    });

  const enter = (asker: LaneTicket) =>
    Effect.tx(TxRef.update(state, (s) => ({ ...s, waiting: [...s.waiting, asker] })));
  const take = (asker: LaneTicket) =>
    Effect.tx(
      Effect.gen(function* () {
        const s = yield* TxRef.get(state);
        if (s.holder !== null || (yield* first(s.waiting))?.asker !== asker)
          return yield* Effect.txRetry;
        yield* TxRef.set(state, {
          holder: asker,
          waiting: s.waiting.filter((each) => each !== asker),
        });
      }),
    );
  const leave = (asker: LaneTicket) =>
    Effect.tx(
      TxRef.update(state, (s) => ({
        holder: s.holder === asker ? null : s.holder,
        waiting: s.waiting.filter((each) => each !== asker),
      })),
    );
  /** Ends once a waiter outranks the holder. */
  const outranked = (holder: LaneTicket) =>
    Effect.tx(
      Effect.gen(function* () {
        const mine = yield* TxRef.get(holder.rank);
        const head = yield* first((yield* TxRef.get(state)).waiting);
        if (head === null || head.rank >= mine) return yield* Effect.txRetry;
      }),
    );

  /** One hold: the work's exit, or null when it gave way and must run again. */
  const holdOnce = <A, E, R>(asker: LaneTicket, work: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const asked = yield* Clock.currentTimeMillis;
        yield* enter(asker);
        // `leave` drops a waiter, or a holder whose take committed as the interrupt landed.
        yield* restore(take(asker)).pipe(Effect.onInterrupt(() => leave(asker)));
        // What a wait cost is the evidence for the lane's bound, so each turn says it.
        yield* Effect.logInfo("play lane: a play's turn", {
          seq: asker.seq,
          priority: PRIORITIES[asker.rank.value],
          waitedMs: (yield* Clock.currentTimeMillis) - asked,
        });
        const fiber = yield* Effect.forkChild(restore(Effect.provideService(work, Holding, true)));
        const gaveWay = yield* restore(
          Effect.raceFirst(Effect.as(Fiber.await(fiber), false), Effect.as(outranked(asker), true)),
          // The lane frees only once the work's teardown ended: its browser and bot are gone.
        ).pipe(Effect.ensuring(Effect.andThen(Fiber.interrupt(fiber), leave(asker))));
        const exit = yield* Fiber.await(fiber);
        // Work that finished as it was outranked keeps its result.
        return gaveWay && Exit.hasInterrupts(exit) ? null : exit;
      }),
    );

  /**
   * Runs `work` alone in the lane, as `asker` (a ticket kept across its turns, or a priority
   * for a one-off). Inside another hold it runs at once: the outer hold is its turn.
   */
  const hold = <A, E, R>(
    asker: LaneTicket | PlayPriority,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      if (yield* Holding) return yield* work;
      const mine = typeof asker === "string" ? ticket(asker) : asker;
      for (;;) {
        const exit = yield* holdOnce(mine, work);
        if (exit !== null) return yield* exit;
        yield* Effect.logInfo("play lane: a play gave way to a more urgent one; it runs again", {
          seq: mine.seq,
        });
      }
    });

  /** Askers waiting before this one, for "queued behind" (committed values, read outside a transaction). */
  const ahead = (asker: LaneTicket) =>
    state.value.waiting.filter(
      (each) =>
        each !== asker &&
        (each.rank.value < asker.rank.value ||
          (each.rank.value === asker.rank.value && each.seq < asker.seq)),
    ).length;

  return { ticket, raise, hold, ahead };
};

/** The server's one lane. */
export const playLane = makePlayLane();
