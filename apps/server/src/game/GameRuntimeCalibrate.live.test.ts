// @effect-diagnostics nodeBuiltinImport:off -- Root-owned live validation: real Godot headless calibration. NEVER run in a worker session.
// Opt in with GAME_STUDIO_RUNTIME_CALIBRATE_LIVE=1 on a quiet Linux host, one
// heavy operation at a time. The worker slice proves wiring with mocks; this
// file proves engines, isolation and cadence sensitivity. See OUT/runtime-calibration.md.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  type GameOperationError,
  type ServerSettingsError,
  type GameRuntimeCalibrateResult,
} from "@t3tools/contracts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  designApprovalTestLayer,
  roundStoreTestLayer,
  qualificationTestLayer,
} from "./gameTestLayers.ts";

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);

const onPath = (name: string): boolean =>
  (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((dir) => NodePath.join(dir, name))
    .some((candidate) => {
      try {
        NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

/** Root runs this; workers never do, even to check collection. */
const ready =
  process.env.GAME_STUDIO_RUNTIME_CALIBRATE_LIVE === "1" && NodeFS.existsSync(godotExecutable);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
};

const approve = (approvals: GameDesignApproval.GameDesignApproval["Service"], root: string) =>
  Effect.gen(function* () {
    const design = "# Live calibration fixture.\n\nA disposable acceptance fixture.\n";
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "DESIGN.md"), design));
    yield* approvals.write(root, {
      schemaVersion: 1,
      game: NodePath.resolve(root),
      approvalId: "live-calibrate-approval",
      designHash: GameDesignApproval.designDocumentHash(design),
      approvedAt: "2026-10-20T00:00:00.000Z",
      acceptance: [],
    });
  });

/**
 * A minimal physics fixture written from scratch in tmp: a project with one
 * player moved at a constant velocity, one scenario holding right, and a
 * user:// visit-count sentinel exposed on GameState. `renderSensitive` moves
 * the player in _process (render-rate dependent, a genuine fault) instead of
 * _physics_process (correct). Nothing here asserts a canned verdict: the
 * engine's measured runs decide.
 */
const writeFixture = (root: string, renderSensitive: boolean) =>
  Effect.promise(async () => {
    const godot = NodePath.join(root, "godot");
    await NodeFSP.mkdir(NodePath.join(godot, "tests/scenarios"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(godot, "project.godot"),
      [
        "; Live calibration fixture.",
        "config_version=5",
        "",
        "[application]",
        `config/name="live-calibrate-${renderSensitive ? "faulty" : "clean"}"`,
        'run/main_scene="res://scenes/main.tscn"',
        'config/features=PackedStringArray("4.7", "GL Compatibility")',
        "",
        "[autoload]",
        'GameState="*res://scripts/game_state.gd"',
        "",
        "[display]",
        "window/size/viewport_width=640",
        "window/size/viewport_height=360",
        "",
        "[input]",
        'move_right={"deadzone": 0.5, "events": []}',
        "",
        "[physics]",
        "common/physics_ticks_per_second=60",
        "",
        "[rendering]",
        'renderer/rendering_method="gl_compatibility"',
        "",
      ].join("\n"),
    );
    await NodeFSP.mkdir(NodePath.join(godot, "scripts"), { recursive: true });
    // The sentinel persists a visit count in user://: within one run the file
    // lives for the whole route, while fresh per-run isolation resets it
    // across repeats. Equal finals across repeats prove the reset.
    await NodeFSP.writeFile(
      NodePath.join(godot, "scripts/game_state.gd"),
      [
        "extends Node",
        "var state := 1",
        "var visits := 0",
        "var restored := 0",
        "var seeded_value := 0",
        "func _ready() -> void:",
        "  var count := 0",
        '  if FileAccess.file_exists("user://visits.cfg"):',
        '    var read := FileAccess.open("user://visits.cfg", FileAccess.READ)',
        "    if read != null:",
        "      count = int(read.get_as_text().strip_edges())",
        "  visits = count + 1",
        '  var write := FileAccess.open("user://visits.cfg", FileAccess.WRITE)',
        "  if write != null:",
        "    write.store_string(str(visits))",
        "func _process(_delta: float) -> void:",
        '  if FileAccess.file_exists("user://visits.cfg"):',
        '    var read := FileAccess.open("user://visits.cfg", FileAccess.READ)',
        "    if read != null:",
        "      restored = int(read.get_as_text().strip_edges())",
        "",
      ].join("\n"),
    );
    const mover = renderSensitive
      ? [
          "extends CharacterBody2D",
          "func _ready() -> void:",
          "  GameState.seeded_value = randi() % 10000",
          "func _process(_delta: float) -> void:",
          "  # FAULT: render-rate movement. A 120 fps render cadence steps",
          "  # twice as often as 60 fps, so displacement diverges by cadence.",
          '  var direction := Input.get_axis("ui_left", "move_right")',
          "  position.x += direction * 2.0",
          "",
        ].join("\n")
      : [
          "extends CharacterBody2D",
          "func _ready() -> void:",
          "  GameState.seeded_value = randi() % 10000",
          "func _physics_process(_delta: float) -> void:",
          "  # Correct: one constant step per physics tick, independent of the",
          "  # render cadence the fixed-fps runner uses.",
          '  var direction := Input.get_axis("ui_left", "move_right")',
          "  position.x += direction * 2.0",
          "",
        ].join("\n");
    await NodeFSP.writeFile(NodePath.join(godot, "scripts/player.gd"), mover);
    await NodeFSP.mkdir(NodePath.join(godot, "scenes"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(godot, "scenes/main.tscn"),
      [
        '[gd_scene load_steps=3 format=3 uid="uid://livecalibratemain"]',
        '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
        '[ext_resource type="Script" path="res://scripts/game_state.gd" id="2"]',
        '[node name="Main" type="Node2D"]',
        '[node name="Player" type="CharacterBody2D" parent="." groups=["player"]]',
        'script = ExtResource("1")',
        "",
      ].join("\n"),
    );
    await NodeFSP.writeFile(
      NodePath.join(godot, "tests/scenarios/full-run.json"),
      JSON.stringify({ id: "full-run", steps: [{ hold: ["move_right"], frames: 120 }] }),
    );
  });

const withLiveGame = <A, E>(
  renderSensitive: boolean,
  run: (input: {
    readonly root: string;
    readonly game: GameService.GameService["Service"];
    readonly threadId: Parameters<GameService.GameService["Service"]["runtimeCalibrate"]>[0];
  }) => Effect.Effect<A, E, never>,
  fixtureSource?: string,
): Effect.Effect<A, E | GameOperationError | ServerSettingsError, never> =>
  Effect.gen(function* () {
    const parent = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runtime-calibrate-live-")),
    );
    const designStateDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runtime-calibrate-live-design-")),
    );
    const layer = GameService.layer.pipe(
      Layer.provideMerge(GameProjectService.layer),
      Layer.provideMerge(GameOperations.layer),
      Layer.provideMerge(GameToolchain.layer),
      Layer.provideMerge(GamePreview.layer),
      Layer.provideMerge(GameProcesses.layer),
      Layer.provide(projectTestLayer()),
      Layer.provide(previewBrowserTestLayer()),
      Layer.provideMerge(qualificationTestLayer(NodePath.join(parent, ".test-state"))),
      Layer.provideMerge(designApprovalTestLayer(designStateDir)),
      Layer.provideMerge(roundStoreTestLayer(designStateDir)),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provideMerge(admissionTestLayer),
      Layer.provide(NodeServices.layer),
    );
    const cleanup = Effect.promise(() =>
      process.env.GAME_STUDIO_KEEP_TEST === "1"
        ? Promise.resolve()
        : Promise.all([
            NodeFSP.rm(parent, { recursive: true, force: true }),
            NodeFSP.rm(designStateDir, { recursive: true, force: true }),
          ]).then(() => undefined),
    ).pipe(Effect.orDie);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* GameProjectService.GameProjectService;
        const approvals = yield* GameDesignApproval.GameDesignApproval;
        const created = yield* projects.create({
          name: `live calibrate ${renderSensitive ? "faulty" : "clean"}`,
          parentDirectory: parent,
          template: "blank",
          brief: "A disposable live calibration fixture.",
          planFirst: false,
          modelSelection,
        });
        if (fixtureSource === undefined) yield* writeFixture(created.root, renderSensitive);
        else
          yield* Effect.promise(() =>
            NodeFSP.cp(fixtureSource, created.root, {
              recursive: true,
              filter: (source) => ![".godot", "builds", ".git"].includes(NodePath.basename(source)),
            }),
          );
        yield* approve(approvals, created.root);
        const game = yield* GameService.GameService;
        return yield* run({ root: created.root, game, threadId: created.threadId });
      }),
    ).pipe(Effect.provide(layer), Effect.ensuring(cleanup));
  });

const saveResult = (name: string, result: GameRuntimeCalibrateResult) =>
  Effect.promise(async () => {
    const output = process.env.GAME_STUDIO_RUNTIME_CALIBRATE_RESULTS;
    if (output === undefined) return;
    await NodeFSP.mkdir(output, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(output, `${name}.json`), JSON.stringify(result, null, 2));
  });

it.live.skipIf(!ready)(
  "measures equal physical outcomes on the clean physics fixture",
  () =>
    Effect.gen(function* () {
      yield* withLiveGame(false, ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.runtimeCalibrate(threadId, { scenarioId: "full-run" });
          // Real measured facts, not canned: every repeat isolated, moved,
          // and reset the user:// sentinel to the same final.
          yield* saveResult("clean", result);
          expect(result.runs).toHaveLength(4);
          for (const run of result.runs) {
            expect(run.error).toBeNull();
            expect(run.userDataDirIsolated).toBe(true);
            expect(run.playerMoved).toBe(true);
            expect(run.playerDisplacement).not.toBeNull();
            expect(run.playerDisplacement!).toBeGreaterThan(0);
          }
          const visits = result.runs.map((run) => run.gameState["visits"]);
          expect(visits).toEqual([1, 1, 1, 1]);
          expect(
            result.runs.every(
              (run) => run.gameState.restored === 1 && run.initialGameState?.visits === 1,
            ),
          ).toBe(true);
          expect(new Set(result.runs.map((run) => run.gameState.seeded_value)).size).toBe(1);
          expect(result.verdict).toBe("equivalent");
          expect(result.message).toContain("tested route and settings only");
        }),
      );
    }),
  600_000,
);

it.live.skipIf(!ready)(
  "marks the render-sensitive faulty fixture different or unknown, never equivalent",
  () =>
    Effect.gen(function* () {
      yield* withLiveGame(true, ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.runtimeCalibrate(threadId, { scenarioId: "full-run" });
          // The fault is genuine render-rate movement: cross-cadence
          // displacement must diverge, or a run must fail openly. Either
          // way the calibration must not call it equivalent.
          yield* saveResult("faulty", result);
          for (const run of result.runs) expect(run.error).toBeNull();
          expect(result.verdict, JSON.stringify(result.comparisons)).toBe("different");
          expect(result.runs.every((run) => run.gameState.visits === 1)).toBe(true);
          expect(
            result.comparisons.some((pair) =>
              pair.differences.some((detail) => detail.startsWith("playerLast")),
            ),
          ).toBe(true);
        }),
      );
    }),
  600_000,
);

it.live.skipIf(!ready)(
  "compares 30/60/120 and surfaces per-run engine counters",
  () =>
    Effect.gen(function* () {
      yield* withLiveGame(false, ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.runtimeCalibrate(threadId, {
            scenarioId: "full-run",
            cadences: [30, 60, 120],
          });
          yield* saveResult("clean-three-cadences", result);
          expect(result.runs).toHaveLength(6);
          for (const run of result.runs) {
            expect(run.error).toBeNull();
            // Actual counters, never estimates: engine ticks since boot stay
            // separate from the runner's scenario frames.
            expect(run.enginePhysicsFrames).toBeGreaterThan(0);
            expect(run.renderFrames).toBeGreaterThan(0);
            expect(run.nominalPhysicsSeconds).toBeGreaterThan(0);
          }
          expect(result.comparisons.length).toBeGreaterThan(0);
          expect(result.comparedCount).toBeGreaterThan(0);
        }),
      );
    }),
  900_000,
);

void onPath;

it.live.skipIf(!ready || !onPath("xvfb-run") || !onPath("ffmpeg") || !onPath("ffprobe"))(
  "encoding FPS conversion preserves native simulation cadence and physical results",
  () =>
    withLiveGame(false, ({ root, game, threadId }) =>
      Effect.gen(function* () {
        const first = yield* game.nativeCapture(threadId, {
          scenarioId: "full-run",
          fps: 60,
          outputFps: 30,
        });
        const second = yield* game.nativeCapture(threadId, {
          scenarioId: "full-run",
          fps: 60,
          outputFps: 60,
        });
        expect(first.renderFps).toBe(60);
        expect(second.renderFps).toBe(60);
        expect(first.actualFps).toBe(30);
        expect(second.actualFps).toBe(60);
        expect(first.scenarioFrames).toBe(second.scenarioFrames);
        expect(second.movieFrames).toBeGreaterThan(first.movieFrames);
        const reports = yield* Effect.promise(async () =>
          Promise.all(
            [first, second].map(async (clip) =>
              JSON.parse(await NodeFSP.readFile(NodePath.join(root, clip.resultPath), "utf8")),
            ),
          ),
        );
        expect(reports[0].playerLast).toEqual(reports[1].playerLast);
        expect(reports[0].playerBaseline).toEqual(reports[1].playerBaseline);
        expect(reports[0].userDataDir).not.toBe(reports[1].userDataDir);
        yield* Effect.promise(async () => {
          const output = process.env.GAME_STUDIO_RUNTIME_CALIBRATE_RESULTS;
          if (output !== undefined)
            await NodeFSP.writeFile(
              NodePath.join(output, "encoding.json"),
              JSON.stringify({ first, second, reports }, null, 2),
            );
        });
      }),
    ),
  300000,
);

it.live.skipIf(!ready || process.env.GAME_STUDIO_RUNTIME_CALIBRATE_GAME === undefined)(
  "measures the retained generated game without changing its original sources",
  () =>
    withLiveGame(
      false,
      ({ game, threadId }) =>
        Effect.gen(function* () {
          const result = yield* game.runtimeCalibrate(threadId, {
            scenarioId: "full-run",
            cadences: [30, 60, 120],
          });
          yield* saveResult("generated-tiny-roof", result);
          expect(result.runs).toHaveLength(6);
          expect(result.runs.every((run) => run.userDataDirIsolated)).toBe(true);
          expect(result.sourceId).not.toBeNull();
        }),
      process.env.GAME_STUDIO_RUNTIME_CALIBRATE_GAME,
    ),
  300000,
);

it.live.skipIf(!ready)(
  "calibrates supported 30 and 120 Hz physics without relabelling render frames",
  () =>
    Effect.gen(function* () {
      for (const physicsHz of [30, 120])
        yield* withLiveGame(false, ({ root, game, threadId }) =>
          Effect.gen(function* () {
            const project = NodePath.join(root, "godot/project.godot");
            yield* Effect.promise(async () =>
              NodeFSP.writeFile(
                project,
                (await NodeFSP.readFile(project, "utf8")).replace(
                  "common/physics_ticks_per_second=60",
                  `common/physics_ticks_per_second=${physicsHz}`,
                ),
              ),
            );
            const result = yield* game.runtimeCalibrate(threadId, {
              scenarioId: "full-run",
              cadences: [30, 60, 120],
            });
            yield* saveResult(`clean-physics-${physicsHz}`, result);
            expect(result.physicsHz).toBe(physicsHz);
            expect(result.verdict, JSON.stringify(result.comparisons)).toBe("equivalent");
            expect(
              result.runs.every(
                (run) =>
                  run.error === null && run.playerLast?.[0] === 240 && run.gameState.visits === 1,
              ),
            ).toBe(true);
          }),
        );
    }),
  300000,
);
