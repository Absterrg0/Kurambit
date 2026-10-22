// @effect-diagnostics nodeBuiltinImport:off -- Build identities live on a temporary native build tree.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  candidateBuildDirectory,
  candidateBuildId,
  describeWebArtifacts,
  hashWebBuild,
  webArtifactsMatch,
  webBuildId,
} from "./webBuild.ts";

const withBuild = <A, E>(
  body: (input: { readonly root: string; readonly directory: string }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-build-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const directory = candidateBuildDirectory("a".repeat(64));
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
        for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
          await NodeFSP.writeFile(NodePath.join(root, directory, name), `export ${name}`);
      });
      return yield* body({ root, directory });
    }),
  );

it.effect("a build id is over paths and bytes; touching mtimes changes nothing", () =>
  withBuild(({ root, directory }) =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => hashWebBuild(root, directory));
      expect(first).not.toBeNull();
      yield* Effect.promise(async () => {
        for (const file of first!.files) {
          const target = NodePath.join(root, directory, file.path);
          const stat = await NodeFSP.stat(target);
          await NodeFSP.utimes(target, stat.atimeMs / 1000, stat.mtimeMs / 1000 + 10);
        }
      });
      const touched = yield* Effect.promise(() => hashWebBuild(root, directory));
      expect(touched?.buildId).toBe(first!.buildId);
      // A same-size edit must change the identity the round decides on.
      yield* Effect.promise(async () => {
        const target = NodePath.join(root, directory, "index.pck");
        const bytes = await NodeFSP.readFile(target);
        bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x61 ? 0x62 : 0x61;
        await NodeFSP.writeFile(target, bytes);
      });
      const edited = yield* Effect.promise(() => hashWebBuild(root, directory));
      expect(edited?.buildId).not.toBe(first!.buildId);
    }),
  ),
);

it.effect("the legacy size/mtime descriptor is checked against the directory it names", () =>
  withBuild(({ root, directory }) =>
    Effect.gen(function* () {
      const artifacts = yield* Effect.promise(() => describeWebArtifacts(root, directory));
      expect(artifacts?.map((file) => file.path)).toEqual([
        `${directory}/index.html`,
        `${directory}/index.js`,
        `${directory}/index.pck`,
        `${directory}/index.wasm`,
      ]);
      expect(yield* Effect.promise(() => webArtifactsMatch(root, artifacts!, directory))).toBe(
        true,
      );
      // The same descriptor must not pass against the legacy directory.
      expect(yield* Effect.promise(() => webArtifactsMatch(root, artifacts!))).toBe(false);
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, directory, "index.pck")));
      expect(yield* Effect.promise(() => webArtifactsMatch(root, artifacts!, directory))).toBe(
        false,
      );
    }),
  ),
);

it("candidate directories are exactly their own hash", () => {
  const buildId = "b".repeat(64);
  const directory = candidateBuildDirectory(buildId);
  expect(candidateBuildId(directory)).toBe(buildId);
  expect(candidateBuildId("builds/web")).toBeNull();
  expect(candidateBuildId(`builds/candidates/${"a".repeat(63)}`)).toBeNull();
  expect(candidateBuildId(`builds/candidates/${"A".repeat(64)}`)).toBeNull();
  expect(candidateBuildId(`builds/candidates/${buildId}/nested`)).toBeNull();
  expect(webBuildId([])).toMatch(/^[0-9a-f]{64}$/);
});
