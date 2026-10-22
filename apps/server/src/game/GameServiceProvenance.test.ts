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
import * as GameRoundStore from "./GameRoundStore.ts";
import type * as GameServiceModule from "./GameService.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { previewBrowserTestLayer, visualJudgeTestLayer } from "./gameTestLayers.ts";

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
  // This fixture's game owes no probe, so the evaluator's pixel rule qualifies.
  qualifies: true,
  blockers: [],
  interaction: "no state probe",
};

interface FixtureOptions {
  /** The engine boundary. The check and test scripts are written here by the tests. */
  readonly run: (input: {
    readonly root: string;
    readonly operation: string;
    readonly args: readonly string[];
  }) => Effect.Effect<GameProcessResult, GameOperationError>;
  readonly playtest?: typeof GameWebPlaytest.playtest;
  /** Which build directory Play asks the preview to serve. */
  readonly preview?: (directory: string) => Effect.Effect<string, GameOperationError>;
  /** The native-launch boundary; records the display mode the service asks for. */
  readonly start?: (input: {
    readonly root: string;
    readonly display: "headless" | "inherit" | undefined;
  }) => Effect.Effect<{ readonly pid: number; readonly logPath: string }, GameOperationError>;
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
    readonly rounds: GameRoundStore.GameRoundStore["Service"];
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
            start: (input) =>
              options.start === undefined
                ? Effect.die("This test provides no native launch.")
                : options.start({ root, display: input.display }),
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
            open: (_root, directory) =>
              options.preview === undefined
                ? Effect.succeed(`http://127.0.0.1:9/${directory ?? "builds/web"}`)
                : options.preview(directory ?? "builds/web"),
            stop: () => Effect.void,
            url: () => null,
          }),
        ),
        Layer.provide(previewBrowserTestLayer(executable)),
        Layer.provideMerge(qualificationLayer),
        Layer.provideMerge(GameRoundStore.layer({ stateDir })),
        Layer.provideMerge(visualJudgeTestLayer(stateDir)),
        Layer.provideMerge(GameDesignApproval.layer({ stateDir })),
        Layer.provide(NodeServices.layer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const qualification = yield* GameQualification.GameQualification;
        const rounds = yield* GameRoundStore.GameRoundStore;
        return yield* body({ root, game, qualification, rounds });
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
        // The export is immutable and build-addressed; the served directory is
        // named by the result, never the legacy mutable builds/web.
        const buildDirectory = NodePath.dirname(exported.path!);
        expect(buildDirectory).toContain("builds/candidates/");
        expect(current.builds.find((build) => build.target === "Web")?.path).toBe(
          `${NodePath.relative(root, buildDirectory)}/index.html`,
        );

        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(buildDirectory, "index.pck")));
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
          // Find the exported build by its address, not a mutable path.
          const parent = NodePath.join(playtestRoot, "builds/candidates");
          const directory = (await NodeFSP.readdir(parent)).find((name) =>
            /^[0-9a-f]{64}$/.test(name),
          );
          await NodeFSP.appendFile(
            NodePath.join(parent, directory!, "index.wasm"),
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

it.live("a round's candidate export leaves Play on the incumbent until promotion", () => {
  let exports = 0;
  const opened: string[] = [];
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
              `export ${exports} ${name}`,
            );
          return processOk(input.root);
        });
      },
      preview: (directory) => {
        opened.push(directory);
        return Effect.succeed(`http://127.0.0.1:9/${opened.length}`);
      },
    },
    ({ root, game, rounds }) =>
      Effect.gen(function* () {
        const first = yield* game.action(threadId, "preview");
        expect(first.success, first.message).toBe(true);
        expect(opened).toHaveLength(1);
        const incumbentDirectory = opened[0]!;

        const round = yield* rounds.begin(root, {});
        // The repair changes a source file, then exports one build.
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repair\n"),
        );
        const candidate = yield* game.export(threadId, "Web");
        expect(candidate.success, candidate.message).toBe(true);
        expect(candidate.message).toContain("candidate");
        expect(exports).toBe(2);
        yield* rounds.recordPostRepair(root, round.id);

        // Play still opens the incumbent directory the creator was watching.
        const still = yield* game.action(threadId, "preview");
        expect(still.success, still.message).toBe(true);
        expect(opened.at(-1)).toBe(incumbentDirectory);
        const selectedBefore = yield* rounds.read(root);
        // The challenger exists on disk but selection did not move.
        expect(selectedBefore.selected?.buildId).toBe(NodePath.basename(incumbentDirectory));
        expect(candidate.path).toContain("builds/candidates/");

        const promoted = yield* rounds.promote(root, round.id);
        expect(promoted.kind).toBe("promoted");
        const after = yield* game.action(threadId, "preview");
        expect(after.success, after.message).toBe(true);
        expect(opened).toHaveLength(3);
        expect(opened.at(-1)).not.toBe(incumbentDirectory);
        expect(opened.at(-1)).toContain("builds/candidates/");
        const state = yield* rounds.read(root);
        expect(state.selected?.buildId).toBe(opened.at(-1)?.split("/").at(-1));
      }),
  );
});

it.live("the agent native run is headless while the creator's Play may watch", () => {
  const displays: Array<"headless" | "inherit" | undefined> = [];
  return withGame(
    {
      run: (input) => Effect.succeed(processOk(input.root)),
      start: ({ root, display }) => {
        displays.push(display);
        return Effect.succeed({ pid: 4242, logPath: NodePath.join(root, "fake-native.log") });
      },
    },
    ({ game }) =>
      Effect.gen(function* () {
        const agent = yield* game.native(threadId, { display: "headless" });
        expect(agent.success, agent.message).toBe(true);
        // The default for a caller that did not ask to watch is headless too.
        yield* game.native(threadId);
        const creator = yield* game.action(threadId, "native");
        expect(creator.success, creator.message).toBe(true);
        expect(displays).toEqual(["headless", "headless", "inherit"]);
      }),
  );
});

it.live("a failed or partial export leaves Play on the incumbent", () => {
  let partial = false;
  const opened: string[] = [];
  return withGame(
    {
      run: (input) => {
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        const output = input.args.at(-1)!;
        return Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(output), { recursive: true });
          // The engine writes part of a build, then dies.
          await NodeFSP.writeFile(output, "<html>partial</html>");
          if (partial)
            return {
              ...processOk(input.root),
              exitCode: 1,
              stderr: "ERROR: export failed",
            };
          for (const name of ["index.js", "index.wasm", "index.pck"])
            await NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(output), name),
              `export ${name}`,
            );
          return processOk(input.root);
        });
      },
      preview: (directory) => {
        opened.push(directory);
        return Effect.succeed(`http://127.0.0.1:9/${opened.length}`);
      },
    },
    ({ root, game }) =>
      Effect.gen(function* () {
        const first = yield* game.action(threadId, "preview");
        expect(first.success, first.message).toBe(true);
        const incumbent = opened.at(-1)!;
        partial = true;
        const failed = yield* game.export(threadId, "Web");
        expect(failed.success).toBe(false);
        const still = yield* game.action(threadId, "preview");
        expect(still.success, still.message).toBe(true);
        expect(opened.at(-1)).toBe(incumbent);
        // The staging directory is cleaned up; no half build is addressable.
        const candidates = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(root, "builds/candidates")),
        );
        expect(candidates.filter((name) => name.startsWith(".staging-"))).toEqual([]);
      }),
  );
});
