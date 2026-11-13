// @effect-diagnostics nodeBuiltinImport:off -- Builds a scratch game folder with links out of it.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { serveGameDirectory } from "./gameWebServer.ts";

// fetch normalizes "..", so the raw request line goes out through node:http.
const get = (url: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = NodeHttp.request(`${url}${path.slice(1)}`, { headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      });
      request.path = path;
      request.on("error", reject);
      request.end();
    },
  );

it("serves the game folder and its runtime, and nothing outside either", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-web-"));
  const served: string[] = [];
  const server = await (async () => {
    const game = NodePath.join(root, "game");
    NodeFS.mkdirSync(NodePath.join(game, "web", "assets"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(game, "web", "index.html"), "<!doctype html>\n");
    NodeFS.writeFileSync(NodePath.join(game, "web", "assets", "hero.glb"), "glTF");
    NodeFS.writeFileSync(NodePath.join(game, "secret.txt"), "not served\n");
    NodeFS.symlinkSync(
      NodePath.join(game, "secret.txt"),
      NodePath.join(game, "web", "assets", "escape.txt"),
    );
    const shell = NodePath.join(root, "runtimes", "three", "1", "shell");
    NodeFS.mkdirSync(shell, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(shell, "shell.js"), "export {};\n");
    return serveGameDirectory(game, "web", {
      runtimes: NodePath.join(root, "runtimes"),
      onServed: (path) => served.push(path),
    });
  })();
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const index = await get(server.url, "/");
    expect([index.status, index.body, index.headers["content-type"]]).toEqual([
      200,
      "<!doctype html>\n",
      "text/html; charset=utf-8",
    ]);
    expect(index.headers["cache-control"]).toBe("no-store");
    const hero = await get(server.url, "/assets/hero.glb");
    expect([hero.status, hero.headers["content-type"]]).toEqual([200, "model/gltf-binary"]);
    expect(served).toEqual(["index.html", "assets/hero.glb"]);

    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/escape.txt",
      "/..%5csecret.txt",
    ])
      expect((await get(server.url, path)).status, path).toBeOneOf([403, 404]);
    expect((await get(server.url, "/missing.js")).status).toBe(404);
    expect(served).toEqual(["index.html", "assets/hero.glb"]);

    const runtime = await get(server.url, "/_kurambit/runtime/three/1/shell/shell.js");
    expect([runtime.status, runtime.headers["cache-control"]]).toEqual([200, "no-cache"]);
    const etag = runtime.headers.etag;
    expect(etag).toBeTypeOf("string");
    const again = await get(server.url, "/_kurambit/runtime/three/1/shell/shell.js", {
      "if-none-match": etag!,
    });
    expect(again.status).toBe(304);
    expect(served).toEqual(["index.html", "assets/hero.glb"]);
  } finally {
    await server.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
