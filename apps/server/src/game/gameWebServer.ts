// @effect-diagnostics nodeBuiltinImport:off -- This module owns the loopback HTTP boundary for three.js sources.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { engineChildEnv } from "./GameProcesses.ts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

export interface WebStaticServer {
  /** Loopback origin serving the directory, e.g. http://127.0.0.1:PORT/. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Serves a game-relative directory over loopback for check/explore/bot runs
 * on three.js sources. Never touches GamePreview state: Play keeps serving
 * whatever build it had, and this server closes with the run.
 */
export const serveGameDirectory = async (
  root: string,
  directory: string,
): Promise<WebStaticServer> => {
  const webRoot = await NodeFSP.realpath(NodePath.join(root, directory));
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
 * A clean room for Chromium and its children: the allowlisted engine base
 * plus the pinned scratch and heap knobs, and nothing else. No desktop
 * display leaks in (headless runs own no DISPLAY), and page JS stays
 * sandboxed with no environment to read; only the utility processes that
 * launch the browser see this.
 */
export const chromiumChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...engineChildEnv() };
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
  env.NODE_OPTIONS = "--max-old-space-size=1536";
  return env;
};
