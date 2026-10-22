// @effect-diagnostics nodeBuiltinImport:off -- Rounds keep their store on a temporary native game tree.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GameReviewArtifact } from "@t3tools/contracts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameSnapshots from "./GameSnapshots.ts";
import { candidateBuildDirectory } from "./webBuild.ts";

const withGame = <A, E>(
  body: (input: {
    readonly root: string;
    readonly stateDir: string;
    readonly rounds: GameRoundStore.GameRoundStore["Service"];
    readonly snapshots: GameSnapshots.GameSnapshots["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-round-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), '{"name":"probe"}\n');
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
      });
      return yield* Effect.gen(function* () {
        const rounds = yield* GameRoundStore.GameRoundStore;
        const snapshots = yield* GameSnapshots.GameSnapshots;
        return yield* body({ root, stateDir, rounds, snapshots });
      }).pipe(
        Effect.provide(
          Layer.merge(GameRoundStore.layer({ stateDir }), GameSnapshots.layer({ stateDir })),
        ),
      );
    }),
  );

const edit = (root: string, contents: string) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), contents));

/** A candidate directory the store can name; promotion does not read its bytes. */
const candidate = async (root: string, sourceId: string): Promise<GameReviewArtifact> => {
  const buildId = NodeCrypto.createHash("sha256").update(sourceId).digest("hex");
  const directory = candidateBuildDirectory(buildId);
  await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, directory, "index.html"), "<html>candidate</html>");
  return {
    buildId,
    directory,
    sourceId,
    engine: "godot",
    target: "Web",
    entry: "index.html",
  };
};

it.live(
  "begin snapshots the source, promote switches the selected build, reject restores and drops it",
  () =>
    withGame(({ root, rounds, snapshots }) =>
      Effect.gen(function* () {
        const opened = yield* rounds.begin(root, {});
        expect(opened.status).toBe("running");
        expect(opened.incumbentBuildId).toBeNull();
        const incumbentSource = opened.incumbentSnapshotId;

        // The repair writes, then the server records what the child left.
        yield* edit(root, "extends Node2D # repaired\n");
        yield* rounds.recordPostRepair(root, opened.id);
        const repaired = yield* snapshots.capture(root);
        const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
        yield* rounds.recordCandidate(root, opened.id, build);

        const promoted = yield* rounds.promote(root, opened.id);
        expect(promoted.kind).toBe("promoted");
        const afterPromote = yield* rounds.read(root);
        expect(afterPromote.selected?.buildId).toBe(build.buildId);
        expect(afterPromote.rounds.find((round) => round.id === opened.id)?.status).toBe(
          "promoted",
        );

        // A second round is rejected: the source returns to its pre-round bytes
        // and the challenger directory is removed, while selection stays put.
        const second = yield* rounds.begin(root, {});
        yield* edit(root, "extends Node2D # worse\n");
        yield* rounds.recordPostRepair(root, second.id);
        const worse = yield* Effect.promise(() => candidate(root, second.incumbentSnapshotId));
        yield* rounds.recordCandidate(root, second.id, worse);
        const rejected = yield* rounds.reject(root, second.id);
        expect(rejected.kind).toBe("rejected");
        if (rejected.kind === "rejected") {
          expect(rejected.restored).toEqual(["godot/scripts/main.gd"]);
          expect(rejected.deleted).toEqual([]);
        }
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node2D # repaired\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, worse.directory)).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        const state = yield* rounds.read(root);
        expect(state.selected?.buildId).toBe(build.buildId);
        expect(state.rounds.find((round) => round.id === second.id)?.status).toBe("rejected");
        // The pre-repair snapshot remains available to a later restore action.
        expect((yield* snapshots.read(root, incumbentSource)).manifest.sourceId).toBe(
          incumbentSource,
        );
      }),
    ),
);

it.live("a user edit after the repair blocks the restore and keeps the snapshot", () =>
  withGame(({ root, rounds }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repaired\n");
      yield* rounds.recordPostRepair(root, first.id);
      const repaired = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
      );
      expect(repaired).toContain("repaired");
      const candidateBuild = yield* Effect.promise(() =>
        candidate(root, first.incumbentSnapshotId),
      );
      yield* rounds.recordCandidate(root, first.id, candidateBuild);
      // The creator edits the same file while the round is still open.
      yield* edit(root, "extends Node2D # the creator wrote this\n");
      const rejected = yield* rounds.reject(root, first.id);
      expect(rejected.kind).toBe("blocked");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node2D # the creator wrote this\n");
      const state = yield* rounds.read(root);
      expect(state.rounds.find((round) => round.id === first.id)?.status).toBe("stopped");
      // Nothing was promoted and the snapshot the user would restore from stays.
      expect(state.selected).toBeNull();
    }),
  ),
);

it.live("restart marks a running round interrupted and keeps the selected build", () =>
  withGame(({ root, stateDir, rounds, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repair\n");
      yield* rounds.recordPostRepair(root, first.id);
      const repaired = yield* snapshots.capture(root);
      const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, first.id, build);
      expect((yield* rounds.promote(root, first.id)).kind).toBe("promoted");

      const second = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # unfinished\n");
      yield* rounds.recordCandidate(
        root,
        second.id,
        yield* Effect.promise(() => candidate(root, second.incumbentSnapshotId)),
      );

      // A fresh store instance is the next server process.
      const restarted = yield* GameRoundStore.GameRoundStore.pipe(
        Effect.provide(GameRoundStore.layer({ stateDir })),
      );
      const state = yield* restarted.read(root);
      const interrupted = state.rounds.find((round) => round.id === second.id);
      expect(interrupted?.status).toBe("interrupted");
      expect(interrupted?.decision).toBe("interrupt");
      expect(state.selected?.buildId).toBe(build.buildId);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node2D # unfinished\n");
    }),
  ),
);
