// @effect-diagnostics nodeBuiltinImport:off -- Snapshot tests use real temporary source trees.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { snapshotSource } from "./sourceSnapshot.ts";

const withTree = <A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "source-snapshot-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n"),
      );
      return yield* run(root);
    }),
  );

const knownId = async (root: string) => {
  const snapshot = await snapshotSource(root, "godot");
  if (snapshot.kind !== "known")
    throw new Error(`Expected a known snapshot, got ${snapshot.reason}`);
  return snapshot.sourceId;
};

it.effect("hashes paths, sizes and mtimes so additions, edits and deletions all change it", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => knownId(root));
      // Unchanged sources reuse the same identity.
      expect(yield* Effect.promise(() => knownId(root))).toBe(first);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/extra.gd"), "extends Node2D\n"),
      );
      const withExtra = yield* Effect.promise(() => knownId(root));
      expect(withExtra).not.toBe(first);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node2D\n"),
      );
      const edited = yield* Effect.promise(() => knownId(root));
      expect(edited).not.toBe(withExtra);

      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "godot/scripts/extra.gd")));
      const deleted = yield* Effect.promise(() => knownId(root));
      expect(deleted).not.toBe(edited);
      expect(deleted).not.toBe(withExtra);
    }),
  ),
);

it.effect("ignores Godot's own scratch directory", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => knownId(root));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "godot/.godot/imported"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/.godot/imported/cache.bin"), "cache"),
      );
      expect(yield* Effect.promise(() => knownId(root))).toBe(first);
    }),
  ),
);

it.effect("reports unknown instead of fresh when the scan bound is exceeded", () =>
  withTree((root) =>
    Effect.gen(function* () {
      for (let index = 0; index < 8; index++)
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(root, `godot/scripts/extra-${index}.gd`),
            "extends Node\n",
          ),
        );
      const bounded = yield* Effect.promise(() => snapshotSource(root, "godot", { maxEntries: 4 }));
      expect(bounded).toEqual({ kind: "unknown", reason: "entry-limit" });
    }),
  ),
);

it.effect("reports unknown when the tree cannot be read", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const missing = yield* Effect.promise(() => snapshotSource(root, "missing-godot"));
      expect(missing).toEqual({ kind: "unknown", reason: "io" });
    }),
  ),
);
