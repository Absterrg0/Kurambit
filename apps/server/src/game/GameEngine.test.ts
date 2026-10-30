// @effect-diagnostics nodeBuiltinImport:off -- Tests the engine adapter seam with mocked processes and real temporary game files.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RunId,
  ThreadId,
  type GameManifest,
  type GameProcessResult,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GameEngine from "./GameEngine.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("game-engine-test");

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Engine seam probe",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});

const checkReport = (errors: readonly string[] = []) =>
  JSON.stringify({
    mainScene: "res://scenes/main.tscn",
    entries: ["main", "gameplay"],
    errors: errors.map((message) => ({ file: "res://scripts/main.gd", message })),
    warnings: [],
  });

const playtestResult = (): GameWebPlaytestResult => ({
  success: true,
  timing: "controlled-clock",
  booted: true,
  bootMs: 20,
  responded: true,
  executedInputSteps: 1,
  changedPercent: 14,
  message: "Playtest succeeded: fake run.",
  consoleMessages: [],
  screenshots: [
    { label: "booted", mimeType: "image/png", data: "cG5n", width: 640, height: 360 },
    { label: "after-steps", mimeType: "image/png", data: "cG5n", width: 640, height: 360 },
  ],
  state: null,
  qualifies: true,
  blockers: [],
  interaction: "fake response",
});

interface RecordedCall {
  readonly operation: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

interface FixtureOptions {
  readonly manifest?: GameManifest;
  readonly checkFails?: boolean;
  readonly mutateOnCheck?: boolean;
  readonly testFails?: boolean;
  readonly exportFails?: boolean;
  readonly gateCheck?: Deferred.Deferred<void>;
  readonly enteredCheck?: Deferred.Deferred<void>;
}

interface Fixture {
  readonly root: string;
  readonly game: GameService.GameService["Service"];
  readonly qualification: GameQualification.GameQualification["Service"];
  readonly calls: ReadonlyArray<RecordedCall>;
  readonly executableCalls: () => number;
}

const processResult = (
  root: string,
  overrides: Partial<GameProcessResult> = {},
): GameProcessResult => ({
  pid: 1000,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: NodePath.join(root, "builds/logs/mock.log"),
  ...overrides,
});

const withFixture = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E>,
  options: FixtureOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-engine-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot/scripts"), { recursive: true });
        await NodeFSP.mkdir(NodePath.join(root, "godot/tests"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/project.godot"),
          "[application]\n\n[display]\nwindow/size/viewport_width=960\nwindow/size/viewport_height=540\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "godot/scripts/main.gd"), "extends Node\n");
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/tests/smoke_test.gd"),
          "extends SceneTree\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), JSON.stringify(manifest()));
      });
      const current = options.manifest ?? manifest();
      const calls: RecordedCall[] = [];
      let executableCalls = 0;
      const gameLayer = GameService.layerWithPlaytest(() => Effect.succeed(playtestResult())).pipe(
        Layer.provideMerge(
          Layer.mock(GameProcesses.GameProcesses)({
            run: (input) =>
              Effect.gen(function* () {
                calls.push({
                  operation: input.operation,
                  executable: input.executable,
                  args: [...input.args],
                });
                if (input.operation === "godot-import") return processResult(root);
                if (input.operation === "godot-check") {
                  if (options.enteredCheck !== undefined)
                    yield* Deferred.succeed(options.enteredCheck, undefined);
                  if (options.gateCheck !== undefined) yield* Deferred.await(options.gateCheck);
                  if (options.mutateOnCheck === true)
                    yield* Effect.promise(() =>
                      NodeFSP.appendFile(
                        NodePath.join(root, "godot/scripts/main.gd"),
                        "\n# edited during the check\n",
                      ),
                    );
                  const separator = input.args.indexOf("--");
                  const resultPath = String(input.args[separator + 1]);
                  yield* Effect.promise(() =>
                    NodeFSP.writeFile(
                      resultPath,
                      checkReport(options.checkFails === true ? ["exact-check-diagnostic"] : []),
                    ),
                  );
                  return options.checkFails === true
                    ? processResult(root, {
                        exitCode: 1,
                        stderr: "SCRIPT ERROR: exact-check-diagnostic",
                      })
                    : processResult(root);
                }
                if (input.operation === "godot-test")
                  return options.testFails === true
                    ? processResult(root, {
                        exitCode: 1,
                        stderr: "SCRIPT ERROR: exact-test-diagnostic",
                      })
                    : processResult(root);
                if (input.operation === "export-web") {
                  if (options.exportFails === true)
                    return processResult(root, {
                      exitCode: 1,
                      stderr: "SCRIPT ERROR: exact-export-diagnostic",
                    });
                  const outputPath = String(input.args[input.args.length - 1]);
                  yield* Effect.promise(async () => {
                    await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
                    await NodeFSP.writeFile(outputPath, "x");
                    const stem = outputPath.replace(/\.html$/, "");
                    await NodeFSP.writeFile(`${stem}.wasm`, "x");
                    await NodeFSP.writeFile(`${stem}.js`, "x");
                    await NodeFSP.writeFile(`${stem}.pck`, "x");
                  });
                  return processResult(root);
                }
                return processResult(root);
              }),
            stop: () => Effect.void,
            list: () => [],
          }),
        ),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            activeRun: () => Effect.succeed(RunId.make("run:engine")),
            read: () => Effect.succeed(current),
            inventory: () =>
              Effect.succeed({
                manifest: current,
                design: null,
                designPath: null,
                briefPath: null,
                assets: [],
                scenes: [],
                builds: [],
                viewport: { width: 960, height: 540 },
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () => {
              executableCalls += 1;
              return Effect.succeed({ path: "/mock/godot", version: "4.7.2", templates: null });
            },
            status: Effect.succeed({
              toolsDirectory: base,
              installing: false,
              tools: [
                {
                  tool: "godot" as const,
                  path: "/mock/godot",
                  version: "4.7.2",
                  ready: true,
                  verified: true,
                  message: "stub",
                },
              ],
            }),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            directories: () => [],
            open: (_root, directory) => Effect.succeed(`http://127.0.0.1:9/${directory}`),
            select: (_root, directory) => Effect.succeed(`http://127.0.0.1:9/${directory}`),
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provide(previewBrowserTestLayer("fake-browser")),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const qualification = yield* GameQualification.GameQualification;
        return yield* body({
          root,
          game,
          qualification,
          calls,
          executableCalls: () => executableCalls,
        });
      }).pipe(Effect.provide(gameLayer));
    }),
  );

/** The registry on its own: validation must precede any toolchain lookup. */
const withEngineRegistry = <A, E>(
  body: (fixture: {
    readonly engines: GameEngine.GameEngine["Service"];
    readonly executableCalls: () => number;
  }) => Effect.Effect<A, E>,
  options: { readonly manifest?: GameManifest } = {},
) => {
  const current = options.manifest ?? manifest();
  let executableCalls = 0;
  const registryLayer = GameEngine.layer.pipe(
    Layer.provide(
      Layer.mock(GameProjectService.GameProjectService)({
        resolve: (threadId) => Effect.succeed(`/mock/${String(threadId)}`),
        activeRun: () => Effect.succeed(RunId.make("run:engine")),
        read: () => Effect.succeed(current),
        inventory: () =>
          Effect.succeed({
            manifest: current,
            design: null,
            designPath: null,
            briefPath: null,
            assets: [],
            scenes: [],
            builds: [],
            viewport: { width: 960, height: 540 },
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GameToolchain.GameToolchain)({
        executable: () => {
          executableCalls += 1;
          return Effect.succeed({ path: "/mock/godot", version: "4.7.2", templates: null });
        },
      }),
    ),
    Layer.provide(
      Layer.mock(GameProcesses.GameProcesses)({
        run: () => Effect.die("The registry never runs a process."),
        stop: () => Effect.void,
        list: () => [],
      }),
    ),
  );
  return Effect.gen(function* () {
    const engines = yield* GameEngine.GameEngine;
    return yield* body({ engines, executableCalls: () => executableCalls });
  }).pipe(Effect.provide(registryLayer));
};

it.effect("resolves the godot backend and parses its project settings", () =>
  withEngineRegistry(({ engines }) =>
    Effect.gen(function* () {
      const backend = yield* engines.backendFor("godot");
      expect(backend.id).toBe("godot");
      expect(backend.capabilities).toEqual({ scenarios: true, classDbApi: true });
      expect(
        backend.projectSettings(
          "[display]\nwindow/size/viewport_width=800\nwindow/size/viewport_height=600\n",
        ).viewport,
      ).toEqual({ width: 800, height: 600 });
      // Godot's own default when the project sets no viewport.
      expect(backend.projectSettings("[application]\n").viewport).toEqual({
        width: 1152,
        height: 648,
      });
      expect(backend.parseDiagnostics("SCRIPT ERROR: boom\n  at: foo (res://a.gd:3)\n")).toEqual([
        { file: "res://a.gd", line: 3, message: "boom" },
      ]);
    }),
  ),
);

it.effect("refuses an unsupported engine before any toolchain lookup", () =>
  withEngineRegistry(({ engines, executableCalls }) =>
    Effect.gen(function* () {
      for (const name of ["unity", "__proto__", "constructor", "toString"]) {
        const attempted = yield* Effect.result(engines.backendFor(name));
        expect(Result.isFailure(attempted), name).toBe(true);
        if (Result.isFailure(attempted)) {
          expect(attempted.failure.reason).toBe("invalid-input");
          expect(attempted.failure.detail).toContain("Unsupported game engine");
          expect(attempted.failure.detail).toContain("godot");
        }
      }
      expect(executableCalls()).toBe(0);
    }),
  ),
);

it.effect("resolve validates the engine before resolving its executable", () =>
  withEngineRegistry(
    ({ engines, executableCalls }) =>
      Effect.gen(function* () {
        const attempted = yield* Effect.result(engines.resolve("/mock/game"));
        expect(Result.isFailure(attempted)).toBe(true);
        if (Result.isFailure(attempted)) expect(attempted.failure.reason).toBe("invalid-input");
        expect(executableCalls()).toBe(0);
      }),
    {
      manifest: {
        ...manifest(),
        engine: { name: "unreal" },
      } as unknown as GameManifest,
    },
  ),
);

it.effect("routes import, check and test through the registered backend", () =>
  withFixture(({ game, root, calls, qualification }) =>
    Effect.gen(function* () {
      const imported = yield* game.import(threadId);
      expect(imported.success).toBe(true);
      const checked = yield* game.check(threadId);
      expect(checked.ok).toBe(true);
      expect(checked.entries).toEqual(["main", "gameplay"]);
      const tested = yield* game.test(threadId, "res://tests/smoke_test.gd");
      expect(tested.success).toBe(true);
      const operations = calls.map((call) => call.operation);
      expect(operations).toEqual(["godot-import", "godot-import", "godot-check", "godot-test"]);
      // Every engine invocation goes to the resolved binary with the game's
      // project directory, never a shell or a guessed path.
      for (const call of calls) {
        expect(call.executable).toBe("/mock/godot");
        expect(call.args).toContain(NodePath.join(root, "godot"));
      }
      const checkCall = calls.find((call) => call.operation === "godot-check")!;
      expect(checkCall.args).toContain("--script");
      expect(checkCall.args[checkCall.args.indexOf("--script") + 1]?.endsWith("check.gd")).toBe(
        true,
      );
      const testCall = calls.find((call) => call.operation === "godot-test")!;
      expect(testCall.args).toContain(NodePath.join(root, "godot/tests/smoke_test.gd"));
      const read = yield* qualification.read(root, "godot");
      expect(read.stages.find((stage) => stage.stage === "check")?.status).toBe("passed");
      expect(read.stages.find((stage) => stage.stage === "test")?.status).toBe("passed");
    }),
  ),
);

it.effect("runs verify's check, test, export and playtest through the adapter", () =>
  withFixture(({ game, root, calls, qualification }) =>
    Effect.gen(function* () {
      const result = yield* game.verify(threadId, { steps: [{ press: "Space" }] });
      expect(result.success, result.message).toBe(true);
      expect(result.completed).toEqual(["check", "test", "export", "playtest"]);
      expect(result.build?.buildId).toBeTruthy();
      expect(calls.map((call) => call.operation)).toEqual([
        "godot-import",
        "godot-check",
        "godot-test",
        // The Web export imports twice, like the production baseline: once on
        // the frozen export copy, once on the live tree for source binding.
        "godot-import",
        "godot-import",
        "export-web",
      ]);
      const read = yield* qualification.read(root, "godot");
      for (const stage of ["check", "test", "export", "playtest"] as const)
        expect(read.stages.find((entry) => entry.stage === stage)?.status).toBe("passed");
    }),
  ),
);

it.effect("a failed check stops verify before the export and keeps the failure record", () =>
  withFixture(
    ({ game, root, calls, qualification }) =>
      Effect.gen(function* () {
        const result = yield* game.verify(threadId, { steps: [{ press: "Space" }] });
        expect(result.success).toBe(false);
        expect(result.failedStage).toBe("check");
        expect(result.completed).toEqual([]);
        expect(result.check?.errors[0]?.message).toContain("exact-check-diagnostic");
        expect(result.export).toBeUndefined();
        expect(result.playtest).toBeUndefined();
        expect(calls.map((call) => call.operation)).toEqual(["godot-import", "godot-check"]);
        const read = yield* qualification.read(root, "godot");
        expect(read.stages.find((stage) => stage.stage === "check")?.status).toBe("failed");
        expect(read.stages.find((stage) => stage.stage === "export")?.status).toBe("missing");
      }),
    { checkFails: true },
  ),
);

it.effect("a source edit during the check keeps the unknown-source policy", () =>
  withFixture(
    ({ game, calls }) =>
      Effect.gen(function* () {
        const result = yield* game.verify(threadId, { steps: [{ press: "Space" }] });
        expect(result.success).toBe(false);
        expect(result.failedStage).toBe("check");
        expect(result.completed).toEqual([]);
        expect(result.message).toContain("sources changed while the check ran");
        expect(result.check?.warnings.map((warning) => warning.message).join("\n")).toContain(
          "sources changed while the check ran",
        );
        expect(calls.map((call) => call.operation)).toEqual(["godot-import", "godot-check"]);
      }),
    { mutateOnCheck: true },
  ),
);

it.effect("an unsupported engine fails the check before any Godot work", () =>
  withFixture(
    ({ game, root, calls, executableCalls, qualification }) =>
      Effect.gen(function* () {
        const attempted = yield* Effect.result(game.check(threadId));
        expect(Result.isFailure(attempted)).toBe(true);
        if (Result.isFailure(attempted)) {
          expect(attempted.failure.reason).toBe("invalid-input");
          expect(attempted.failure.detail).toContain("Unsupported game engine");
        }
        expect(executableCalls()).toBe(0);
        expect(calls).toEqual([]);
        const read = yield* qualification.read(root, "godot");
        expect(read.stages.find((stage) => stage.stage === "check")?.status).toBe("failed");
      }),
    {
      manifest: {
        ...manifest(),
        engine: { name: "unity" },
      } as unknown as GameManifest,
    },
  ),
);

it.effect("cancellation during the check keeps the cancelled policy", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    return yield* withFixture(
      ({ game }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(Effect.result(game.check(threadId)));
            yield* Deferred.await(entered);
            // The run is inside the game's exclusive operation; cancelling the
            // thread must fail it as cancelled without touching the gate.
            yield* game.cancelThread(threadId);
            const outcome = yield* Fiber.join(fiber);
            expect(Result.isFailure(outcome)).toBe(true);
            if (Result.isFailure(outcome)) {
              expect(outcome.failure.reason).toBe("command-failed");
              expect(outcome.failure.message).toContain("Operation cancelled.");
            }
          }),
        ),
      { enteredCheck: entered, gateCheck: gate },
    );
  }),
);
