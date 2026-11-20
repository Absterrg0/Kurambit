// A recorded restore's folder move, run by the effect worker from the outbox: the restore
// commits first, the move follows, and a restart runs a move it cut short again (moves are
// safe to repeat with the same request). The game layer attaches the work once its services
// exist, as it does keep going's jobs; the move reports with game-build.restore.settle.
import type { GameBuildRestore, ProjectId, ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface GameBuildMove {
  readonly effectId: string;
  /** The chat that asked: the move's owner of the game's lock. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly root: string;
  readonly restore: GameBuildRestore;
}

/** A move that did not get done; its effect is tried again. */
export class GameBuildMoveError extends Schema.TaggedError<GameBuildMoveError>()(
  "GameBuildMoveError",
  { cause: Schema.Defect() },
) {}

export interface GameBuildMoveRunner {
  readonly move: (move: GameBuildMove) => Effect.Effect<void, GameBuildMoveError>;
}

export class GameBuildMoves extends Context.Service<
  GameBuildMoves,
  {
    readonly move: GameBuildMoveRunner["move"];
    readonly attach: (runner: GameBuildMoveRunner) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameBuilds/GameBuildMoves") {}

const make = Effect.gen(function* () {
  const runner = yield* Deferred.make<GameBuildMoveRunner>();
  return GameBuildMoves.of({
    move: (move) => Deferred.await(runner).pipe(Effect.flatMap((each) => each.move(move))),
    attach: (each) => Deferred.succeed(runner, each).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GameBuildMoves, make);
