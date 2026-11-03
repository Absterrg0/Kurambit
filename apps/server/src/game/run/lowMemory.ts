// A `low-memory` refusal says nothing about the build: the run waits it out
// (it clears on its own, often when the run's own processes end) and only
// past about a quarter of an hour stops, resumably, rather than judging.
import * as Effect from "effect/Effect";
import type { GameOperationError } from "@kurambit/contracts";

export const MEMORY_WAITS = 7;
export const MEMORY_PAUSE = "2 minutes";

const lastLine = (error: GameOperationError) =>
  (error.detail ?? "").split("\n").at(-1)?.slice(0, 200) ?? "";

/** Runs `attempt`, retrying a `low-memory` refusal after a pause; the last refusal fails through. */
export const waitOutLowMemory = <A, R>(
  attempt: Effect.Effect<A, GameOperationError, R>,
  what: string,
  log: (line: string) => Effect.Effect<void>,
): Effect.Effect<A, GameOperationError, R> => {
  const go = (waits: number): Effect.Effect<A, GameOperationError, R> =>
    attempt.pipe(
      Effect.catchIf(
        (error) => error.reason === "low-memory" && waits < MEMORY_WAITS,
        (error) =>
          log(
            `${what} refused, memory short (${lastLine(error)}); waiting ${MEMORY_PAUSE} (${waits + 1} of ${MEMORY_WAITS})`,
          ).pipe(Effect.andThen(Effect.sleep(MEMORY_PAUSE)), Effect.andThen(go(waits + 1))),
      ),
    );
  return go(0);
};

/** The run's ending once the waits ran out: resumable, like a usage limit. */
export const memoryEnded = (error: GameOperationError) =>
  ({
    kind: "ended",
    ending: "low-memory",
    reason: `memory short: ${lastLine(error)}`.slice(0, 300),
  }) as const;
