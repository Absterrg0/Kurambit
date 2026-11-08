// Run work that broke is tried again a few times with backoff, then given up
// on with a step failure, the way T3 retries a checkpoint rollback before it
// records checkpoint.rollback.fail. A defect counts as broken; an interrupt (a
// stop or a shutdown) is never retried and never turned into a failure.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class GameRunWorkBroke extends Data.TaggedError("GameRunWorkBroke")<{
  readonly cause: unknown;
}> {}

/** Tries after the first, about 2, 4 and 8 seconds apart. */
const RETRIES = 3;

export const retrying = <A, E, R>(
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GameRunWorkBroke, R> =>
  work.pipe(
    Effect.catchDefect((defect) => Effect.fail(new GameRunWorkBroke({ cause: defect }))),
    Effect.retry({ times: RETRIES, schedule: Schedule.exponential("2 seconds") }),
  );
