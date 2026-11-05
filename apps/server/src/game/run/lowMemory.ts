// A `low-memory` refusal says nothing about the build: the run waits it out
// (it clears on its own, often when the run's own processes end) and only
// past about a quarter of an hour stops, resumably, rather than judging. A
// step waits by handing its work back to a durable timer, never by sleeping in
// its job: a sleeping job would hold one of the run jobs' shared step slots.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { GameOperationError } from "@kurambit/contracts";

export const MEMORY_WAITS = 7;
export const MEMORY_PAUSE = "2 minutes";

export const lastLine = (error: GameOperationError) =>
  (error.detail ?? "").split("\n").at(-1)?.slice(0, 200) ?? "";

/** A step's work refused for memory while the step still has waits left. */
export class GameRunMemoryShort extends Data.TaggedError("GameRunMemoryShort")<{
  readonly what: string;
  readonly error: GameOperationError;
}> {}

/**
 * Hands the step back on a `low-memory` refusal while it has waits left; the
 * runner sets its timer. Past the last wait the refusal fails through as itself.
 */
export const handBackOnLowMemory = <A, R>(
  attempt: Effect.Effect<A, GameOperationError, R>,
  what: string,
  waitsLeft: boolean,
): Effect.Effect<A, GameOperationError | GameRunMemoryShort, R> =>
  waitsLeft
    ? attempt.pipe(
        Effect.catchIf(
          (error) => error.reason === "low-memory",
          (error) => Effect.fail(new GameRunMemoryShort({ what, error })),
        ),
      )
    : attempt;

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
