// @effect-diagnostics globalTimers:off -- Retry delays use Effect.sleep so tests drive them with a fake clock.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * Bounded transport recovery for harness observation reads.
 *
 * The e2e RpcClient uses `pingTimeout: "30 seconds"`, `retryTransientErrors:
 * false`, `retryPolicy: Schedule.recurs(0)`. That combination is deliberate:
 * `retryTransientErrors` only replays in-flight calls that failed to *open*,
 * never a read that died mid-stream with `SocketReadError: ping timeout`, and
 * `recurs(0)` means the dead protocol stays dead (`currentError` is set and
 * every later send fails with it). Application-level retry with a fresh
 * transport is the only honest recovery, and it is only safe for idempotent
 * observation reads. Mutations (`gameCreate`, `gameOpen`, `gameSubmit`,
 * `gameRequestChange`, `gameApproveDesign`, `gameApproveRevision`,
 * `gameAction`, dispatches) must run exactly once and never go through this
 * helper.
 */

export const DEFAULT_OBSERVATION_MAX_ATTEMPTS = 4;
export const DEFAULT_OBSERVATION_RETRY_DELAY_MS = 5_000;

const TRANSIENT_SOCKET_TAGS = new Set([
  "SocketReadError",
  "SocketCloseError",
  "SocketOpenError",
  "SocketWriteError",
  "SocketUpgradeError",
]);

/**
 * True only for transport loss: an `RpcClientError` (or bare `SocketError` /
 * socket reason) whose reason is a socket failure, including the ping-timeout
 * `SocketReadError` the Rover run died with. Business refusals, validation,
 * `RpcClientDefect` decoding failures, timeouts and `HarnessError`s that do
 * not wrap a socket failure are permanent and must fail immediately.
 */
export const isTransientTransportError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const tagged = current as {
      readonly _tag?: unknown;
      readonly reason?: unknown;
      readonly cause?: unknown;
    };
    if (tagged._tag === "RpcClientError" || tagged._tag === "SocketError") {
      const reason = tagged.reason as { readonly _tag?: unknown } | undefined;
      return (
        reason !== null &&
        typeof reason === "object" &&
        typeof (reason as { _tag?: unknown })._tag === "string" &&
        TRANSIENT_SOCKET_TAGS.has((reason as { _tag: string })._tag)
      );
    }
    if (typeof tagged._tag === "string" && TRANSIENT_SOCKET_TAGS.has(tagged._tag)) return true;
    // HarnessError carries the RpcClientError in `cause`.
    if (tagged._tag === "HarnessError" && tagged.cause !== undefined) {
      current = tagged.cause;
      continue;
    }
    return false;
  }
  return false;
};

export interface ObservationRetryOptions {
  /** Total attempts including the first read. Default 4 (1 + 3 reconnects). */
  readonly maxAttempts?: number | undefined;
  /** Delay between attempts. Default 5000ms. Uses Effect.sleep (TestClock-safe). */
  readonly retryDelayMs?: number | undefined;
  /** Absolute hard stop (Date.now ms). No new attempt starts past it minus reserve. */
  readonly deadlineMs?: number | undefined;
  /** Time kept for the caller to record state before the deadline. Default 0. */
  readonly deadlineReserveMs?: number | undefined;
  readonly now?: Effect.Effect<number> | undefined;
  readonly sleep?: Effect.Effect<void> | undefined;
  readonly onOutage?:
    | ((info: { readonly attempt: number; readonly error: unknown }) => Effect.Effect<void>)
    | undefined;
  /**
   * Reads are idempotent (`true`, the default). Pass `false` for a mutation:
   * the read runs exactly once and a transient failure is not retried.
   */
  readonly idempotent?: boolean | undefined;
}

/**
 * Runs an idempotent observation read with bounded reconnect/retry.
 *
 * `read` must be a thunk that builds a fresh Effect from the current
 * transport on every call (so a `reconnect` that swaps the client is picked
 * up); `reconnect` rebuilds the socket/protocol/client for the same
 * thread/run/loop identity and never replays a mutation. Only transient
 * transport errors retry, at most `maxAttempts` total, spaced by
 * `retryDelayMs`, never starting past `deadlineMs - deadlineReserveMs`.
 * Defects and interrupts propagate immediately; permanent errors fail without
 * a reconnect. A failed `reconnect` aborts with its own cause.
 */
export const retryObservationRead = <A, E, R, EReconnect, RReconnect>(
  read: () => Effect.Effect<A, E, R>,
  reconnect: () => Effect.Effect<void, EReconnect, RReconnect>,
  options: ObservationRetryOptions = {},
): Effect.Effect<A, E | EReconnect, R | RReconnect> => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_OBSERVATION_MAX_ATTEMPTS;
  const delayMs = options.retryDelayMs ?? DEFAULT_OBSERVATION_RETRY_DELAY_MS;
  const reserveMs = options.deadlineReserveMs ?? 0;
  const idempotent = options.idempotent ?? true;
  const nowEffect = options.now ?? Clock.currentTimeMillis;
  const sleepEffect = options.sleep ?? Effect.sleep(Duration.millis(delayMs));
  const onOutage = options.onOutage;
  const pastDeadline =
    options.deadlineMs === undefined
      ? Effect.succeed(false)
      : nowEffect.pipe(Effect.map((now) => now >= options.deadlineMs! - Math.max(0, reserveMs)));
  const loop = (attempt: number): Effect.Effect<A, E | EReconnect, R | RReconnect> =>
    read().pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!idempotent) return yield* Effect.fail(error);
          if (!isTransientTransportError(error)) return yield* Effect.fail(error);
          if (attempt >= Math.max(1, Math.floor(maxAttempts))) return yield* Effect.fail(error);
          if (yield* pastDeadline) return yield* Effect.fail(error);
          if (onOutage !== undefined) yield* onOutage({ attempt, error });
          yield* sleepEffect;
          if (yield* pastDeadline) return yield* Effect.fail(error);
          yield* reconnect();
          if (yield* pastDeadline) return yield* Effect.fail(error);
          return yield* loop(attempt + 1);
        }),
      ),
    );
  return loop(1);
};
