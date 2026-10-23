// @effect-diagnostics nodeBuiltinImport:off -- Snapshot tests use real temporary source trees.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { comparedSource, snapshotBuildSource, type SourceSnapshot } from "./sourceSnapshot.ts";

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
  const snapshot = await snapshotBuildSource(root, "godot");
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

it.effect("ignores engine-generated sidecars and everything outside the engine project", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => knownId(root));
      // An import writes these beside real sources; one import must not make a
      // build look stale.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd.uid"), "uid:1\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/icon.svg.import"), "[remap]\n"),
      );
      // Design, briefs, notes and art sources are not export inputs.
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "art/blender"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), "# Design\n"),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "BRIEF.md"), "# Brief\n"));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "notes.md"), "# Notes\n"));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "art/blender/hero.blend"), "blend"),
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
      const bounded = yield* Effect.promise(() =>
        snapshotBuildSource(root, "godot", { maxEntries: 4 }),
      );
      expect(bounded).toEqual({ kind: "unknown", reason: "entry-limit" });
    }),
  ),
);

it.effect("reports unknown when the tree cannot be read", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const missing = yield* Effect.promise(() => snapshotBuildSource(root, "missing-godot"));
      expect(missing).toEqual({ kind: "unknown", reason: "io" });
    }),
  ),
);

it.effect("reports unknown instead of fresh when a linked input is found", () =>
  withTree((root) =>
    Effect.gen(function* () {
      const linked = NodePath.join(root, "linked.gd");
      yield* Effect.promise(() => NodeFSP.writeFile(linked, "extends Node\nvar from_link=1\n"));
      yield* Effect.promise(() => NodeFSP.symlink(linked, NodePath.join(root, "godot/smoke.gd")));
      const snapshot = yield* Effect.promise(() => snapshotBuildSource(root, "godot"));
      expect(snapshot.kind).toBe("unknown");
      if (snapshot.kind === "unknown") {
        expect(snapshot.reason).toBe("symlink");
        expect(snapshot.detail).toBe("godot/smoke.gd");
      }
      // Following the link would hide its content: the same tree with an edited
      // target must not look fresh.
      yield* Effect.promise(() => NodeFSP.writeFile(linked, "extends Node\nvar from_link=2\n"));
      const after = yield* Effect.promise(() => snapshotBuildSource(root, "godot"));
      expect(after.kind).toBe("unknown");
    }),
  ),
);

it.effect("an operation only claims sources that did not change while it ran", () =>
  Effect.sync(() => {
    const known = (sourceId: string): SourceSnapshot => ({ kind: "known", sourceId, entries: 1 });
    const unknown: SourceSnapshot = { kind: "unknown", reason: "entry-limit" };
    expect(comparedSource(known("a"), known("a"), "check")).toEqual({
      kind: "current",
      sourceId: "a",
    });
    // A mixed run and an unreadable input can never be current.
    const changed = comparedSource(known("a"), known("b"), "check");
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "current") expect(changed.detail).toContain("changed while the check ran");
    expect(comparedSource(unknown, known("a"), "check").kind).toBe("unknown");
    expect(comparedSource(known("a"), unknown, "check").kind).toBe("unknown");
  }),
);
