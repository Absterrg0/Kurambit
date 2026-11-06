// @effect-diagnostics nodeBuiltinImport:off -- Paths name the build Play serves; gameWebServer owns the loopback HTTP boundary.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError } from "@kurambit/contracts";
import { serveGameDirectory } from "./gameWebServer.ts";

export class GamePreview extends Context.Service<
  GamePreview,
  {
    /** Serves a build and makes it the one Play shows. */
    readonly select: (root: string, directory: string) => Effect.Effect<string, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    /** Closes the servers of this game's builds other than `directories` (builds an export pruned). */
    readonly retain: (root: string, directories: ReadonlyArray<string>) => Effect.Effect<void>;
    /** The URL of the build most recently selected for Play, or null. */
    readonly url: (root: string) => string | null;
  }
>()("kurambit/game/GamePreview") {}
const make = Effect.gen(function* () {
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
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      const roots = new Set([...servers.values()].map((entry) => entry.root));
      for (const root of roots) await closeWhere(root);
      await Promise.all([...pending.values()].map((opening) => opening.catch(() => undefined)));
    }),
  );
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
    stop: (root) => Effect.promise(() => closeWhere(root)),
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
