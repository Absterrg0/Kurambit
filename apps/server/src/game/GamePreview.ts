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
    readonly open: (root: string) => Effect.Effect<string, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    readonly url: (root: string) => string | null;
  }
>()("t3/game/GamePreview") {}
const make = Effect.gen(function* () {
  const servers = new Map<string, { server: NodeHttp.Server; url: string }>();
  const pending = new Map<string, Promise<string>>();
  const close = async (root: string) => {
    await pending.get(root)?.catch(() => {});
    const entry = servers.get(root);
    if (!entry) return;
    servers.delete(root);
    entry.server.closeAllConnections();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await Promise.all([...new Set([...pending.keys(), ...servers.keys()])].map(close));
    }),
  );
  return GamePreview.of({
    url: (root) => servers.get(root)?.url ?? null,
    stop: (root) => Effect.promise(() => close(root)),
    open: (root) =>
      Effect.tryPromise({
        try: async () => {
          const existing = servers.get(root);
          if (existing) return existing.url;
          const inFlight = pending.get(root);
          if (inFlight) return inFlight;
          const opening = (async () => {
            const webRoot = await NodeFSP.realpath(NodePath.join(root, "builds/web"));
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
            servers.set(root, { server, url });
            return url;
          })();
          pending.set(root, opening);
          try {
            return await opening;
          } finally {
            pending.delete(root);
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "preview",
            path: NodePath.join(root, "builds/web/index.html"),
            reason: "io",
            cause,
          }),
      }),
  });
});
export const layer = Layer.effect(GamePreview, make);
