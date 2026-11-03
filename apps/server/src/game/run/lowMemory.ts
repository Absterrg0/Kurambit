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

export type MemoryMark = {
  readonly refusals: number;
  readonly refused: boolean;
  readonly executedInputSteps: number;
};

/**
 * Whether a sample's play turn is played again: only when it executed no
 * input since `atTurnStart` and its own latest start was refused for memory.
 * A turn that played keeps its result (a replay would give one side a second
 * turn), and a turn that never tried to start is not the machine's fault.
 */
export const replayRefusedTurn = (atTurnStart: MemoryMark, now: MemoryMark): boolean =>
  now.refused &&
  now.refusals > atTurnStart.refusals &&
  now.executedInputSteps === atTurnStart.executedInputSteps;
