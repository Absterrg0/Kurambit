// @effect-diagnostics nodeBuiltinImport:off -- Proves runtime calibration wiring with mocked native executables.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadId, type GameManifest, type GameProcessResult } from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

afterEach(() => vi.unstubAllEnvs());

const threadId = ThreadId.make("runtime-calibrate-test");
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Runtime calibrate",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
};

const projectGodot = `[application]
config/name="Runtime calibrate"

[display]
window/size/viewport_width=960
window/size/viewport_height=540

[input]
move_right={
}
`;

const winRoute = { id: "win-run", steps: [{ press: "move_right" }] };

type Plan = "equivalent" | "cross-different" | "run-error" | "change-sources" | "hang";

const resultFor = (directory: string): GameProcessResult => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: NodePath.join(directory, "builds/logs/fake.log"),
});

interface SeenRun {
  readonly fps: string | null;
  readonly dataDir: string | null;
  readonly seed: unknown;
  readonly scenarioPath: string | null;
}

interface Fixture {
  readonly root: string;
  readonly game: GameService.GameService["Service"];
  readonly seen: SeenRun[];
  readonly started: Deferred.Deferred<void>;
}

const withFixture = <A, E>(
  plan: Plan,
  run: (fixture: Fixture) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runtime-calibrate-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests/scenarios"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/logs"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), projectGodot);
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/scenarios/win-run.json"),
          JSON.stringify(winRoute),
        );
      });
      const seen: SeenRun[] = [];
      let calls = 0;
      const started = yield* Deferred.make<void>();
      const processes = Layer.mock(GameProcesses.GameProcesses)({
        run: (input) =>
          Effect.gen(function* () {
            if (input.operation === "godot-import") return resultFor(root);
            if (input.operation === "runtime-calibrate") {
              yield* Deferred.succeed(started, undefined);
              if (plan === "hang") return yield* Effect.never;
              if (plan === "change-sources" && calls === 0)
                yield* Effect.promise(() =>
                  NodeFSP.writeFile(NodePath.join(root, "godot/touched.gd"), "extends Node\n"),
                );
              const fpsIndex = input.args.indexOf("--fixed-fps");
              const fps = fpsIndex >= 0 ? String(input.args[fpsIndex + 1]) : null;
              const requestPath = input.args[input.args.indexOf("--") + 1]!;
              const resultPath = input.args[input.args.indexOf("--") + 2]!;
              const request = JSON.parse(
                yield* Effect.promise(() => NodeFSP.readFile(requestPath, "utf8")),
              ) as { seed?: unknown; scenarioPath?: unknown };
              const expectedPrefix = (request as Record<string, unknown>)[
                "expectedUserDataPrefix"
              ] as string;
              seen.push({
                fps,
                dataDir: (input.env?.XDG_DATA_HOME as string | undefined) ?? null,
                seed: request.seed ?? null,
                scenarioPath: (request.scenarioPath as string | undefined) ?? null,
              });
              const index = calls;
              calls += 1;
              const isolatedDir = `${expectedPrefix}/godot/app_userdata/game`;
              const collected =
                plan === "cross-different" && fps === "60"
                  ? 5
                  : plan === "run-error" && index === 2
                    ? 6
                    : 6;
              const error =
                plan === "run-error" && index === 2 ? "The runner failed this run." : null;
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  resultPath,
                  JSON.stringify({
                    id: "win-run",
                    frames: 100,
                    durationMs: 10,
                    firstInputFrame: 30,
                    baselineFrame: 32,
                    playerMoved: true,
                    error,
                    invalidActions: [],
                    observations: [
                      {
                        key: "state",
                        min: 0,
                        max: 1,
                        first: 0,
                        last: 1,
                        firstChangeFrame: 40,
                        baseline: 0,
                        matches: [],
                      },
                      {
                        key: "collected",
                        min: 0,
                        max: 6,
                        first: 0,
                        last: collected,
                        firstChangeFrame: 40,
                        baseline: 0,
                        matches: [],
                      },
                    ],
                    userDataDir: isolatedDir,
                    playerFirst: [0, 0],
                    playerBaseline: [1, 1],
                    playerLast: [3, 4],
                    enginePhysicsFrames: 100,
                    renderFrames: fps === "60" ? 100 : 50,
                    physicsHz: 60,
                    timeline: [],
                  }),
                ),
              );
              return resultFor(root);
            }
            return yield* Effect.die(
              `Unexpected runtime calibration operation ${input.operation}.`,
            );
          }),
        stop: () => Effect.void,
        list: () => [],
      });
      const services = GameService.layer.pipe(
        Layer.provideMerge(processes),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({
                path: NodePath.join(root, "godot-fake"),
                version: "4.7.2",
                templates: null,
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            serving: () => false,
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
          }),
        ),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () =>
              Effect.succeed({
                state: "approved",
                document: null,
                documentTruncated: false,
                approvedHash: null,
                currentHash: null,
                approvedAt: null,
                acceptance: [],
                issues: [],
                autoRevision: 0,
                pendingRevision: null,
                revisionDiff: null,
              }),
            snapshot: () =>
              Effect.succeed({
                read: {
                  state: "legacy",
                  document: null,
                  documentTruncated: false,
                  approvedHash: null,
                  currentHash: null,
                  approvedAt: null,
                  acceptance: [],
                  issues: [],
                  autoRevision: 0,
                  pendingRevision: null,
                  revisionDiff: null,
                },
                record: null,
              }),
          }),
        ),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(roundStoreTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(admissionTestLayer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        return yield* run({ root, game, seen, started });
      }).pipe(Effect.provide(services));
    }),
  );

it.effect("refuses an unknown scenario without running anything", () =>
  withFixture("equivalent", (fixture) =>
    Effect.gen(function* () {
      const error = yield* fixture.game
        .runtimeCalibrate(threadId, { scenarioId: "nope" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(fixture.seen).toHaveLength(0);
    }),
  ),
);

it.effect("refuses an escaping custom user directory instead of claiming clean state", () =>
  withFixture("equivalent", (fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "godot/project.godot"),
          `${projectGodot}\n[application]\nconfig/use_custom_user_dir=true\nconfig/custom_user_dir_name="../../escape"\n`,
        ),
      );
      const error = yield* fixture.game
        .runtimeCalibrate(threadId, { scenarioId: "win-run" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid-input");
      expect(fixture.seen).toHaveLength(0);
    }),
  ),
);

it.effect("runs every repeat with the same route, seed and source under separate userdata", () =>
  withFixture("equivalent", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.runtimeCalibrate(threadId, { scenarioId: "win-run" });
      expect(result.verdict).toBe("equivalent");
      expect(result.runs).toHaveLength(4);
      expect(result.seed).toBe(12345);
      expect(result.physicsHz).toBe(60);
      expect(result.sourceId).toMatch(/^[0-9a-f]{64}$/);
      // Same route and seed on every run.
      expect(new Set(fixture.seen.map((run) => run.seed))).toEqual(new Set([12345]));
      for (const run of fixture.seen) expect(run.scenarioPath).toContain("win-run.json");
      // Separate userdata per run: four distinct isolated data dirs.
      const dirs = fixture.seen.map((run) => run.dataDir);
      expect(new Set(dirs).size).toBe(4);
      for (const run of result.runs) expect(run.userDataDirIsolated).toBe(true);
      // Physical displacement is genuinely observed, not assumed.
      for (const run of result.runs) expect(run.playerDisplacement).toBeCloseTo(3.6056, 3);
      expect(result.comparedCount).toBeGreaterThan(0);
      expect(result.unknownCount).toBe(0);
      expect(result.message).toContain("tested route and settings only");
      const calibration = NodePath.join(fixture.root, result.calibrationPath);
      expect(yield* Effect.promise(() => NodeFSP.stat(calibration))).toBeDefined();
    }),
  ),
);

it.effect("reports cross-rate divergence with concrete differences", () =>
  withFixture("cross-different", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.runtimeCalibrate(threadId, { scenarioId: "win-run" });
      expect(result.verdict).toBe("different");
      expect(
        result.comparisons.some((entry) =>
          entry.differences.some((difference) => difference.includes("GameState.collected")),
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("marks a failed run unknown, never equivalent", () =>
  withFixture("run-error", (fixture) =>
    Effect.gen(function* () {
      const result = yield* fixture.game.runtimeCalibrate(threadId, { scenarioId: "win-run" });
      expect(result.verdict).toBe("unknown");
      expect(result.runs.some((run) => run.error !== null)).toBe(true);
      expect(result.unknownCount).toBeGreaterThan(0);
    }),
  ),
);

it.effect("refuses changed sources instead of certifying them", () =>
  withFixture("change-sources", (fixture) =>
    Effect.gen(function* () {
      const error = yield* fixture.game
        .runtimeCalibrate(threadId, { scenarioId: "win-run" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("command-failed");
      expect(error.message).toContain("changed");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, "builds/runtime-calibrate")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("cleans up a cancelled calibration", () =>
  withFixture("hang", (fixture) =>
    Effect.gen(function* () {
      const fiber = yield* fixture.game
        .runtimeCalibrate(threadId, { scenarioId: "win-run" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.started);
      yield* Fiber.interrupt(fiber);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(fixture.root, "builds/runtime-calibrate")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  ),
);

it.effect("keeps the render cadence in Godot while converting only the encoding", () =>
  withFixture("equivalent", (fixture) =>
    Effect.gen(function* () {
      // The render/encode split is proven by the helper args contract: the
      // service passes the render rate to --fixed-fps and converts only the
      // FFmpeg transcode with -r. The calibration sweep itself always runs
      // each cadence headlessly at its own render rate.
      const result = yield* fixture.game.runtimeCalibrate(threadId, {
        scenarioId: "win-run",
        cadences: [30, 60],
      });
      expect(result.cadences).toEqual([30, 60]);
      expect(fixture.seen.map((run) => run.fps).sort()).toEqual(["30", "30", "60", "60"]);
    }),
  ),
);

it.effect("splits native capture render cadence from encode-only output rate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-output-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests/scenarios"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "builds/logs"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "bin"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(root, "godot/project.godot"), projectGodot);
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/scenarios/win-run.json"),
          JSON.stringify(winRoute),
        );
        for (const tool of ["xvfb-run", "ffmpeg", "ffprobe"])
          await NodeFSP.writeFile(NodePath.join(root, "bin", tool), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          });
      });
      vi.stubEnv("PATH", NodePath.join(root, "bin"));
      let godotFps: string | null = null;
      let transcodeRate: string | null = null;
      const processes = Layer.mock(GameProcesses.GameProcesses)({
        run: (input) =>
          Effect.gen(function* () {
            if (input.operation === "godot-import") return resultFor(root);
            if (input.operation === "native-capture") {
              const fpsIndex = input.args.indexOf("--fixed-fps");
              godotFps = fpsIndex >= 0 ? String(input.args[fpsIndex + 1]) : null;
              const resultPath = input.args[input.args.indexOf("--") + 2]!;
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  resultPath,
                  JSON.stringify({
                    id: "win-run",
                    frames: 32,
                    physicsHz: 60,
                    playerMoved: true,
                    error: null,
                    timeline: [],
                  }),
                ),
              );
              return resultFor(root);
            }
            if (input.operation === "native-capture-transcode") {
              const rateIndex = input.args.indexOf("-r");
              transcodeRate = rateIndex >= 0 ? String(input.args[rateIndex + 1]) : null;
              yield* Effect.promise(() =>
                NodeFSP.writeFile(input.args[input.args.length - 1]!, "fake-mp4"),
              );
              return resultFor(root);
            }
            if (input.operation === "native-capture-probe")
              return {
                ...resultFor(root),
                stdout: JSON.stringify({
                  streams: [
                    {
                      width: 960,
                      height: 540,
                      r_frame_rate: "60/1",
                      avg_frame_rate: "60/1",
                      nb_frames: "47",
                      codec_name: "h264",
                      duration: "0.783333",
                    },
                  ],
                }),
              };
            if (input.operation === "native-capture-poster") {
              yield* Effect.promise(() =>
                NodeFSP.writeFile(input.args[input.args.length - 1]!, "fake-png"),
              );
              return resultFor(root);
            }
            return yield* Effect.die(`Unexpected operation ${input.operation}.`);
          }),
        stop: () => Effect.void,
        list: () => [],
      });
      const services = GameService.layer.pipe(
        Layer.provideMerge(processes),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            read: () => Effect.succeed(manifest),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () =>
              Effect.succeed({
                path: NodePath.join(root, "godot-fake"),
                version: "4.7.2",
                templates: null,
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            serving: () => false,
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
          }),
        ),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () =>
              Effect.succeed({
                state: "approved",
                document: null,
                documentTruncated: false,
                approvedHash: null,
                currentHash: null,
                approvedAt: null,
                acceptance: [],
                issues: [],
                autoRevision: 0,
                pendingRevision: null,
                revisionDiff: null,
              }),
            snapshot: () =>
              Effect.succeed({
                read: {
                  state: "legacy",
                  document: null,
                  documentTruncated: false,
                  approvedHash: null,
                  currentHash: null,
                  approvedAt: null,
                  acceptance: [],
                  issues: [],
                  autoRevision: 0,
                  pendingRevision: null,
                  revisionDiff: null,
                },
                record: null,
              }),
          }),
        ),
        Layer.provide(previewBrowserTestLayer()),
        Layer.provideMerge(qualificationTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(roundStoreTestLayer(NodePath.join(root, ".test-state"))),
        Layer.provideMerge(admissionTestLayer),
      );
      const game = yield* Effect.gen(function* () {
        return yield* GameService.GameService;
      }).pipe(Effect.provide(services));
      // Render 30, encode 60: Godot still runs at the render cadence while
      // only the transcode converts. The disk preflight reserves the raw
      // render-cadence frames, never the output-only count.
      const result = yield* game.nativeCapture(threadId, {
        scenarioId: "win-run",
        fps: 30,
        outputFps: 60,
      });
      expect(godotFps).toBe("30");
      expect(transcodeRate).toBe("60");
      expect(result.requestedFps).toBe(30);
      expect(result.renderFps).toBe(30);
      expect(result.requestedOutputFps).toBe(60);
      expect(result.actualFps).toBe(60);
    }),
  ),
);
