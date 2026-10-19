// @effect-diagnostics nodeBuiltinImport:off -- Real temporary game folders prove mtime behaviour no mock reproduces.
import { it, expect } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { isWebBuildStale } from "./webBuild.ts";

const write = (root: string, relative: string, contents: string) =>
  Effect.promise(async () => {
    const path = NodePath.join(root, relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents);
    return path;
  });

const touch = (path: string, mtimeMs: number) =>
  Effect.promise(() => NodeFSP.utimes(path, mtimeMs / 1_000, mtimeMs / 1_000));

const modifiedMs = (path: string) =>
  Effect.promise(() => NodeFSP.stat(path).then((stat) => stat.mtimeMs));

it.effect("reports a missing web build as stale and a newer build as fresh", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-web-build-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    yield* write(root, "godot/project.godot", "[application]\n");
    const mainScript = yield* write(root, "godot/scripts/main.gd", "extends Node\n");
    expect(yield* isWebBuildStale(root, "godot")).toBe(true);
    const index = yield* write(root, "builds/web/index.html", "<html></html>");
    const built = yield* modifiedMs(index);
    yield* touch(mainScript, built - 60_000);
    expect(yield* isWebBuildStale(root, "godot")).toBe(false);
    // A scene edited after the last export makes the served game out of date.
    const scene = yield* write(root, "godot/scenes/main.tscn", "[gd_scene]");
    yield* touch(scene, built + 60_000);
    expect(yield* isWebBuildStale(root, "godot")).toBe(true);
    yield* touch(scene, built - 30_000);
    // Godot's own scratch is rewritten by exporting; it never makes a build stale.
    const scratch = yield* write(root, "godot/.godot/editor/state.cfg", "x");
    yield* touch(scratch, built + 120_000);
    expect(yield* isWebBuildStale(root, "godot")).toBe(false);
  }),
);
