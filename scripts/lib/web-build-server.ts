// @effect-diagnostics nodeBuiltinImport:off -- Maintainer scripts serve a saved Web build on loopback and locate the pinned headless browser.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** Serves the build on loopback only; Godot's single-threaded web export needs no COOP/COEP. */
export const serveWebBuild = async (
  root: string,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = NodeHttp.createServer(async (request, response) => {
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = NodePath.resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${NodePath.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file).catch(() => null);
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[NodePath.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The static server did not report a port.");
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** The pinned headless browser the studio installs under its checkout. */
export const defaultHeadlessBrowser = async (): Promise<string> => {
  const checkout = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
  const root = NodePath.join(checkout, ".kurambit/tools/chrome-headless-shell");
  const platforms = await NodeFSP.readdir(root).catch(() => []);
  for (const platform of platforms) {
    const versions = await NodeFSP.readdir(NodePath.join(root, platform)).catch(() => []);
    for (const version of versions) {
      const candidate = NodePath.join(root, platform, version, "chrome-headless-shell");
      if (
        await NodeFSP.access(candidate)
          .then(() => true)
          .catch(() => false)
      )
        return candidate;
    }
  }
  throw new Error(`No chrome-headless-shell under ${root}; pass --browser <path>.`);
};
