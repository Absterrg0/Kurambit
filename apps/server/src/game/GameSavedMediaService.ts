// @effect-diagnostics nodeBuiltinImport:off -- A saved file's error names its path in the game's saved/ folder.
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError, type GameSavedMedia, type ThreadId } from "@kurambit/contracts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import {
  SAVED_DIR,
  SAVED_EVENT,
  SavedMediaError,
  deleteSaved,
  listSaved,
  saveMedia,
} from "./gameSavedMedia.ts";

/** A game's saved/ folder: generated videos and images kept past the log cleanup. */
export class GameSavedMediaService extends Context.Service<
  GameSavedMediaService,
  {
    /** Copies a generated video or image into the game's saved/, past the log cleanup. */
    readonly save: (
      threadId: ThreadId,
      source: string,
      label?: string,
    ) => Effect.Effect<GameSavedMedia, GameOperationError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<GameSavedMedia>, GameOperationError>;
    /** Removes one file directly inside saved/. */
    readonly delete: (threadId: ThreadId, name: string) => Effect.Effect<void, GameOperationError>;
  }
>()("kurambit/game/GameSavedMediaService") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  // No operation lock: a saved copy touches neither the engine nor the folder Kurambit works in.
  const inSaved = <A>(operation: string, root: string, work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: (cause) =>
        new GameOperationError({
          operation,
          path: NodePath.join(root, SAVED_DIR),
          reason: cause instanceof SavedMediaError ? cause.reason : "io",
          detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000),
          cause,
        }),
    });
  // Pushed to every client of the game, so a save an agent made shows in the Saved list.
  const announce = (root: string, message: string) =>
    operations.changed(root, SAVED_EVENT, message).pipe(Effect.ignore);
  return GameSavedMediaService.of({
    save: (threadId, source, label) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // The day on the server's own clock and zone: the creator's machine.
        const day = DateTime.formatIsoDate(
          DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }),
        );
        const root = yield* projects.resolve(threadId);
        const saved = yield* inSaved("Save media", root, () =>
          saveMedia(root, source, label, day, now),
        );
        yield* announce(root, `Saved ${saved.name}`);
        return saved;
      }),
    list: (threadId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const root = yield* projects.resolve(threadId);
        return yield* inSaved("List saved media", root, () => listSaved(root, now));
      }),
    delete: (threadId, name) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const root = yield* projects.resolve(threadId);
        yield* inSaved("Delete saved media", root, () => deleteSaved(root, name, now));
        yield* announce(root, `Deleted ${name}`);
      }),
  });
});

export const layer = Layer.effect(GameSavedMediaService, make);
