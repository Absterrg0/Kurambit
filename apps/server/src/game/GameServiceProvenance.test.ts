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
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
  /** The native-launch boundary; records the display mode and args the service asks for. */
  readonly start?: (input: {
    readonly root: string;
    readonly display: "headless" | "inherit" | undefined;
    readonly args: readonly string[];
  }) => Effect.Effect<{ readonly pid: number; readonly logPath: string }, GameOperationError>;
  /** Replace the qualification store, e.g. to make terminal writes fail. */
  readonly qualification?: (stateDir: string) => Layer.Layer<GameQualification.GameQualification>;
  /** Replace the round store, e.g. to gate a byte capture a status read asks for. */
  readonly rounds?: (stateDir: string) => Layer.Layer<GameRoundStore.GameRoundStore>;
  readonly manifest?: Partial<GameManifest>;
}

const withGame = <A, E, R = never>(
  options: FixtureOptions,
  body: (input: {
    readonly root: string;
    readonly game: GameServiceModule.GameService["Service"];
    readonly qualification: QualificationService;
    readonly rounds: GameRoundStore.GameRoundStore["Service"];
  }) => Effect.Effect<A, E, R>,
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
      let selectedPreviewUrl: string | null = null;
      let selectedPreviewDirectory: string | null = null;
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
                : options.start({ root, display: input.display, args: input.args }),
            list: () => [],
            stop: () => Effect.void,
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
            select: (_root, directory) =>
              (options.preview === undefined
                ? Effect.succeed(`http://127.0.0.1:9/${directory}`)
                : options.preview(directory)
              ).pipe(
                Effect.tap((url) =>
                  Effect.sync(() => {
                    selectedPreviewUrl = url;
                    selectedPreviewDirectory = directory;
                  }),
                ),
              ),
            stop: () =>
              Effect.sync(() => {
                selectedPreviewUrl = null;
                selectedPreviewDirectory = null;
              }),
            url: () => selectedPreviewUrl,
            urlFor: (_root, directory) =>
              directory === selectedPreviewDirectory ? selectedPreviewUrl : null,
            serving: () => false,
          }),
        ),
        Layer.provide(previewBrowserTestLayer(executable)),
        Layer.provideMerge(qualificationLayer),
        Layer.provideMerge(options.rounds?.(stateDir) ?? GameRoundStore.layer({ stateDir })),
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

it.live(
  "deleting the .pck makes the export stale and Play reports it instead of republishing",
  () => {
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
          expect(current.selectedArtifactUsable).toBe(true);
          expect(current.sourcesDifferFromPlay).toBe(false);
          expect(stageOf(current.qualification, "export")?.status).toBe("passed");
          // The export is immutable and build-addressed; the served directory is
          // named by the result, never the legacy mutable builds/web.
          const buildDirectory = NodePath.dirname(exported.path!);
          expect(buildDirectory).toContain("builds/candidates/");
          expect(current.selectedBuildId).toBe(NodePath.basename(buildDirectory));
          expect(current.builds.find((build) => build.target === "Web")?.path).toBe(
            `${NodePath.relative(root, buildDirectory)}/index.html`,
          );

          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(buildDirectory, "index.pck")));
          const stale = yield* game.status(threadId);
          expect(stale.webBuildStale).toBe(true);
          expect(stale.selectedArtifactUsable).toBe(false);
          expect(stageOf(stale.qualification, "export")?.status).toBe("stale");

          // Play must not turn an unavailable incumbent into a new publication of
          // the current sources; only an explicit Rebuild does that.
          const played = yield* game.action(threadId, "preview");
          expect(played.success).toBe(false);
          expect(played.message).toContain("selected build is unavailable");
          expect(exports).toBe(1);

          const rebuilt = yield* game.action(threadId, "rebuild");
          expect(rebuilt.success, rebuilt.message).toBe(true);
          expect(exports).toBe(2);
          expect((yield* qualification.read(root, "godot")).buildId).not.toBeNull();
        }),
    );
  },
);

it.live("status compares Play against current bytes, not a Godot size/mtime cache", () => {
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
    ({ root, game }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "assets"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, "assets/hero.png"), "art-one");
        });
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success, exported.message).toBe(true);
        expect(exports).toBe(1);
        expect((yield* game.status(threadId)).sourcesDifferFromPlay).toBe(false);

        // Art beside the Godot project is source too; the Godot size/mtime
        // snapshot does not see it.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "assets/hero.png"), "art-two"),
        );
        expect((yield* game.status(threadId)).sourcesDifferFromPlay).toBe(true);

        // A same-size script edit with the original mtime restored is invisible
        // to size/mtime but different bytes.
        const script = NodePath.join(root, "godot/scripts/main.gd");
        const before = yield* Effect.promise(async () => {
          const stat = await NodeFSP.stat(script);
          return { mtime: stat.mtime, text: await NodeFSP.readFile(script, "utf8") };
        });
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(root, "assets/hero.png"), "art-one");
          await NodeFSP.writeFile(script, `${before.text.slice(0, -1)}X\n`);
          await NodeFSP.utimes(script, before.mtime, before.mtime);
        });
        expect((yield* game.status(threadId)).sourcesDifferFromPlay).toBe(true);
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
        const incumbentUrl = first.url;

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

        // Subscribe before the promotion: a push stream does not replay.
        const queue = yield* game.events.pipe(Stream.toQueue({ capacity: 16 }));
        yield* Effect.yieldNow;
        const promoted = yield* game.promote(threadId, round.id);
        expect(promoted.kind).toBe("promoted");
        // Promotion itself switches the open preview. No status read and no
        // second Play call are needed for Play to follow the selected build.
        expect(opened).toHaveLength(3);
        expect(opened.at(-1)).toContain("builds/candidates/");
        const promotedDirectory = opened.at(-1)!;

        // The cheap read reports the URL the promotion selected; it must not
        // switch anything (a stale in-flight read is allowed to be stale, not
        // to move Play).
        const after = yield* game.status(threadId);
        expect(after.previewUrl).toBe("http://127.0.0.1:9/3");
        expect(after.previewUrl).not.toBe(incumbentUrl);
        expect(after.selectedBuildId).toBe(NodePath.basename(promotedDirectory));
        expect(opened).toHaveLength(3);

        // The promotion published the stage's refresh event.
        const events = yield* Queue.takeAll(queue);
        expect(events.map((event) => `${event.name}:${event.state}`)).toEqual([
          "Promote build:running",
          "Promote build:succeeded",
        ]);

        const state = yield* rounds.read(root);
        expect(state.selected?.buildId).toBe(NodePath.basename(promotedDirectory));
      }),
  );
});

it.live("a candidate changed after its export is refused by promotion", () => {
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
        const incumbentDirectory = opened[0]!;
        const incumbentUrl = first.url;

        const round = yield* rounds.begin(root, {});
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repair\n"),
        );
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success, exported.message).toBe(true);
        yield* rounds.recordPostRepair(root, round.id);
        const selectedBefore = (yield* rounds.read(root)).selected;

        // The export sealed the artifact; then a served file changed. Explicit
        // Play refuses those bytes through the same hash check, so promotion
        // must refuse them too rather than make them Play's build.
        yield* Effect.promise(() =>
          NodeFSP.appendFile(
            NodePath.join(NodePath.dirname(exported.path!), "index.js"),
            "// edit",
          ),
        );
        const refused = yield* game.promote(threadId, round.id);
        expect(refused.kind).toBe("blocked");
        if (refused.kind === "blocked") expect(refused.detail).toContain("artifact-changed");

        const state = yield* rounds.read(root);
        expect(state.selected?.buildId).toBe(selectedBefore?.buildId);
        expect(state.rounds.find((entry) => entry.id === round.id)?.status).toBe("stopped");
        // Nothing switched: Play still shows the incumbent.
        expect(opened.at(-1)).toBe(incumbentDirectory);
        expect((yield* game.status(threadId)).previewUrl).toBe(incumbentUrl);
      }),
  );
});

it.live("the agent native run is headless while the creator's Play may watch", () => {
  const displays: Array<"headless" | "inherit" | undefined> = [];
  const args: Array<readonly string[]> = [];
  return withGame(
    {
      run: (input) => Effect.succeed(processOk(input.root)),
      start: ({ root, display, args: launchArgs }) => {
        displays.push(display);
        args.push(launchArgs);
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
        // Godot's headless display driver is an argument, not an environment
        // omission: agent runs must pass it, and the creator's Play must not.
        expect(args[0]).toContain("--headless");
        expect(args[1]).toContain("--headless");
        expect(args[2]).not.toContain("--headless");
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

it.live("a candidate playtest serves evidence without changing the Play URL or identity", () => {
  let exports = 0;
  const opened: string[] = [];
  const played: string[] = [];
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
      playtest: (input) => {
        played.push(input.url);
        return Effect.succeed(playtestResult);
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
        const incumbentDirectory = opened[0]!;
        const incumbentUrl = first.url;
        expect((yield* game.status(threadId)).previewUrl).toBe(incumbentUrl);

        yield* rounds.begin(root, {});
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repair\n"),
        );
        const playtest = yield* game.webPlaytest(threadId, { steps: [{ waitMs: 1 }] });
        expect(playtest.success, playtest.message).toBe(true);
        // The playtest opened the candidate's evidence URL, not the selected build.
        expect(opened).toHaveLength(2);
        expect(opened[1]).toContain("builds/candidates/");
        expect(opened[1]).not.toBe(incumbentDirectory);
        expect(played.at(-1)).toBe(`http://127.0.0.1:9/2`);

        const status = yield* game.status(threadId);
        expect(status.previewUrl).toBe(incumbentUrl);
        expect(status.selectedBuildId).toBe(NodePath.basename(incumbentDirectory));
        expect(status.selectedArtifactUsable).toBe(true);
        expect(status.sourcesDifferFromPlay).toBe(true);
        expect(status.builds.find((build) => build.target === "Web")?.path).toBe(
          `${incumbentDirectory}/index.html`,
        );
        const selection = yield* rounds.read(root);
        expect(selection.selected?.buildId).toBe(NodePath.basename(incumbentDirectory));
      }),
  );
});

it.live("an export naming a stopped round fails instead of publishing directly", () => {
  let exports = 0;
  return withGame(
    {
      run: (input) => {
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        exports += 1;
        return Effect.succeed(processOk(input.root));
      },
    },
    ({ root, game, rounds }) =>
      Effect.gen(function* () {
        const round = yield* rounds.begin(root, {});
        yield* rounds.stop(root, round.id, "The review was stopped.");
        const expired = yield* Effect.result(game.export(threadId, "Web", { roundId: round.id }));
        expect(expired._tag).toBe("Failure");
        if (expired._tag === "Failure") expect(expired.failure.reason).toBe("invalid-input");
        expect(exports).toBe(0);
        expect((yield* rounds.read(root)).selected).toBeNull();
      }),
  );
});

it.live("an export builds from frozen bytes and refuses a source edit during the run", () => {
  let exports = 0;
  let frozenScript = "";
  let frozenPath = "";
  return withGame(
    {
      run: (input) => {
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        const pathIndex = input.args.indexOf("--path") + 1;
        frozenPath = input.args[pathIndex]!;
        const output = input.args.at(-1)!;
        return Effect.promise(async () => {
          exports += 1;
          // The export runs against the frozen copy while the creator edits the
          // real file; the build must not be bound to the newer bytes.
          frozenScript = await NodeFSP.readFile(
            NodePath.join(frozenPath, "scripts/main.gd"),
            "utf8",
          );
          await NodeFSP.appendFile(
            NodePath.join(input.root, "godot/scripts/main.gd"),
            "# edited during export\n",
          );
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
    ({ root, game }) =>
      Effect.gen(function* () {
        const result = yield* game.export(threadId, "Web");
        expect(result.success, result.message).toBe(false);
        expect(result.message).toContain("changed during the export");
        expect(exports).toBe(1);
        expect(frozenScript).toBe("extends Node\n");
        expect(frozenPath).not.toBe(NodePath.join(root, "godot"));
        const status = yield* game.status(threadId);
        expect(status.selectedBuildId).toBeNull();
      }),
  );
});

it.live("a fresh import that writes sidecars still exports and never mutates the snapshot", () => {
  const imported: string[] = [];
  let exportProject = "";
  return withGame(
    {
      run: (input) => {
        if (input.operation === "godot-import") {
          const project = input.args[input.args.indexOf("--path") + 1]!;
          imported.push(project);
          return Effect.promise(async () => {
            // Godot writes import sidecars beside the sources and a cache tree.
            await NodeFSP.mkdir(NodePath.join(project, ".godot/imported"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(project, ".godot/imported/hero.png-shape.ctex"),
              "cache",
            );
            await NodeFSP.writeFile(NodePath.join(project, "scripts/main.gd.uid"), "uid://main\n");
            await NodeFSP.writeFile(NodePath.join(project, "art/hero.png.import"), "[remap]\n");
            return processOk(input.root);
          });
        }
        if (input.operation !== "export-web") return Effect.succeed(processOk(input.root));
        exportProject = input.args[input.args.indexOf("--path") + 1]!;
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
    },
    ({ root, game, rounds }) =>
      Effect.gen(function* () {
        // A fresh 3d-explorer-shaped tree: art beside the Godot project, no
        // sidecars and no import cache yet.
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(root, "godot/art"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(root, "godot/scenes"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, "godot/art/hero.png"), "png-bytes");
          await NodeFSP.writeFile(NodePath.join(root, "godot/scenes/main.tscn"), "[gd_scene]\n");
        });
        const exported = yield* game.export(threadId, "Web");
        expect(exported.success, exported.message).toBe(true);
        // The editable tree and the private frozen copy were both imported.
        expect(imported).toHaveLength(2);
        expect(exportProject).not.toContain(NodePath.join(root, "godot"));
        const sourceId = yield* rounds.sourceId(root);
        const state = yield* rounds.read(root);
        expect(state.selected?.sourceId).toBe(sourceId);
        // The stored snapshot names source bytes only, and a later freeze of the
        // same bytes reuses it untouched.
        const frozen = yield* rounds.freeze(root);
        expect(frozen.sourceId).toBe(sourceId);
        const stored = yield* Effect.promise(async () => {
          const found: string[] = [];
          const stack = [""];
          while (stack.length > 0) {
            const relative = stack.pop()!;
            const absolute = NodePath.join(frozen.directory, "files", relative);
            for (const entry of await NodeFSP.readdir(absolute, { withFileTypes: true })) {
              const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
              if (entry.isDirectory()) stack.push(child);
              else found.push(child);
            }
          }
          return found.sort();
        });
        expect(stored).toContain("godot/art/hero.png");
        expect(stored.filter((name) => /\.(?:import|uid)$/.test(name))).toEqual([]);
        expect(stored.filter((name) => name.startsWith(".godot/"))).toEqual([]);
        // The import mutated the editable tree, not the stored copy.
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, "godot/art/hero.png.import"), "utf8"),
          ),
        ).toBe("[remap]\n");
      }),
  );
});

it.live("explicit Rebuild stops the open round before publishing", () => {
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
              `export ${exports} ${name}`,
            );
          return processOk(input.root);
        });
      },
    },
    ({ root, game, rounds }) =>
      Effect.gen(function* () {
        const round = yield* rounds.begin(root, {});
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repair\n"),
        );
        const rebuilt = yield* game.action(threadId, "rebuild");
        expect(rebuilt.success, rebuilt.message).toBe(true);
        expect(exports).toBe(1);
        const state = yield* rounds.read(root);
        const closed = state.rounds.find((entry) => entry.id === round.id);
        expect(closed?.status).toBe("stopped");
        expect(closed?.decision).toBe("stop");
        expect(closed?.reason).toContain("Rebuild");
        expect(state.selected).not.toBeNull();
      }),
  );
});

it.live("cancelling the originating turn stops the open round without touching the folder", () =>
  withGame({ run: (input) => Effect.succeed(processOk(input.root)) }, ({ root, game, rounds }) =>
    Effect.gen(function* () {
      const round = yield* rounds.begin(root, {});
      yield* Effect.promise(() =>
        NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repair\n"),
      );
      yield* game.cancelThread(threadId);
      const state = yield* rounds.read(root);
      const stopped = state.rounds.find((entry) => entry.id === round.id);
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.decision).toBe("stop");
      expect(stopped?.reason).toContain("cancelled");
      expect(state.selected).toBeNull();
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, "godot/scripts/main.gd"), "utf8"),
        ),
      ).toBe("extends Node\n# repair\n");
    }),
  ),
);
