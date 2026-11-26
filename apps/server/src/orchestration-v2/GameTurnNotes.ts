// What a game's turn is told beside its message, each note a tagged block: where a chat in a copy
// works (GameCopies), what Kurambit measured wrong in the build it starts from (GameBuilds). The
// turn's start reads them here; the game layer attaches each once its services exist, the way keep
// going's step runner attaches to GameRunJobs. None until then, so a turn never waits on one.
import type { ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type GameTurnNote = (turn: {
  readonly threadId: ThreadId;
  /** The person wrote the message, not keep going, whose step briefs its own session. */
  readonly person: boolean;
}) => Effect.Effect<string | null>;

export class GameTurnNotes extends Context.Service<
  GameTurnNotes,
  {
    readonly notes: (turn: Parameters<GameTurnNote>[0]) => Effect.Effect<ReadonlyArray<string>>;
    readonly attach: (note: GameTurnNote) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/GameTurnNotes") {}

export const layer = Layer.effect(
  GameTurnNotes,
  Effect.sync(() => {
    const attached: Array<GameTurnNote> = [];
    return GameTurnNotes.of({
      notes: (turn) =>
        Effect.suspend(() => Effect.forEach(attached, (note) => note(turn))).pipe(
          Effect.map((notes) => notes.filter((note) => note !== null)),
        ),
      attach: (note) =>
        Effect.sync(() => {
          attached.push(note);
        }),
    });
  }),
);
