// @effect-diagnostics nodeBuiltinImport:off -- Snapshot tests exercise the real store on a temporary game tree.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameSnapshots from "./GameSnapshots.ts";

const withTree = <A, E>(
  body: (input: {
    readonly root: string;
    readonly stateDir: string;
    readonly snapshots: GameSnapshots.GameSnapshots["Service"];
  }) => Effect.Effect<A, E>,
  options: {
    readonly maxBytes?: number;
    readonly maxEntries?: number;
    readonly beforePath?:
      | ((operation: "delete" | "restore", path: string) => Promise<void>)
      | undefined;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-snapshot-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "godot/.godot"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/web"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, ".git"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), '{"name":"probe"}\n');
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.writeFile(NodePath.join(root, "godot/.godot/cache"), "generated");
        await NodeFSP.writeFile(NodePath.join(root, "builds/web/index.html"), "generated");
        await NodeFSP.writeFile(NodePath.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
        await NodeFSP.writeFile(NodePath.join(root, "art.blend1"), "backup");
      });
      return yield* Effect.gen(function* () {
        const snapshots = yield* GameSnapshots.GameSnapshots;
        return yield* body({ root, stateDir, snapshots });
      }).pipe(
        Effect.provide(
          GameSnapshots.layer({
            stateDir,
            ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
            ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
            ...(options.beforePath === undefined ? {} : { beforePath: options.beforePath }),
          }),
        ),
      );
    }),
  );

it.effect("a same-size edit in the same mtime tick still changes the source identity", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const before = yield* snapshots.capture(root);
      const path = NodePath.join(root, "godot/scripts/main.gd");
      const stat = yield* Effect.promise(() => NodeFSP.stat(path));
      // Same length, restored mtime: the legacy size/mtime identity cannot see
      // this, the content manifest must.
      const original = yield* Effect.promise(() => NodeFSP.readFile(path));
      const edited = Buffer.from(original);
      edited[edited.length - 2] = edited[edited.length - 2] === 0x41 ? 0x42 : 0x41;
      yield* Effect.promise(() => NodeFSP.writeFile(path, edited));
      yield* Effect.promise(() => NodeFSP.utimes(path, stat.atimeMs / 1000, stat.mtimeMs / 1000));
      const after = yield* snapshots.capture(root);
      expect(after.sourceId).not.toBe(before.sourceId);
      const comparison = yield* snapshots.compare(root, before);
      expect(comparison.kind).toBe("changed");
      if (comparison.kind === "changed")
        expect(comparison.modified).toEqual(["godot/scripts/main.gd"]);
    }),
  ),
);

it.effect("generated trees stay out of the manifest", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const manifest = yield* snapshots.capture(root);
      const paths = manifest.files.map((file) => file.path);
      expect(paths).toEqual(["game.json", "godot/scripts/main.gd"]);
    }),
  ),
);

it.effect("restores modified, added and deleted files and verifies the result", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const stored = yield* snapshots.store(root);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node2D\n");
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/extra.gd"), "extends Node\n");
        await NodeFSP.rm(NodePath.join(root, "game.json"));
      });
      const changed = yield* snapshots.capture(root);
      const restored = yield* snapshots.restore(root, stored.manifest, {
        expectSourceId: changed.sourceId,
      });
      expect(restored.kind).toBe("restored");
      if (restored.kind !== "restored") return;
      expect(restored.restored).toEqual(
        expect.arrayContaining(["game.json", "godot/scripts/main.gd"]),
      );
      expect(restored.deleted).toEqual(["godot/scripts/extra.gd"]);
      const after = yield* snapshots.capture(root);
      expect(after.sourceId).toBe(stored.manifest.sourceId);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")),
      ).toBe('{"name":"probe"}\n');
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(root, "godot/scripts/extra.gd")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ),
);

it.effect("a folder changed after the expected manifest is never restored", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const stored = yield* snapshots.store(root);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "user edit\n"),
      );
      const blocked = yield* snapshots.restore(root, stored.manifest, {
        expectSourceId: stored.manifest.sourceId,
      });
      expect(blocked.kind).toBe("blocked");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("user edit\n");
    }),
  ),
);

it.effect("an identical snapshot is stored once", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* snapshots.store(root);
      const second = yield* snapshots.store(root);
      expect(second.manifest.sourceId).toBe(first.manifest.sourceId);
      expect(second.directory).toBe(first.directory);
      const entries = yield* Effect.promise(() => NodeFSP.readdir(first.directory));
      expect(entries.sort()).toEqual(["files", "manifest.json"]);
    }),
  ),
);

it.effect("symlinks fail closed instead of reading outside the tree", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(root, "game.json"), NodePath.join(root, "link.json")),
      );
      const linked = yield* Effect.result(snapshots.capture(root));
      expect(linked._tag).toBe("Failure");
      if (linked._tag === "Failure") expect(linked.failure.reason).toBe("invalid-path");
    }),
  ),
);

it.effect("a tree past the byte bound is rejected rather than truncated", () =>
  withTree(
    ({ root, snapshots }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(snapshots.store(root));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid-input");
      }),
    { maxBytes: 8 },
  ),
);

it.effect("an edit between the tree read and a path's mutation blocks that path", () => {
  let edited = false;
  return withTree(
    ({ root, snapshots }) =>
      Effect.gen(function* () {
        const stored = yield* snapshots.store(root);
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "repair\n");
          await NodeFSP.rm(NodePath.join(root, "game.json"));
        });
        const changed = yield* snapshots.capture(root);
        const restored = yield* snapshots.restore(root, stored.manifest, {
          expectSourceId: changed.sourceId,
          beforePath: async (operation, path) => {
            if (operation !== "restore" || path !== "game.json" || edited) return;
            edited = true;
            // The entrance capture saw "repair"; this edit lands before the
            // later file's verification, so restore must stop, not overwrite it.
            await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "user edit\n");
          },
        });
        expect(restored.kind).toBe("blocked");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("user edit\n");
      }),
    {},
  );
});

it.effect("a file that becomes a symlink before its mutation blocks the restore", () => {
  let swapped = false;
  return withTree(
    ({ root, snapshots }) =>
      Effect.gen(function* () {
        const stored = yield* snapshots.store(root);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "godot/scripts/extra.gd"), "repair extra\n"),
        );
        const changed = yield* snapshots.capture(root);
        const restored = yield* snapshots.restore(root, stored.manifest, {
          expectSourceId: changed.sourceId,
          beforePath: async (operation, path) => {
            if (operation !== "delete" || path !== "godot/scripts/extra.gd" || swapped) return;
            swapped = true;
            await NodeFSP.rm(NodePath.join(root, path));
            await NodeFSP.symlink(NodePath.join(root, "game.json"), NodePath.join(root, path));
          },
        });
        expect(restored.kind).toBe("blocked");
        if (restored.kind === "blocked") expect(restored.detail).toContain("symlink");
      }),
    {},
  );
});

it.effect("a file the repair turned into a directory is restored over the empty directory", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const stored = yield* snapshots.store(root);
      yield* Effect.promise(async () => {
        // game.json (a file in the snapshot) became a directory holding a new file.
        await NodeFSP.rm(NodePath.join(root, "game.json"));
        await NodeFSP.mkdir(NodePath.join(root, "game.json"));
        await NodeFSP.writeFile(NodePath.join(root, "game.json/repair.txt"), "new\n");
      });
      const changed = yield* snapshots.capture(root);
      const restored = yield* snapshots.restore(root, stored.manifest, {
        expectSourceId: changed.sourceId,
      });
      expect(restored.kind).toBe("restored");
      if (restored.kind === "restored") expect(restored.deleted).toEqual(["game.json/repair.txt"]);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")),
      ).toBe('{"name":"probe"}\n');
      const after = yield* snapshots.capture(root);
      expect(after.sourceId).toBe(stored.manifest.sourceId);
    }),
  ),
);

it.effect("empty directories the repair created are removed before restoring files", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const stored = yield* snapshots.store(root);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts/scratch/deep"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/scripts/scratch/deep/temp.gd"),
          "repair\n",
        );
      });
      const changed = yield* snapshots.capture(root);
      const restored = yield* snapshots.restore(root, stored.manifest, {
        expectSourceId: changed.sourceId,
      });
      expect(restored.kind).toBe("restored");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(root, "godot/scripts/scratch")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  ),
);

it.effect("a directory the repair deleted is recreated before the snapshot file is written", () =>
  withTree(({ root, snapshots }) =>
    Effect.gen(function* () {
      const stored = yield* snapshots.store(root);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(root, "godot/scripts"), { recursive: true, force: true }),
      );
      const changed = yield* snapshots.capture(root);
      const restored = yield* snapshots.restore(root, stored.manifest, {
        expectSourceId: changed.sourceId,
      });
      expect(restored.kind).toBe("restored");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node\n");
    }),
  ),
);

it.effect(
  "a parent replaced by a symlink blocks the write and leaves the outside file alone",
  () => {
    let swapped = false;
    return withTree(
      ({ root, snapshots }) =>
        Effect.gen(function* () {
          const stored = yield* snapshots.store(root);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "repair\n"),
          );
          const changed = yield* snapshots.capture(root);
          const outside = NodePath.join(root, "..", "outside-scripts");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "repair\n"),
          );
          const restored = yield* snapshots.restore(root, stored.manifest, {
            expectSourceId: changed.sourceId,
            beforePath: async (operation, path) => {
              if (operation !== "restore" || path !== "godot/scripts/main.gd" || swapped) return;
              swapped = true;
              // Same bytes as the current file, so content verification passes and
              // only the parent check can stop the write.
              await NodeFSP.mkdir(outside, { recursive: true });
              await NodeFSP.writeFile(NodePath.join(outside, "main.gd"), "repair\n");
              await NodeFSP.rename(
                NodePath.join(root, "godot/scripts"),
                NodePath.join(root, "godot/scripts-original"),
              );
              await NodeFSP.symlink(outside, NodePath.join(root, "godot/scripts"));
            },
          });
          expect(restored.kind).toBe("blocked");
          if (restored.kind === "blocked")
            expect(restored.detail).toContain("not a real directory");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(outside, "main.gd"), "utf8"),
            ),
          ).toBe("repair\n");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.lstat(NodePath.join(root, "godot/scripts")).then((stat) =>
                stat.isSymbolicLink(),
              ),
            ),
          ).toBe(true);
        }),
      {},
    );
  },
);

it.effect("a parent symlink blocks deleting an added file outside the game", () => {
  let swapped = false;
  return withTree(
    ({ root, snapshots }) =>
      Effect.gen(function* () {
        const stored = yield* snapshots.store(root);
        const outside = NodePath.join(root, "..", "outside-added");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "godot/extra"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, "godot/extra/temp.gd"), "repair\n");
          await NodeFSP.mkdir(outside, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(outside, "temp.gd"), "repair\n");
        });
        const changed = yield* snapshots.capture(root);
        const restored = yield* snapshots.restore(root, stored.manifest, {
          expectSourceId: changed.sourceId,
          beforePath: async (operation, path) => {
            if (operation !== "delete" || path !== "godot/extra/temp.gd" || swapped) return;
            swapped = true;
            await NodeFSP.rename(
              NodePath.join(root, "godot/extra"),
              NodePath.join(root, "godot/extra-real"),
            );
            await NodeFSP.symlink(outside, NodePath.join(root, "godot/extra"));
          },
        });
        expect(restored.kind).toBe("blocked");
        if (restored.kind === "blocked") expect(restored.detail).toContain("not a real directory");
        // The file the symlink pointed at is untouched.
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(outside, "temp.gd"), "utf8")),
        ).toBe("repair\n");
      }),
    {},
  );
});
