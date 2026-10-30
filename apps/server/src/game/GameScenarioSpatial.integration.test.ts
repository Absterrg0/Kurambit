// @effect-diagnostics nodeBuiltinImport:off -- Opt-in native probe: runs the real pinned Godot scenario runner against real temporary games.
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
 * Root-owned native validation, guarded by an explicit env opt-in so default
 * collection stays engine-free. Enable with GODOT_SPATIAL_LIVE=1 on a machine
 * with the pinned toolchain installed. Fixtures are generic 2D/3D Area shapes
 * under translated parents, never game-specific names: they prove engine
 * transforms and the no-drift rule (inspection on/off keeps the same physical
 * frames and state).
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

const write2DProject = (projectDir: string) => {
  NodeFS.mkdirSync(projectDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "project.godot"),
    [
      "config_version=5",
      "[application]",
      'config/name="Spatial 2D"',
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
      'renderer/rendering_method="gl_compatibility"',
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "state.gd"),
    "extends Node\nvar state := 1\nvar ticks := 0\nfunc _physics_process(_delta: float):\n\tticks += 1\n",
  );
  // Generic 2D fixture: a player plus three areas. Spawn overlaps the player
  // origin, Far sits under a translated parent, Empty has no shape (unknown).
  // Seventeen filler areas push the run past the 16-area cap to prove
  // truncation, all with the same shared rectangle.
  const filler = Array.from(
    { length: 17 },
    (_, index) =>
      `[node name="Filler${index}" type="Area2D" parent="."]\nposition = Vector2(${400 + index * 10}, 500)\n\n[node name="CollisionShape2D" type="CollisionShape2D" parent="Filler${index}"]\nshape = SubResource("1")\n`,
  ).join("\n");
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "main.tscn"),
    [
      "[gd_scene load_steps=2 format=3]",
      "",
      '[sub_resource type="RectangleShape2D" id="1"]',
      "size = Vector2(100, 100)",
      "",
      '[node name="Main" type="Node2D"]',
      "",
      '[node name="Player" type="CharacterBody2D" parent="." groups=["player"]]',
      "position = Vector2(100, 100)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="Player"]',
      'shape = SubResource("1")',
      "",
      '[node name="Spawn" type="Area2D" parent="."]',
      "position = Vector2(100, 100)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="Spawn"]',
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
      '[node name="Empty" type="Area2D" parent="."]',
      "position = Vector2(300, 300)",
      "",
      '[node name="CollisionShape2D" type="CollisionShape2D" parent="Empty"]',
      "",
      filler,
    ].join("\n"),
  );
};

const write3DProject = (projectDir: string) => {
  NodeFS.mkdirSync(projectDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(projectDir, "project.godot"),
    [
      "config_version=5",
      "[application]",
      'config/name="Spatial 3D"',
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
      'renderer/rendering_method="gl_compatibility"',
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
      "[gd_scene load_steps=4 format=3]",
      "",
      '[sub_resource type="BoxShape3D" id="1"]',
      "size = Vector3(2, 2, 2)",
      "",
      '[sub_resource type="SphereShape3D" id="2"]',
      "radius = 1.0",
      "",
      '[sub_resource type="ConcavePolygonShape3D" id="3"]',
      "faces = PackedVector3Array(0, 0, 0, 1, 0, 0, 0, 1, 0)",
      "",
      '[node name="Main" type="Node3D"]',
      "",
      '[node name="Player" type="CharacterBody3D" parent="." groups=["player"]]',
      "position = Vector3(1, 0, 0)",
      "",
      '[node name="Spawn" type="Area3D" parent="."]',
      "position = Vector3(1, 0, 0)",
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="Spawn"]',
      'shape = SubResource("1")',
      "",
      '[node name="Offset" type="Node3D" parent="."]',
      "position = Vector3(10, 0, 0)",
      "",
      '[node name="Far" type="Area3D" parent="Offset"]',
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="Offset/Far"]',
      'shape = SubResource("2")',
      "",
      '[node name="Unsupported" type="Area3D" parent="."]',
      "position = Vector3(5, 5, 5)",
      "",
      '[node name="CollisionShape3D" type="CollisionShape3D" parent="Unsupported"]',
      'shape = SubResource("3")',
      "",
    ].join("\n"),
  );
};

const approx = (actual: number | undefined, expected: number) => {
  expect(actual).toBeDefined();
  if (actual === undefined) throw new Error("Missing measured coordinate");
  expect(actual).toBeCloseTo(expected, 0);
};

it.skipIf(!liveEnabled)(
  "2D world bounds follow translated parents and truncate honestly",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-spatial-2d-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      write2DProject(projectDir);
      const scenarioPath = NodePath.join(parent, "spatial-2d.json");
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ id: "spatial-2d", steps: [{ press: "nudge" }, { wait: 30 }] }),
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
      // Boot plus one input boundary: at least two synchronous snapshots.
      expect(spatial!.coverage.snapshots).toBeGreaterThanOrEqual(2);
      expect(spatial!.snapshots.length).toBeLessThanOrEqual(4);
      // Player group origin and built-in body kind are captured.
      const first = spatial!.snapshots[0]!;
      expect(first.player.present).toBe(true);
      expect(first.player.position).toHaveLength(2);
      expect(first.player.bodyKind).toContain("CharacterBody");
      // Translated nesting: Offset (50,0) + Far (150,0) centers a 100x100 box
      // at (200,0), so world bounds are (150,-50)-(250,50).
      const far = first.areas.find((area) => area.nodePath.endsWith("Offset/Far"));
      expect(far).toBeDefined();
      const farShape = far!.shapes[0]!;
      expect(farShape.bounds.kind).toBe("rect2");
      const [minX, minY] = farShape.bounds.min!;
      const [maxX, maxY] = farShape.bounds.max!;
      approx(minX, 150);
      approx(minY, -50);
      approx(maxX, 250);
      approx(maxY, 50);
      expect(farShape.conservative).toBe(false);
      expect(farShape.containsPlayerOrigin).toBe(false);
      // Overlap at spawn: the player origin sits inside Spawn.
      const spawn = first.areas.find((area) => area.nodePath.endsWith("Spawn"));
      expect(spawn!.shapes[0]!.containsPlayerOrigin).toBe(true);
      // Empty shape is explicit unknown, never invented geometry.
      const empty = first.areas.find((area) => area.nodePath.endsWith("Empty"));
      expect(empty!.shapes[0]!.bounds.kind).toBe("unknown");
      expect(empty!.shapes[0]!.containsPlayerOrigin).toBeNull();
      // Seventeen fillers push past the 16-area cap: truncation is honest.
      expect(spatial!.coverage.truncated).toBe(true);
      expect(spatial!.coverage.areas).toBeLessThanOrEqual(16);
      expect(spatial!.coverage.shapes).toBeLessThanOrEqual(32);
      for (const snapshot of spatial!.snapshots) {
        for (const area of snapshot.areas) {
          for (const shape of area.shapes) {
            if (shape.bounds.min !== null) {
              for (const coord of [...shape.bounds.min, ...shape.bounds.max!])
                expect(Number.isFinite(coord)).toBe(true);
            }
          }
        }
      }
      // No timing drift: the same route without probing keeps the same
      // physical frames, ticks and player samples.
      const off = runGodot(projectDir, { ...baseRequest, recordSpatial: false }, scriptPath);
      expect(off.run.status, `${off.run.stdout}\n${off.run.stderr}`).toBe(0);
      const baseline = decodeScenarioEvidence(NodeFS.readFileSync(off.resultPath, "utf8"));
      expect(baseline?.frames).toBe(decoded?.frames);
      expect(baseline?.playerMoved).toBe(decoded?.playerMoved);
      const ticks = decoded?.observations.find((entry) => entry.key === "ticks");
      const baselineTicks = baseline?.observations.find((entry) => entry.key === "ticks");
      expect(ticks?.first).toBe(baselineTicks?.first);
      expect(ticks?.last).toBe(baselineTicks?.last);
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!liveEnabled)(
  "3D boxes, spheres and unsupported shapes report conservative bounds",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-spatial-3d-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      write3DProject(projectDir);
      const scenarioPath = NodePath.join(parent, "spatial-3d.json");
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ id: "spatial-3d", steps: [{ press: "nudge" }, { wait: 30 }] }),
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
      expect(first.player.present).toBe(true);
      expect(first.player.position).toHaveLength(3);
      expect(first.player.bodyKind).toContain("CharacterBody");
      // Box at the player origin contains it; exact box is not conservative.
      const spawn = first.areas.find((area) => area.nodePath.endsWith("Spawn"));
      const box = spawn!.shapes[0]!;
      expect(box.bounds.kind).toBe("aabb3");
      const [bMinX, bMinY, bMinZ] = box.bounds.min!;
      const [bMaxX, bMaxY, bMaxZ] = box.bounds.max!;
      approx(bMinX, 0);
      approx(bMinY, -1);
      approx(bMinZ, -1);
      approx(bMaxX, 2);
      approx(bMaxY, 1);
      approx(bMaxZ, 1);
      expect(box.conservative).toBe(false);
      expect(box.containsPlayerOrigin).toBe(true);
      // Sphere under a translated parent is a conservative AABB away from home.
      const far = first.areas.find((area) => area.nodePath.endsWith("Offset/Far"));
      const sphere = far!.shapes[0]!;
      expect(sphere.shapeKind).toBe("SphereShape3D");
      expect(sphere.bounds.kind).toBe("aabb3");
      expect(sphere.conservative).toBe(true);
      expect(sphere.containsPlayerOrigin).toBe(false);
      const [sMinX] = sphere.bounds.min!;
      const [sMaxX] = sphere.bounds.max!;
      approx(sMinX, 9);
      approx(sMaxX, 11);
      // Unsupported shape kinds are explicit unknown.
      const unsupported = first.areas.find((area) => area.nodePath.endsWith("Unsupported"));
      expect(unsupported!.shapes[0]!.bounds.kind).toBe("unknown");
      expect(unsupported!.shapes[0]!.conservative).toBe(true);
      // Drift check mirrors the 2D proof: probing adds no physics.
      const off = runGodot(projectDir, { ...baseRequest, recordSpatial: false }, scriptPath);
      expect(off.run.status, `${off.run.stdout}\n${off.run.stderr}`).toBe(0);
      const baseline = decodeScenarioEvidence(NodeFS.readFileSync(off.resultPath, "utf8"));
      expect(baseline?.frames).toBe(decoded?.frames);
      const ticks = decoded?.observations.find((entry) => entry.key === "ticks");
      const baselineTicks = baseline?.observations.find((entry) => entry.key === "ticks");
      expect(ticks?.last).toBe(baselineTicks?.last);
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);
