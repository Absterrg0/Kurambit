// @effect-diagnostics nodeBuiltinImport:off -- Rounds keep their store on a temporary native game tree.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
        // while selection stays put. Its challenger has the same content-addressed
        // identity as the selected build, so rejecting it must not delete the
        // directory Play is serving.
        const second = yield* rounds.begin(root, {});
        yield* edit(root, "extends Node2D # worse\n");
        yield* rounds.recordPostRepair(root, second.id);
        const worse = yield* Effect.promise(() => candidate(root, second.incumbentSnapshotId));
        expect(worse.directory).toBe(build.directory);
        yield* rounds.recordCandidate(root, second.id, worse);
        const rejected = yield* rounds.reject(root, second.id);
        expect(rejected.kind).toBe("rejected");
        if (rejected.kind === "rejected") {
          expect(rejected.restored).toEqual(["godot/scripts/main.gd"]);
          expect(rejected.deleted).toEqual([]);
          expect(rejected.discarded).toEqual([]);
        }
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node2D # repaired\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, build.directory, "index.html"), "utf8"),
          ),
        ).toContain("candidate");
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

it.live("a promotion blocked by a source change stops the round and keeps the candidate", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repaired\n");
      yield* rounds.recordPostRepair(root, first.id);
      const repaired = yield* snapshots.capture(root);
      const incumbent = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, first.id, incumbent);
      expect((yield* rounds.promote(root, first.id)).kind).toBe("promoted");
      const selectedBefore = (yield* rounds.read(root)).selected;

      const second = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # contender\n");
      yield* rounds.recordPostRepair(root, second.id);
      const contenderSource = yield* snapshots.capture(root);
      const contender = yield* Effect.promise(() => candidate(root, contenderSource.sourceId));
      yield* rounds.recordCandidate(root, second.id, contender);
      // The creator edits the folder after the repair was recorded.
      yield* edit(root, "extends Node2D # user edit\n");

      const blocked = yield* rounds.promote(root, second.id);
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") return;
      expect(blocked.round.status).toBe("stopped");
      expect(blocked.round.decision).toBe("stop");
      expect(blocked.round.reason).toContain("source-changed");
      // Nothing was restored or discarded, and selection did not move.
      expect(blocked.round.candidate?.buildId).toBe(contender.buildId);
      const state = yield* rounds.read(root);
      expect(state.selected?.buildId).toBe(selectedBefore?.buildId);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node2D # user edit\n");
    }),
  ),
);

it.live("an identical candidate is never deleted out from under the selected build", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const opened = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repair\n");
      yield* rounds.recordPostRepair(root, opened.id);
      const repaired = yield* snapshots.capture(root);
      const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, opened.id, build);
      expect((yield* rounds.promote(root, opened.id)).kind).toBe("promoted");

      const second = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # no-op repair\n");
      yield* rounds.recordPostRepair(root, second.id);
      // Content addressing makes this the selected directory: a no-op repair.
      const identical = yield* Effect.promise(() => candidate(root, build.sourceId!));
      expect(identical.directory).toBe(build.directory);
      yield* rounds.recordCandidate(root, second.id, identical);
      const rejected = yield* rounds.reject(root, second.id);
      expect(rejected.kind).toBe("rejected");
      if (rejected.kind !== "rejected") return;
      expect(rejected.discarded).toEqual([]);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, build.directory, "index.html"), "utf8"),
        ),
      ).toContain("candidate");
      const state = yield* rounds.read(root);
      expect(state.selected?.directory).toBe(build.directory);
    }),
  ),
);

it.live("stopping a round persists a terminal record and leaves the folder alone", () =>
  withGame(({ root, rounds }) =>
    Effect.gen(function* () {
      const opened = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # in flight\n");
      const stopped = yield* rounds.stopRunning(root, "The creator superseded the round.");
      expect(stopped.map((round) => round.id)).toEqual([opened.id]);
      expect(stopped[0]?.status).toBe("stopped");
      expect(stopped[0]?.decision).toBe("stop");
      expect(stopped[0]?.reason).toBe("The creator superseded the round.");
      const state = yield* rounds.read(root);
      expect(state.rounds.find((round) => round.id === opened.id)?.status).toBe("stopped");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node2D # in flight\n");
    }),
  ),
);

it.live(
  "an explicit restore stops the round, keeps the replaced version, and discards only its candidate",
  () =>
    withGame(({ root, rounds, snapshots }) =>
      Effect.gen(function* () {
        const opened = yield* rounds.begin(root, {});
        const original = yield* snapshots.capture(root);
        yield* edit(root, "extends Node2D # repair\n");
        yield* rounds.recordPostRepair(root, opened.id);
        const repairedSource = yield* snapshots.capture(root);
        const build = yield* Effect.promise(() => candidate(root, repairedSource.sourceId));
        yield* rounds.recordCandidate(root, opened.id, build);

        const restored = yield* rounds.restore(root, opened.id);
        expect(restored.kind).toBe("restored");
        if (restored.kind !== "restored") return;
        // The version that was replaced is preserved for a later restore.
        expect(restored.preservedSnapshotId).toBe(repairedSource.sourceId);
        expect((yield* snapshots.read(root, restored.preservedSnapshotId)).manifest.sourceId).toBe(
          repairedSource.sourceId,
        );
        expect(restored.restored).toEqual(["godot/scripts/main.gd"]);
        expect(restored.discarded).toEqual([build.directory]);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node\n");
        const after = yield* snapshots.capture(root);
        expect(after.sourceId).toBe(original.sourceId);
        const state = yield* rounds.read(root);
        expect(state.rounds.find((round) => round.id === opened.id)?.preRestoreSnapshotId).toBe(
          repairedSource.sourceId,
        );
      }),
    ),
);

it.live(
  "an explicit restore refuses an edit made after the replaced version was preserved",
  () =>
    withGame(({ root, rounds, snapshots }) =>
      Effect.gen(function* () {
        const opened = yield* rounds.begin(root, {});
        yield* edit(root, "extends Node2D # repair\n");
        yield* rounds.recordPostRepair(root, opened.id);

        const restored = yield* rounds.restore(root, opened.id, {
          beforeRestore: async () => {
            // A user edit lands between preservation and the restore's read.
            await NodeFSP.writeFile(
              NodePath.join(root, "godot/scripts/main.gd"),
              "extends Node2D # user edit\n",
            );
          },
        });
        expect(restored.kind).toBe("blocked");
        if (restored.kind === "blocked") expect(restored.detail).toContain("changed");
        // The edit was never overwritten by the older incumbent.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
          ),
        ).toBe("extends Node2D # user edit\n");
        // It was still preserved as the version a later restore can return to.
        const state = yield* rounds.read(root);
        const stopped = state.rounds.find((entry) => entry.id === opened.id)!;
        expect(stopped.status).toBe("stopped");
        expect(stopped.preRestoreSnapshotId).not.toBeNull();
        expect(
          (yield* snapshots.read(root, stopped.preRestoreSnapshotId!)).manifest.files.map(
            (file) => file.path,
          ),
        ).toContain("godot/scripts/main.gd");
      }),
    ),
);

it.live("an explicit restore refuses while another round is running", () =>
  withGame(({ root, rounds }) =>
    Effect.gen(function* () {
      const older = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # older repair\n");
      yield* rounds.recordPostRepair(root, older.id);
      yield* rounds.stop(root, older.id, "The creator stepped away from this repair.");
      const newer = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # newer repair\n");

      const restored = yield* rounds.restore(root, older.id);
      expect(restored.kind).toBe("busy");
      if (restored.kind === "busy") expect(restored.owner.id).toBe(newer.id);
      // The newer round still owns the folder and its bytes are untouched.
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node2D # newer repair\n");
      const state = yield* rounds.read(root);
      expect(state.rounds.find((entry) => entry.id === newer.id)?.status).toBe("running");
      expect(state.rounds.find((entry) => entry.id === older.id)?.status).toBe("stopped");
    }),
  ),
);

it.live("concurrent promote and reject never leave a half-decided round", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const incumbent = yield* snapshots.capture(root);
      const opened = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # contender\n");
      yield* rounds.recordPostRepair(root, opened.id);
      const repaired = yield* snapshots.capture(root);
      const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, opened.id, build);

      yield* Effect.all(
        [
          Effect.result(rounds.promote(root, opened.id)),
          Effect.result(rounds.reject(root, opened.id)),
        ],
        { concurrency: "unbounded" },
      );
      const state = yield* rounds.read(root);
      const round = state.rounds.find((entry) => entry.id === opened.id)!;
      expect(["promoted", "rejected"]).toContain(round.status);
      const current = yield* snapshots.capture(root);
      if (round.status === "promoted") {
        expect(state.selected?.buildId).toBe(build.buildId);
        expect(current.sourceId).toBe(repaired.sourceId);
      } else {
        expect(state.selected).toBeNull();
        expect(current.sourceId).toBe(incumbent.sourceId);
      }
    }),
  ),
);

it.live(
  "an interrupt while a round transition runs leaves one complete state, never a partial one",
  () =>
    withGame(({ root, rounds, snapshots }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 40; index += 1)
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, `godot/scripts/extra_${index}.gd`),
              "extends Node\n",
            ),
          );
        const opened = yield* rounds.begin(root, {});
        yield* Effect.promise(async () => {
          for (let index = 0; index < 40; index += 1)
            await NodeFSP.writeFile(
              NodePath.join(root, `godot/scripts/extra_${index}.gd`),
              "extends Node # repaired\n",
            );
        });
        yield* rounds.recordPostRepair(root, opened.id);
        const repaired = yield* snapshots.capture(root);
        const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
        yield* rounds.recordCandidate(root, opened.id, build);

        // The interrupt either lands before the transition starts (folder stays
        // as the repair left it) or waits for it to finish (incumbent restored).
        const fiber = yield* rounds.reject(root, opened.id).pipe(Effect.forkChild);
        yield* Fiber.interrupt(fiber);
        const state = yield* rounds.read(root);
        const round = state.rounds.find((entry) => entry.id === opened.id)!;
        const current = yield* snapshots.capture(root);
        // A running round means the cancel arrived before the transition began;
        // the folder must still be exactly what the repair left.
        if (round.status === "rejected") expect(current.sourceId).toBe(opened.incumbentSnapshotId);
        else {
          expect(round.status).toBe("running");
          expect(current.sourceId).toBe(repaired.sourceId);
        }
      }),
    ),
);
