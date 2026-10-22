// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError } from "@t3tools/contracts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};
export class GamePreview extends Context.Service<
  GamePreview,
  {
    /**
     * Serves one immutable build directory. The same game may have several
     * servers at once: a window opened before a promotion keeps loading the
     * build it was opened on, so lazy resource requests cannot mix builds.
     */
    readonly open: (root: string, directory?: string) => Effect.Effect<string, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    /** The most recently opened build for this game, or null when none is open. */
    readonly url: (root: string) => string | null;
  }
>()("t3/game/GamePreview") {}
const make = Effect.gen(function* () {
  const servers = new Map<
    string,
    { root: string; directory: string; server: NodeHttp.Server; url: string }
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
        entry.server.closeAllConnections();
        await new Promise<void>((resolve) => entry.server.close(() => resolve()));
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
  return GamePreview.of({
    url: (root) => latest.get(root)?.url ?? null,
    stop: (root) => Effect.promise(() => closeWhere(root)),
    open: (root, directory = "builds/web") =>
      Effect.tryPromise({
        try: async () => {
          const key = keyOf(root, directory);
          const existing = servers.get(key);
          if (existing) {
            latest.set(root, { key, url: existing.url });
            return existing.url;
          }
          const inFlight = pending.get(key);
          if (inFlight) return inFlight;
          const opening = (async () => {
            const webRoot = await NodeFSP.realpath(NodePath.join(root, directory));
            await NodeFSP.access(NodePath.join(webRoot, "index.html"));
            const server = NodeHttp.createServer((request, response) => {
              void (async () => {
                if (request.method !== "GET" && request.method !== "HEAD") {
                  response.writeHead(405).end();
                  return;
                }
                const raw = decodeURIComponent((request.url ?? "/").split("?")[0]!);
                if (raw.includes("\0") || raw.includes("\\") || raw.split("/").includes("..")) {
                  response.writeHead(403).end();
                  return;
                }
                const target = NodePath.resolve(webRoot, `.${raw === "/" ? "/index.html" : raw}`);
                const real = await NodeFSP.realpath(target);
                if (!real.startsWith(webRoot + NodePath.sep)) {
                  response.writeHead(403).end();
                  return;
                }
                const stat = await NodeFSP.stat(real);
                if (!stat.isFile()) {
                  response.writeHead(404).end();
                  return;
                }
                response.writeHead(200, {
                  "Content-Type": mime[NodePath.extname(real)] ?? "application/octet-stream",
                  "Content-Length": stat.size,
                  "Cache-Control": "no-store",
                });
                if (request.method === "HEAD") response.end();
                else
                  NodeFS.createReadStream(real)
                    .on("error", () => response.destroy())
                    .pipe(response);
              })().catch(() => {
                if (!response.headersSent) response.writeHead(404);
                response.end();
              });
            });
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve());
            });
            const address = server.address();
            if (!address || typeof address === "string")
              throw new Error("Preview did not bind TCP");
            const url = `http://127.0.0.1:${address.port}/`;
            servers.set(key, { root, directory, server, url });
            latest.set(root, { key, url });
            return url;
          })();
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
      }),
  });
});
export const layer = Layer.effect(GamePreview, make);
