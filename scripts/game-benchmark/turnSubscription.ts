import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

/**
 * Feeds one turn from its thread subscription. The stream normally ends only
 * when the caller interrupts its fiber; an error or close before the terminal
 * run leaves the ready/done waiters unresolved, so report it as a failure
 * instead of letting the caller wait out its whole run budget.
 */
export const runTurnSubscription = <A, E, R, B, F, OE>(input: {
  readonly entries: Stream.Stream<A, E, R>;
  readonly onEntry: (entry: A) => Effect.Effect<void, OE>;
  readonly ready: Deferred.Deferred<void, F>;
  readonly done: Deferred.Deferred<B, F>;
  readonly failure: (cause: unknown) => F;
  readonly closedBeforeReady: string;
  readonly closedBeforeDone: string;
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Stream.runForEach(input.entries, input.onEntry));
    if (!(yield* Deferred.isDone(input.ready))) {
      const error = Exit.isFailure(exit)
        ? input.failure(Cause.squash(exit.cause))
        : input.failure(new Error(input.closedBeforeReady));
      yield* Deferred.fail(input.done, error);
      yield* Deferred.fail(input.ready, error);
      return;
    }
    if (yield* Deferred.isDone(input.done)) return;
    const error = Exit.isFailure(exit)
      ? input.failure(Cause.squash(exit.cause))
      : input.failure(new Error(input.closedBeforeDone));
    yield* Deferred.fail(input.done, error);
  });
