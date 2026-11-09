// @effect-diagnostics nodeBuiltinImport:off -- This module owns the loopback HTTP boundary for three.js sources.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import { engineChildEnv } from "./GameProcesses.ts";
import { runtimeRequestFile } from "./gameRuntime.ts";
import { insideGame } from "./gamePath.ts";

/** Text types carry their charset so a page without a meta tag still decodes as UTF-8. */
const contentType = (path: string): string =>
  Option.match(Mime.getType(path), {
    onNone: () => "application/octet-stream",
    onSome: (type) => (type.startsWith("text/") ? `${type}; charset=utf-8` : type),
  });

export interface WebStaticServer {
  /** Loopback origin serving the directory, e.g. http://127.0.0.1:PORT/. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Serves a game-relative directory over loopback, for Play and for
 * check/explore/bot runs. It is its own origin on purpose: the game is
 * agent-written JS and must never run on the app origin beside the session
 * cookie. Requests resolve through realpath, so a symlink cannot reach outside
 * the directory. With `runtimes`, `/_kurambit/runtime/...` is answered from
 * Kurambit's runtime (gameRuntime.ts) for a game that loads it; an export
 * holds its own copy and is served without.
 */
export const serveGameDirectory = async (
  root: string,
  directory: string,
  options: {
    /** Each file a GET is answered with, by its path inside the directory ("assets/hero.glb"). */
    readonly onServed?: (path: string) => void;
    /** The server's runtimes folder (gameRuntime's runtimesDirectory), for a folder that loads one. */
    readonly runtimes?: string | null;
  } = {},
): Promise<WebStaticServer> => {
  // The served folder itself must stay in the game: a link at it (or a selection naming
  // another folder) would serve whatever it points at to the game's page.
  const webRoot = await NodeFSP.realpath(insideGame(root, directory, { root: "allowed" }));
  await NodeFSP.access(NodePath.join(webRoot, "index.html"));
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const raw = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      if (raw.includes("\0") || raw.includes("\\") || raw.split("/").includes("..")) {
        response.writeHead(403).end();
        return;
      }
      const runtimeFile =
        options.runtimes == null ? null : await runtimeRequestFile(options.runtimes, raw);
      if (runtimeFile !== null) {
        await serveRuntimeFile(request, response, runtimeFile);
        return;
      }
      const target = NodePath.resolve(webRoot, `.${raw === "/" ? "/index.html" : raw}`);
      let real: string;
      try {
        real = await NodeFSP.realpath(target);
      } catch {
        response.writeHead(404).end();
        return;
      }
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
        "Content-Type": contentType(real),
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") response.end();
      else {
        options.onServed?.(NodePath.relative(webRoot, real).split(NodePath.sep).join("/"));
        NodeFS.createReadStream(real)
          .on("error", () => response.destroy())
          .pipe(response);
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || !NodeNet.isIPv4(address.address))
    throw new Error("Preview did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * One runtime file. Its URL names only the major, so a minor update must reach the next load:
 * the browser keeps it and asks again each time (no-cache), and an unchanged file answers 304
 * from its stat alone, which keeps the compiled module in the browser's code cache across a
 * live reload. Runtime files are Kurambit's, not the game's, so asset use never counts them.
 */
const serveRuntimeFile = async (
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  file: string,
) => {
  const stat = await NodeFSP.stat(file);
  if (!stat.isFile()) {
    response.writeHead(404).end();
    return;
  }
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers).end();
    return;
  }
  response.writeHead(200, {
    ...headers,
    "Content-Type": contentType(file),
    "Content-Length": stat.size,
  });
  if (request.method === "HEAD") response.end();
  else
    NodeFS.createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
};

/**
 * A clean room for Chromium and its children: the allowlisted engine base
 * plus the heap knob, and nothing else. No desktop
 * display leaks in (headless runs own no DISPLAY), and page JS stays
 * sandboxed with no environment to read; only the utility processes that
 * launch the browser see this.
 */
export const chromiumChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...engineChildEnv() };
  env.NODE_OPTIONS = "--max-old-space-size=1536";
  return env;
};
