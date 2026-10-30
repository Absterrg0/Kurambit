// @effect-diagnostics nodeBuiltinImport:off -- The studio test writes real playtest evidence in a temporary game.
// @effect-diagnostics globalDate:off -- Fixed evidence timestamps make the newest-run read deterministic.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GameManifest,
  type GamePlaytestProbe,
  type GameWebPlaytestInput,
  type GameWebPlaytestResult,
  type GameReviewFrozenInputs,
  GameOperationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import {
  readLastPlaytest,
  readPlaytestRunFacts,
  writePlaytestEvidence,
} from "./playtestEvidence.ts";
import { candidateBuildDirectory, hashWebBuildDirectory } from "./webBuild.ts";

const threadId = ThreadId.make("thread:studio-check");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Studio probe",
  brief: "Make a small platformer.",
  artDirection: "Warm paper colours.",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

const probe = (hudText: string): GamePlaytestProbe => ({
  gameState: { score: 0, playing: true },
  player: { x: 12, y: 40, z: 0 },
  hudText,
});

/** Fixed evidence timestamps: reading the newest run must not depend on the clock. */
const FIRST_EVIDENCE_AT = new Date("2026-10-01T10:00:00.000Z");
const LATER_EVIDENCE_AT = new Date("2026-10-01T10:05:00.000Z");

const baseResult = (inputSteps: number | null = 1): GameWebPlaytestResult => ({
  success: true,
  ...(inputSteps === null ? {} : { executedInputSteps: inputSteps }),
  booted: true,
  bootMs: 900,
  responded: true,
  changedPercent: 12,
  message: "played",
  consoleMessages: [],
  screenshots: [
    { label: "after-steps", mimeType: "image/png", data: "cG5n", width: 1152, height: 648 },
  ],
  state: null,
  baseViewport: { width: 1152, height: 648 },
});

interface Harness {
  readonly root: string;
  results: GameWebPlaytestResult;
  /** What an exact-size window capture returns; the route runs keep `results`. */
  windowResults: GameWebPlaytestResult;
  windowError: GameOperationError | null;
  persistExperiment?: boolean;
  readonly calls: Array<GameWebPlaytestInput | undefined>;
  /** When set, every route run fails; boot-only runs still succeed. */
  replayError: GameOperationError | null;
  bootError?: GameOperationError;
  /** The raw stage records the qualification store would report. */
  exportStage: GameQualification.QualificationStageRecord | null;
  playtestStage: GameQualification.QualificationStageRecord | null;
  /** The frozen state-exam record the native hints bind against, when set. */
  stateStage: GameQualification.QualificationStageRecord | null;
}

/** Two frames at the capture window, as a boot+burst run produces. */
const windowResult = (width: number, height: number): GameWebPlaytestResult => ({
  ...baseResult(),
  screenshots: [
    { label: "booted", mimeType: "image/png", data: "cG5n", width, height },
    { label: "after-steps", mimeType: "image/png", data: "cG5n", width, height },
  ],
  baseViewport: { width, height },
});

/**
 * A real content-addressed build directory: the id is the hash of the files, so
 * the test can corrupt it afterwards and prove the byte check noticed.
 */
const makeBuild = async (root: string): Promise<string> => {
  const staging = NodePath.join(root, "builds/candidates/staging");
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(staging, "index.html"), "<html>game</html>\n");
  await NodeFSP.writeFile(NodePath.join(staging, "index.pck"), "pck");
  const hashed = await hashWebBuildDirectory(staging);
  if (hashed === null) throw new Error("the fixture build did not hash");
  const final = NodePath.join(root, candidateBuildDirectory(hashed.buildId));
  await NodeFSP.rename(staging, final);
  return hashed.buildId;
};

const stage = (input: {
  readonly buildId: string;
  readonly evidenceDirectory?: string | null;
  readonly outcome?: "passed" | "failed";
}): GameQualification.QualificationStageRecord => ({
  outcome: input.outcome ?? "passed",
  sourceId: "fixture-source",
  buildId: input.buildId,
  finishedAt: "2026-10-01T10:05:00.000Z",
  evidenceDirectory: input.evidenceDirectory ?? null,
  runId: "run:builder",
});

const withStudio = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, GameRepairStudio.GameRepairStudio>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-check-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "game.json"),
          `${JSON.stringify({ name: "Studio probe", brief: "Make a platformer." })}\n`,
        );
      });
      const harness: Harness = {
        root,
        results: baseResult(),
        windowResults: windowResult(900, 900),
        windowError: null,
        calls: [],
        replayError: null,
        exportStage: null,
        playtestStage: null,
        stateStage: null,
      };
      const game = Layer.mock(GameService.GameService)({
        webPlaytestBuild: (_thread, _buildId, input, directory) => {
          harness.calls.push(input);
          const exact = input?.exactSize === true;
          if (exact && harness.windowError !== null) return Effect.fail(harness.windowError);
          if (harness.replayError !== null && (input?.steps?.length ?? 0) > 0 && !exact)
            return Effect.fail(harness.replayError);
          if (harness.bootError !== undefined && (input?.steps?.length ?? 0) === 0)
            return Effect.fail(harness.bootError);
          const result = exact ? harness.windowResults : harness.results;
          if (directory !== undefined && harness.persistExperiment)
            return Effect.promise(async () => {
              const evidence = await writePlaytestEvidence({
                root,
                directory: NodePath.join(directory, "evidence"),
                steps: input?.steps ?? [],
                result,
              });
              return { ...result, screenshots: [], evidenceDirectory: evidence.directory };
            });
          return Effect.succeed(result);
        },
      });
      const projects = Layer.mock(GameProjectService.GameProjectService)({
        resolve: () => Effect.succeed(root),
        read: () => Effect.succeed(manifest),
      });
      const qualification = Layer.mock(GameQualification.GameQualification)({
        stageRecord: (_root, stage) =>
          Effect.succeed(
            stage === "export"
              ? harness.exportStage
              : stage === "playtest"
                ? harness.playtestStage
                : stage === "state"
                  ? harness.stateStage
                  : null,
          ),
      });
      const rounds = Layer.mock(GameRoundStore.GameRoundStore)({
        exported: (_root, buildId) =>
          Effect.gen(function* () {
            const played = harness.playtestStage;
            const facts =
              played?.buildId === buildId && played.evidenceDirectory !== null
                ? yield* Effect.promise(() => readPlaytestRunFacts(root, played.evidenceDirectory!))
                : null;
            const last = yield* Effect.promise(() => readLastPlaytest(root, [], null));
            return {
              artifact: {
                buildId,
                directory: candidateBuildDirectory(buildId),
                sourceId: "fixture",
                engine: "godot" as const,
                target: "Web" as const,
                entry: "index.html",
              },
              sourceDirectory: root,
              playtest:
                facts === null
                  ? null
                  : {
                      ...facts,
                      ...(played?.evidenceDirectory === null ||
                      played?.evidenceDirectory === undefined
                        ? {}
                        : { evidenceDirectory: played.evidenceDirectory }),
                      steps: last?.steps ?? [],
                      viewport: last?.viewport ?? null,
                      ...(last?.captureScale === undefined
                        ? {}
                        : { captureScale: last.captureScale }),
                    },
            };
          }),
      });
      const layer = GameRepairStudio.layer({ stateDir: NodePath.join(base, "state") }).pipe(
        Layer.provide(game),
        Layer.provide(projects),
        Layer.provide(qualification),
        Layer.provide(rounds),
        Layer.provide(NodeServices.layer),
      );
      return yield* body(harness).pipe(Effect.provide(layer));
    }),
  );

it.live("captures the builder's route once and replays it for every later check", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ key: "ArrowRight", holdMs: 120 }],
          result: baseResult(),
          at: FIRST_EVIDENCE_AT,
        }),
      );
      const inputs = yield* studio.frozenInputs(harness.root);
      expect(inputs.steps).toEqual([{ key: "ArrowRight", holdMs: 120 }]);
      expect(inputs.viewport).toEqual({ width: 1152, height: 648 });
      // The playtest records no seed; it says so rather than inventing one.
      expect(inputs.seed).toBe("unknown");

      yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      // The frozen route is the only route run; the window capture is the one
      // fixed burst and says so with exactSize.
      const routeCalls = harness.calls.filter((call) => call?.exactSize !== true);
      expect(routeCalls.at(-1)).toEqual({
        steps: [{ key: "ArrowRight", holdMs: 120 }],
        width: 1152,
        height: 648,
      });
      expect(harness.calls.find((call) => call?.exactSize === true)).toMatchObject({
        width: 900,
        height: 900,
      });

      // A repair child writes its own, easier demo route. The loop's frozen
      // inputs are what every later check replays, never the newest playtest.
      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ key: "ArrowLeft", holdMs: 20 }],
          result: baseResult(),
          at: LATER_EVIDENCE_AT,
        }),
      );
      const newer = yield* studio.frozenInputs(harness.root);
      expect(newer.steps).toEqual([{ key: "ArrowLeft", holdMs: 20 }]);
      yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(harness.calls.filter((call) => call?.exactSize !== true).at(-1)?.steps).toEqual([
        { key: "ArrowRight", holdMs: 120 },
      ]);
    }),
  ),
);

it.live("freezes and replays the window a scaled route was played in", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const played = {
        ...baseResult(),
        baseViewport: { width: 640, height: 360 },
        captureScale: 2,
      };
      harness.results = played;
      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          // A click below the base height, valid in the 1280×720 window it
          // was actually played in.
          steps: [{ click: "left", x: 640, y: 400 }],
          result: played,
          at: FIRST_EVIDENCE_AT,
        }),
      );
      const inputs = yield* studio.frozenInputs(harness.root);
      expect(inputs.viewport).toEqual({ width: 1280, height: 720 });
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(harness.calls.filter((call) => call?.exactSize !== true).at(-1)).toEqual({
        steps: [{ click: "left", x: 640, y: 400 }],
        width: 1280,
        height: 720,
      });
      // A wide played window gets a square one, the one shape it never shows.
      expect(harness.calls.find((call) => call?.exactSize === true)).toMatchObject({
        width: 900,
        height: 900,
      });
      expect(checked.viewport).toEqual({ width: 1280, height: 720 });
      expect(checked.frames.filter((frame) => frame.window === true)).toHaveLength(2);
    }),
  ),
);

it.live("adds one labelled window capture per check, outside the playtest record", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs: {
          steps: [{ press: "Space" }],
          viewport: { width: 960, height: 540 },
          seed: "unknown",
        },
      });
      // Exactly one extra browser run per check, at a different window shape.
      const windowCalls = harness.calls.filter((call) => call?.exactSize === true);
      expect(windowCalls).toHaveLength(1);
      expect(windowCalls[0]).toMatchObject({ width: 900, height: 900 });
      expect(windowCalls[0]?.steps?.length).toBeGreaterThan(0);
      const windowFrames = checked.frames.filter((frame) => frame.window === true);
      expect(windowFrames).toHaveLength(2);
      expect(windowFrames.map((frame) => frame.label)).toEqual([
        "window 900x900: boot",
        "window 900x900: after a short input burst",
      ]);
      // The manifest has the size as data, not just in the label.
      expect(windowFrames[0]).toMatchObject({ width: 900, height: 900 });
      expect(windowFrames[1]).toMatchObject({ width: 900, height: 900 });
      expect(checked.checks.find((check) => check.id === "window")).toEqual({
        id: "window",
        status: "passed",
        detail: "900x900 window",
      });
    }),
  ),
);

it.live("a failed window capture is a failed evidence check, not a veto", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.windowError = new GameOperationError({
        operation: "Web playtest",
        path: harness.root,
        reason: "command-failed",
        detail: "The browser exited before the second frame.",
      });
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs: {
          steps: [{ press: "Space" }],
          viewport: { width: 960, height: 540 },
          seed: "unknown",
        },
      });
      expect(checked.frames.every((frame) => frame.window !== true)).toBe(true);
      const window = checked.checks.find((check) => check.id === "window");
      expect(window).toMatchObject({ status: "failed" });
      expect(window?.detail).toContain("900x900 window");
      // The execution facts a promotion compares are untouched by the extra run.
      expect(
        checked.checks
          .filter((check) => check.id !== "window")
          .map(({ id, status }) => ({ id, status })),
      ).toEqual([
        { id: "boot", status: "passed" },
        { id: "console", status: "passed" },
        { id: "input", status: "passed" },
      ]);
    }),
  ),
);

it.live("a failed frozen-route replay is evidence, not the end of the review", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      harness.results = {
        ...baseResult(),
        baseViewport: { width: 640, height: 360 },
        captureScale: 2,
      };
      harness.replayError = new GameOperationError({
        operation: "Web playtest",
        path: harness.root,
        reason: "command-failed",
        detail: "The browser exited before the route finished.",
      });
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId,
        inputs: {
          steps: [{ click: "left", x: 640, y: 400 }],
          viewport: { width: 1280, height: 720 },
          seed: "unknown",
        },
      });
      expect(checked.checks.find((check) => check.id === "replay")).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("browser exited"),
      });
      // Boot frames still show the critic the build it is reviewing.
      expect(checked.frames.length).toBeGreaterThan(0);
      expect(harness.calls.map((call) => call?.steps?.length ?? 0)).toEqual([1, 0]);
      expect(checked.viewport).toEqual({ width: 1280, height: 720 });
    }),
  ),
);

it.live("a failed boot fallback returns both errors as critic evidence", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      harness.replayError = new GameOperationError({
        operation: "Web playtest",
        path: harness.root,
        reason: "command-failed",
        detail: "The recorded route could not run.",
      });
      harness.bootError = new GameOperationError({
        operation: "Web playtest",
        path: harness.root,
        reason: "command-failed",
        detail: "The boot fallback browser process exited.",
      });
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId,
        inputs: {
          steps: [{ press: "Space" }],
          viewport: { width: 640, height: 360 },
          seed: "unknown",
        },
      });
      expect(checked.checks).toEqual([
        { id: "replay", status: "failed", detail: harness.replayError.message.slice(0, 1000) },
        { id: "boot", status: "failed", detail: harness.bootError.message.slice(0, 1000) },
      ]);
      expect(checked.frames).toEqual([]);
      expect(checked.viewport).toEqual({ width: 640, height: 360 });
    }),
  ),
);

it.live("a build whose bytes changed still ends the replay", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      harness.replayError = new GameOperationError({
        operation: "Web playtest",
        path: harness.root,
        reason: "invalid-input",
        detail: "Step 1 pointer coordinates exceed the frozen 640×360 viewport.",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(harness.root, candidateBuildDirectory(buildId), "index.html"),
          "<html>hacked</html>\n",
        ),
      );
      const failed = yield* studio
        .check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId,
          inputs: {
            steps: [{ click: "left", x: 640, y: 400 }],
            viewport: { width: 1280, height: 720 },
            seed: "unknown",
          },
        })
        .pipe(Effect.flip);
      expect(failed.detail).toContain("Step 1 pointer coordinates exceed");
      // No boot-only evidence run: a changed build ends the replay.
      expect(harness.calls.map((call) => call?.steps?.length ?? 0)).toEqual([1]);
    }),
  ),
);

it.live.each(["stationary card", "instant dialogue", "endless", "animated scenery"])(
  "%s measurements go to the critic without inferred vetoes",
  (genre) =>
    withStudio((harness) =>
      Effect.gen(function* () {
        const studio = yield* GameRepairStudio.GameRepairStudio;
        harness.results = {
          ...baseResult(),
          success: false,
          responded: false,
          changedPercent: genre === "animated scenery" ? 35 : 0,
          state: {
            before: probe(""),
            after: probe(""),
            playerMoved: 0,
            changes: [],
            notOnScreen: ["score"],
          },
          qualifies: false,
          blockers: ["no movement or win"],
          designObservations: [],
        };
        const inputs: GameReviewFrozenInputs = {
          steps: [{ click: "left" }],
          viewport: null,
          seed: null,
        };
        const checked = yield* studio.check({
          threadId,
          root: harness.root,
          target: "candidate",
          buildId: "a".repeat(64),
          inputs,
        });
        expect(checked.checks.map(({ id, status }) => ({ id, status }))).toEqual([
          { id: "boot", status: "passed" },
          { id: "console", status: "passed" },
          { id: "input", status: "passed" },
          { id: "playtest", status: "failed" },
          { id: "window", status: "passed" },
        ]);
        expect(checked.checks.find((check) => check.id === "input")?.measurements).toEqual({
          steps: inputs.steps,
          changedPercent: harness.results.changedPercent,
          state: harness.results.state,
          designObservations: [],
        });
        // One route frame plus the bounded boot+burst pair, never a gate.
        expect(checked.frames.map((frame) => frame.window === true)).toEqual([false, true, true]);
        expect(checked.frames.at(-1)?.label).toBe("window 900x900: after a short input burst");
      }),
    ),
);

it.live.each([undefined, 0])(
  "missing or undispatched inputs do not pass: %s",
  (executedInputSteps) =>
    withStudio((harness) =>
      Effect.gen(function* () {
        const studio = yield* GameRepairStudio.GameRepairStudio;
        harness.results = baseResult(executedInputSteps ?? null);
        const checked = yield* studio.check({
          threadId,
          root: harness.root,
          target: "candidate",
          buildId: "a".repeat(64),
          inputs: { steps: [{ click: "left" }], viewport: null, seed: null },
        });
        expect(checked.checks.find((check) => check.id === "input")?.status).toBe(
          executedInputSteps === undefined ? "unmeasured" : "failed",
        );
      }),
    ),
);

/** The passed playtest a submission needs, written as real evidence. */
const passedPlaytest = (root: string, at = FIRST_EVIDENCE_AT) =>
  writePlaytestEvidence({
    root,
    steps: [{ key: "ArrowRight", holdMs: 120 }],
    result: { ...baseResult(), qualifies: true },
    at,
  });

it.live("submission facts pass on the bytes, the current export and a clean playtest", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed, facts.reason ?? "").toBe(true);
      expect(facts.buildId).toBe(buildId);
      expect(facts.reason).toBeNull();
      const byId = new Map(facts.checks.map((entry) => [entry.id, entry]));
      for (const id of ["build", "bytes", "sources", "playtest", "boot", "console", "input"]) {
        expect(byId.get(id)?.status, id).toBe("passed");
      }
    }),
  ),
);

it.live("submission facts refuse a build whose bytes changed and name the fact", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      // A same-size rewrite changes the id the directory claims to name.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(harness.root, candidateBuildDirectory(buildId), "index.html"),
          "<html>hacked</html>\n",
        ),
      );
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      expect(facts.reason).toContain("bytes:");
      const bytes = facts.checks.find((entry) => entry.id === "bytes");
      expect(bytes?.status).toBe("failed");
      expect(bytes?.detail).toContain("changed after export");
      // The dirty build is never hashed as if it were the one it claims to be.
      expect(facts.checks.some((entry) => entry.id === "playtest")).toBe(false);
    }),
  ),
);

it.live("submission facts accept an older bound build when a newer export exists", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId: "e".repeat(64) });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root, buildId);
      expect(facts.passed, facts.reason ?? "").toBe(true);
      expect(facts.checks.find((entry) => entry.id === "sources")?.status).toBe("passed");
    }),
  ),
);

it.live("submission facts refuse console errors and a playtest with no input", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [],
          result: {
            ...baseResult(),
            responded: false,
            executedInputSteps: 0,
            consoleMessages: [
              { level: "error", text: "boom" },
              { level: "error", text: "bang" },
            ],
          },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      const byId = new Map(facts.checks.map((entry) => [entry.id, entry]));
      expect(byId.get("console")?.status).toBe("failed");
      expect(byId.get("console")?.detail).toContain("2 console error(s)");
      expect(byId.get("input")?.status).toBe("failed");
      expect(byId.get("input")?.detail).toContain("no input steps");
      expect(facts.reason).toContain("console:");
      expect(facts.reason).toContain("input:");
    }),
  ),
);

it.live("a failed gameplay qualification refuses submission even when boot and input passed", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ press: "Space" }],
          result: {
            ...baseResult(),
            responded: true,
            qualifies: false,
            blockers: ["no movement or design progress"],
          },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({
        buildId,
        evidenceDirectory: evidence.directory,
        outcome: "failed",
      });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      const byId = new Map(facts.checks.map((entry) => [entry.id, entry]));
      expect(byId.get("boot")?.status).toBe("passed");
      expect(byId.get("input")?.status).toBe("passed");
      expect(byId.get("playtest")?.status).toBe("failed");
      expect(byId.get("playtest")?.detail).toContain("no movement or design progress");
      expect(facts.reason).toContain("playtest:");

      // The review reads the same build binding: its own failed playtest is a
      // hard failed check, never a boot/input-only pass.
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs,
      });
      expect(harness.calls).toEqual([]);
      expect(checked.checks.find((entry) => entry.id === "playtest")?.status).toBe("failed");
      expect(checked.checks.every((entry) => entry.status === "passed")).toBe(false);
      expect(checked.checks.find((entry) => entry.id === "input")?.status).toBe("passed");
    }),
  ),
);

it.live("a build's failed playtest vetoes a passing replay of a different route", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ press: "Space" }],
          result: {
            ...baseResult(),
            qualifies: false,
            blockers: ["no movement or design progress"],
          },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({
        buildId,
        evidenceDirectory: evidence.directory,
        outcome: "failed",
      });
      // The frozen route is not the failed route and the replay passes. The
      // build's own failed qualification still vetoes promotion.
      harness.results = { ...baseResult(), qualifies: true };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs: {
          steps: [{ press: "Enter" }],
          viewport: { width: 1152, height: 648 },
          seed: "unknown",
        },
      });
      expect(harness.calls.filter((call) => call?.exactSize !== true)).toHaveLength(1);
      expect(checked.checks.find((entry) => entry.id === "playtest")).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("no movement or design progress"),
      });
      expect(checked.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
      expect(checked.checks.every((entry) => entry.status === "passed")).toBe(false);
    }),
  ),
);

it.live("a legacy playtest without a stored verdict is replayed, not failed for absence", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ press: "Space" }],
          result: baseResult(),
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      expect((yield* studio.submissionFacts(harness.root)).passed).toBe(true);

      // The route matches, but the old run measured no gameplay verdict. The
      // check must replay it with the frozen route instead of treating the
      // missing optional field as a failed game.
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      harness.results = {
        ...baseResult(),
        qualifies: false,
        blockers: ["no movement or design progress"],
      };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs,
      });
      expect(harness.calls.filter((call) => call?.exactSize !== true)).toHaveLength(1);
      expect(checked.checks.find((entry) => entry.id === "playtest")?.status).toBe("failed");

      yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ press: "Space" }],
          result: {
            ...baseResult(),
            booted: false,
            responded: false,
            qualifies: false,
            consoleMessages: [{ level: "error", text: "boom" }],
          },
          at: LATER_EVIDENCE_AT,
        }).then((bad) => {
          harness.playtestStage = stage({
            buildId,
            evidenceDirectory: bad.directory,
            outcome: "failed",
          });
        }),
      );
      const refused = yield* studio.submissionFacts(harness.root);
      expect(refused.reason).toContain("boot: The playtest recorded that the game did not boot.");
      expect(refused.reason).toContain("console: 1 console error(s)");
      expect(refused.reason).toContain("playtest:");
      expect(refused.reason).toContain("input: The playtest recorded no visible response");
    }),
  ),
);

it.live("a matching recorded playtest reuses gameplay and still checks the other window", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const steps = [{ key: "ArrowRight", holdMs: 120 }];
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps,
          result: {
            ...baseResult(),
            qualifies: true,
            timing: "controlled-clock",
            designObservations: ["a reply changes trust"],
            screenshots: [
              {
                label: "recorded gameplay",
                mimeType: "image/png",
                data: "cmVjb3JkZWQ=",
                width: 1152,
                height: 648,
              },
            ],
          },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      expect(inputs.steps).toEqual(steps);
      expect(inputs.viewport).toEqual({ width: 1152, height: 648 });

      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs,
      });
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]?.exactSize).toBe(true);
      expect(checked.checks).toEqual([
        { id: "boot", status: "passed" },
        { id: "console", status: "passed", detail: "0 console errors" },
        {
          id: "input",
          status: "passed",
          detail: "1 input steps executed",
          measurements: {
            steps,
            changedPercent: 12,
            state: null,
            designObservations: ["a reply changes trust"],
          },
        },
        { id: "playtest", status: "passed" },
        { id: "window", status: "passed", detail: "900x900 window" },
      ]);
      expect(
        checked.frames.filter((frame) => frame.window !== true).map((frame) => frame.label),
      ).toEqual(["recorded gameplay"]);
      expect(checked.frames.filter((frame) => frame.window === true)).toHaveLength(2);
      expect(yield* Effect.promise(() => NodeFSP.readFile(checked.frames[0]!.path, "utf8"))).toBe(
        "recorded",
      );
      expect(checked.viewport).toEqual({ width: 1152, height: 648 });
    }),
  ),
);

it.live("a wall-time recorded pass replays instead of reusing controlled evidence", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const steps = [{ key: "ArrowRight", holdMs: 120 }];
      // No timing marker: wall-time evidence from before the controlled
      // driver. It must not be reused as a controlled-clock pass.
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps,
          result: { ...baseResult(), qualifies: true },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      expect(inputs.steps).toEqual(steps);
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs,
      });
      // A fresh route replay plus the alternate-window burst, not a reuse.
      expect(harness.calls.filter((call) => call?.exactSize !== true)).toHaveLength(1);
      expect(harness.calls).toHaveLength(2);
      expect(checked.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("missing cached pixels replay the route instead of aborting the review", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() => passedPlaytest(harness.root));
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      yield* Effect.promise(() =>
        NodeFSP.unlink(NodePath.join(harness.root, evidence.directory, "01-after-steps.png")),
      );
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs,
      });
      expect(harness.calls.filter((call) => call?.exactSize !== true)).toHaveLength(1);
      expect(checked.frames.length).toBeGreaterThan(0);
      expect(checked.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("a different frozen route replays instead of borrowing the builder's run", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ key: "ArrowRight", holdMs: 120 }],
          result: { ...baseResult(), qualifies: true },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const inputs = yield* studio.frozenInputs(harness.root, buildId);
      harness.results = {
        ...baseResult(),
        qualifies: false,
        blockers: ["no movement under the frozen route"],
      };
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId,
        inputs: { ...inputs, steps: [{ key: "ArrowLeft", holdMs: 120 }] },
      });
      const routeCalls = harness.calls.filter((call) => call?.exactSize !== true);
      expect(routeCalls).toHaveLength(1);
      expect(routeCalls[0]?.steps).toEqual([{ key: "ArrowLeft", holdMs: 120 }]);
      // The build's recorded pass is not evidence for this different route.
      expect(checked.checks.find((entry) => entry.id === "playtest")?.status).toBe("failed");
    }),
  ),
);

it.live("an invalid browser route is rejected before any playtest launches", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const failed = yield* studio
        .check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId: "a".repeat(64),
          inputs: { steps: [{ press: "ui_accept" }], viewport: null, seed: "unknown" },
        })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("invalid-input");
      expect(failed.detail).toContain('"ui_accept" is not a browser key');
      expect(failed.detail).toContain("game_scenarios_run");
      expect(harness.calls).toEqual([]);
    }),
  ),
);

it.live("submission names an invalid recorded route instead of passing it", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ press: "ui_accept" }],
          result: { ...baseResult(), qualifies: true },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      expect(facts.reason).toContain(
        "playtest: The recorded playtest route is not a browser route",
      );
      expect(facts.reason).toContain('"ui_accept" is not a browser key');
    }),
  ),
);

it.live("waits and screenshots cannot supply submission input, even with animated frames", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const buildId = yield* Effect.promise(() => makeBuild(harness.root));
      const evidence = yield* Effect.promise(() =>
        writePlaytestEvidence({
          root: harness.root,
          steps: [{ waitMs: 500 }, { screenshot: "animated" }],
          result: { ...baseResult(), executedInputSteps: 0 },
          at: FIRST_EVIDENCE_AT,
        }),
      );
      harness.exportStage = stage({ buildId });
      harness.playtestStage = stage({ buildId, evidenceDirectory: evidence.directory });
      const facts = yield* studio.submissionFacts(harness.root);
      expect(facts.passed).toBe(false);
      expect(facts.reason).toBe(
        "input: The playtest executed no input steps; waits and screenshots do not count.",
      );
    }),
  ),
);

it.live(
  "critic evidence uses eight complete persisted images even if the response omitted them",
  () =>
    withStudio((harness) =>
      Effect.gen(function* () {
        const studio = yield* GameRepairStudio.GameRepairStudio;
        const screenshots = Array.from({ length: 5 }, (_, stepIndex) => [
          {
            ...baseResult().screenshots[0]!,
            label: `input ${stepIndex} before`,
            inputPair: {
              stepIndex,
              phase: "before" as const,
              input: { key: "ArrowRight", holdMs: 1000 },
              changedPercent: 12,
              stateChanges: [{ key: "state.card", before: "ready", after: "chosen" }],
            },
          },
          {
            ...baseResult().screenshots[0]!,
            label: `input ${stepIndex} after`,
            inputPair: {
              stepIndex,
              phase: "after" as const,
              input: { key: "ArrowRight", holdMs: 1000 },
              changedPercent: 12,
              stateChanges: [{ key: "state.card", before: "ready", after: "chosen" }],
            },
          },
        ]).flat();
        const evidence = yield* Effect.promise(() =>
          writePlaytestEvidence({
            root: harness.root,
            steps: [],
            result: { ...baseResult(), screenshots },
          }),
        );
        harness.results = {
          ...baseResult(),
          screenshots: [],
          evidenceDirectory: evidence.directory,
        };
        const checked = yield* studio.check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId: "a".repeat(64),
          inputs: { steps: [{ key: "ArrowRight", holdMs: 1000 }], viewport: null, seed: null },
        });
        expect(checked.frames.map((frame) => frame.inputPair?.stepIndex)).toEqual([
          0,
          0,
          1,
          1,
          3,
          3,
          4,
          4,
          undefined,
          undefined,
        ]);
        expect(checked.frames[1]?.inputPair).toEqual(screenshots[1]?.inputPair);
        expect(yield* Effect.promise(() => NodeFSP.readFile(checked.frames[0]!.path, "utf8"))).toBe(
          "png",
        );
      }),
    ),
);

it.live("experiment replay keeps persisted frames omitted from the response before cleanup", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.persistExperiment = true;
      const result = yield* studio.experiment({
        threadId,
        root: harness.root,
        buildId: "a".repeat(64),
        steps: [{ press: "Space" }],
        captureEveryMs: 100,
        viewport: null,
      });
      expect(result.frames).toHaveLength(1);
      expect(yield* Effect.promise(() => NodeFSP.readFile(result.frames[0]!.path, "utf8"))).toBe(
        "png",
      );
    }),
  ),
);

const scenarioEvidenceWithLayout = (subject: string) =>
  JSON.stringify({
    id: "full-run",
    frames: 120,
    durationMs: 2000,
    firstInputFrame: 30,
    baselineFrame: 36,
    playerMoved: true,
    error: null,
    invalidActions: [],
    observations: [],
    layout: {
      findings: [
        {
          kind: "overlap-risk",
          subject,
          detail:
            'may be obscured by later sibling Panel "Footer" (overlap risk: 40% overlaps; visual occlusion not proven from geometry).',
          nodePath: "Main/Serve",
          scenarioFrame: 66,
          step: 1,
          viewport: { width: 1152, height: 648 },
        },
      ],
      coverage: {
        probes: 2,
        omittedProbes: 0,
        inspectedControls: 3,
        pairs: 4,
        truncated: false,
        viewport: { width: 1152, height: 648 },
      },
    },
  });

const writeScenarioEvidence = (root: string, directory: string, text: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, directory, "full-run.result.json"), text);
  });

const checkInputs = {
  steps: [{ press: "Space" }],
  viewport: { width: 960, height: 540 },
  seed: "unknown",
} as const;

it.live("an incumbent check binds same-source scenario layout as critic hints", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "qualified-inputs" };
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithLayout('Button "Serve"'),
      );
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs: { ...checkInputs, steps: [...checkInputs.steps] },
      });
      // The hints ride beside the checks, never as one: no gate was added.
      expect(checked.checks.some((check) => check.id === "native-layout")).toBe(false);
      expect(checked.nativeDiagnostics).toMatchObject({
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      });
      const text = checked.nativeDiagnostics!.text;
      expect(text).toContain('Button "Serve"');
      expect(text).toContain("full-run");
      expect(text).toContain("route step 2");
      expect(text).toContain("game_try_input");
      expect(text.length).toBeLessThanOrEqual(3_000);
    }),
  ),
);

it.live("stale or missing scenario evidence selects no native hints", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithLayout('Button "Serve"'),
      );
      const inputs = { ...checkInputs, steps: [...checkInputs.steps] };
      // Stale: the state record names other sources than the build.
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "other-sources",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      const stale = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(stale.nativeDiagnostics).toBeUndefined();
      // Missing: no state record at all still checks the build.
      harness.stateStage = null;
      const missing = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(missing.nativeDiagnostics).toBeUndefined();
      expect(missing.checks.find((check) => check.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("candidate checks carry no native hints even with same-source evidence", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "fixture",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithLayout('Button "Serve"'),
      );
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs: { ...checkInputs, steps: [...checkInputs.steps] },
      });
      // The evidence predates the repair, so it cannot describe the candidate.
      expect(checked.nativeDiagnostics).toBeUndefined();
    }),
  ),
);

it.live("native hints never follow scenario evidence symlinks outside the game", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "fixture" };
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "fixture",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* Effect.promise(async () => {
        const outside = NodePath.join(NodePath.dirname(harness.root), "outside.result.json");
        await NodeFSP.writeFile(outside, scenarioEvidenceWithLayout('Button "Outside"'));
        const directory = NodePath.join(harness.root, "builds/logs/scenarios-1");
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.symlink(outside, NodePath.join(directory, "full-run.result.json"));
      });
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs: { ...checkInputs, steps: [...checkInputs.steps] },
      });
      expect(checked.nativeDiagnostics).toBeUndefined();
      expect(checked.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("native hints require the matching build's passed qualification export", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithLayout('Button "Serve"'),
      );
      const valid = { ...stage({ buildId: "a".repeat(64) }), sourceId: "qualified-inputs" };
      for (const record of [
        { ...valid, buildId: "b".repeat(64) },
        { ...valid, sourceId: "other-inputs" },
        { ...valid, outcome: "failed" as const },
        null,
      ]) {
        harness.exportStage = record;
        const checked = yield* studio.check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId: "a".repeat(64),
          inputs: { ...checkInputs, steps: [...checkInputs.steps] },
        });
        expect(checked.nativeDiagnostics).toBeUndefined();
      }
    }),
  ),
);

it.live("experiment frames retain an end-state key late in the bounded probe", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const counters = Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`a${String(index).padStart(2, "0")}`, index]),
      );
      harness.persistExperiment = true;
      harness.results = {
        ...baseResult(),
        screenshots: (["before", "after"] as const).map((phase) => ({
          ...baseResult().screenshots[0]!,
          label: phase,
          inputPair: {
            stepIndex: 0,
            phase,
            input: { press: "Space" },
            changedPercent: 0,
            stateChanges: [],
          },
          probe: { ...probe(phase), gameState: { ...counters, won: phase === "after" } },
        })),
      };
      const result = yield* studio.experiment({
        threadId,
        root: harness.root,
        buildId: "a".repeat(64),
        steps: [{ press: "Space" }],
        captureEveryMs: 1000,
        viewport: { width: 1152, height: 648 },
      });
      expect(result.frames[0]?.observations?.won).toBe(false);
      expect(result.frames[1]?.observations?.won).toBe(true);
    }),
  ),
);

const scenarioSpatialPayload = () => ({
  snapshots: [
    {
      scenarioFrame: 30,
      step: null,
      player: {
        present: true,
        position: [100, 200],
        velocity: [0, 0],
        bodyKind: "CharacterBody2D",
      },
      areas: [
        {
          nodePath: "Main/Zone",
          type: "Area2D",
          monitoring: true,
          monitorable: true,
          visible: true,
          shapes: [
            {
              nodePath: "Main/Zone/Shape",
              shapeKind: "RectangleShape2D",
              disabled: false,
              bounds: { kind: "rect2", min: [50, 150], max: [150, 250] },
              conservative: false,
              containsPlayerOrigin: true,
            },
          ],
        },
      ],
    },
  ],
  coverage: {
    snapshots: 1,
    omittedSnapshots: 0,
    visitedNodes: 42,
    areas: 1,
    shapes: 1,
    skippedFreed: 0,
    truncated: false,
  },
});

const scenarioEvidenceWithSpatial = () =>
  JSON.stringify({
    id: "full-run",
    frames: 120,
    durationMs: 2000,
    firstInputFrame: 30,
    baselineFrame: 36,
    playerMoved: true,
    error: null,
    invalidActions: [],
    observations: [],
    spatial: scenarioSpatialPayload(),
  });

it.live("an incumbent check binds same-source spatial even with zero layout findings", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "qualified-inputs" };
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithSpatial(),
      );
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs: { ...checkInputs, steps: [...checkInputs.steps] },
      });
      // Zero layout findings still deliver the world packet, never as a gate.
      expect(checked.checks.some((check) => check.id === "native-world")).toBe(false);
      expect(checked.nativeDiagnostics).toBeUndefined();
      expect(checked.nativeWorld).toMatchObject({
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      });
      const text = checked.nativeWorld!.text;
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).toContain("full-run");
      expect(text).toContain("containsPlayerOrigin");
      expect(text).toContain("headless world measurements");
      expect(text).toContain("never cite as proof");
      expect(text.length).toBeLessThanOrEqual(32_768);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32_768);
      expect(checked.checks.find((check) => check.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("candidate checks carry no native world even with same-source evidence", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "fixture" };
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "fixture",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithSpatial(),
      );
      const checked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "candidate",
        buildId: "a".repeat(64),
        inputs: { ...checkInputs, steps: [...checkInputs.steps] },
      });
      // The evidence predates the repair, so it cannot describe the candidate.
      // Ballot evidence likewise never carries native files: only the
      // incumbent check binds them, never a gate or ballot change.
      expect(checked.nativeWorld).toBeUndefined();
      expect(checked.nativeDiagnostics).toBeUndefined();
      expect(checked.checks.find((check) => check.id === "boot")?.status).toBe("passed");
    }),
  ),
);

it.live("mismatched source or failed export omits the world without invalidating the build", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      yield* writeScenarioEvidence(
        harness.root,
        "builds/logs/scenarios-1",
        scenarioEvidenceWithSpatial(),
      );
      const inputs = { ...checkInputs, steps: [...checkInputs.steps] };
      // Stale: state names other sources than the build.
      harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "qualified-inputs" };
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "other-sources",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      expect(
        (yield* studio.check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId: "a".repeat(64),
          inputs,
        })).nativeWorld,
      ).toBeUndefined();
      // Missing state record still checks the build.
      harness.stateStage = null;
      const missing = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(missing.nativeWorld).toBeUndefined();
      expect(missing.checks.find((check) => check.id === "boot")?.status).toBe("passed");
      // The matching build needs its own passed export: different build,
      // different source, failed outcome, or no record all omit honestly.
      harness.stateStage = {
        ...stage({ buildId: "a".repeat(64) }),
        sourceId: "qualified-inputs",
        evidenceDirectory: "builds/logs/scenarios-1",
      };
      const valid = { ...stage({ buildId: "a".repeat(64) }), sourceId: "qualified-inputs" };
      for (const record of [
        { ...valid, buildId: "b".repeat(64) },
        { ...valid, sourceId: "other-inputs" },
        { ...valid, outcome: "failed" as const },
        null,
      ]) {
        harness.exportStage = record;
        const checked = yield* studio.check({
          threadId,
          root: harness.root,
          target: "incumbent",
          buildId: "a".repeat(64),
          inputs,
        });
        expect(checked.nativeWorld).toBeUndefined();
        expect(checked.checks.find((check) => check.id === "boot")?.status).toBe("passed");
      }
    }),
  ),
);

it.live("unreadable, symlink or oversized scenario evidence omits the world honestly", () =>
  withStudio((harness) =>
    Effect.gen(function* () {
      const studio = yield* GameRepairStudio.GameRepairStudio;
      const inputs = { ...checkInputs, steps: [...checkInputs.steps] };
      const bind = () => {
        harness.exportStage = { ...stage({ buildId: "a".repeat(64) }), sourceId: "fixture" };
        harness.stateStage = {
          ...stage({ buildId: "a".repeat(64) }),
          sourceId: "fixture",
          evidenceDirectory: "builds/logs/scenarios-1",
        };
      };
      // Unreadable: invalid JSON never invalidates the playable artifact.
      bind();
      yield* writeScenarioEvidence(harness.root, "builds/logs/scenarios-1", "not json");
      const unreadable = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(unreadable.nativeWorld).toBeUndefined();
      expect(unreadable.checks.find((check) => check.id === "boot")?.status).toBe("passed");
      // Symlink outside the game is never followed.
      bind();
      yield* Effect.promise(async () => {
        const outside = NodePath.join(NodePath.dirname(harness.root), "outside-world.result.json");
        await NodeFSP.writeFile(outside, scenarioEvidenceWithSpatial());
        const directory = NodePath.join(harness.root, "builds/logs/scenarios-1");
        await NodeFSP.rm(directory, { recursive: true, force: true });
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.symlink(outside, NodePath.join(directory, "full-run.result.json"));
      });
      const linked = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(linked.nativeWorld).toBeUndefined();
      expect(linked.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
      // Oversized result files are skipped by the bounded reader.
      bind();
      yield* Effect.promise(async () => {
        const directory = NodePath.join(harness.root, "builds/logs/scenarios-1");
        await NodeFSP.rm(directory, { recursive: true, force: true });
        await NodeFSP.mkdir(directory, { recursive: true });
        const large = `${scenarioEvidenceWithSpatial().slice(0, -2)},"pad":"${"x".repeat(210_000)}"}`;
        await NodeFSP.writeFile(NodePath.join(directory, "full-run.result.json"), large);
      });
      const oversized = yield* studio.check({
        threadId,
        root: harness.root,
        target: "incumbent",
        buildId: "a".repeat(64),
        inputs,
      });
      expect(oversized.nativeWorld).toBeUndefined();
      expect(oversized.checks.find((entry) => entry.id === "boot")?.status).toBe("passed");
    }),
  ),
);
