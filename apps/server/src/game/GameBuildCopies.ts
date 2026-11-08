// @effect-diagnostics nodeBuiltinImport:off -- A build's copy is a folder on disk outside the game repository.
// The copies a game's builds are played and measured in. A copy is a plain
// folder of one build (no git, no .studio or NOTES.md) under Kurambit's own
// worktrees folder, never in the game repository, so playing or measuring an
// old build never touches the game folder. Copies are content-addressed by
// the build's engine project, so builds with the same project share one. A
// copy names its game folder in COPY_OF, so a Unity copy reuses that folder's
// import cache. This service sits below GameStage so Stop game reaches the
// work on a game's copies too.
//
// One owner at a time: Play and a measurement of the same build share one
// copy, and every engine step on it (a check, a bot run, a Web export) runs
// under the copy's one lock, so two never import into its project at once
// and neither fails the other "busy". A copy is removed only while nothing
// leases or serves it, decided under the lock its lease takes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  CheckpointRef,
  GAME_BUILDS_EVENT,
  type GameBuildId,
  GameOperationError,
} from "@kurambit/contracts";
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
    /** Runs one engine step on a copy (a check, a bot run, a Web export) as the copy's only one. */
    readonly exclusive: <A, E, R>(
      copy: string,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Work on a game's copies that Stop game also ends (the measurements, queued or running). */
    readonly onStop: (stop: (root: string) => Effect.Effect<void>) => Effect.Effect<void>;
    /** Ends the game's work on its copies: measurements, their operations, bots and previews. */
    readonly stopFor: (root: string) => Effect.Effect<void>;
    /** Records that `copy` is serving build `build` of the game at `url`, and says so to its clients. */
    readonly playing: (
      root: string,
      build: GameBuildId,
      copy: string,
      url: string | null,
    ) => Effect.Effect<void>;
    /** The builds of the game being played from their copies now. */
    readonly plays: (
      root: string,
    ) => ReadonlyArray<{ readonly build: GameBuildId; readonly url: string | null }>;
    /** Stops one build's Play; a measurement of it and the folder's own Play go on. */
    readonly stopPlay: (root: string, build: GameBuildId) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBuildCopies") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const operations = yield* GameOperations.GameOperations;
  const processes = yield* GameProcesses.GameProcesses;
  const preview = yield* GamePreview.GamePreview;
  const bots = yield* GameBot.GameBot;
  /** Held while a copy is made or removed, and while eviction decides. */
  const folderLocks = yield* KeyedLock.make<string>();
  /** Held for one engine step on a copy. */
  const engineLocks = yield* KeyedLock.make<string>();
  const base = NodePath.join(config.worktreesDir, GAME_BUILD_COPIES);
  /** Holders of each copy: leases, and a served Play counts as one. */
  const holders = new Map<string, number>();
  const stoppers: Array<(root: string) => Effect.Effect<void>> = [];
  const served = new Map<
    string,
    Map<GameBuildId, { readonly copy: string; readonly url: string | null }>
  >();
  const hold = (path: string, by: number) => {
    const next = (holders.get(path) ?? 0) + by;
    if (next <= 0) holders.delete(path);
    else holders.set(path, next);
  };
  const announce = (root: string, message: string) =>
    operations.changed(root, GAME_BUILDS_EVENT, message);
  // A Play that ends lets its copy go; its game's clients hear of it.
  const unserve = (root: string, copy: string) =>
    Effect.suspend(() => {
      const plays = served.get(root);
      const gone = [...(plays ?? [])]
        .filter(([, play]) => play.copy === copy)
        .map(([build]) => build);
      if (gone.length === 0) return Effect.void;
      for (const build of gone) {
        plays?.delete(build);
        hold(copy, -1);
      }
      return announce(root, `Stopped playing build ${gone[0]!.slice(0, 8)}.`);
    });

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

  // The oldest copies beyond KEPT go; each is checked again under its lock,
  // so one leased or served meanwhile stays.
  const evict = (root: string) =>
    Effect.gen(function* () {
      const dir = gameDir(root);
      const candidates = yield* Effect.promise(async () => {
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
          .filter((entry) => !holders.has(entry.path))
          .toSorted((a, b) => b.used - a.used)
          .slice(KEPT)
          .map((entry) => entry.path);
      });
      yield* Effect.forEach(
        candidates,
        (path) =>
          folderLocks.withLock(
            path,
            Effect.suspend(() =>
              holders.has(path)
                ? Effect.void
                : stopIn(path).pipe(
                    Effect.andThen(
                      Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
                    ),
                  ),
            ),
          ),
        { discard: true },
      );
    });

  const lease: GameBuildCopies["Service"]["lease"] = (root, build) =>
    Effect.gen(function* () {
      const key = KEY.exec(build.key);
      if (key === null || !/^[0-9a-f]{40,64}$/.test(build.oid))
        return yield* invalid(root, "a build copy is named by its build's content key");
      const path = NodePath.join(gameDir(root), `${key[1]}-${key[2]}`);
      // Held before the folder is looked at, so an eviction deciding under the lock sees it.
      yield* Effect.acquireRelease(
        Effect.sync(() => hold(path, 1)),
        () => Effect.sync(() => hold(path, -1)).pipe(Effect.andThen(evict(root)), Effect.ignore),
      );
      yield* folderLocks.withLock(
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

  const exclusive: GameBuildCopies["Service"]["exclusive"] = (copy, work) =>
    engineLocks.withLock(copy, work);

  const onStop: GameBuildCopies["Service"]["onStop"] = (stop) =>
    Effect.sync(() => void stoppers.push(stop));

  const stopFor: GameBuildCopies["Service"]["stopFor"] = (root) =>
    Effect.gen(function* () {
      yield* Effect.forEach(stoppers, (stop) => stop(root), { discard: true });
      const dir = gameDir(root);
      const names = yield* Effect.promise(() => NodeFSP.readdir(dir).catch(() => [] as string[]));
      yield* Effect.forEach(names, (name) => stopIn(NodePath.join(dir, name)), {
        discard: true,
      });
      const plays = served.get(root);
      if (plays !== undefined && plays.size > 0) {
        for (const play of plays.values()) hold(play.copy, -1);
        served.delete(root);
        yield* announce(root, "Stopped playing the game's builds.");
      }
    });

  const playing: GameBuildCopies["Service"]["playing"] = (root, build, copy, url) =>
    Effect.suspend(() => {
      const plays = served.get(root) ?? new Map();
      if (!plays.has(build)) hold(copy, 1);
      plays.set(build, { copy, url });
      served.set(root, plays);
      return announce(root, `Playing build ${build.slice(0, 8)}.`);
    });

  const plays: GameBuildCopies["Service"]["plays"] = (root) =>
    [...(served.get(root) ?? [])].map(([build, play]) => ({ build, url: play.url }));

  const stopPlay: GameBuildCopies["Service"]["stopPlay"] = (root, build) =>
    Effect.gen(function* () {
      const play = served.get(root)?.get(build);
      if (play === undefined) return;
      // Only the copy's preview: a measurement of the same build keeps going.
      yield* preview.stop(play.copy);
      yield* unserve(root, play.copy);
      yield* evict(root);
    });

  return GameBuildCopies.of({
    lease,
    exclusive,
    onStop,
    stopFor,
    playing,
    plays,
    stopPlay,
  });
});

export const layer = Layer.effect(GameBuildCopies, make);
