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
          Effect.succeed(stage === "export" ? harness.exportStage : harness.playtestStage),
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
        reason: "invalid-input",
        detail: "Step 1 pointer coordinates exceed the frozen 640×360 viewport.",
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
        detail: expect.stringContaining("Step 1 pointer coordinates exceed"),
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
        reason: "invalid-input",
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
    result: baseResult(),
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

it.live.each([false, undefined])(
  "submission uses raw facts when gameplay qualification is %s",
  (qualifies) =>
    withStudio((harness) =>
      Effect.gen(function* () {
        const studio = yield* GameRepairStudio.GameRepairStudio;
        const buildId = yield* Effect.promise(() => makeBuild(harness.root));
        const evidence = yield* Effect.promise(() =>
          writePlaytestEvidence({
            root: harness.root,
            steps: [{ click: "left" }],
            result: {
              ...baseResult(),
              responded: false,
              changedPercent: 0,
              ...(qualifies === undefined ? {} : { qualifies }),
              blockers: ["no movement or design progress"],
            },
            at: FIRST_EVIDENCE_AT,
          }),
        );
        harness.exportStage = stage({ buildId });
        harness.playtestStage = {
          ...stage({ buildId, evidenceDirectory: evidence.directory, outcome: "failed" }),
          detail: "Interaction: none.",
        };
        expect((yield* studio.submissionFacts(harness.root)).passed).toBe(true);
        yield* Effect.promise(() =>
          writePlaytestEvidence({
            root: harness.root,
            steps: [{ click: "left" }],
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
        expect(refused.reason).not.toContain("input:");
        expect(refused.reason).not.toContain("qualification");
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
