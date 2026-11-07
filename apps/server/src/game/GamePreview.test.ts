// @effect-diagnostics nodeBuiltinImport:off -- Writes a scratch game folder on disk to watch it.
import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { GamePreview, isLiveChange, layer } from "./GamePreview.ts";

it("counts the game's own files as live changes, not Blender's or editors' temporaries", () => {
  for (const path of ["main.js", "shell/hud.js", "assets/library/kaykit/Knight.glb", "index.html"])
    expect(isLiveChange(path), path).toBe(true);
  for (const path of [
    "assets/blender/hero.blend",
    "assets/blender/hero.blend1",
    ".main.js.swp",
    "main.js~",
    "main.js.tmp",
    ".#main.js",
    "sedwyBd9l",
    ".git/index",
    "assets/.cache/x.png",
    "",
  ])
    expect(isLiveChange(path), path).toBe(false);
});

it.live("pushes a settled save, and nothing once Stop closed the watch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "kurambit-live-" });
    yield* fs.makeDirectory(path.join(root, "web"));
    yield* fs.writeFileString(path.join(root, "web", "index.html"), "<!doctype html>");
    const preview = yield* GamePreview;
    const pushes = yield* Queue.unbounded<string>();
    const url = yield* preview.live(root, "web", (changed) => Queue.offer(pushes, changed));
    assert.strictEqual(preview.liveUrl(root), url);
    yield* fs.writeFileString(path.join(root, "web", "main.js"), "export {}");
    assert.strictEqual(yield* Queue.take(pushes), "main.js");
    yield* preview.stop(root);
    assert.strictEqual(preview.liveUrl(root), null);
    yield* fs.writeFileString(path.join(root, "web", "main.js"), "export const x = 1");
    // Past the settle window: a watch still open would have pushed by now.
    yield* Effect.sleep("1 second");
    assert.strictEqual(yield* Queue.size(pushes), 0);
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.live("a Stop that lands while the live serve is opening leaves no server and no watch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "kurambit-live-race-" });
    yield* fs.makeDirectory(path.join(root, "web"));
    yield* fs.writeFileString(path.join(root, "web", "index.html"), "<!doctype html>");
    const preview = yield* GamePreview;
    const pushes = yield* Queue.unbounded<string>();
    // The open is in flight (holding the game's key, awaiting its server) when Stop arrives.
    const opening = yield* preview
      .live(root, "web", (changed) => Queue.offer(pushes, changed))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* preview.stop(root, { markStopped: true });
    yield* Fiber.join(opening);
    assert.strictEqual(preview.liveState(root), "stopped");
    assert.strictEqual(preview.liveUrl(root), null);
    yield* fs.writeFileString(path.join(root, "web", "main.js"), "export {}");
    yield* Effect.sleep("1 second");
    assert.strictEqual(yield* Queue.size(pushes), 0);
  }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
