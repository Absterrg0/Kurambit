// @effect-diagnostics nodeBuiltinImport:off -- Runs the real pinned Godot, export templates and managed headless Chrome against an isolated starter.
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameRepairStudio from "./GameRepairStudio.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameService from "./GameService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  admissionTestLayer,
  designApprovalTestLayer,
  previewBrowserTestLayer,
  projectTestLayer,
  qualificationTestLayer,
  roundStoreTestLayer,
} from "./gameTestLayers.ts";

const workspaceRoot = (() => {
  let directory = process.cwd();
  for (
    let hops = 0;
    hops < 5 && !NodeFS.existsSync(NodePath.join(directory, "apps/server/package.json"));
    hops++
  ) {
    directory = NodePath.resolve(directory, "..");
  }
  return directory;
})();
const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);
const browserExecutable = (() => {
  const installRoot = NodePath.join(
    NodePath.join(workspaceRoot, ".t3"),
    "tools",
    "chrome-headless-shell",
  );
  if (!NodeFS.existsSync(installRoot)) return null;
  for (const platform of NodeFS.readdirSync(installRoot)) {
    const platformPath = NodePath.join(installRoot, platform);
    for (const version of NodeFS.readdirSync(platformPath)) {
      for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
        const candidate = NodePath.join(platformPath, version, name);
        if (NodeFS.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
})();
const templatesInstalled = (() => {
  const dataRoot = process.env.XDG_DATA_HOME ?? NodePath.join(NodeOS.homedir(), ".local/share");
  const roots = [
    NodePath.join(dataRoot, "godot/export_templates"),
    NodePath.join(
      GameToolchain.toolsDirectory(),
      `godot-${GameToolchain.GODOT_VERSION}`,
      "editor_data/export_templates",
    ),
  ];
  try {
    for (const root of roots) {
      if (!NodeFS.existsSync(root)) continue;
      for (const version of NodeFS.readdirSync(root))
        for (const name of ["web_nothreads_release.zip", "web_nothreads_debug.zip"])
          if (
            NodeFS.existsSync(NodePath.join(root, version, version, name)) ||
            NodeFS.existsSync(NodePath.join(root, version, name))
          )
            return true;
    }
  } catch {
    // Unreadable template roots count as missing.
  }
  return false;
})();
const available =
  NodeFS.existsSync(godotExecutable) && browserExecutable !== null && templatesInstalled;

const evidenceDirectory = NodePath.join(NodeOS.tmpdir(), "game-verify-evidence");

it.live.skipIf(!available)(
  "checks, tests, exports and records a real Web playtest of an isolated starter in one call",
  () =>
    Effect.gen(function* () {
      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-verify-real-")),
      );
      const stateDir = NodePath.join(parent, ".test-state");
      const dependencies = GameService.layer.pipe(
        Layer.provideMerge(GameProjectService.layer),
        Layer.provideMerge(GameOperations.layer),
        Layer.provideMerge(GameToolchain.layer),
        Layer.provideMerge(GamePreview.layer),
        Layer.provideMerge(GameProcesses.layer),
        Layer.provide(projectTestLayer()),
        Layer.provide(previewBrowserTestLayer(browserExecutable!)),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(designApprovalTestLayer(stateDir)),
        Layer.provideMerge(roundStoreTestLayer(stateDir)),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(admissionTestLayer),
        Layer.provide(NodeServices.layer),
      );
      const services = GameRepairStudio.layer({ stateDir }).pipe(Layer.provideMerge(dependencies));
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const projects = yield* GameProjectService.GameProjectService;
            const game = yield* GameService.GameService;
            const qualification = yield* GameQualification.GameQualification;
            const rounds = yield* GameRoundStore.GameRoundStore;
            const studio = yield* GameRepairStudio.GameRepairStudio;
            const created = yield* projects.create({
              name: "Verify Starter",
              parentDirectory: parent,
              template: "blank",
              brief: "Hold right and the square slides across the screen.",
              planFirst: false,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
            });
            yield* Effect.addFinalizer(() =>
              game.action(created.threadId, "stop").pipe(Effect.ignore),
            );
            yield* Effect.promise(async () => {
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scenes/main.tscn"),
                `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Background" type="ColorRect" parent="."]
offset_right = 960.0
offset_bottom = 540.0
color = Color(0.08, 0.1, 0.16, 1)

[node name="Player" type="Node2D" parent="." groups=["player"]]
position = Vector2(160, 280)

[node name="Body" type="Polygon2D" parent="Player"]
polygon = PackedVector2Array(-40, -40, 40, -40, 40, 40, -40, 40)
color = Color(0.95, 0.55, 0.2, 1)
`,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scripts/game_state.gd"),
                `extends Node

## A run value the probe reports; it drains while the game runs.
var energy := 100.0
`,
              );
              await NodeFSP.writeFile(
                NodePath.join(created.root, "godot/scripts/main.gd"),
                `extends Node2D

func _process(delta: float) -> void:
	GameState.energy = maxf(0.0, GameState.energy - 60.0 * delta)
	if Input.is_action_pressed("ui_right"):
		$Player.position.x = min($Player.position.x + 260.0 * delta, 820.0)
`,
              );
            });

            const result = yield* game.verify(created.threadId, {
              // The first hold establishes the gameplay baseline while the
              // player exists; the second is the movement the baseline measures.
              steps: [
                { key: "ArrowRight", holdMs: 600 },
                { key: "ArrowRight", holdMs: 600 },
              ],
              bootTimeoutMs: 45_000,
            });
            expect(result.success, result.message).toBe(true);
            expect(result.failedStage).toBeUndefined();
            expect(result.completed).toEqual(["check", "test", "export", "playtest"]);
            expect(result.check?.ok, JSON.stringify(result.check?.errors)).toBe(true);
            expect(result.test?.success, result.test?.message).toBe(true);
            expect(result.export?.success, result.export?.message).toBe(true);
            expect(result.build?.buildId).toMatch(/^[0-9a-f]{64}$/);
            expect(result.playtest?.booted).toBe(true);
            expect(result.playtest?.responded).toBe(true);
            expect(result.playtest?.success).toBe(true);
            expect(result.playtest?.qualifies, result.playtest?.blockers?.join("; ")).toBe(true);
            expect(result.playtest?.state?.playerMoved ?? 0).toBeGreaterThan(0.75);
            expect(result.screenshots.length).toBeGreaterThan(0);
            expect(result.screenshots[0]?.mimeType).toBe("image/png");
            expect(result.screenshots[0]?.width).toBeGreaterThan(0);
            expect(result.screenshots[0]?.height).toBeGreaterThan(0);

            const state = yield* rounds.read(created.root);
            expect(state.selected?.buildId).toBe(result.build?.buildId);
            const derived = yield* qualification.read(created.root, "godot");
            for (const stage of ["check", "test", "export", "playtest"] as const)
              expect(
                derived.stages.find((entry) => entry.stage === stage)?.status,
                `derived ${stage} status`,
              ).toBe("passed");
            const binding = yield* rounds.exported(created.root, result.build!.buildId);
            expect(binding?.playtest?.booted).toBe(true);
            expect(binding?.playtest?.executedInputSteps).toBe(2);
            expect(binding?.playtest?.consoleErrors).toBe(0);
            const facts = yield* studio.submissionFacts(created.root, result.build!.buildId);
            expect(facts.passed, facts.reason ?? "").toBe(true);

            yield* Effect.promise(async () => {
              await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
              for (const [index, frame] of result.screenshots.entries()) {
                const bytes = Buffer.from(frame.data, "base64");
                expect(bytes.subarray(0, 8)).toEqual(
                  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                );
                await NodeFSP.writeFile(
                  NodePath.join(evidenceDirectory, `game-verify-${index + 1}-${frame.label}.png`),
                  bytes,
                );
              }
            });
            yield* Effect.log(
              `game_verify real run: ${result.message} Frames: ${result.screenshots.length}; evidence: ${result.playtest?.evidenceDirectory}`,
            );
          }).pipe(Effect.provide(services)),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(parent, { recursive: true, force: true }));
      }
    }),
  600_000,
);
