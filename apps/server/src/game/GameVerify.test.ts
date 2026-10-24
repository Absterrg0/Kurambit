// @effect-diagnostics nodeBuiltinImport:off -- Runs real child processes against a stub Godot executable and real temporary game files.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RunId,
  ThreadId,
  type GameManifest,
  type GameWebPlaytestInput,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  previewBrowserTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const threadId = ThreadId.make("game-verify-test");
const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Verify probe",
  brief: "",
  artDirection: "",
  testSuite: "res://tests/smoke_test.gd",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});
/**
 * A stand-in Godot driven by marker files in the fixture root. It behaves like
 * the real boundaries the service depends on: imports succeed, the check
 * reports its JSON, the canonical suite exits nonzero on demand, and a release
 * export writes the four files the service insists on.
 */
const fakeGodot = `#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$*" in
  *--export-release*)
    echo export >> "$dir/operations"
    if [ -f "$dir/export-fails" ]; then
      echo "SCRIPT ERROR: exact-export-diagnostic" >&2
      exit 1
    fi
    if [ -f "$dir/mutate-on-export" ]; then
      printf '\\n# edited during the export\\n' >> "$dir/game/godot/scripts/main.gd"
    fi
    out=""
    for last do out=$last; done
    cat "$dir/game/godot/scripts/main.gd" > "$out"
    printf x > "\${out%.html}.wasm"
    printf x > "\${out%.html}.js"
    printf x > "\${out%.html}.pck"
    ;;
  *check.gd*)
    echo check >> "$dir/operations"
    result=""
    after=0
    for arg in "$@"; do
      if [ "$after" = "1" ]; then result=$arg; after=0; fi
      if [ "$arg" = "--" ]; then after=1; fi
    done
    if [ -f "$dir/mutate-on-check" ]; then
      printf '\\n# edited during the check\\n' >> "$dir/game/godot/scripts/main.gd"
    fi
    if [ -f "$dir/check-fails" ]; then
      printf '%s' '{"mainScene":"res://scenes/main.tscn","entries":["main","gameplay"],"errors":[{"file":"res://scripts/main.gd","message":"Parse Error: exact-check-diagnostic"}],"warnings":[]}' > "$result"
    else
      printf '%s' '{"mainScene":"res://scenes/main.tscn","entries":["main","gameplay"],"errors":[],"warnings":[]}' > "$result"
    fi
    if [ -f "$dir/block-check" ]; then
      printf '%s' "$$" > "$dir/check-ready"
      exec sleep 60
    fi
    ;;
  *smoke_test.gd*)
    echo test >> "$dir/operations"
    if [ -f "$dir/test-fails" ]; then
      echo "SCRIPT ERROR: exact-test-diagnostic" >&2
      exit 1
    fi
    ;;
  *--editor*)
    echo import >> "$dir/operations"
    ;;
esac
exit 0
`;

const playtestResult = (): GameWebPlaytestResult => ({
  success: true,
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

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly game: GameService.GameService["Service"];
  readonly processes: GameProcesses.GameProcesses["Service"];
  readonly qualification: GameQualification.GameQualification["Service"];
  readonly rounds: GameRoundStore.GameRoundStore["Service"];
  readonly studio: GameRepairStudio.GameRepairStudio["Service"];
  readonly playtestCalls: ReadonlyArray<{ readonly steps: readonly unknown[] }>;
  readonly operations: Effect.Effect<ReadonlyArray<string>>;
}

const marker = (base: string, name: string) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(base, name), ""));
const withFixture = <A, E, R>(
  body: (fixture: Fixture) => Effect.Effect<A, E, R>,
  options: { readonly playtest?: () => GameWebPlaytestResult } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-verify-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const stateDir = NodePath.join(base, "state");
      const executable = NodePath.join(base, "godot");
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
        await NodeFSP.writeFile(executable, fakeGodot, { mode: 0o755 });
      });
      const current = manifest();
      const playtestCalls: Array<{ readonly steps: readonly unknown[] }> = [];
      const gameLayer = GameService.layerWithPlaytest((input) => {
        playtestCalls.push({ steps: input.steps });
        return Effect.succeed((options.playtest ?? playtestResult)());
      }).pipe(
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(root),
            activeRun: () => Effect.succeed(RunId.make("run:verify")),
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
            directories: () => [],
            open: (_root, directory) => Effect.succeed(`http://127.0.0.1:9/${directory}`),
            select: (_root, directory) => Effect.succeed(`http://127.0.0.1:9/${directory}`),
            stop: () => Effect.void,
            url: () => null,
            urlFor: () => null,
            serving: () => false,
          }),
        ),
        Layer.provide(previewBrowserTestLayer(executable)),
        Layer.provideMerge(GameQualification.layer({ stateDir })),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      const services = GameRepairStudio.layer({ stateDir }).pipe(Layer.provideMerge(gameLayer));
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        const processes = yield* GameProcesses.GameProcesses;
        const qualification = yield* GameQualification.GameQualification;
        const rounds = yield* GameRoundStore.GameRoundStore;
        const studio = yield* GameRepairStudio.GameRepairStudio;
        return yield* body({
          base,
          root,
          game,
          processes,
          qualification,
          rounds,
          studio,
          playtestCalls,
          operations: Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(base, "operations"), "utf8").then(
              (text) => text.split("\n").filter(Boolean),
              () => [],
            ),
          ),
        });
      }).pipe(Effect.provide(services));
    }),
  );

const steps = [{ press: "Space" }] as const;

it.live("rejects bad playtest input before any engine work", () =>
  withFixture(({ game, base, operations }) =>
    Effect.gen(function* () {
      for (const input of [
        { steps: [{ waitMs: 1_000 }] },
        { steps: [{ press: "Space" }], exactSize: true, width: 640, height: 360 },
        { steps: [{ click: "left", x: 9_999, y: 10 }] },
      ] satisfies ReadonlyArray<GameWebPlaytestInput>) {
        const attempted = yield* Effect.result(game.verify(threadId, input));
        expect(Result.isFailure(attempted)).toBe(true);
        if (Result.isFailure(attempted)) {
          expect(attempted.failure.reason).toBe("invalid-input");
          expect(attempted.failure.detail).toBeTruthy();
        }
      }
      expect(yield* operations).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(base, "game/builds/candidates"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(base, "game/builds/playtests"))).toBe(false);
    }),
  ),
);

it.live("a failed check stops before the test, export and playtest", () =>
  withFixture(({ game, root, base, qualification, operations }) =>
    Effect.gen(function* () {
      yield* marker(base, "check-fails");
      const result = yield* game.verify(threadId, { steps });
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("check");
      expect(result.completed).toEqual([]);
      expect(result.check?.errors[0]?.message).toContain("exact-check-diagnostic");
      expect(result.test).toBeUndefined();
      expect(result.export).toBeUndefined();
      expect(result.playtest).toBeUndefined();
      expect(result.screenshots).toEqual([]);
      expect(yield* operations).toEqual(["import", "check"]);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/candidates"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(false);
      const read = yield* qualification.read(root, "godot");
      expect(read.stages.find((stage) => stage.stage === "check")?.status).toBe("failed");
      expect(read.stages.find((stage) => stage.stage === "test")?.status).toBe("missing");
      expect(read.stages.find((stage) => stage.stage === "export")?.status).toBe("missing");
      expect(read.stages.find((stage) => stage.stage === "playtest")?.status).toBe("missing");
    }),
  ),
);

it.live("a source edit during the check never verifies a later export", () =>
  withFixture(({ game, base, operations }) =>
    Effect.gen(function* () {
      yield* marker(base, "mutate-on-check");
      const result = yield* game.verify(threadId, { steps });
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("check");
      expect(result.completed).toEqual([]);
      expect(result.message).toContain("sources changed while the check ran");
      expect(result.check?.warnings.map((warning) => warning.message).join("\n")).toContain(
        "sources changed while the check ran",
      );
      expect(yield* operations).toEqual(["import", "check"]);
      expect(NodeFS.existsSync(NodePath.join(base, "game/builds/playtests"))).toBe(false);
    }),
  ),
);

it.live("a failed canonical test stops before the export and playtest", () =>
  withFixture(({ game, root, base, qualification, operations }) =>
    Effect.gen(function* () {
      yield* marker(base, "test-fails");
      const result = yield* game.verify(threadId, { steps });
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("test");
      expect(result.completed).toEqual(["check"]);
      expect(result.test?.success).toBe(false);
      expect(result.test?.message).toContain("exact-test-diagnostic");
      expect(result.test?.process?.logPath).toBeTruthy();
      expect(result.export).toBeUndefined();
      expect(result.playtest).toBeUndefined();
      expect(yield* operations).toEqual(["import", "check", "test"]);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/candidates"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(false);
      const read = yield* qualification.read(root, "godot");
      expect(read.stages.find((stage) => stage.stage === "test")?.status).toBe("failed");
      expect(read.stages.find((stage) => stage.stage === "export")?.status).toBe("missing");
    }),
  ),
);

it.live("a failed export stops before the recorded playtest", () =>
  withFixture(({ game, root, base, playtestCalls, operations }) =>
    Effect.gen(function* () {
      yield* marker(base, "export-fails");
      const result = yield* game.verify(threadId, { steps });
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("export");
      expect(result.completed).toEqual(["check", "test"]);
      expect(result.export?.success).toBe(false);
      expect(result.export?.message).toContain("exact-export-diagnostic");
      expect(result.export?.process?.logPath).toBeTruthy();
      expect(result.playtest).toBeUndefined();
      expect(result.screenshots).toEqual([]);
      expect(playtestCalls).toHaveLength(0);
      expect(yield* operations).toEqual(["import", "check", "test", "import", "import", "export"]);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(false);
    }),
  ),
);

it.live("a source edit during the export stops before the recorded playtest", () =>
  withFixture(({ game, root, base, playtestCalls }) =>
    Effect.gen(function* () {
      yield* marker(base, "mutate-on-export");
      const result = yield* game.verify(threadId, { steps });
      expect(result.success).toBe(false);
      expect(result.failedStage).toBe("export");
      expect(result.completed).toEqual(["check", "test"]);
      expect(result.export?.success).toBe(false);
      expect(result.export?.message).toContain("game folder changed during the export");
      expect(result.playtest).toBeUndefined();
      expect(playtestCalls).toHaveLength(0);
      expect(NodeFS.existsSync(NodePath.join(root, "builds/playtests"))).toBe(false);
    }),
  ),
);

it.live("runs the recorded stages in order and binds the playtest to the exact build", () =>
  withFixture(({ game, root, playtestCalls, qualification, rounds, studio, operations }) =>
    Effect.gen(function* () {
      const result = yield* game.verify(threadId, { steps });
      expect(result.success, result.message).toBe(true);
      expect(result.failedStage).toBeUndefined();
      expect(result.completed).toEqual(["check", "test", "export", "playtest"]);
      expect(result.check?.ok).toBe(true);
      expect(result.test?.success).toBe(true);
      expect(result.export?.success).toBe(true);
      expect(result.build?.buildId).toBeTruthy();
      expect(result.build?.path).toBe(NodePath.join(root, result.build!.directory, "index.html"));
      expect(result.playtest?.success).toBe(true);
      expect(result.playtest?.responded).toBe(true);
      expect("screenshots" in (result.playtest ?? {})).toBe(false);
      expect(result.screenshots.map((frame) => frame.label)).toEqual(["booted", "after-steps"]);
      expect(result.message).toContain("not a quality verdict");
      expect(playtestCalls).toHaveLength(1);
      expect(playtestCalls[0]?.steps).toEqual(steps);
      expect(yield* operations).toEqual(["import", "check", "test", "import", "import", "export"]);

      const read = yield* qualification.read(root, "godot");
      for (const stage of ["check", "test", "export"] as const)
        expect(read.stages.find((entry) => entry.stage === stage)?.status).toBe("passed");
      const playtestRecord = yield* qualification.stageRecord(root, "playtest");
      expect(playtestRecord?.outcome).toBe("passed");
      expect(playtestRecord?.buildId).toBe(result.build?.buildId);
      const state = yield* rounds.read(root);
      expect(state.selected?.buildId).toBe(result.build?.buildId);
      expect(state.submissions ?? []).toEqual([]);
      const binding = yield* rounds.exported(root, result.build!.buildId);
      expect(binding?.playtest?.responded).toBe(true);
      expect(binding?.playtest?.executedInputSteps).toBe(1);
      const facts = yield* studio.submissionFacts(root, result.build!.buildId);
      expect(facts.passed, facts.reason ?? "").toBe(true);
    }),
  ),
);

it.live("keeps the selected incumbent while a repair round is open", () =>
  withFixture(({ game, root, rounds }) =>
    Effect.gen(function* () {
      const first = yield* game.verify(threadId, { steps });
      expect(first.success, first.message).toBe(true);
      const incumbent = (yield* rounds.read(root)).selected;
      expect(incumbent?.buildId).toBe(first.build?.buildId);

      yield* Effect.promise(() =>
        NodeFSP.appendFile(NodePath.join(root, "godot/scripts/main.gd"), "# repaired sources\n"),
      );
      const round = yield* rounds.begin(root);
      const repaired = yield* game.verify(threadId, { steps });
      expect(repaired.success, repaired.message).toBe(true);
      expect(repaired.build?.buildId).not.toBe(incumbent?.buildId);
      expect(repaired.export?.message).toContain("candidate");
      const state = yield* rounds.read(root);
      expect(state.selected?.buildId).toBe(incumbent?.buildId);
      const open = state.rounds.find((entry) => entry.id === round.id);
      expect(open?.candidate?.buildId).toBe(repaired.build?.buildId);
      const binding = yield* rounds.exported(root, repaired.build!.buildId);
      expect(binding?.playtest?.responded).toBe(true);
    }),
  ),
);

it.live("holds one operation across the cycle and cancellation kills the captured child", () =>
  withFixture(({ game, root, base, processes }) =>
    Effect.gen(function* () {
      yield* marker(base, "block-check");
      const watcher = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.watch(base)),
        (watch) => Effect.sync(() => watch.close()),
      );
      const ready = new Promise<void>((resolve) =>
        watcher.on("change", (_event, filename) => {
          if (filename === "check-ready") resolve();
        }),
      );
      const fiber = yield* game.verify(threadId, { steps }).pipe(Effect.forkChild);
      yield* Effect.promise(() => ready);
      const pid = Number(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(base, "check-ready"), "utf8")),
      );
      expect(processes.list(root).map((entry) => entry.pid)).toContain(pid);

      const concurrent = yield* Effect.result(game.verify(threadId, { steps }));
      expect(Result.isFailure(concurrent)).toBe(true);
      if (Result.isFailure(concurrent)) expect(concurrent.failure.reason).toBe("busy");

      yield* game.cancelThread(threadId);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(processes.list(root)).toEqual([]);

      // The cancelled operation released the lock; a fresh cycle can run.
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(base, "block-check")));
      const after = yield* game.verify(threadId, { steps });
      expect(after.success, after.message).toBe(true);
    }),
  ),
);
