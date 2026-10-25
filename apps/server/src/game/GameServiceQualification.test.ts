// @effect-diagnostics nodeBuiltinImport:off -- Runs a real child process against a stub Godot executable and a temp qualification store.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ThreadId,
  type GameAcceptanceCriterion,
  type GameManifest,
  type GamePlaytestState,
  type GameQualificationRead,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import { approvalRecordFile, designDocumentHash, designIntentFile } from "./GameDesignApproval.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  previewBrowserTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("qualification-rules-test");
const manifest = (overrides: Partial<GameManifest> = {}): GameManifest => ({
  schemaVersion: 1,
  name: "Qualification probe",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
  ...overrides,
});
// A stand-in Godot: imports and scripts succeed, and a release export writes the
// four files the service insists on. Nothing here needs a real engine install.
const fakeGodot = `#!/bin/sh
for last do :; done
case "$*" in
  *--export-release*)
    out="$last"
    printf x > "$out"
    printf x > "\${out%.html}.wasm"
    printf x > "\${out%.html}.js"
    printf x > "\${out%.html}.pck"
    ;;
esac
exit 0
`;
const probe = (gameState: Record<string, number | boolean | string>) => ({
  gameState,
  player: { x: 0, y: 0, z: 0 },
});
// The evaluator (playtestState.ts) already covers the verdict rules with unit
// tests on real samples; service tests fake the browser run, so the fake
// carries the verdict the evaluator would have produced for that run.
const playtestResult = (input: {
  readonly success: boolean;
  readonly responded: boolean;
  readonly qualifies?: boolean;
  readonly blockers?: readonly string[];
  readonly interaction?: string;
  readonly state?: GamePlaytestState | null;
}): GameWebPlaytestResult => ({
  success: input.success,
  booted: true,
  bootMs: 25,
  responded: input.responded,
  // This fake stands in for a real run; a responding run dispatched input.
  executedInputSteps: input.responded ? 1 : 0,
  changedPercent: input.responded ? 12 : 0,
  message: input.success ? "Playtest succeeded: fake run." : "Playtest failed: fake run.",
  consoleMessages: [],
  screenshots: [],
  state: input.state ?? null,
  ...(input.qualifies === undefined
    ? {}
    : {
        qualifies: input.qualifies,
        ...(input.blockers === undefined ? {} : { blockers: [...input.blockers] }),
        ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
      }),
});
const withFixture = <A, E, R>(
  run: (input: { readonly root: string }) => Effect.Effect<A, E, R>,
  options: {
    readonly manifest?: GameManifest;
    readonly playtest?: typeof GameWebPlaytest.playtest;
    /** An approved design whose acceptance the playtest reports on. */
    readonly acceptance?: readonly GameAcceptanceCriterion[];
    /** Record the creation-time promise that this game's template ships StudioProbe. */
    readonly probeRequired?: boolean;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-rules-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const executable = NodePath.join(base, "godot");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), "[application]\n");
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/smoke_test.gd"),
          "extends SceneTree\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "godot/tests/other.gd"), "extends SceneTree\n");
        await NodeFSP.writeFile(executable, fakeGodot, { mode: 0o755 });
        if (options.probeRequired === true) {
          await NodeFSP.mkdir(NodePath.dirname(designIntentFile(stateDir, root)), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            designIntentFile(stateDir, root),
            JSON.stringify({
              schemaVersion: 1,
              game: NodePath.resolve(root),
              intent: "skipped",
              probe: true,
            }),
          );
        }
        if (options.acceptance !== undefined) {
          const design = "# Fixture design\n\nA disposable acceptance fixture.\n";
          await NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design);
          // The approval record the server would write: outside the game, bound
          // to the document's hash. Written directly so the fixture setup does
          // not need the approval service's context.
          await NodeFSP.mkdir(NodePath.dirname(approvalRecordFile(stateDir, root)), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            approvalRecordFile(stateDir, root),
            JSON.stringify({
              schemaVersion: 1,
              game: NodePath.resolve(root),
              approvalId: "fixture-approval",
              designHash: designDocumentHash(design),
              approvedAt: "2026-10-20T00:00:00.000Z",
              acceptance: options.acceptance,
            }),
          );
        }
      });
      const current = options.manifest ?? manifest();
      const gameLayer = GameService.layerWithPlaytest(
        options.playtest ??
          (() => Effect.succeed(playtestResult({ success: true, responded: true }))),
      ).pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provideMerge(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(current),
            activeRun: () => Effect.succeed(null),
            inventory: () =>
              Effect.succeed({
                manifest: current,
                design: null,
                designPath: null,
                briefPath: null,
                assets: [],
                scenes: [],
                builds: [],
                viewport: { width: 1152, height: 648 },
              }),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({ path: executable, version: "4.7.2", templates: null }),
            status: Effect.succeed({
              toolsDirectory: base,
              installing: false,
              tools: [
                {
                  tool: "godot" as const,
                  path: executable,
                  version: "4.7.2",
                  ready: true,
                  verified: true,
                  message: "stub",
                },
              ],
            }),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            open: () => Effect.succeed("http://127.0.0.1:9/game"),
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provideMerge(previewBrowserTestLayer(executable)),
        Layer.provideMerge(GameQualification.layer({ stateDir })),

        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
      );
      // The studio reads the same services the game layer built, so the test
      // exercises the loop's real playable check rather than a fake.
      const services = GameRepairStudio.layer({ stateDir }).pipe(
        Layer.provideMerge(gameLayer),
        Layer.provide(NodeServices.layer),
      );
      return yield* run({ root }).pipe(Effect.provide(services));
    }),
  );

const stageOf = (read: GameQualificationRead, stage: string) =>
  read.stages.find((entry) => entry.stage === stage);

it.live("a non-canonical test script runs but does not record the test stage", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const tested = yield* game.test(threadId, "tests/other.gd");
      expect(tested.success, tested.message).toBe(true);
      expect(tested.message).toContain("Only the canonical suite");
      expect(tested.message).toContain("res://tests/smoke_test.gd");
      const qualification = yield* GameQualification.GameQualification;
      const read = yield* qualification.read(root, "godot");
      expect(stageOf(read, "test")?.status).toBe("missing");
    }),
  ),
);

it.live("the canonical suite records the test stage", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const tested = yield* game.test(threadId, "tests/smoke_test.gd");
      expect(tested.success, tested.message).toBe(true);
      expect(tested.message).not.toContain("Only the canonical suite");
      const qualification = yield* GameQualification.GameQualification;
      const read = yield* qualification.read(root, "godot");
      expect(stageOf(read, "test")?.status).toBe("passed");
    }),
  ),
);

it.live("a policy change invalidates the test evidence recorded under it", () =>
  withFixture(({ root }) =>
    Effect.gen(function* () {
      const game = yield* GameService.GameService;
      const approvals = yield* GameDesignApproval.GameDesignApproval;
      const qualification = yield* GameQualification.GameQualification;
      const before = yield* approvals.readPolicy(root, manifest());
      const tested = yield* game.test(threadId, "tests/smoke_test.gd");
      expect(tested.message).not.toContain("Only the canonical suite");
      const identity = { policyRevision: before.revision, probeRequired: before.policy.probe };
      const current = yield* qualification.read(root, "godot", undefined, null, identity);
      expect(stageOf(current, "test")?.status).toBe("passed");
      // The creator moves the canonical suite: the old pass cannot certify it.
      const after = yield* approvals.updatePolicy(root, {
        ...before.policy,
        testSuite: "res://tests/other.gd",
      });
      const invalidated = yield* qualification.read(root, "godot", undefined, null, {
        policyRevision: after.revision,
        probeRequired: after.policy.probe,
      });
      expect(stageOf(invalidated, "test")?.status).toBe("stale");
      // The service now follows the record: the old suite is diagnostic and the
      // new canonical suite records under the new revision.
      expect((yield* game.test(threadId, "tests/smoke_test.gd")).message).toContain(
        "Only the canonical suite",
      );
      expect((yield* game.test(threadId, "tests/other.gd")).message).not.toContain(
        "Only the canonical suite",
      );
      const reread = yield* qualification.read(root, "godot", undefined, null, {
        policyRevision: after.revision,
        probeRequired: after.policy.probe,
      });
      expect(stageOf(reread, "test")?.status).toBe("passed");
    }),
  ),
);

it.live("the manifest's suite is canonical instead of the default", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const smoke = yield* game.test(threadId, "tests/smoke_test.gd");
        expect(smoke.success, smoke.message).toBe(true);
        expect(smoke.message).toContain("Only the canonical suite");
        const qualification = yield* GameQualification.GameQualification;
        const before = yield* qualification.read(root, "godot");
        expect(stageOf(before, "test")?.status).toBe("missing");
        const canonical = yield* game.test(threadId, "tests/other.gd");
        expect(canonical.message).not.toContain("Only the canonical suite");
        const after = yield* qualification.read(root, "godot");
        expect(stageOf(after, "test")?.status).toBe("passed");
      }),
    { manifest: manifest({ testSuite: "res://tests/other.gd" }) },
  ),
);

it.live("a playtest with no steps succeeds as a tool result but fails qualification", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [] });
        // The boot smoke result stays useful to the tool caller.
        expect(playtest.success, playtest.message).toBe(true);
        expect(playtest.message).toContain("no input steps were given");
        expect(playtest.message).toContain("the game did not visibly respond to the input steps");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "export")?.status).toBe("passed");
        expect(stageOf(read, "playtest")?.status).toBe("failed");
      }),
    {
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: false,
            qualifies: false,
            blockers: [
              "no input steps were given",
              "the game did not visibly respond to the input steps",
            ],
            interaction: "no state probe",
          }),
        ),
    },
  ),
);

it.live("a scripted playtest that responded records a passed playtest", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ waitMs: 1 }] });
        expect(playtest.success, playtest.message).toBe(true);
        expect(playtest.message).not.toContain("Qualification:");
        // This fixture's game owes no probe, so no state probe is expected.
        expect(playtest.state).toBeNull();
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("passed");
        expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(true);
      }),
    {
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: true,
            interaction: "no state probe",
          }),
        ),
    },
  ),
);

it.live("a design-doc edit and an engine import keep the exported build playable", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const studio = yield* GameRepairStudio.GameRepairStudio;
        const qualification = yield* GameQualification.GameQualification;
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success, exported.message).toBe(true);
        const playtest = yield* game.webPlaytest(threadId, {
          steps: [{ key: "ArrowRight", holdMs: 1 }],
        });
        expect(playtest.success, playtest.message).toBe(true);
        const read = yield* qualification.read(root, "godot");
        expect(read.completion).toBe("complete");
        expect(stageOf(read, "export")?.status).toBe("passed");
        expect(stageOf(read, "playtest")?.status).toBe("passed");

        // The t50 sequence: the builder edited DESIGN.md after the export, and
        // the next Godot run wrote sidecars beside the sources. Neither is
        // build input, so neither may stale the playable build.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), "# Revised design\n"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd.uid"), "uid://new\n"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "godot/project.godot.import"), "[remap]\n"),
        );
        const afterDesign = yield* qualification.read(root, "godot");
        expect(afterDesign.completion).toBe("complete");
        // The submission gate reads the build's own facts: these bytes exist,
        // hash to their id, are the current export, and their playtest booted
        // cleanly and responded. A design edit cannot move any of that.
        const submitted = yield* studio.submissionFacts(root);
        expect(submitted.passed, submitted.reason ?? "").toBe(true);
        const provenance = yield* studio.exportProvenance(root);
        expect(provenance.exportBuildId).not.toBeNull();
        expect(submitted.buildId).toBe(provenance.exportBuildId);

        // A real build input still invalidates the export and the playtest for
        // the current sources. That is a status fact; the exported build is
        // immutable, so its own submission facts still describe it honestly.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n# edit\n"),
        );
        const stale = yield* qualification.read(root, "godot");
        expect(stageOf(stale, "export")?.status).toBe("stale");
        expect(stageOf(stale, "playtest")?.status).toBe("stale");
        expect(stale.completion).toBe("incomplete");
        expect((yield* studio.submissionFacts(root)).passed).toBe(true);
      }),
    {
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: true,
            interaction: "no state probe",
          }),
        ),
    },
  ),
);

it.live("a probe that saw only a menu change fails the playtest stage", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ waitMs: 1 }] });
        // The picture changed, so the tool itself succeeded; the run still proved
        // nothing about play.
        expect(playtest.success, playtest.message).toBe(true);
        expect(playtest.message).toContain("the player did not move from the gameplay baseline");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("failed");
        expect(stageOf(read, "playtest")?.detail).toContain("no player movement");
      }),
    {
      probeRequired: true,
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: false,
            blockers: [
              "the player did not move from the gameplay baseline",
              "no GameState value changed on a ride a stopped clock would not show",
            ],
            interaction: "no player movement or GameState change",
            state: {
              before: probe({ state: 0 }),
              after: probe({ state: 1 }),
              playerMoved: 0,
              changes: [],
            },
          }),
        ),
    },
  ),
);

it.live("a probe-required run with movement and a non-clock change records a pass", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ key: "w", holdMs: 800 }] });
        expect(playtest.message).not.toContain("Qualification:");
        expect(playtest.state?.playerMoved).toBe(42);
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("passed");
      }),
    {
      probeRequired: true,
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: true,
            interaction: "collected 0→2, player moved 42",
            state: {
              before: probe({ state: 1, collected: 0 }),
              after: probe({ state: 1, collected: 2 }),
              playerMoved: 42,
              changes: [{ key: "collected", before: 0, after: 2 }],
            },
          }),
        ),
    },
  ),
);

it.live("a game that never owed a probe keeps the pixel rule", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ key: "e", holdMs: 80 }] });
        expect(playtest.message).not.toContain("Qualification:");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("passed");
      }),
    {
      playtest: () =>
        Effect.succeed(playtestResult({ success: true, responded: true, qualifies: true })),
    },
  ),
);

it.live("an approved design's observe criteria are reported without gating", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ key: "w", holdMs: 800 }] });
        // The playtest satisfied the collection promise but not the finish, and
        // neither changes the qualification outcome: the scenario runner gates.
        expect(playtest.designObservations).toEqual(["collect-two"]);
        expect(playtest.message).toContain("collect-two");
        expect(playtest.message).toContain("informational");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("passed");
        // The evidence keeps the snapshot and the informational report.
        const status = yield* game.status(threadId);
        const stored = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(root, status.lastPlaytest!.directory, "result.json"),
              "utf8",
            ),
          ),
        );
        expect(stored.designObservations).toEqual(["collect-two"]);
        expect(stored.state.after.gameState.collected).toBe(2);
      }),
    {
      acceptance: [
        {
          id: "collect-two",
          kind: "content",
          text: "Collect two relics",
          observe: { key: "collected", expect: ">=2" },
        },
        {
          id: "win-the-run",
          kind: "win",
          text: "Reach the gate",
          observe: { key: "won", expect: "==1" },
        },
      ],
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: true,
            interaction: "collected 0→2, player moved 42",
            state: {
              before: probe({ state: 1, collected: 0, won: false }),
              after: probe({ state: 1, collected: 2, won: false }),
              playerMoved: 42,
              changes: [{ key: "collected", before: 0, after: 2 }],
            },
          }),
        ),
    },
  ),
);

it.live("rejects an out-of-bounds capture before exporting or launching the browser", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const error = yield* game
          .webPlaytest(threadId, {
            width: 100,
            steps: [{ waitMs: 1 }, { key: "w", holdMs: 10_001 }],
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
        expect(error.detail).toContain("width must be between 320 and 1920 pixels.");
        expect(error.detail).toContain("one step may last at most 10000 ms");
        // The route T115 sent to verify; the shared guard plans 33 frames at 400 ms.
        const interval = yield* game
          .webPlaytest(threadId, {
            steps: [
              { press: "Enter" },
              { waitMs: 500 },
              { hold: "ArrowRight", holdMs: 1800 },
              { screenshot: "gap-ahead" },
              { hold: "ArrowRight", holdMs: 600 },
              { screenshot: "at-the-mouth" },
              { hold: "ArrowRight", holdMs: 400 },
              { screenshot: "falling" },
              { waitMs: 600 },
              { screenshot: "in-the-dark" },
              { hold: "ArrowRight", holdMs: 1000 },
              { screenshot: "respawned" },
              { press: "Space" },
              { screenshot: "jump-works" },
            ],
            captureEveryMs: 400,
            captureAllSteps: true,
          })
          .pipe(Effect.flip);
        expect(interval.reason).toBe("invalid-input");
        expect(interval.detail).toContain("Interval capture requests 33 frames; limit is 32.");
        expect(interval.detail).toContain("Increase captureEveryMs or shorten the steps.");
        // The rejection lands before the stale-build export the run would need.
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "export")?.status).toBe("missing");
        expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(false);
      }),
    {
      // A browser launch would be a defect in this test, not a slow pass.
      playtest: () => Effect.die(new Error("browser launched for an invalid capture")),
    },
  ),
);

it.live("fails the playtest stage when a probe-required game has no probe", () =>
  withFixture(
    ({ root }) =>
      Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ key: "w", holdMs: 100 }] });
        expect(playtest.message).toContain("StudioProbe missing");
        expect(playtest.message).toContain("restore scripts/studio_probe.gd");
        const qualification = yield* GameQualification.GameQualification;
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "playtest")?.status).toBe("failed");
        expect(stageOf(read, "playtest")?.detail).toBe(
          "StudioProbe missing — restore scripts/studio_probe.gd autoload",
        );
      }),
    {
      probeRequired: true,
      playtest: () =>
        Effect.succeed(
          playtestResult({
            success: true,
            responded: true,
            qualifies: false,
            blockers: ["the StudioProbe autoload is missing or never answered"],
            interaction: "no state probe",
          }),
        ),
    },
  ),
);
