// A `low-memory` refusal says nothing about the build: the run waits it out
// (it clears on its own, often when the run's own processes end) and only
// past about a quarter of an hour stops, resumably, rather than judging. A
// step waits by handing its work back to a durable timer, never by sleeping in
// its job: a sleeping job would hold one of the run jobs' shared step slots.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GameOperationError } from "@kurambit/contracts";

const isGameOperationError = Schema.is(GameOperationError);

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

// Another operation holding the game (a Play the creator started, an
// operation begun before the run, the one live Unity editor busy elsewhere)
// says nothing about the build either: the step hands back the same way, on
// its own count, and past it the run stops resumably with what held the game.
export const BUSY_WAITS = 15;
export const BUSY_PAUSE = "1 minute";

/** A step's work found the game held by another operation while the step still has waits left. */
export class GameRunGameBusy extends Data.TaggedError("GameRunGameBusy")<{
  readonly what: string;
  readonly error: GameOperationError;
}> {}

/**
 * The refusals that say the game was not free for this work: busy, and a
 * cancel that was not the run's. Nothing about the build itself is one: a
 * player build refused for its sources (a link in the project, too many
 * files, sources that moved while only the run writes the folder) is the
 * build's own verdict, so it never hides behind waits a resume would reset.
 */
export const isContention = (error: GameOperationError) =>
  error.reason === "busy" || error.reason === "cancelled";

/** Hands the step back while the game is not free and it has waits left; past them the refusal fails through. */
export const handBackOnBusy = <A, E, R>(
  attempt: Effect.Effect<A, E | GameOperationError, R>,
  what: string,
  waitsLeft: boolean,
): Effect.Effect<A, E | GameOperationError | GameRunGameBusy, R> =>
  waitsLeft
    ? attempt.pipe(
        Effect.catchIf(
          (error): error is GameOperationError =>
            isGameOperationError(error) && isContention(error),
          (error) => Effect.fail(new GameRunGameBusy({ what, error })),
        ),
      )
    : attempt;

/** The run's ending once the busy waits ran out: resumable, and it names what held the game. */
export const busyEnded = (what: string, error: GameOperationError) =>
  ({
    kind: "failed",
    reason:
      `${what} could not run: the game stayed busy through ${BUSY_WAITS} waits (${(error.detail ?? error.reason).split("\n")[0]}); resume the run when it is free`.slice(
        0,
        300,
      ),
  }) as const;

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
