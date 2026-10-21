// @effect-diagnostics nodeBuiltinImport:off -- These tests use real temporary game and record directories with stubbed engine boundaries.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  GameOperationError,
  ThreadId,
  type GameManifest,
  type GameProcessResult,
  type GameQualificationRead,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import type * as GameServiceModule from "./GameService.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { previewBrowserTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("provenance-test");
/** Test-local gates; the tests in this file run sequentially. */
let failSpawn = false;
let playtestRoot = "";
const checkStarted = Deferred.makeUnsafe<void>();
const checkRelease = Deferred.makeUnsafe<void>();
const manifest = (overrides: Partial<GameManifest> = {}): GameManifest => ({
  schemaVersion: 1,
  name: "Provenance probe",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
  ...overrides,
});
type QualificationService = GameQualification.GameQualification["Service"];
const stageOf = (read: GameQualificationRead, stage: string) =>
  read.stages.find((entry) => entry.stage === stage);
const processOk = (root: string): GameProcessResult => ({
  pid: 1,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  logPath: NodePath.join(root, "fake.log"),
});
const playtestResult: GameWebPlaytestResult = {
  success: true,
  booted: true,
  bootMs: 10,
  responded: true,
  changedPercent: 10,
  message: "Playtest succeeded: fake run.",
  consoleMessages: [],
  screenshots: [],
  state: null,
};

interface FixtureOptions {
  /** The engine boundary. The check and test scripts are written here by the tests. */
  readonly run: (input: {
    readonly root: string;
    readonly operation: string;
    readonly args: readonly string[];
  }) => Effect.Effect<GameProcessResult, GameOperationError>;
  readonly playtest?: typeof GameWebPlaytest.playtest;
  /** Replace the qualification store, e.g. to make terminal writes fail. */
  readonly qualification?: (stateDir: string) => Layer.Layer<GameQualification.GameQualification>;
  readonly manifest?: Partial<GameManifest>;
}

const withGame = <A, E>(
  options: FixtureOptions,
  body: (input: {
    readonly root: string;
    readonly game: GameServiceModule.GameService["Service"];
    readonly qualification: QualificationService;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-provenance-"))),
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
        await NodeFSP.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      });
      const current = manifest(options.manifest);
      const qualificationLayer =
        options.qualification?.(stateDir) ?? GameQualification.layer({ stateDir });
      const services = GameService.layerWithPlaytest(
        options.playtest ?? (() => Effect.die("This test provides no browser run.")),
      ).pipe(
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
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
                viewport: { width: 1152, height: 648 },
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            run: (input) => options.run({ root, operation: input.operation, args: input.args }),
            list: () => [],
          }),
        ),
        Layer.provide(
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
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            open: () => Effect.succeed("http://127.0.0.1:9/game"),
            stop: () => Effect.void,
            url: () => null,
          }),
        ),
        Layer.provide(previewBrowserTestLayer(executable)),
        Layer.provideMerge(qualificationLayer),
        Layer.provideMerge(GameDesignApproval.layer({ stateDir })),
        Layer.provide(NodeServices.layer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const qualification = yield* GameQualification.GameQualification;
        return yield* body({ root, game, qualification });
      }).pipe(Effect.provide(services));
    }),
  );

it.live("a source edit during the check records unknown and says why", () =>
  withGame(
    {
      run: (input) => {
        if (input.operation !== "godot-check") return Effect.succeed(processOk(input.root));
        const separator = input.args.indexOf("--");
        const resultPath = input.args[separator + 1]!;
        // The engine loaded the old script; the edit lands before the tool
        // returns, at the explicit process boundary rather than on a timer.
        return Effect.promise(async () => {
          await NodeFSP.writeFile(
            resultPath,
            JSON.stringify({
              mainScene: "res://scenes/main.tscn",
              entries: ["main"],
              errors: [],
              warnings: [],
            }),
          );
          await NodeFSP.appendFile(
            NodePath.join(input.root, "godot/scripts/main.gd"),
            "# edited during the check\n",
          );
          return processOk(input.root);
        });
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        const result = yield* game.check(threadId);
        expect(result.ok, JSON.stringify(result.errors)).toBe(true);
        expect(result.warnings.map((warning) => warning.message).join("\n")).toContain(
          "sources changed while the check ran",
        );
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "check")?.status).toBe("unknown");
        expect(stageOf(read, "check")?.detail).toContain("sources changed while the check ran");
      }),
  ),
);

it.live("a source edit during the canonical test records unknown and says why", () =>
  withGame(
    {
      run: (input) => {
        if (input.operation !== "godot-test") return Effect.succeed(processOk(input.root));
        return Effect.promise(async () => {
          await NodeFSP.appendFile(
            NodePath.join(input.root, "godot/scripts/main.gd"),
            "# edited during the test\n",
          );
          return processOk(input.root);
        });
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        const result = yield* game.test(threadId, "tests/smoke_test.gd");
        expect(result.success, result.message).toBe(true);
        expect(result.message).toContain("sources changed while the test ran");
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "test")?.status).toBe("unknown");
      }),
  ),
);

it.live("a thrown process-start failure replaces an earlier test pass", () =>
  withGame(
    {
      run: (input) => {
        if (input.operation !== "godot-test") return Effect.succeed(processOk(input.root));
        if (!failSpawn) return Effect.succeed(processOk(input.root));
        return Effect.fail(
          new GameOperationError({
            operation: "godot-test",
            path: input.root,
            reason: "command-failed",
            detail: "Injected spawn failure.",
          }),
        );
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        const passed = yield* game.test(threadId, "tests/smoke_test.gd");
        expect(passed.success, passed.message).toBe(true);
        expect(stageOf(yield* qualification.read(root, "godot"), "test")?.status).toBe("passed");
        failSpawn = true;
        const error = yield* game.test(threadId, "tests/smoke_test.gd").pipe(Effect.flip);
        expect(error.detail).toContain("Injected spawn failure.");
        // The start-invalidation plus the failure record means the old pass is
        // gone even though no result was returned.
        expect(stageOf(yield* qualification.read(root, "godot"), "test")?.status).not.toBe(
          "passed",
        );
      }),
  ),
);

it.live("an interrupted check leaves no readable pass", () =>
  withGame(
    {
      run: (input) => {
        if (input.operation !== "godot-check") return Effect.succeed(processOk(input.root));
        return Effect.gen(function* () {
          yield* Deferred.succeed(checkStarted, undefined);
          yield* Deferred.await(checkRelease);
          return processOk(input.root);
        });
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        const fiber = yield* game.check(threadId).pipe(Effect.forkChild);
        yield* Deferred.await(checkStarted);
        yield* game.cancelThread(threadId);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        const stage = stageOf(yield* qualification.read(root, "godot"), "check");
        expect(stage?.status).not.toBe("passed");
        expect(stage?.detail).toContain("cancelled");
      }),
  ),
);

it.live("a defect during the canonical test records unknown, not the earlier pass", () => {
  let defect = false;
  return withGame(
    {
      run: (input) => {
        if (input.operation !== "godot-test") return Effect.succeed(processOk(input.root));
        if (!defect) return Effect.succeed(processOk(input.root));
        return Effect.die(new Error("Injected defect."));
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        yield* game.test(threadId, "tests/smoke_test.gd");
        expect(stageOf(yield* qualification.read(root, "godot"), "test")?.status).toBe("passed");
        defect = true;
        const exit = yield* Effect.exit(game.test(threadId, "tests/smoke_test.gd"));
        expect(Exit.isFailure(exit)).toBe(true);
        const stage = stageOf(yield* qualification.read(root, "godot"), "test");
        expect(stage?.status).toBe("unknown");
        expect(stage?.detail).toContain("without a result that can be trusted");
      }),
  );
});

it.live("a failed terminal qualification write never leaves the earlier pass readable", () => {
  let failTerminal = false;
  return withGame(
    {
      run: () => Effect.succeed(processOk(".")),
      qualification: (stateDir) =>
        Layer.effect(
          GameQualification.GameQualification,
          Effect.gen(function* () {
            const inner = yield* GameQualification.GameQualification;
            return GameQualification.GameQualification.of({
              ...inner,
              record: (root, input) =>
                failTerminal
                  ? Effect.fail(
                      new GameOperationError({
                        operation: "qualification",
                        path: stateDir,
                        reason: "io",
                      }),
                    )
                  : inner.record(root, input),
            });
          }),
        ).pipe(Layer.provide(GameQualification.layer({ stateDir }))),
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        yield* game.test(threadId, "tests/smoke_test.gd");
        expect(stageOf(yield* qualification.read(root, "godot"), "test")?.status).toBe("passed");
        failTerminal = true;
        const result = yield* game.test(threadId, "tests/smoke_test.gd");
        expect(result.success).toBe(true);
        // The write failed, but `begin` already removed the stage.
        expect(stageOf(yield* qualification.read(root, "godot"), "test")?.status).toBe("missing");
      }),
  );
});

it.live("deleting the .pck makes the export stale and Play rebuilds it", () => {
  let exports = 0;
  return withGame(
    {
      run: (input) => {
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        const output = input.args.at(-1)!;
        return Effect.promise(async () => {
          exports += 1;
          await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
          for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
            await NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(output), name),
              `export ${name}`,
            );
          return processOk(input.root);
        });
      },
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success, exported.message).toBe(true);
        expect(exports).toBe(1);
        const current = yield* game.status(threadId);
        expect(current.webBuildStale).toBe(false);
        expect(stageOf(current.qualification, "export")?.status).toBe("passed");

        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "builds/web/index.pck")));
        const stale = yield* game.status(threadId);
        expect(stale.webBuildStale).toBe(true);
        expect(stageOf(stale.qualification, "export")?.status).toBe("stale");

        const played = yield* game.action(threadId, "preview");
        expect(played.success, played.message).toBe(true);
        expect(exports).toBe(2);
        expect((yield* qualification.read(root, "godot")).buildId).not.toBeNull();
      }),
  );
});

it.live("a web playtest does not stay current when its build files change mid-run", () =>
  withGame(
    {
      run: (input) => {
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        const output = input.args.at(-1)!;
        return Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
          for (const name of ["index.html", "index.js", "index.wasm", "index.pck"])
            await NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(output), name),
              `export ${name}`,
            );
          return processOk(input.root);
        });
      },
      playtest: () =>
        Effect.promise(async () => {
          await NodeFSP.appendFile(
            NodePath.join(playtestRoot, "builds/web/index.wasm"),
            "# replaced while the playtest ran",
          );
          return playtestResult;
        }),
    },
    ({ root, game, qualification }) =>
      Effect.gen(function* () {
        playtestRoot = root;
        const result = yield* game.webPlaytest(threadId, { steps: [{ waitMs: 1 }] });
        expect(result.success, result.message).toBe(true);
        const read = yield* qualification.read(root, "godot");
        expect(stageOf(read, "export")?.status).toBe("stale");
        expect(stageOf(read, "playtest")?.status).toBe("stale");
      }),
  ),
);
