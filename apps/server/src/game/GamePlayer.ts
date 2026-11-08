// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of the built-player cache.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { GameOperationError, isGameEngineActive } from "@kurambit/contracts";
import { sweepPublished } from "./archivePublication.ts";
import * as GameEngine from "./GameEngine.ts";
import { publishFolder, releaseTo } from "./GameExport.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { snapshotBuildSource, sourceIdentityError } from "./sourceSnapshot.ts";
import { makeCheckoutOf, reuseMainPlayer, touchPlayer } from "./unityPlayerCache.ts";

/** Players a game keeps under builds/logs, about 100 MB each. */
const PLAYERS_KEPT = 3;

type PlayerOrigin = "cached" | "reused" | "built";

export interface PreparedPlayer {
  readonly player: string;
  readonly sourceId: string;
  readonly origin: PlayerOrigin;
  readonly ms: number;
}

const invalid = (path: string, detail: string) =>
  new GameOperationError({ operation: "Explore session", path, reason: "invalid-input", detail });

/**
 * Built players for engines whose games play as one (the backend's
 * `player`), cached per source identity, and the live editor's first open.
 * Both are paid outside any role's clock when the run asks for them.
 */
export class GamePlayer extends Context.Service<
  GamePlayer,
  {
    /**
     * The Linux player of the game's current sources: the one it has, a copy
     * of its main checkout's of identical sources, or a build that runs as
     * the game's exclusive operation (so it never races game_export or
     * game_check for the editor), outside any explore start lock. A build
     * imports into the folder, so it runs only once `beforeBuild` admits it.
     */
    readonly playerFor: (
      owner: string,
      root: string,
      beforeBuild?: Effect.Effect<void, GameOperationError>,
    ) => Effect.Effect<PreparedPlayer, GameOperationError>;
    /**
     * Gives a game folder a complete player of its current sources.
     * Idempotent. A blind sample's worktree gets this before its thread
     * exists, so no sample spends its play time on a build.
     */
    readonly prepare: (root: string) => Effect.Effect<
      {
        /** The player executable. */
        readonly player: string;
        readonly origin: PlayerOrigin;
        readonly ms: number;
        readonly sourceId: string;
      },
      GameOperationError
    >;
    /**
     * Opens the game's live editor once and closes it, so its first full
     * import is paid outside any role's clock. False when the engine has no
     * live editor or the project already had its import.
     */
    readonly warmEditor: (root: string) => Effect.Effect<boolean, GameOperationError>;
  }
>()("kurambit/game/GamePlayer") {}

const make = Effect.gen(function* () {
  const engines = yield* GameEngine.GameEngine;
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  const checkoutOf = yield* makeCheckoutOf;
  // Both samples of a pair prepare at once and one live editor runs at a
  // time: the second waits for the first's build instead of failing busy.
  const prepareLock = Semaphore.makeUnsafe(1);

  const playerFor = (
    owner: string,
    root: string,
    beforeBuild: Effect.Effect<void, GameOperationError> = Effect.void,
  ) =>
    Effect.gen(function* () {
      const { backend, ctx } = yield* engines.context(root);
      const engine = backend.profile.displayName;
      if (backend.player === null || backend.editor === null)
        return yield* invalid(root, `${engine} games play no prepared player.`);
      const { player, editor } = backend;
      const known = (when: string) =>
        Effect.flatMap(
          Effect.promise((signal) =>
            snapshotBuildSource(root, ctx.projectName, {
              signal,
              rules: backend.profile.buildInputs,
            }),
          ),
          (source) =>
            source.kind === "known"
              ? Effect.succeed(source.sourceId)
              : Effect.fail(sourceIdentityError(when, root, ctx.projectName, source)),
        );
      const playerOf = (sourceId: string) =>
        NodePath.join(player.cacheDir(root, sourceId), player.executable);
      const startedMs = yield* Clock.currentTimeMillis;
      const prepared = (sourceId: string, origin: PlayerOrigin) =>
        Effect.map(Clock.currentTimeMillis, (now) => ({
          player: playerOf(sourceId),
          sourceId,
          origin,
          ms: now - startedMs,
        }));
      const checkout = yield* checkoutOf(root);
      // Only an exact content match is reused: the same sources build the same player.
      const ready = (sourceId: string) =>
        Effect.gen(function* () {
          if (yield* player.complete(player.cacheDir(root, sourceId))) {
            yield* Effect.promise(() => touchPlayer(player.cacheDir(root, sourceId)));
            return yield* prepared(sourceId, "cached");
          }
          if (checkout.kind !== "linked") return null;
          const notReused = yield* Effect.promise(() =>
            reuseMainPlayer(checkout.main, root, sourceId),
          );
          if (notReused === null) {
            yield* Effect.logInfo(`${engine} worktree reuses its main checkout's player`, {
              root,
              sourceId,
            });
            return yield* prepared(sourceId, "reused");
          }
          yield* Effect.logInfo(`${engine} worktree builds its own player`, {
            root,
            sourceId,
            reason: notReused,
          });
          return null;
        });
      const before = yield* known(`${engine} play build`);
      const early = yield* ready(before);
      if (early !== null) return early;
      yield* beforeBuild;
      return yield* operations.exclusive(
        root,
        `${engine} play build`,
        editor.hold(root)(
          Effect.gen(function* () {
            // The import writes metadata for new assets (Unity's .meta files),
            // so the identity the player is built and cached under is taken after it.
            const imported = (yield* backend.importProject(ctx)).result;
            if (!imported.success)
              return yield* new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: `The ${engine} import failed, so no session was opened.
${imported.message}`.slice(0, 3000),
              });
            const sourceId = yield* known(`${engine} play build`);
            const afterImport = yield* ready(sourceId);
            if (afterImport !== null) return afterImport;
            // The most recently built or played few players are kept, so the
            // sources a comparison's worktrees play are usually still here; a
            // cut-short build's staging goes too.
            const logs = NodePath.join(root, "builds/logs");
            yield* Effect.promise(async () => {
              await sweepPublished(logs, (name) => name.startsWith(".release-"));
              const players: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
              for (const name of await NodeFSP.readdir(logs).catch(() => [] as string[]))
                if (player.isCacheDir(name)) {
                  const path = NodePath.join(logs, name);
                  const stat = await NodeFSP.stat(path).catch(() => null);
                  if (stat !== null) players.push({ path, mtimeMs: stat.mtimeMs });
                }
              players.sort((a, b) => b.mtimeMs - a.mtimeMs);
              // A player another process still holds open (Windows) goes next time.
              for (const { path } of players.slice(PLAYERS_KEPT - 1))
                await NodeFSP.rm(path, { recursive: true, force: true }).catch(() => undefined);
            });
            const operation = `${engine} play build`;
            // The player is kept under the sources it was built from, which the
            // release proves did not move while it ran.
            const built = yield* releaseTo(backend, ctx, {
              target: player.playTarget,
              preset: player.playTarget,
              operation,
              stagingParent: logs,
              publish: (staging, _artifact, built) =>
                publishFolder(operation, staging, player.cacheDir(root, built)),
            });
            if (built.kind === "failed")
              return yield* new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: `The ${engine} play build failed, so no session was opened.
${built.result.message}`.slice(0, 3000),
              });
            return yield* prepared(built.sourceId, "built");
          }),
        ),
        owner,
      );
    });

  // Both read the manifest's engine first: a game whose engine has no player
  // or editor is answered without resolving its executable.
  const backendOf = (root: string) =>
    Effect.flatMap(projects.read(root), (manifest) =>
      isGameEngineActive(manifest.engine.name)
        ? engines.backendFor(manifest.engine.name)
        : Effect.fail(GameEngine.parkedEngine(manifest.engine.name)),
    );

  const prepare = Effect.fn("GamePlayer.prepare")(function* (root: string) {
    const backend = yield* backendOf(root);
    if (backend.player === null || backend.editor === null)
      return yield* invalid(root, `${backend.profile.displayName} games play no prepared player.`);
    const editor = backend.editor;
    const prepared = yield* prepareLock.withPermits(1)(
      Effect.gen(function* () {
        const ready = yield* playerFor("game run player preparation", root);
        // The sample plays only its player; an idle editor beside it would
        // take the memory the player runs in.
        if (ready.origin === "built") yield* editor.close(root);
        return ready;
      }),
    );
    return {
      player: prepared.player,
      origin: prepared.origin,
      ms: prepared.ms,
      sourceId: prepared.sourceId,
    };
  });

  const warmEditor = Effect.fn("GamePlayer.warmEditor")(function* (root: string) {
    const backend = yield* backendOf(root);
    const editor = backend.editor;
    if (editor === null) return false;
    const { ctx } = yield* engines.context(root);
    if (yield* editor.warm(ctx)) return false;
    yield* operations.exclusive(
      root,
      `${backend.profile.displayName} warm-up`,
      editor.open(ctx),
      "game run warm-up",
    );
    yield* editor.close(root);
    return true;
  });

  return GamePlayer.of({ playerFor, prepare, warmEditor });
});

export const layer = Layer.effect(GamePlayer, make);
