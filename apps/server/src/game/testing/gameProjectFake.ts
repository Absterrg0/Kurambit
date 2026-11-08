// The one GameProjectService fake for tests: it applies the real rules
// (resolution, game.json) over a scripted world, so a test never passes a
// seam the real service would refuse.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError, type GameManifest, type ThreadId } from "@kurambit/contracts";
import * as GameProjectService from "../GameProjectService.ts";

export interface GameProjectWorld {
  /** Each known thread's folder: its worktree, else its project's root. */
  readonly threads: Map<string, string>;
  /** Folders holding a game.json, with the manifest it holds. */
  readonly games: Map<string, GameManifest>;
}

export const gameProjectWorld = (input: Partial<GameProjectWorld> = {}): GameProjectWorld => ({
  threads: input.threads ?? new Map(),
  games: input.games ?? new Map(),
});

const notInFake = (what: string) => Effect.die(`GameProjectService.${what} is not in the fake`);

export const layerGameProjectFake = (world: GameProjectWorld) =>
  Layer.succeed(
    GameProjectService.GameProjectService,
    GameProjectService.GameProjectService.of({
      create: () => notInFake("create"),
      open: () => notInFake("open"),
      list: () => notInFake("list"),
      inventory: () => notInFake("inventory"),
      refreshGuidance: () => Effect.void,
      resolve: (threadId: ThreadId) => {
        const root = world.threads.get(String(threadId));
        if (root === undefined)
          return Effect.fail(
            new GameOperationError({
              operation: "resolve-thread",
              path: threadId,
              reason: "project-not-found",
            }),
          );
        return world.games.has(root)
          ? Effect.succeed(root)
          : Effect.fail(
              new GameOperationError({
                operation: "read-game",
                path: `${root}/game.json`,
                reason: "invalid-project",
              }),
            );
      },
      read: (root) => {
        const manifest = world.games.get(root);
        return manifest === undefined
          ? Effect.fail(
              new GameOperationError({
                operation: "read-game",
                path: `${root}/game.json`,
                reason: "invalid-project",
              }),
            )
          : Effect.succeed(manifest);
      },
    }),
  );
