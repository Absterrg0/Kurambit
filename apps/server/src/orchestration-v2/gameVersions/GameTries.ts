// A try's run ("try it N ways") is done by the game layer, never by a provider:
// the run's start hands it here instead of opening a session. The game layer
// attaches its starter once its services exist, the way keep going's step
// runner attaches to GameRunJobs.
import type { RunId, ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface GameTryStart {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly versions: number;
  readonly text: string;
}

/** Why a try could not start; its text is the person's. */
export class GameTryStartError extends Data.TaggedError("GameTryStartError")<{
  readonly message: string;
}> {}

export interface GameTryStarter {
  /** Makes the try's versions and completes its run, through `game-version.start`. */
  readonly start: (input: GameTryStart) => Effect.Effect<void, GameTryStartError>;
  /** What a turn in a copy of a game is told beside its message (where it works); null elsewhere. */
  readonly copyNote?: (threadId: ThreadId) => Effect.Effect<string | null>;
}

export class GameTries extends Context.Service<
  GameTries,
  {
    readonly start: GameTryStarter["start"];
    /** Null until the game layer attaches: a turn never waits on it. */
    readonly copyNote: (threadId: ThreadId) => Effect.Effect<string | null>;
    readonly attach: (starter: GameTryStarter) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameVersions/GameTries") {}

export const layer = Layer.effect(
  GameTries,
  Effect.gen(function* () {
    const starter = yield* Deferred.make<GameTryStarter>();
    let now: GameTryStarter | null = null;
    return GameTries.of({
      start: (input) =>
        Effect.flatMap(Deferred.await(starter), (attached) => attached.start(input)),
      copyNote: (threadId) =>
        Effect.suspend(() =>
          now?.copyNote === undefined ? Effect.succeed(null) : now.copyNote(threadId),
        ),
      attach: (attached) =>
        Effect.sync(() => {
          now = attached;
        }).pipe(Effect.andThen(Deferred.succeed(starter, attached)), Effect.asVoid),
    });
  }),
);
