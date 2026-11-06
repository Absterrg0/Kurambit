import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Runs `effect` holding `key` if the key comes free within `waitMs`; None,
   * with `effect` never started, when it does not. 0 takes the key only if it
   * is free now. A wait never holds the key, so a timeout cannot leak it.
   */
  readonly tryWithLock: <A, E, R>(
    key: Key,
    waitMs: number,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 */
export const make = <Key>(): Effect.Effect<KeyedLock<Key>> =>
  Effect.gen(function* () {
    const locks = yield* Ref.make<ReadonlyMap<Key, LockEntry>>(new Map());

    const acquire = (key: Key) =>
      Effect.flatMap(Semaphore.make(1), (candidate) =>
        Ref.modify(locks, (current) => {
          const existing = current.get(key);
          const semaphore = existing?.semaphore ?? candidate;
          const next = new Map(current);
          next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
          return [semaphore, next] as const;
        }),
      );

    const release = (key: Key) =>
      Ref.update(locks, (current) => {
        const existing = current.get(key);
        if (existing === undefined) return current;
        const next = new Map(current);
        if (existing.users === 1) {
          next.delete(key);
        } else {
          next.set(key, { ...existing, users: existing.users - 1 });
        }
        return next;
      });

    return {
      withLock: (key, effect) =>
        Effect.acquireUseRelease(
          acquire(key),
          (semaphore) => semaphore.withPermit(effect),
          () => release(key),
        ),
      tryWithLock: (key, waitMs, effect) =>
        Effect.acquireUseRelease(
          acquire(key),
          (semaphore) =>
            waitMs <= 0
              ? semaphore.withPermitsIfAvailable(1)(effect)
              : Effect.suspend(() => {
                  // Whichever settles first wins: work that started always runs to
                  // its end, and a wait past its time never starts the work.
                  let started = false;
                  const locked = semaphore.withPermits(1)(
                    Effect.suspend(() => {
                      started = true;
                      return Effect.asSome(effect);
                    }),
                  );
                  const expiry = Effect.sleep(Duration.millis(waitMs)).pipe(
                    Effect.andThen(
                      Effect.suspend(() => (started ? Effect.never : Effect.succeedNone)),
                    ),
                  );
                  return Effect.raceFirst(locked, expiry);
                }),
          () => release(key),
        ),
      activeKeys: Effect.map(Ref.get(locks), (current) => Array.from(current.keys())),
    } satisfies KeyedLock<Key>;
  });
