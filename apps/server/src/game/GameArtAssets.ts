// @effect-diagnostics nodeBuiltinImport:off -- An error names the game's assets folder.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError, type GameArtAssetsResult, type ThreadId } from "@kurambit/contracts";
import { listArtAssets, saveArtThumbnail } from "./artAssets.ts";
import * as GameProjectService from "./GameProjectService.ts";

/** The Workbench's Art tab: the game's art files, and the thumbnails it drew of them. */
export class GameArtAssets extends Context.Service<
  GameArtAssets,
  {
    readonly list: (threadId: ThreadId) => Effect.Effect<GameArtAssetsResult, GameOperationError>;
    /** Keeps a model's thumbnail by the content hash it was drawn from; answers its path. */
    readonly saveThumbnail: (
      threadId: ThreadId,
      sha256: string,
      png: string,
    ) => Effect.Effect<string, GameOperationError>;
  }
>()("kurambit/game/GameArtAssets") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  // No operation lock: reading files and caching a picture outside the build change nothing a
  // build or a turn holds.
  const onDisk = <A>(operation: string, root: string, work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: (cause) =>
        new GameOperationError({
          operation,
          path: root,
          reason: "io",
          detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000),
          cause,
        }),
    });
  return GameArtAssets.of({
    list: (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const manifest = yield* projects.read(root);
        return yield* onDisk("List the game's art", root, () =>
          listArtAssets(root, manifest.engine.name, manifest.project),
        );
      }),
    saveThumbnail: (threadId, sha256, png) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* onDisk("Keep an art thumbnail", NodePath.join(root, "builds"), () =>
          saveArtThumbnail(root, sha256, png),
        );
      }),
  });
});

export const layer = Layer.effect(GameArtAssets, make);
