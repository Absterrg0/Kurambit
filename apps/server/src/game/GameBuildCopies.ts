// @effect-diagnostics nodeBuiltinImport:off -- A build's copy is a folder on disk outside the game repository.
// The copies a game's builds are played and measured in. A copy is a plain
// folder of one build (no git, no .studio or NOTES.md) under Kurambit's own
// worktrees folder, never in the game repository, so playing or measuring an
// old build never touches the game folder. Copies are content-addressed by
// the build's engine project, so builds with the same project share one. A
// copy names its game folder in COPY_OF, so a Unity copy reuses that folder's
// import cache. This service sits below GameService so Stop game reaches the
// work on a game's copies too.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { CheckpointRef, GameOperationError } from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { GAME_BUILD_COPIES } from "../config.ts";
import * as GameBot from "./GameBot.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import { NOT_IN_SAMPLE } from "./run/builds.ts";
import { COPY_OF } from "./unityPlayerCache.ts";

/** Copies kept per game besides those in use: a compare pair and a little history. */
const KEPT = 4;
/** A facts key as a folder name: the engine and the project's tree id. */
const KEY = /^([a-z]+):([0-9a-f]{40,64})$/;

export class GameBuildCopies extends Context.Service<
  GameBuildCopies,
  {
    /**
     * The folder holding build `oid` of the game at `root`, made once per
     * content `key`, held for the caller's scope: no eviction removes it
     * meanwhile. A build that is gone fails `invalid-input`.
     */
    readonly lease: (
      root: string,
      build: { readonly oid: string; readonly key: string },
    ) => Effect.Effect<string, GameOperationError, Scope.Scope>;
    /**
     * Registers work on the game's copies (a measurement) that Stop game
     * ends, for the caller's scope.
     */
    readonly track: (
      root: string,
      stop: Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Ends the game's work on its copies: measurements, their operations, bots and previews. */
    readonly stopFor: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBuildCopies") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const operations = yield* GameOperations.GameOperations;
  const processes = yield* GameProcesses.GameProcesses;
  const preview = yield* GamePreview.GamePreview;
  const bots = yield* GameBot.GameBot;
  const locks = yield* KeyedLock.make<string>();
  const base = NodePath.join(config.worktreesDir, GAME_BUILD_COPIES);
  const leases = new Map<string, number>();
  const tracked = new Map<string, Set<Effect.Effect<void>>>();

  const gameDir = (root: string) =>
    NodePath.join(base, NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  const invalid = (root: string, detail: string) =>
    new GameOperationError({
      operation: "Build copy",
      path: root,
      reason: "invalid-input",
      detail,
    });
  const io = (root: string, detail: string) => (cause: unknown) =>
    new GameOperationError({ operation: "Build copy", path: root, reason: "io", detail, cause });

  // A copy cut short by a restart is never mistaken for a complete one.
  yield* Effect.promise(async () => {
    const games = await NodeFSP.readdir(base).catch(() => [] as string[]);
    for (const game of games) {
      const entries = await NodeFSP.readdir(NodePath.join(base, game)).catch(() => [] as string[]);
      for (const entry of entries)
        if (entry.endsWith(".making"))
          await NodeFSP.rm(NodePath.join(base, game, entry), { recursive: true, force: true });
    }
  });

  const stopIn = (copy: string) =>
    Effect.all(
      [operations.cancel(copy), processes.stop(copy), bots.stop(copy), preview.stop(copy)],
      { discard: true },
    );

  // The oldest copies beyond KEPT that nothing holds go, their previews first.
  const evict = (root: string) =>
    Effect.promise(async () => {
      const dir = gameDir(root);
      const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
      const complete = await Promise.all(
        names
          .filter((name) => !name.endsWith(".making"))
          .map(async (name) => {
            const path = NodePath.join(dir, name);
            const stat = await NodeFSP.stat(path).catch(() => null);
            return { path, used: stat?.mtimeMs ?? 0 };
          }),
      );
      return complete
        .filter((entry) => (leases.get(entry.path) ?? 0) === 0)
        .toSorted((a, b) => b.used - a.used)
        .slice(KEPT)
        .map((entry) => entry.path);
    }).pipe(
      Effect.flatMap((gone) =>
        Effect.forEach(
          gone,
          (path) =>
            stopIn(path).pipe(
              Effect.andThen(
                Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
              ),
            ),
          { discard: true },
        ),
      ),
    );

  const lease: GameBuildCopies["Service"]["lease"] = (root, build) =>
    Effect.gen(function* () {
      const key = KEY.exec(build.key);
      if (key === null || !/^[0-9a-f]{40,64}$/.test(build.oid))
        return yield* invalid(root, "a build copy is named by its build's content key");
      const path = NodePath.join(gameDir(root), `${key[1]}-${key[2]}`);
      yield* Effect.acquireRelease(
        Effect.sync(() => void leases.set(path, (leases.get(path) ?? 0) + 1)),
        () =>
          Effect.sync(() => {
            const left = (leases.get(path) ?? 1) - 1;
            if (left === 0) leases.delete(path);
            else leases.set(path, left);
          }).pipe(Effect.andThen(evict(root)), Effect.ignore),
      );
      yield* locks.withLock(
        path,
        Effect.gen(function* () {
          const exists = yield* Effect.promise(() =>
            NodeFSP.access(path).then(
              () => true,
              () => false,
            ),
          );
          if (exists) {
            // Its age orders eviction: a copy in use stays.
            const now = (yield* Clock.currentTimeMillis) / 1000;
            yield* Effect.promise(() => NodeFSP.utimes(path, now, now).catch(() => undefined));
            return;
          }
          const staging = `${path}.making`;
          const made = yield* checkpoints
            .materializeCheckpoint({
              cwd: root,
              checkpointRef: CheckpointRef.make(build.oid),
              destination: staging,
              excludePaths: NOT_IN_SAMPLE,
            })
            .pipe(Effect.mapError(io(root, "the build could not be copied")));
          if (!made) return yield* invalid(root, "the build is no longer kept");
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.writeFile(NodePath.join(staging, COPY_OF), `${root}\n`);
              await NodeFSP.rename(staging, path);
            },
            catch: io(root, "the build's copy could not be finished"),
          });
        }),
      );
      return path;
    });

  const track: GameBuildCopies["Service"]["track"] = (root, stop) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const set = tracked.get(root) ?? new Set();
        set.add(stop);
        tracked.set(root, set);
      }),
      () => Effect.sync(() => void tracked.get(root)?.delete(stop)),
    );

  const stopFor: GameBuildCopies["Service"]["stopFor"] = (root) =>
    Effect.gen(function* () {
      yield* Effect.forEach([...(tracked.get(root) ?? [])], (stop) => stop, { discard: true });
      const dir = gameDir(root);
      const names = yield* Effect.promise(() => NodeFSP.readdir(dir).catch(() => [] as string[]));
      yield* Effect.forEach(names, (name) => stopIn(NodePath.join(dir, name)), {
        discard: true,
      });
    });

  return GameBuildCopies.of({ lease, track, stopFor });
});

export const layer = Layer.effect(GameBuildCopies, make);
