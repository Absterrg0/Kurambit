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
import { describeWebArtifacts, type WebArtifactFile } from "./webBuild.ts";

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
  artifacts?: readonly WebArtifactFile[],
): QualificationRecordInput => ({
  stage,
  outcome: "passed",
  sourceId: null,
  buildId,
  evidenceDirectory,
  ...(artifacts === undefined ? {} : { artifacts }),
});

/** Writes the four files a web export produces and returns their descriptor. */
const writeWebBuild = async (root: string): Promise<readonly WebArtifactFile[]> => {
  const directory = NodePath.join(root, "builds/web");
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
    await NodeFSP.writeFile(NodePath.join(directory, name), `fixture ${name}`);
  const artifacts = await describeWebArtifacts(root);
  if (artifacts === null) throw new Error("Fixture web build should be readable");
  return artifacts;
};

const recordAll = (
  qualification: GameQualificationService.GameQualification["Service"],
  root: string,
  sourceId: string,
  buildId: string,
) =>
  Effect.gen(function* () {
    const artifacts = yield* Effect.promise(() => writeWebBuild(root));
    for (const input of [
      passed("check", null),
      passed("test", null),
      passed("export", buildId, null, artifacts),
      passed("playtest", buildId, "builds/playtests/run-1"),
      passed("state", null, "builds/logs/scenarios-1"),
    ])
      yield* qualification.record(root, { ...input, sourceId });
  });

it.effect("starts unqualified, with every stage missing and later stages never passed", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const read = yield* qualification.read(root, "godot");
      expect(read.state).toBe("unqualified");
      expect(read.stages.map((entry) => [entry.stage, entry.status])).toEqual([
        ["design", "missing"],
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

it.effect("records real stage results and only qualifies when all stages are current", () =>
  withGame({}, ({ root, stateDir, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      const buildId = `${sourceId}:first`;
      yield* recordAll(qualification, root, sourceId, buildId);

      const read = yield* qualification.read(root, "godot", "approved");
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
      expect((yield* qualification.read(root, "godot", "approved")).state).toBe("qualified");
      // Unchanged sources keep the record current.
      expect((yield* qualification.read(root, "godot", "approved")).state).toBe("qualified");
    }),
  ),
);

it.effect("keeps the state stage's per-criterion summary with its record", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* qualification.record(root, {
        stage: "state",
        outcome: "passed",
        sourceId,
        buildId: null,
        evidenceDirectory: "builds/logs/scenarios-1",
        criteria: [
          {
            id: "reach-the-goal",
            kind: "end",
            text: "The run ends at the goal",
            status: "passed",
            observed: "full-run: state 1..3",
            scenarios: ["full-run"],
          },
        ],
        detail: "Every observable criterion passed.",
      });
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "state")).toMatchObject({
        status: "passed",
        detail: "Every observable criterion passed.",
        criteria: [{ id: "reach-the-goal", status: "passed" }],
      });
    }),
  ),
);

it.effect("a newly approved design invalidates an old state pass", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* qualification.record(root, {
        stage: "state",
        outcome: "passed",
        sourceId,
        buildId: null,
        evidenceDirectory: "builds/logs/scenarios-1",
        designHash: "hash-a",
        criteria: [],
        detail: "Passed against the first design.",
      });
      const same = yield* qualification.read(root, "godot", "approved", "hash-a");
      expect(same.stages.find((entry) => entry.stage === "state")?.status).toBe("passed");
      const changed = yield* qualification.read(root, "godot", "approved", "hash-b");
      expect(changed.stages.find((entry) => entry.stage === "state")?.status).toBe("stale");
      expect(changed.state).toBe("unqualified");
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
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.state).toBe("unqualified");
      expect(
        read.stages.filter((entry) => entry.status === "stale").map((entry) => entry.stage),
      ).toEqual(["check", "test", "export", "playtest", "state"]);
      expect(read.sourceId).not.toBe(sourceId);
    }),
  ),
);

it.effect("a deletion after the stages also invalidates them", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "godot/scripts/main.gd")));
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.state).toBe("unqualified");
      expect(read.stages.find((entry) => entry.stage === "export")?.status).toBe("stale");
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
      const read = yield* qualification.read(root, "godot", "approved");
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
      expect((yield* qualification.read(root, "godot", "approved")).state).toBe("qualified");

      yield* qualification.record(root, {
        stage: "export",
        outcome: "passed",
        sourceId,
        buildId: `${sourceId}:second`,
        evidenceDirectory: null,
        artifacts: (yield* Effect.promise(() => describeWebArtifacts(root)))!,
      });
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.buildId).toBe(`${sourceId}:second`);
      expect(read.stages.find((entry) => entry.stage === "playtest")?.status).toBe("stale");
      expect(read.state).toBe("unqualified");
    }),
  ),
);

it.effect("the design stage passes only for an approved or legacy design", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      for (const state of ["approved", "legacy"] as const) {
        const read = yield* qualification.read(root, "godot", state);
        expect(read.stages.find((entry) => entry.stage === "design")?.status).toBe("passed");
        expect(read.state).toBe("qualified");
      }
      for (const state of ["draft", "changed"] as const) {
        const read = yield* qualification.read(root, "godot", state);
        expect(read.stages.find((entry) => entry.stage === "design")?.status).toBe("failed");
        expect(read.state).toBe("unqualified");
      }
    }),
  ),
);

it.effect("a tree past the scan bound reads as unknown, never as current", () =>
  withGame({ maxSourceEntries: 2 }, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      const read = yield* qualification.read(root, "godot", "approved");
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
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "check")?.status).toBe("passed");
      expect(read.stages.find((entry) => entry.stage === "test")?.status).toBe("passed");
    }),
  ),
);

it.effect("summarizes the record without reading the source tree", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      expect(yield* qualification.summary(root, null)).toEqual({
        state: "unqualified",
        asOf: null,
      });
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      const buildId = `${sourceId}:first`;
      yield* recordAll(qualification, root, sourceId, buildId);
      const summary = yield* qualification.summary(root, null);
      expect(summary.state).toBe("qualified");
      expect(summary.asOf).not.toBeNull();
      // A record bound to another design revision cannot speak for this one.
      expect((yield* qualification.summary(root, "another-design")).state).toBe("unqualified");
      // The summary trusts the record; the exact read sees the deleted source.
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(root, "godot/scripts/main.gd"), { force: true }),
      );
      expect((yield* qualification.summary(root, null)).state).toBe("qualified");
      expect((yield* qualification.read(root, "godot", "approved")).state).toBe("unqualified");
    }),
  ),
);

it.effect("deleting an exported file makes the export stale and the game unqualified", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* recordAll(qualification, root, sourceId, `${sourceId}:first`);
      expect((yield* qualification.read(root, "godot", "approved")).state).toBe("qualified");

      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "builds/web/index.pck")));
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "export")?.status).toBe("stale");
      expect(read.stages.find((entry) => entry.stage === "playtest")?.status).toBe("stale");
      expect(read.state).toBe("unqualified");
      expect(read.buildId).toBeNull();
    }),
  ),
);

it.effect("an export record without an artifact descriptor is never current", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      for (const input of [
        passed("check", null),
        passed("test", null),
        // The record-level fixture the review reproduced: a passed export with
        // no build files and no descriptor must not qualify.
        passed("export", `${sourceId}:first`),
        passed("playtest", `${sourceId}:first`),
        passed("state", null),
      ])
        yield* qualification.record(root, { ...input, sourceId });
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "export")?.status).toBe("stale");
      expect(read.state).toBe("unqualified");
    }),
  ),
);

it.effect("begin removes the previous stage so a failed attempt cannot leave a pass", () =>
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
      expect(
        (yield* qualification.read(root, "godot", "approved")).stages.find(
          (entry) => entry.stage === "check",
        )?.status,
      ).toBe("passed");
      yield* qualification.begin(root, "check");
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "check")?.status).toBe("missing");
      expect(read.state).toBe("unqualified");
    }),
  ),
);

it.effect("unknown and cancelled outcomes never read as passed", () =>
  withGame({}, ({ root, qualification }) =>
    Effect.gen(function* () {
      const sourceId = yield* Effect.promise(() => sourceIdOf(root));
      yield* qualification.record(root, {
        stage: "check",
        outcome: "unknown",
        sourceId: null,
        buildId: null,
        evidenceDirectory: null,
        detail: "The game sources changed while the check ran.",
      });
      yield* qualification.record(root, {
        stage: "test",
        outcome: "cancelled",
        sourceId,
        buildId: null,
        evidenceDirectory: null,
        detail: "The test was cancelled before it finished.",
      });
      const read = yield* qualification.read(root, "godot", "approved");
      expect(read.stages.find((entry) => entry.stage === "check")).toMatchObject({
        status: "unknown",
        detail: "The game sources changed while the check ran.",
      });
      expect(read.stages.find((entry) => entry.stage === "test")?.status).toBe("failed");
      expect(read.state).toBe("unqualified");
    }),
  ),
);
