// @effect-diagnostics nodeBuiltinImport:off -- Opt-in native ownership proof: runs the real pinned Godot scenario runner against real temporary games.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { GODOT_SCENARIO_SCRIPT } from "./godotScenarioScript.ts";
import { decodeScenarioEvidence } from "./gameScenarios.ts";
import * as GameToolchain from "./GameToolchain.ts";

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);

/**
 * Independent real-native ownership proof, guarded by the same opt-in as the
 * main spatial file so default collection stays engine-free. Enable with
 * GODOT_SPATIAL_LIVE=1 on a machine with the pinned toolchain installed.
 * Generic 2D/3D fixtures only, never Rover-specific names: they prove the
 * direct-shape ownership rule (a CollisionShape configures its immediate
 * CollisionObject parent; descendant Areas own their own shapes) plus
 * translated-parent transforms and rotated/non-box conservative bounds.
 */
const liveEnabled = process.env.GODOT_SPATIAL_LIVE === "1" && NodeFS.existsSync(godotExecutable);

const runGodot = (projectDir: string, request: unknown, scriptPath: string) => {
  const parent = NodePath.dirname(projectDir);
  const runDirectory = NodeFS.mkdtempSync(NodePath.join(parent, "probe-"));
  const requestPath = NodePath.join(runDirectory, "request.json");
  const resultPath = NodePath.join(runDirectory, "result.json");
  NodeFS.writeFileSync(requestPath, JSON.stringify(request));
  const run = NodeChildProcess.spawnSync(
    godotExecutable,
    [
      "--headless",
      "--fixed-fps",
      "60",
      "--path",
      projectDir,
      "--script",
      scriptPath,
      "--",
      requestPath,
      resultPath,
    ],
    {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1", LP_NUM_THREADS: "2" },
    },
  );
  return { run, requestPath, resultPath };
};

const approx = (actual: number | undefined, expected: number) => {
  expect(actual).toBeDefined();
  if (actual === undefined) throw new Error("Missing measured coordinate");
  expect(actual).toBeCloseTo(expected, 0);
};

const writeOwnership2D = (projectDir: string) => {
  NodeFS.mkdirSync(projectDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "project.godot"),
    [
      "config_version=5",
      "[application]",
      'config/name="Spatial Ownership 2D"',
      'run/main_scene="res://main.tscn"',
      "[autoload]",
      'GameState="*res://state.gd"',
      "[display]",
      "window/size/viewport_width=1152",
      "window/size/viewport_height=648",
      "[input]",
      "nudge={",
      '"deadzone": 0.5,',
      '"events": []',
      "}",
      "[rendering]",
      'rendering_method="gl_compatibility"',
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "state.gd"),
    "extends Node\nvar state := 1\nvar ticks := 0\nfunc _physics_process(_delta: float):\n\tticks += 1\n",
  );
  // Ownership: ParentArea owns one direct rectangle; NestedArea under it owns
  // its own smaller rectangle. A direct shape must never absorb a descendant
  // Area's shape. RotatedArea proves rotated rectangles are conservative.
  // Offset/Far proves translated-parent world transforms.
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "main.tscn"),
    [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[sub_resource type="RectangleShape2D" id="1"]',
      "size = Vector2(100, 100)",
      "",
      '[sub_resource type="RectangleShape2D" id="2"]',
      "size = Vector2(50, 50)",
      "",
      '[node name="Main" type="Node2D"]',
      "",
      '[node name="Player" type="CharacterBody2D" parent="." groups=["player"]]',
      "position = Vector2(100, 100)",
      "",
      '[node name="ParentArea" type="Area2D" parent="."]',
      "position = Vector2(200, 200)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="ParentArea"]',
      'shape = SubResource("1")',
      "",
      '[node name="NestedArea" type="Area2D" parent="ParentArea"]',
      "position = Vector2(10, 0)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="ParentArea/NestedArea"]',
      'shape = SubResource("2")',
      "",
      '[node name="RotatedArea" type="Area2D" parent="."]',
      "position = Vector2(500, 200)",
      "rotation = 0.785398",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="RotatedArea"]',
      'shape = SubResource("1")',
      "",
      '[node name="Offset" type="Node2D" parent="."]',
      "position = Vector2(50, 0)",
      "",
      '[node name="Far" type="Area2D" parent="Offset"]',
      "position = Vector2(150, 0)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="Offset/Far"]',
      'shape = SubResource("1")',
      "",
    ].join("\n"),
  );
};

const writeOwnership3D = (projectDir: string) => {
  NodeFS.mkdirSync(projectDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "project.godot"),
    [
      "config_version=5",
      "[application]",
      'config/name="Spatial Ownership 3D"',
      'run/main_scene="res://main.tscn"',
      "[autoload]",
      'GameState="*res://state.gd"',
      "[display]",
      "window/size/viewport_width=1152",
      "window/size/viewport_height=648",
      "[input]",
      "nudge={",
      '"deadzone": 0.5,',
      '"events": []',
      "}",
      "[rendering]",
      'rendering_method="gl_compatibility"',
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "state.gd"),
    "extends Node\nvar state := 1\nvar ticks := 0\nfunc _physics_process(_delta: float):\n\tticks += 1\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "main.tscn"),
    [
      "[gd_scene load_steps=3 format=3]",
      "",
      '[sub_resource type="BoxShape3D" id="1"]',
      "size = Vector3(2, 2, 2)",
      "",
      '[sub_resource type="CapsuleShape3D" id="2"]',
      "radius = 0.5",
      "height = 2.0",
      "",
      '[node name="Main" type="Node3D"]',
      "",
      '[node name="Player" type="CharacterBody3D" parent="." groups=["player"]]',
      "position = Vector3(1, 0, 0)",
      "",
      '[node name="ParentArea" type="Area3D" parent="."]',
      "position = Vector3(4, 0, 0)",
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="ParentArea"]',
      'shape = SubResource("1")',
      "",
      '[node name="NestedArea" type="Area3D" parent="ParentArea"]',
      "position = Vector3(0, 3, 0)",
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="ParentArea/NestedArea"]',
      'shape = SubResource("2")',
      "",
      '[node name="Tilted" type="Area3D" parent="."]',
      "position = Vector3(10, 0, 0)",
      "rotation = Vector3(0, 0.6, 0)",
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="Tilted"]',
      'shape = SubResource("1")',
      "",
    ].join("\n"),
  );
};

it.skipIf(!liveEnabled)(
  "2D nested Area ownership with rotated conservative bounds",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-spatial-own-2d-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      writeOwnership2D(projectDir);
      const scenarioPath = NodePath.join(parent, "ownership-2d.json");
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ id: "ownership-2d", steps: [{ press: "nudge" }, { wait: 30 }] }),
      );
      const scriptPath = NodePath.join(parent, "scenario.gd");
      NodeFS.writeFileSync(scriptPath, GODOT_SCENARIO_SCRIPT);
      const baseRequest = {
        scenarioPath,
        observations: [{ id: "ticks", key: "ticks", expect: "changes" }],
        sampleEvery: 6,
        bootFrames: 30,
        recordLayout: false,
        recordSpatial: true,
      };
      const { run, resultPath } = runGodot(projectDir, baseRequest, scriptPath);
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const decoded = decodeScenarioEvidence(NodeFS.readFileSync(resultPath, "utf8"));
      expect(decoded?.error).toBeNull();
      const spatial = decoded?.spatial;
      expect(spatial).toBeDefined();
      const first = spatial!.snapshots[0]!;
      // Direct-shape ownership: ParentArea keeps its own rectangle only.
      const parentArea = first.areas.find((area) => area.nodePath.endsWith("ParentArea"));
      expect(parentArea).toBeDefined();
      expect(parentArea!.shapes).toHaveLength(1);
      expect(parentArea!.shapes[0]!.nodePath).toContain("ParentArea/CollisionShape2D");
      expect(parentArea!.shapes[0]!.nodePath).not.toContain("NestedArea");
      // Descendant Areas own their own shapes, never their ancestor's.
      const nested = first.areas.find((area) => area.nodePath.endsWith("ParentArea/NestedArea"));
      expect(nested).toBeDefined();
      expect(nested!.shapes).toHaveLength(1);
      expect(nested!.shapes[0]!.nodePath).toContain("NestedArea/CollisionShape2D");
      // Translated parent: Offset (50,0) + Far (150,0) centers a 100x100 box
      // at (200,0), so world bounds are (150,-50)-(250,50).
      const far = first.areas.find((area) => area.nodePath.endsWith("Offset/Far"));
      expect(far).toBeDefined();
      const [minX, minY] = far!.shapes[0]!.bounds.min!;
      const [maxX, maxY] = far!.shapes[0]!.bounds.max!;
      approx(minX, 150);
      approx(minY, -50);
      approx(maxX, 250);
      approx(maxY, 50);
      expect(far!.shapes[0]!.conservative).toBe(false);
      // Rotated rectangle is conservative with finite expanded bounds.
      const rotated = first.areas.find((area) => area.nodePath.endsWith("RotatedArea"));
      expect(rotated).toBeDefined();
      expect(rotated!.shapes[0]!.conservative).toBe(true);
      const [rMinX, rMinY] = rotated!.shapes[0]!.bounds.min!;
      const [rMaxX, rMaxY] = rotated!.shapes[0]!.bounds.max!;
      for (const coord of [rMinX, rMinY, rMaxX, rMaxY]) expect(Number.isFinite(coord)).toBe(true);
      expect(rMaxX! - rMinX!).toBeGreaterThan(100);
      expect(rMaxY! - rMinY!).toBeGreaterThan(100);
      // No drift: probing off keeps the same physical frames and ticks.
      const off = runGodot(projectDir, { ...baseRequest, recordSpatial: false }, scriptPath);
      expect(off.run.status, `${off.run.stdout}\n${off.run.stderr}`).toBe(0);
      const baseline = decodeScenarioEvidence(NodeFS.readFileSync(off.resultPath, "utf8"));
      expect(baseline?.frames).toBe(decoded?.frames);
      expect(baseline?.playerMoved).toBe(decoded?.playerMoved);
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!liveEnabled)(
  "3D nested Area ownership with capsule and tilted-box conservative bounds",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-spatial-own-3d-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      writeOwnership3D(projectDir);
      const scenarioPath = NodePath.join(parent, "ownership-3d.json");
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ id: "ownership-3d", steps: [{ press: "nudge" }, { wait: 30 }] }),
      );
      const scriptPath = NodePath.join(parent, "scenario.gd");
      NodeFS.writeFileSync(scriptPath, GODOT_SCENARIO_SCRIPT);
      const baseRequest = {
        scenarioPath,
        observations: [{ id: "ticks", key: "ticks", expect: "changes" }],
        sampleEvery: 6,
        bootFrames: 30,
        recordLayout: false,
        recordSpatial: true,
      };
      const { run, resultPath } = runGodot(projectDir, baseRequest, scriptPath);
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const decoded = decodeScenarioEvidence(NodeFS.readFileSync(resultPath, "utf8"));
      expect(decoded?.error).toBeNull();
      const spatial3d = decoded?.spatial;
      expect(spatial3d).toBeDefined();
      const first = spatial3d!.snapshots[0]!;
      expect(first).toBeDefined();
      const parentArea = first.areas.find((area) => area.nodePath.endsWith("ParentArea"));
      expect(parentArea!.shapes).toHaveLength(1);
      expect(parentArea!.shapes[0]!.shapeKind).toBe("BoxShape3D");
      expect(parentArea!.shapes[0]!.conservative).toBe(false);
      const nested = first.areas.find((area) => area.nodePath.endsWith("ParentArea/NestedArea"));
      expect(nested!.shapes).toHaveLength(1);
      expect(nested!.shapes[0]!.shapeKind).toBe("CapsuleShape3D");
      expect(nested!.shapes[0]!.conservative).toBe(true);
      expect(nested!.shapes[0]!.bounds.kind).toBe("aabb3");
      const tilted = first.areas.find((area) => area.nodePath.endsWith("Tilted"));
      expect(tilted!.shapes[0]!.conservative).toBe(true);
      expect(tilted!.shapes[0]!.bounds.kind).toBe("aabb3");
      const off = runGodot(projectDir, { ...baseRequest, recordSpatial: false }, scriptPath);
      expect(off.run.status, `${off.run.stdout}\n${off.run.stderr}`).toBe(0);
      const baseline = decodeScenarioEvidence(NodeFS.readFileSync(off.resultPath, "utf8"));
      expect(baseline?.frames).toBe(decoded?.frames);
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);
