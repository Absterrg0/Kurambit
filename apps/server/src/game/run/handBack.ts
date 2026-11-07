// Who kept a keep-going step from its answer. A step turn that failed is read
// by its provider's failure: a usage limit or a provider that stopped
// answering pauses the run resumably, anything else is the turn's own end. A
// step's job whose own work broke (a record it reads, a tool of Kurambit's)
// waits on a durable timer a few times, then pauses the run as a tool that
// kept failing. Nothing here is a verdict about the game.
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  CommandId,
  GameOperationError,
  type GameRunId,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type OrchestrationV2ProviderFailure,
  type ThreadId,
  plainReason,
} from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

const isGameOperationError = Schema.is(GameOperationError);

/** A tool that failed in a way waiting may clear: a held file, a busy game, a browser under memory pressure. */
const TOOL_WAITS = 3;
const TOOL_PAUSE = "2 minutes";

type Ended = Extract<GameRunStepResult, { readonly kind: "ended" }>;

/**
 * A failure in words, whatever shape it came in: text passed as the cause, an
 * error's message, a wrapper's cause (a tagged error carries no message of its
 * own), a `detail` or `reason` field, else its tag and value. A pause shows
 * this, so it never reads as a failure without a cause.
 */
export const failureText = (error: unknown, depth = 0): string => {
  if (typeof error === "string") return error.trim() === "" ? "no detail given" : error;
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const field = (name: string): string | null => {
      const value = record[name];
      return typeof value === "string" && value !== "" ? value : null;
    };
    const detail = field("detail");
    if (detail !== null) return detail;
    if (depth < 4 && record.cause !== undefined && record.cause !== null)
      return failureText(record.cause, depth + 1);
    const said = field("reason") ?? field("message");
    if (said !== null) return said;
    const tag = field("_tag") ?? (error instanceof Error ? error.name : "");
    let value = "";
    try {
      value = JSON.stringify(error) ?? "";
    } catch {
      value = "";
    }
    const shown = value === "{}" ? "" : value.slice(0, 200);
    return [tag, shown].filter((x) => x !== "").join(" ") || "a failure with no detail";
  }
  return error === undefined || error === null ? "no detail given" : String(error);
};

/** A failure of Kurambit's own work in plain words, machine paths scrubbed. */
export const toolReason = (what: string, cause: unknown, roots: ReadonlyArray<string> = []) =>
  `${what}: ${plainReason(
    isGameOperationError(cause) ? (cause.detail ?? cause.message) : failureText(cause),
    roots,
  )}`.slice(0, 300);

/**
 * A step turn's provider failure, as the run ends on it: a usage limit or a
 * provider that is down (or never answered) pauses resumably; null for any
 * other failure, which is the turn's own end.
 */
export const providerEnding = (failure: OrchestrationV2ProviderFailure | null): Ended | null => {
  if (failure === null) return null;
  switch (failure.class) {
    case "usage_limit":
      return {
        kind: "ended",
        ending: "usage-limit",
        reason:
          `usage limit${failure.resetAt ? ` until ${failure.resetAt}` : ""}: ${failure.message}`.slice(
            0,
            300,
          ),
      };
    case "provider_error":
    case "transport_error":
      return {
        kind: "ended",
        ending: "provider-down",
        reason: `${failure.class}: ${failure.message}`.slice(0, 300),
      };
    default:
      return null;
  }
};

/** The step the wait is for: its record counts the waits. */
interface WaitTarget {
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly stepId: GameRunStepId;
  readonly attempt: number;
  readonly record: GameRunStep;
}

/**
 * A step whose job broke waits for the tool on a durable timer (its work runs
 * again then), or, past its waits, reports the pause. A wait that cannot be
 * written fails with the store's error: the caller's own retry or recovery
 * owes it.
 */
export const toolWait = <E, R>(
  engine: Orchestrator.OrchestratorV2["Service"],
  target: WaitTarget,
  reason: string,
  report: (result: Ended) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const n = (target.record.toolWaits ?? 0) + 1;
    if (n > TOOL_WAITS) {
      yield* Effect.logInfo(`${reason}; the run pauses`);
      return yield* report({ kind: "ended", ending: "tool-failed", reason });
    }
    yield* Effect.logInfo(`${reason}; the step waits ${TOOL_PAUSE} (${n} of ${TOOL_WAITS})`);
    const at =
      DateTime.toEpochMillis(yield* DateTime.now) +
      Duration.toMillis(Duration.fromInputUnsafe(TOOL_PAUSE));
    yield* engine
      .dispatch({
        type: "game-run.step.schedule",
        commandId: CommandId.make(
          `server:game-run-wait:${target.stepId}:attempt:${target.attempt}:${n}`,
        ),
        threadId: target.threadId,
        runId: target.runId,
        stepId: target.stepId,
        attempt: target.attempt,
        at,
        timer: { kind: "tool", n },
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          // The run moved on or stopped.
          OrchestratorGameRunRefusedError: (error) =>
            Effect.logInfo("game run wait not taken", { detail: error.detail }),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );
  });
