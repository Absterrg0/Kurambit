// @effect-diagnostics nodeBuiltinImport:off -- Qualification tests use real temporary game and state directories.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as GameQualificationService from "./GameQualification.ts";
import {
  qualificationRecordPath,
  type QualificationRecordInput,
  type RecordedQualificationStage,
} from "./GameQualification.ts";
import { snapshotSource } from "./sourceSnapshot.ts";

const withGame = <A, E>(
  options: { readonly maxSourceEntries?: number },
  run: (input: {
    readonly root: string;
    readonly stateDir: string;
    readonly qualification: GameQualificationService.GameQualification["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "qualification-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n"),
      );
      return yield* Effect.gen(function* () {
        const qualification = yield* GameQualificationService.GameQualification;
        return yield* run({ root, stateDir, qualification });
      }).pipe(
        Effect.provide(
          GameQualificationService.layer({
            stateDir,
            maxSourceEntries: options.maxSourceEntries,
          }),
        ),
      );
    }),
  );

const sourceIdOf = async (root: string) => {
  const snapshot = await snapshotSource(root, "godot");
  if (snapshot.kind !== "known") throw new Error("Fixture sources should be known");
  return snapshot.sourceId;
};

const passed = (
  stage: RecordedQualificationStage,
  buildId: string | null,
  evidenceDirectory: string | null = null,
): QualificationRecordInput => ({
  stage,
  outcome: "passed",
  sourceId: null,
  buildId,
  evidenceDirectory,
});

const recordAll = (
  qualification: GameQualificationService.GameQualification["Service"],
  root: string,
  sourceId: string,
  buildId: string,
) =>
  Effect.gen(function* () {
    for (const input of [
      passed("check", null),
      passed("test", null),
      passed("export", buildId),
      passed("playtest", buildId, "builds/playtests/run-1"),
    ])
      yield* qualification.record(root, { ...input, sourceId });
  });

it.effect("starts unqualified, with every stage missing and later stages never passed", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const read = yield* qualification.read(root, "godot");
      expect(read.state).toBe("unqualified");
      expect(read.stages.map((entry) => [entry.stage, entry.status])).toEqual([
        ["check", "missing"],
        ["test", "missing"],
        ["export", "missing"],
        ["playtest", "missing"],
        ["state", "missing"],
        ["visual", "missing"],
      ]);
    }),
  ),
);

it.effect("records real stage results and only qualifies when all four are current", () =>
  withGame({}, ({ root, stateDir, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      const buildId = `${sourceId}:first`;
      yield* recordAll(qualification, root, sourceId, buildId);

      const read = yield* qualification.read(root, "godot");
      expect(read.state).toBe("qualified");
      expect(read.buildId).toBe(buildId);
      expect(read.stages.find((entry) => entry.stage === "playtest")).toMatchObject({
        status: "passed",
        sourceId,
        buildId,
      });
      // The record is server state, outside the game the agent can edit.
      const file = qualificationRecordPath(stateDir, root);
      expect(file.startsWith(stateDir)).toBe(true);
      expect(file.startsWith(root)).toBe(false);
      expect(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"))).toContain(sourceId);

      // A fabricated playtest result inside the game folder proves nothing.
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "builds/playtests/fake"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "builds/playtests/fake/result.json"),
          JSON.stringify({ success: true, responded: true }),
        ),
      );
      expect((yield* qualification.read(root, "godot")).state).toBe("qualified");
      // Unchanged sources keep the record current.
      expect((yield* qualification.read(root, "godot")).state).toBe("qualified");
    }),
  ),
);

it.effect("an edit after the stages makes them stale, so the game is unqualified", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "godot/scripts/main.gd"),
          "extends Node\n# revised\n",
        ),
      );
      const read = yield* qualification.read(root, "godot");
      expect(read.state).toBe("unqualified");
      expect(
        read.stages.filter((entry) => entry.status === "stale").map((entry) => entry.stage),
      ).toEqual(["check", "test", "export", "playtest"]);
      expect(read.sourceId).not.toBe(sourceId);
    }),
  ),
);

it.effect("a later failing check replaces the pass", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* qualification.record(root, {
        stage: "check",
        outcome: "passed",
        sourceId,
        buildId: null,
        evidenceDirectory: null,
      });
      yield* qualification.record(root, {
        stage: "check",
        outcome: "failed",
        sourceId,
        buildId: null,
        evidenceDirectory: null,
      });
      const read = yield* qualification.read(root, "godot");
      expect(read.stages.find((entry) => entry.stage === "check")?.status).toBe("failed");
      expect(read.state).toBe("unqualified");
    }),
  ),
);

it.effect("a re-export on the same sources invalidates the playtest build", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      expect((yield* qualification.read(root, "godot")).state).toBe("qualified");

      yield* qualification.record(root, {
        stage: "export",
        outcome: "passed",
        sourceId,
        buildId: `${sourceId}:second`,
        evidenceDirectory: null,
      });
      const read = yield* qualification.read(root, "godot");
      expect(read.buildId).toBe(`${sourceId}:second`);
      expect(read.stages.find((entry) => entry.stage === "playtest")?.status).toBe("stale");
      expect(read.state).toBe("unqualified");
    }),
  ),
);

it.effect("a tree past the scan bound reads as unknown, never as current", () =>
  withGame({ maxSourceEntries: 2 }, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      const read = yield* qualification.read(root, "godot");
      expect(read).toMatchObject({ state: "unknown", sourceId: null, buildId: null });
      expect(read.stages.every((entry) => entry.status === "unknown")).toBe(true);
    }),
  ),
);

it.effect("serializes concurrent stage writes instead of losing one", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* Effect.all(
        [
          qualification.record(root, {
            stage: "check",
            outcome: "passed",
            sourceId,
            buildId: null,
            evidenceDirectory: null,
          }),
          qualification.record(root, {
            stage: "test",
            outcome: "passed",
            sourceId,
            buildId: null,
            evidenceDirectory: null,
          }),
        ],
        { concurrency: 2 },
      );
      const read = yield* qualification.read(root, "godot");
      expect(read.stages.find((entry) => entry.stage === "check")?.status).toBe("passed");
      expect(read.stages.find((entry) => entry.stage === "test")?.status).toBe("passed");
    }),
  ),
);
