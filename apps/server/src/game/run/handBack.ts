// What the run could not measure, and who kept it from happening. A step's
// work fails with one of three typed causes (memory short, the game held by
// another operation, a tool of Kurambit's that failed); a fault of the build
// itself is never one of them: it is re-tagged GameRunBuildFault, which only a
// producer with a measured form for it (a boot verdict, a check fail, a bot
// ending) catches. Each not-measured cause hands the step back to a durable
// timer while its waits last, and past them (or at once, for a fault waiting
// cannot clear) the run pauses resumably with why. Nothing here is a verdict.
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  GameOperationError,
  type GameRunId,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type ThreadId,
  gameOperationFault,
  isStandingFault,
  plainReason,
} from "@kurambit/contracts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

const isGameOperationError = Schema.is(GameOperationError);

export const MEMORY_WAITS = 7;
export const MEMORY_PAUSE = "2 minutes";
const BUSY_WAITS = 15;
const BUSY_PAUSE = "1 minute";
/** A tool that failed in a way waiting may clear: a browser under memory pressure, a held file, a restarting licence client. */
const TOOL_WAITS = 3;
const TOOL_PAUSE = "2 minutes";

/** A step's work refused for memory: it says nothing about the build. */
export class GameRunMemoryShort extends Data.TaggedError("GameRunMemoryShort")<{
  readonly what: string;
  readonly error: GameOperationError;
}> {}

/** Another operation held the game, or a start ahead held the machine's gate. */
export class GameRunGameBusy extends Data.TaggedError("GameRunGameBusy")<{
  readonly what: string;
  readonly error: GameOperationError;
}> {}

/** A program Kurambit runs, or a record it keeps, failed: the build was never fairly tried. */
export class GameRunToolFailed extends Data.TaggedError("GameRunToolFailed")<{
  /** What was being measured ("boot check", "a sample's copy"); never a build's name. */
  readonly what: string;
  /** The failure in plain words, machine paths scrubbed (plainReason). */
  readonly reason: string;
  /** Waiting cannot clear it (a missing program, the run's own bad request, a build gone). */
  readonly standing: boolean;
  readonly cause: unknown;
}> {}

/** The build's own fault: a measurement, for the producer that has a form for it. */
export class GameRunBuildFault extends Data.TaggedError("GameRunBuildFault")<{
  readonly what: string;
  readonly error: GameOperationError;
}> {}

export type NotMeasured = GameRunMemoryShort | GameRunGameBusy | GameRunToolFailed;

/**
 * A read or write of the run's own records failed (its report, a record it
 * decides by, a timer it sets): the job is tried again (executeJob), never
 * reported as the step's result and never read as an answer.
 */
export class GameRunJobBroke extends Data.TaggedError("GameRunJobBroke")<{
  readonly cause: unknown;
}> {}
/** A read or write the job's progress depends on: its failure breaks the job. */
export const needed = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(Effect.mapError((cause) => new GameRunJobBroke({ cause })));

const isRunCause = (error: unknown): error is NotMeasured | GameRunBuildFault | GameRunJobBroke =>
  error instanceof GameRunJobBroke ||
  error instanceof GameRunMemoryShort ||
  error instanceof GameRunGameBusy ||
  error instanceof GameRunToolFailed ||
  error instanceof GameRunBuildFault;

// A wrapper error (a tagged one carries no message of its own) says what broke only through its cause.
const messageOf = (error: unknown, depth: number): string => {
  if (error instanceof Error && error.message !== "") return error.message;
  if (depth < 4 && typeof error === "object" && error !== null && "cause" in error)
    return messageOf(error.cause, depth + 1);
  return error instanceof Error ? error.name : "unrecognized failure";
};

/** A tool fault in plain words. */
export const toolFailed = (
  what: string,
  cause: unknown,
  options: { readonly standing?: boolean; readonly roots?: ReadonlyArray<string> } = {},
) =>
  new GameRunToolFailed({
    what,
    reason: plainReason(
      isGameOperationError(cause) ? (cause.detail ?? cause.message) : messageOf(cause, 0),
      options.roots ?? [],
    ),
    standing: options.standing ?? false,
    cause,
  });

/**
 * One failure of a measurement's work, as the run reads it: a game operation
 * error by whose fault it is (the run's own request is a tool fault: the run
 * asked for it), anything else (a checkpoint, a record, a defect) as a tool
 * fault. A cause already read passes as it is.
 */
export const classify = (
  what: string,
  error: unknown,
  roots: ReadonlyArray<string> = [],
): NotMeasured | GameRunBuildFault | GameRunJobBroke => {
  if (isRunCause(error)) return error;
  if (!isGameOperationError(error)) return toolFailed(what, error, { roots });
  switch (gameOperationFault(error.reason)) {
    case "machine":
      return error.reason === "low-memory"
        ? new GameRunMemoryShort({ what, error })
        : new GameRunGameBusy({ what, error });
    case "build":
      return new GameRunBuildFault({ what, error });
    case "tool":
    case "request":
      return toolFailed(what, error, { roots, standing: isStandingFault(error.reason) });
  }
};

/**
 * A measurement's work with nothing left in its error channel a producer
 * could mistake for a verdict: every failure, defects included, is read by
 * `classify` (a broken record write stays the job's). Interrupts pass.
 */
export const measuring =
  (what: string, roots: ReadonlyArray<string> = []) =>
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Extract<E, GameRunJobBroke> | NotMeasured | GameRunBuildFault, R> =>
    Effect.catchCause(
      work,
      (cause): Effect.Effect<never, NotMeasured | GameRunBuildFault | GameRunJobBroke> => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const failure = Cause.findErrorOption(cause);
        const error = failure._tag === "Some" ? failure.value : Cause.squash(cause);
        return Effect.fail(classify(what, error, roots));
      },
    ) as never;

type Ended = Extract<GameRunStepResult, { readonly kind: "ended" }>;

/** The run's ending once a cause cannot wait any more: resumable, with why. */
const endedBy = (cause: NotMeasured): Ended =>
  cause._tag === "GameRunMemoryShort"
    ? {
        kind: "ended",
        ending: "low-memory",
        reason: `memory short: ${plainReason(cause.error.detail ?? cause.error.reason)}`.slice(
          0,
          300,
        ),
      }
    : cause._tag === "GameRunGameBusy"
      ? {
          kind: "ended",
          ending: "busy",
          reason:
            `${cause.what} could not run: the game stayed busy through ${BUSY_WAITS} waits (${plainReason(cause.error.detail ?? cause.error.reason)}); resume the run when it is free`.slice(
              0,
              300,
            ),
        }
      : {
          kind: "ended",
          ending: "tool-failed",
          reason: `${cause.what}: ${cause.reason}`.slice(0, 300),
        };

const KINDS = {
  GameRunMemoryShort: { kind: "memory", limit: MEMORY_WAITS, pause: MEMORY_PAUSE },
  GameRunGameBusy: { kind: "busy", limit: BUSY_WAITS, pause: BUSY_PAUSE },
  GameRunToolFailed: { kind: "tool", limit: TOOL_WAITS, pause: TOOL_PAUSE },
} as const;

const waitsOf = (record: GameRunStep, kind: "memory" | "busy" | "tool") =>
  (kind === "memory"
    ? record.memoryWaits
    : kind === "busy"
      ? record.busyWaits
      : record.toolWaits) ?? 0;

/** Whether the step waits for this cause once more, or the run pauses with it now. */
const nextMove = (
  record: GameRunStep,
  cause: NotMeasured,
):
  | {
      readonly kind: "wait";
      readonly timer: { readonly kind: "memory" | "busy" | "tool"; readonly n: number };
      readonly pause: Duration.Input;
      readonly line: string;
    }
  | { readonly kind: "end"; readonly result: Ended } => {
  const spec = KINDS[cause._tag];
  const n = waitsOf(record, spec.kind) + 1;
  if ((cause._tag === "GameRunToolFailed" && cause.standing) || n > spec.limit)
    return { kind: "end", result: endedBy(cause) };
  const why =
    cause._tag === "GameRunToolFailed"
      ? cause.reason
      : plainReason(cause.error.detail ?? cause.error.reason);
  const line =
    cause._tag === "GameRunMemoryShort"
      ? `${cause.what} refused, memory short (${why}); the step waits ${spec.pause} (${n} of ${spec.limit})`
      : cause._tag === "GameRunGameBusy"
        ? `${cause.what} could not start yet (${why}); the step waits ${spec.pause} (${n} of ${spec.limit})`
        : `${cause.what}: a tool failed (${why}); the step waits ${spec.pause} (${n} of ${spec.limit})`;
  return { kind: "wait", timer: { kind: spec.kind, n }, pause: spec.pause, line };
};

/** The step the hand-back is for: a pair's half names itself, its record counts the waits. */
interface HandBackTarget {
  readonly creator: ThreadId;
  readonly runId: GameRunId;
  readonly stepId: GameRunStepId;
  readonly attempt: number;
  readonly record: GameRunStep;
}

/**
 * Hands the step back to wait for the cause, or reports the pause it has come
 * to. Every wait the step made shares one command-id sequence, so a wait of
 * one kind after another never reuses an id (which the store would swallow as
 * a retry, leaving the step with neither job nor timer); two halves refused in
 * one job make one wait. A wait that cannot be written fails with the store's
 * error: the caller's own retry or recovery owes it.
 */
export const handBack = <E, R>(
  engine: Orchestrator.OrchestratorV2["Service"],
  target: HandBackTarget,
  cause: NotMeasured,
  report: (result: Ended) => Effect.Effect<void, E, R>,
  log: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const move = nextMove(target.record, cause);
    if (move.kind === "end") {
      yield* log(`${move.result.reason}; the run pauses`);
      return yield* report(move.result);
    }
    yield* log(move.line);
    const record = target.record;
    const seq = (record.memoryWaits ?? 0) + (record.busyWaits ?? 0) + (record.toolWaits ?? 0) + 1;
    const at =
      DateTime.toEpochMillis(yield* DateTime.now) +
      Duration.toMillis(Duration.fromInputUnsafe(move.pause));
    yield* engine
      .dispatch({
        type: "game-run.step.schedule",
        commandId: CommandId.make(
          `server:game-run-wait:${record.id}:attempt:${target.attempt}:${seq}`,
        ),
        threadId: target.creator,
        runId: target.runId,
        stepId: target.stepId,
        attempt: target.attempt,
        at,
        timer: move.timer,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          // The run moved on or stopped, or the other half's wait already holds this one.
          OrchestratorGameRunRefusedError: (error) =>
            Effect.logInfo("game run wait not taken", { detail: error.detail }),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );
  });
