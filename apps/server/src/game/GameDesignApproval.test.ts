// @effect-diagnostics nodeBuiltinImport:off -- Approval records and snapshots live on the native filesystem.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type { GameManifest } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";

const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Snapshot game",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  gameplayScene: "res://scenes/game.tscn",
  probe: true,
  design: { status: "draft" },
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

it.effect("returns one document snapshot with the hash the Design tab submits", () =>
  Effect.gen(function* () {
    const base = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-snapshot-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const root = NodePath.join(base, "game");
    const stateDir = NodePath.join(base, "state");
    yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
    const design = "# Snapshot game\n\nA real design paragraph that is long enough to read.\n";
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design));
    yield* Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const read = yield* approvals.status(root, manifest);
      expect(read.document).toBe(design);
      expect(read.documentTruncated).toBe(false);
      expect(read.currentHash).toBe(GameDesignApproval.designDocumentHash(design));
    }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })));

    // A document too large to show cannot be approved from a partial snapshot.
    const huge = `# Huge\n\n${"x".repeat(GameDesignApproval.DESIGN_DOCUMENT_LIMIT)}\n`;
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), huge));
    yield* Effect.gen(function* () {
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const read = yield* approvals.status(root, manifest);
      expect(read.documentTruncated).toBe(true);
      expect(read.currentHash).toBeNull();
      expect(read.document?.length).toBe(GameDesignApproval.DESIGN_DOCUMENT_LIMIT);
      expect(read.issues.join(" ")).toContain("larger than 64 KB");
    }).pipe(Effect.provide(GameDesignApproval.layer({ stateDir })));
  }),
);

it.effect("normalizes an approved record that used the old end kind", () =>
  Effect.gen(function* () {
    const base = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "design-record-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const root = NodePath.join(base, "game");
    const stateDir = NodePath.join(base, "state");
    yield* Effect.promise(() => NodeFSP.mkdir(root, { recursive: true }));
    const file = GameDesignApproval.approvalRecordFile(stateDir, root);
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          game: NodePath.resolve(root),
          approvalId: "old-approval",
          designHash: "a".repeat(64),
          approvedAt: "2026-10-01T00:00:00.000Z",
          acceptance: [
            {
              id: "reach-summit",
              kind: "end",
              text: "The run ends at the summit",
              observe: { key: "state", expect: "==3" },
            },
          ],
        }),
      );
    });
    const record = yield* Effect.promise(() => GameDesignApproval.readDesignApprovalRecord(file));
    expect(record?.acceptance).toEqual([
      {
        id: "reach-summit",
        kind: "win",
        text: "The run ends at the summit",
        observe: { key: "state", expect: "==3" },
      },
    ]);
  }),
);
