// @effect-diagnostics nodeBuiltinImport:off -- Rounds keep their store on a temporary native game tree.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ProviderInstanceId, RunId, type GameReviewArtifact } from "@t3tools/contracts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameSnapshots from "./GameSnapshots.ts";
import { candidateBuildDirectory, hashWebBuildDirectory } from "./webBuild.ts";

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
        await NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            name: "probe",
            brief: "A probe game.",
            artDirection: "Plain.",
            engine: { name: "godot", version: "4.7.2" },
            godotProject: "godot",
            assets: [],
          })}\n`,
        );
        await NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), "# Probe design\n");
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

let candidateBuilds = 0;
/**
 * A candidate build whose directory name is the hash of its bytes, the way an
 * export seals one. `contents` lets a test ask for the same bytes twice, which
 * is how a no-op repair addresses the selected build.
 */
const candidate = async (
  root: string,
  sourceId: string,
  contents?: string,
): Promise<GameReviewArtifact> => {
  candidateBuilds += 1;
  const staging = NodePath.join(root, "builds/candidates", `.staging-${candidateBuilds}`);
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(staging, "index.html"),
    contents ?? `<html>candidate ${candidateBuilds}</html>`,
  );
  const hashed = await hashWebBuildDirectory(staging);
  if (hashed === null) throw new Error("The test candidate build did not hash.");
  const directory = candidateBuildDirectory(hashed.buildId);
  const final = NodePath.join(root, directory);
  const existing = await NodeFSP.stat(NodePath.join(final, "index.html")).then(
    () => true,
    () => false,
  );
  if (existing) await NodeFSP.rm(staging, { recursive: true, force: true });
  else await NodeFSP.rename(staging, final);
  return {
    buildId: hashed.buildId,
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
        // Same bytes as the selected build: content addressing makes this a
        // no-op repair naming the directory Play already serves.
        const worse = yield* Effect.promise(async () =>
          candidate(
            root,
            second.incumbentSnapshotId,
            await NodeFSP.readFile(NodePath.join(root, build.directory, "index.html"), "utf8"),
          ),
        );
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

it.live("consecutive rejections restore the selected source manifest before the next round", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const initial = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # selected\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/roof_rim.gd"), "extends Node2D\n"),
      );
      const incumbent = yield* snapshots.store(root);
      yield* rounds.recordPostRepair(root, initial.id);
      const build = yield* Effect.promise(() => candidate(root, incumbent.manifest.sourceId));
      yield* rounds.recordCandidate(root, initial.id, build);
      expect((yield* rounds.promote(root, initial.id)).kind).toBe("promoted");

      for (const suffix of ["round 2", "round 3"]) {
        const round = yield* rounds.begin(root, {});
        expect(round.incumbentSnapshotId).toBe(incumbent.manifest.sourceId);
        expect(yield* snapshots.capture(root)).toEqual(incumbent.manifest);
        yield* edit(root, `extends Node2D # rejected ${suffix}\n`);
        yield* Effect.promise(async () => {
          await NodeFSP.rm(NodePath.join(root, "godot/scripts/roof_rim.gd"));
          await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/rejected.gd"), suffix);
        });
        const rejectedSource = yield* snapshots.store(root);
        yield* rounds.recordPostRepair(root, round.id);
        yield* rounds.recordCandidate(
          root,
          round.id,
          yield* Effect.promise(() => candidate(root, rejectedSource.manifest.sourceId)),
        );
        expect((yield* rounds.reject(root, round.id)).kind).toBe("rejected");
        expect(yield* snapshots.capture(root)).toEqual(incumbent.manifest);
        expect((yield* rounds.read(root)).selected?.sourceId).toBe(incumbent.manifest.sourceId);
        // Export provenance still names the repair; it is not the folder manifest.
        expect((yield* snapshots.read(root, rejectedSource.manifest.sourceId)).manifest).toEqual(
          rejectedSource.manifest,
        );
      }
      const next = yield* rounds.begin(root, {});
      expect(next.incumbentSnapshotId).toBe(incumbent.manifest.sourceId);
      expect(yield* snapshots.capture(root)).toEqual(incumbent.manifest);
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

it.live("a design-doc edit after the export does not block the promotion", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repaired\n");
      yield* rounds.recordPostRepair(root, first.id);
      // The export freezes the sources it builds from; those are the build inputs.
      const frozen = yield* snapshots.store(root);
      const build = yield* Effect.promise(() => candidate(root, frozen.manifest.sourceId));
      yield* rounds.recordCandidate(root, first.id, build);
      // The repair child updates its plan after the export. The folder identity
      // moves, but every engine source is byte-identical, so the bytes the
      // candidate will serve are still the ones a rebuild would produce.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), "# Plan after the export\n"),
      );
      expect((yield* snapshots.capture(root)).sourceId).not.toBe(frozen.manifest.sourceId);

      const promoted = yield* rounds.promote(root, first.id);
      expect(promoted.kind).toBe("promoted");
      const round = (yield* rounds.read(root)).rounds.find((entry) => entry.id === first.id);
      expect(round?.status).toBe("promoted");
      expect((yield* rounds.read(root)).selected?.buildId).toBe(build.buildId);
    }),
  ),
);

it.live("an engine-source edit after the export still blocks the promotion", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repaired\n");
      yield* rounds.recordPostRepair(root, first.id);
      const frozen = yield* snapshots.store(root);
      const build = yield* Effect.promise(() => candidate(root, frozen.manifest.sourceId));
      yield* rounds.recordCandidate(root, first.id, build);
      yield* edit(root, "extends Node2D # edited after the export\n");

      const blocked = yield* rounds.promote(root, first.id);
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") return;
      expect(blocked.round.reason).toContain("source-changed");
      expect((yield* rounds.read(root)).selected).toBeNull();
    }),
  ),
);

it.live("a restart marks a running round interrupted and keeps the selected build", () =>
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

it.live("a restart interrupts the round and keeps its frozen selections", () =>
  withGame(({ root, stateDir, snapshots }) =>
    Effect.gen(function* () {
      const selection = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode-go/deepseek-v4.1-flash",
      } as const;
      const first = yield* GameRoundStore.GameRoundStore.pipe(
        Effect.provide(GameRoundStore.layer({ stateDir })),
      );
      const opened = yield* first.begin(root, {
        loopId: "loop-1",
        builderSelection: selection,
        reviewSelection: selection,
        defects: [],
        doNotRegress: [],
      });
      expect(opened.loopId).toBe("loop-1");
      expect(opened.builderSelection?.model).toBe(selection.model);
      yield* edit(root, "extends Node2D # repair\n");
      yield* first.recordPostRepair(root, opened.id);

      const restarted = yield* GameRoundStore.GameRoundStore.pipe(
        Effect.provide(GameRoundStore.layer({ stateDir })),
      );
      const state = yield* restarted.read(root);
      const round = state.rounds.find((entry) => entry.id === opened.id);
      expect(round?.status).toBe("interrupted");
      expect(round?.builderSelection?.model).toBe(selection.model);
      // The restart abandons the round; there is no resume to reopen bytes the
      // round never saw, and the user edit stays untouched.
      expect((yield* snapshots.capture(root)).sourceId).not.toBe(opened.postRepairSourceId);
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

it.live("a candidate whose bytes changed after export is not promoted", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const first = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repaired\n");
      yield* rounds.recordPostRepair(root, first.id);
      const repaired = yield* snapshots.capture(root);
      const incumbent = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, first.id, incumbent);
      expect((yield* rounds.promote(root, first.id)).kind).toBe("promoted");

      const second = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # contender\n");
      yield* rounds.recordPostRepair(root, second.id);
      const contenderSource = yield* snapshots.capture(root);
      const contender = yield* Effect.promise(() => candidate(root, contenderSource.sourceId));
      yield* rounds.recordCandidate(root, second.id, contender);
      // The candidate was sealed by its export, then a file changed on disk.
      // Its directory no longer hashes to its name, so it is not the build the
      // export produced and must not become Play's.
      yield* Effect.promise(() =>
        NodeFSP.appendFile(
          NodePath.join(root, contender.directory, "index.html"),
          "<!-- edited after export -->",
        ),
      );

      const blocked = yield* rounds.promote(root, second.id);
      expect(blocked.kind).toBe("blocked");
      if (blocked.kind !== "blocked") return;
      expect(blocked.round.status).toBe("stopped");
      expect(blocked.round.decision).toBe("stop");
      expect(blocked.round.reason).toContain("artifact-changed");
      // Selection stayed on the incumbent and the candidate record is kept.
      const state = yield* rounds.read(root);
      expect(state.selected?.buildId).toBe(incumbent.buildId);
      expect(state.rounds.find((entry) => entry.id === second.id)?.candidate?.buildId).toBe(
        contender.buildId,
      );
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
      const identical = yield* Effect.promise(async () =>
        candidate(
          root,
          build.sourceId!,
          await NodeFSP.readFile(NodePath.join(root, build.directory, "index.html"), "utf8"),
        ),
      );
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

it.live("an explicit restore refuses an edit made after the replaced version was preserved", () =>
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
      // It was still preserved as the version a later restore can return to —
      // the repair's bytes, taken before the user edit landed, not just its path.
      const state = yield* rounds.read(root);
      const stopped = state.rounds.find((entry) => entry.id === opened.id)!;
      expect(stopped.status).toBe("stopped");
      expect(stopped.preRestoreSnapshotId).not.toBeNull();
      const preserved = yield* snapshots.read(root, stopped.preRestoreSnapshotId!);
      expect(preserved.manifest.files.map((file) => file.path)).toContain("godot/scripts/main.gd");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(preserved.directory, "files/godot/scripts/main.gd"),
            "utf8",
          ),
        ),
      ).toBe("extends Node2D # repair\n");
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

it.live("a promotion whose folder capture fails stops the round with the reason", () =>
  withGame(({ root, rounds, snapshots }) =>
    Effect.gen(function* () {
      const opened = yield* rounds.begin(root, {});
      yield* edit(root, "extends Node2D # repair\n");
      yield* rounds.recordPostRepair(root, opened.id);
      const repaired = yield* snapshots.capture(root);
      const build = yield* Effect.promise(() => candidate(root, repaired.sourceId));
      yield* rounds.recordCandidate(root, opened.id, build);
      // A symlink introduced after the candidate exists makes the folder
      // unreadable to the byte capture.
      yield* Effect.promise(() =>
        NodeFSP.symlink(
          NodePath.join(root, "game.json"),
          NodePath.join(root, "godot/scripts/link.gd"),
        ),
      );
      const promoted = yield* rounds.promote(root, opened.id);
      expect(promoted.kind).toBe("blocked");
      const state = yield* rounds.read(root);
      const round = state.rounds.find((entry) => entry.id === opened.id)!;
      expect(round.status).toBe("stopped");
      expect(round.decision).toBe("stop");
      expect(round.reason).toContain("symlink");
      // The decision kept everything the round had.
      expect(state.selected).toBeNull();
      expect(round.candidate?.buildId).toBe(build.buildId);
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

it.live("keeps one submission per run beside the review state", () =>
  withGame(({ root, rounds }) =>
    Effect.gen(function* () {
      const builder = RunId.make("run:builder");
      const repair = RunId.make("run:repair");
      const submission = (runId: typeof builder, note: string, letter: string) => ({
        runId,
        buildId: letter.repeat(64),
        note,
        submittedAt: "2026-10-23T12:00:00.000Z",
      });
      yield* rounds.recordSubmission(root, submission(builder, "The game.", "a"));
      yield* rounds.recordSubmission(root, submission(repair, "Fixed the HUD.", "b"));
      // A resubmit in the same run replaces its declaration rather than adding
      // a second origin for one turn.
      yield* rounds.recordSubmission(root, submission(builder, "The revised game.", "c"));
      const state = yield* rounds.read(root);
      expect(state.submissions?.map((entry) => [String(entry.runId), entry.note])).toEqual([
        [String(repair), "Fixed the HUD."],
        [String(builder), "The revised game."],
      ]);
      expect(state.submissions?.map((entry) => entry.buildId)).toEqual([
        "b".repeat(64),
        "c".repeat(64),
      ]);
    }),
  ),
);

it.live("old facet-only ballot history stays readable without inventing an overall decision", () =>
  withGame(({ root, stateDir, rounds, snapshots }) =>
    Effect.gen(function* () {
      const source = yield* snapshots.capture(root);
      const build = yield* Effect.promise(() => candidate(root, source.sourceId));
      yield* rounds.select(root, build);
      const round = yield* rounds.begin(root);
      yield* rounds.recordReview(root, round.id, {
        ballotAnswers: [
          {
            order: 0,
            outcome: "valid",
            answer: {
              main: { works: "A", look: "tie", feel: "tie", play: "tie" },
              preservation: [{ id: "turns", A: "preserved", B: "unknown", frameIds: ["f1"] }],
              control: { works: "tie", look: "tie", feel: "tie", play: "tie" },
              reason: "Captured before overall judgments existed.",
            },
          },
        ],
      });
      yield* rounds.stop(root, round.id, "Historical review.");
      const restarted = yield* GameRoundStore.GameRoundStore.pipe(
        Effect.provide(GameRoundStore.layer({ stateDir })),
      );
      const reopened = yield* restarted.read(root);
      expect(reopened.selected?.buildId).toBe(build.buildId);
      const ballot = reopened.rounds[0]?.ballotAnswers?.[0]?.answer;
      expect(ballot?.overall).toBeUndefined();
      expect(ballot?.main.works).toBe("A");
      expect(ballot?.preservation[0]?.B).toBe("unknown");
      expect(ballot?.reason).toBe("Captured before overall judgments existed.");
    }),
  ),
);
