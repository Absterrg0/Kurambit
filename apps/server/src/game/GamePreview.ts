// @effect-diagnostics nodeBuiltinImport:off -- Paths name the build Play serves; gameWebServer owns the loopback HTTP boundary.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import { GameOperationError } from "@kurambit/contracts";
import { serveGameDirectory } from "./gameWebServer.ts";

/** A save settles before it is pushed: editors write a file in several events. */
const LIVE_SETTLE = Duration.millis(400);

/**
 * Whether a change under the live-served folder is the game's: Blender's
 * sources and backups, dotfiles and editors' temporary files are not, so
 * saving a .blend or a swap file never reloads the game. Pure.
 */
export const isLiveChange = (path: string): boolean => {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  const name = segments.at(-1);
  if (name === undefined || segments.some((segment) => segment.startsWith("."))) return false;
  return !/(\.blend1?|~|\.swp|\.tmp)$/i.test(name);
};

export class GamePreview extends Context.Service<
  GamePreview,
  {
    /** Serves a build and makes it the one Play shows. */
    readonly select: (root: string, directory: string) => Effect.Effect<string, GameOperationError>;
    /**
     * Serves the game's own folder, as its dev server: one server and one
     * recursive watch per game, kept until `stop`. Each settled change the
     * game's (`isLiveChange`) calls `onChange` with its path. A watch that
     * fails is logged and ends only the watch; the next `live` opens it again.
     */
    readonly live: (
      root: string,
      directory: string,
      onChange: (path: string) => Effect.Effect<void>,
    ) => Effect.Effect<string, GameOperationError>;
    /** The URL of the game's live-served folder, or null when it is not served. */
    readonly liveUrl: (root: string) => string | null;
    /**
     * The live serve as every client sees it: "serving", "stopped" (stopped
     * until Play opens it again), or "off" (not opened since this server started).
     */
    readonly liveState: (root: string) => "off" | "serving" | "stopped";
    /** Each change of a game's `liveState` to serving or stopped. */
    readonly liveStates: Stream.Stream<{
      readonly root: string;
      readonly state: "serving" | "stopped";
    }>;
    /**
     * Closes every server of this game and its live watch; no change is pushed
     * after it. A served game reads stopped after it; `markStopped`, the game's
     * own Stop, makes it read stopped even when it was not being served.
     */
    readonly stop: (
      root: string,
      options?: { readonly markStopped?: boolean },
    ) => Effect.Effect<void>;
    /** Closes the servers of this game's builds other than `directories` (builds an export pruned). */
    readonly retain: (root: string, directories: ReadonlyArray<string>) => Effect.Effect<void>;
    /** The URL of the build most recently selected for Play, or null. */
    readonly url: (root: string) => string | null;
  }
>()("kurambit/game/GamePreview") {}
const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Kept apart from the builds' servers, so an export pruning its builds
  // (`retain`) or selecting one never closes the live folder's.
  const lives = new Map<string, { url: string; close: () => Promise<void> }>();
  const watches = new Map<string, Scope.Closeable>();
  // A game's live open and its Stop run one at a time, so a Stop that lands
  // while an open is in flight closes what the open made.
  const liveLocks = yield* KeyedLock.make<string>();
  const states = new Map<string, "serving" | "stopped">();
  const stateChanges = yield* PubSub.unbounded<{
    readonly root: string;
    readonly state: "serving" | "stopped";
  }>();
  const setState = (root: string, state: "serving" | "stopped") =>
    Effect.suspend(() => {
      if (states.get(root) === state) return Effect.void;
      states.set(root, state);
      return PubSub.publish(stateChanges, { root, state });
    });
  const closeWatch = (root: string) =>
    Effect.suspend(() => {
      const scope = watches.get(root);
      if (scope === undefined) return Effect.void;
      watches.delete(root);
      return Scope.close(scope, Exit.void);
    });
  const servers = new Map<
    string,
    { root: string; directory: string; url: string; close: () => Promise<void> }
  >();
  const latest = new Map<string, { key: string; url: string }>();
  const pending = new Map<string, Promise<string>>();
  const keyOf = (root: string, directory: string) => `${root}\0${directory}`;
  const closeWhere = async (root: string) => {
    // An open still in flight would otherwise store a server after this close.
    await Promise.all(
      [...pending.entries()]
        .filter(([key]) => key.startsWith(`${root}\0`))
        .map(([, opening]) => opening.catch(() => undefined)),
    );
    const keys = [...servers.keys()].filter((key) => key.startsWith(`${root}\0`));
    await Promise.all(
      keys.map(async (key) => {
        const entry = servers.get(key);
        if (entry === undefined) return;
        servers.delete(key);
        await entry.close();
      }),
    );
    latest.delete(root);
    const live = lives.get(root);
    lives.delete(root);
    await live?.close();
  };
  // The watch first, so no change is pushed for a folder no longer served.
  const stopRoot = (root: string, options?: { readonly markStopped?: boolean }) =>
    liveLocks.withLock(
      root,
      Effect.gen(function* () {
        const serving = states.get(root) === "serving";
        yield* closeWatch(root);
        yield* Effect.promise(() => closeWhere(root));
        if (serving || options?.markStopped === true) yield* setState(root, "stopped");
      }).pipe(Effect.uninterruptible),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const root of [...watches.keys()]) yield* closeWatch(root);
      yield* Effect.promise(async () => {
        const roots = new Set([...servers.values()].map((entry) => entry.root));
        for (const root of [...roots, ...lives.keys()]) await closeWhere(root);
        await Promise.all([...pending.values()].map((opening) => opening.catch(() => undefined)));
      });
    }),
  );
  const serveLive = (root: string, directory: string) =>
    Effect.tryPromise({
      try: async () => {
        const existing = lives.get(root);
        if (existing) return existing.url;
        const opened = await serveGameDirectory(root, directory);
        lives.set(root, opened);
        return opened.url;
      },
      catch: (cause) =>
        new GameOperationError({
          operation: "preview",
          path: NodePath.join(root, directory, "index.html"),
          reason: "io",
          cause,
        }),
    });
  const watchLive = (
    root: string,
    directory: string,
    onChange: (path: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      if (watches.has(root)) return;
      const scope = Scope.makeUnsafe();
      watches.set(root, scope);
      // `live` returns once the watch is installed, so a save right after it is seen.
      const ready = Deferred.makeUnsafe<void>();
      const settle = () => Deferred.doneUnsafe(ready, Effect.void);
      yield* fileSystem
        .watch(NodePath.join(root, directory), { recursive: true, onReady: settle })
        .pipe(
          Stream.filter((event) => isLiveChange(event.path)),
          // A folder made (Blender's first export makes assets/blender/) changes
          // nothing the game loads; the files then written in it each count.
          Stream.filterEffect((event) =>
            event._tag !== "Create"
              ? Effect.succeed(true)
              : fileSystem.stat(NodePath.join(root, directory, event.path)).pipe(
                  Effect.map((info) => info.type !== "Directory"),
                  Effect.orElseSucceed(() => true),
                ),
          ),
          Stream.map((event) => event.path),
          Stream.debounce(LIVE_SETTLE),
          Stream.runForEach(onChange),
          Effect.catchCause((cause) =>
            Effect.logWarning("The game's live watch ended; Reload still works.", { root, cause }),
          ),
          // A watch that ended on its own leaves room for the next `live` to open one.
          Effect.ensuring(
            Effect.sync(() => {
              settle();
              if (watches.get(root) === scope) watches.delete(root);
            }),
          ),
          Effect.forkIn(scope),
        );
      yield* Deferred.await(ready);
    });
  const openServer = (root: string, directory: string) =>
    Effect.tryPromise({
      try: async () => {
        const key = keyOf(root, directory);
        const existing = servers.get(key);
        if (existing) return existing.url;
        const inFlight = pending.get(key);
        if (inFlight) return inFlight;
        const opening = serveGameDirectory(root, directory).then(({ url, close }) => {
          servers.set(key, { root, directory, url, close });
          return url;
        });
        pending.set(key, opening);
        try {
          return await opening;
        } finally {
          pending.delete(key);
        }
      },
      catch: (cause) =>
        new GameOperationError({
          operation: "preview",
          path: NodePath.join(root, directory, "index.html"),
          reason: "io",
          cause,
        }),
    });
  const retain = async (root: string, directories: ReadonlyArray<string>) => {
    const keep = new Set(directories.map((directory) => keyOf(root, directory)));
    await Promise.all(
      [...servers.entries()]
        .filter(([key]) => key.startsWith(`${root}\0`) && !keep.has(key))
        .map(async ([key, entry]) => {
          servers.delete(key);
          if (latest.get(root)?.key === key) latest.delete(root);
          await entry.close().catch(() => undefined);
        }),
    );
  };
  return GamePreview.of({
    url: (root) => latest.get(root)?.url ?? null,
    liveUrl: (root) => lives.get(root)?.url ?? null,
    liveState: (root) => states.get(root) ?? "off",
    liveStates: Stream.fromPubSub(stateChanges),
    live: (root, directory, onChange) =>
      liveLocks.withLock(
        root,
        serveLive(root, directory).pipe(
          Effect.tap(() => watchLive(root, directory, onChange)),
          Effect.tap(() => setState(root, "serving")),
          Effect.uninterruptible,
        ),
      ),
    stop: stopRoot,
    retain: (root, directories) => Effect.promise(() => retain(root, directories)),
    // A window opened before a new selection keeps loading the build it was
    // opened on, because each directory keeps its own server. Selecting only
    // changes which URL Play reports.
    select: (root, directory) =>
      openServer(root, directory).pipe(
        Effect.tap((url) =>
          Effect.sync(() => latest.set(root, { key: keyOf(root, directory), url })),
        ),
      ),
  });
});
export const layer = Layer.effect(GamePreview, make);
