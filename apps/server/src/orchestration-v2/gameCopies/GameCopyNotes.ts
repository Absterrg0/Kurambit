// What a turn in a copy of a game is told beside its message (where it works). The turn's start
// reads it here; the game layer attaches the note once its services exist, the way keep going's
// step runner attaches to GameRunJobs. Null until then, so a turn never waits on it.
import type { ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type GameCopyNote = (threadId: ThreadId) => Effect.Effect<string | null>;

export class GameCopyNotes extends Context.Service<
  GameCopyNotes,
  {
    readonly copyNote: GameCopyNote;
    readonly attach: (note: GameCopyNote) => Effect.Effect<void>;
  }
>()("kurambit/orchestration-v2/gameCopies/GameCopyNotes") {}

export const layer = Layer.effect(
  GameCopyNotes,
  Effect.sync(() => {
    let attached: GameCopyNote | null = null;
    return GameCopyNotes.of({
      copyNote: (threadId) =>
        Effect.suspend(() => (attached === null ? Effect.succeed(null) : attached(threadId))),
      attach: (note) =>
        Effect.sync(() => {
          attached = note;
        }),
    });
  }),
);
