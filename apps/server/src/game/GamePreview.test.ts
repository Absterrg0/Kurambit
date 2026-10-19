// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- Verify a real loopback server, including raw traversal and symlink requests.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GamePreview from "./GamePreview.ts";
it.effect(
  "serves actual web files with correct MIME, blocks traversal and symlinks, and closes on stop",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-preview-")),
      );
      try {
        const web = NodePath.join(root, "builds/web");
        yield* Effect.promise(() => NodeFSP.mkdir(web, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(web, "index.html"), "<html>game</html>"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(web, "index.wasm"), new Uint8Array([0, 97, 115, 109])),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "secret"), "secret"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(root, "secret"), NodePath.join(web, "escape")),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const preview = yield* GamePreview.GamePreview;
            const [url, same] = yield* Effect.all([preview.open(root), preview.open(root)], {
              concurrency: "unbounded",
            });
            expect(same).toBe(url);
            const html = yield* Effect.promise(() =>
              fetch(url).then((response) => response.text()),
            );
            expect(html).toContain("game");
            const wasm = yield* Effect.promise(() => fetch(`${url}index.wasm`));
            expect(wasm.headers.get("content-type")).toBe("application/wasm");
            expect(new Uint8Array(yield* Effect.promise(() => wasm.arrayBuffer()))).toEqual(
              new Uint8Array([0, 97, 115, 109]),
            );
            for (const suffix of ["%2e%2e%2fsecret", "escape", "%00", "%5csecret"]) {
              const response = yield* Effect.promise(() => fetch(`${url}${suffix}`));
              expect(response.status).toBeGreaterThanOrEqual(400);
            }
            yield* preview.stop(root);
            expect(preview.url(root)).toBeNull();
            yield* Effect.promise(async () => {
              await expect(fetch(url)).rejects.toThrow();
            });
          }).pipe(Effect.provide(GamePreview.layer)),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
);
