// @effect-diagnostics nodeBuiltinImport:off -- Opt-in native probe: runs the real pinned Godot scenario runner against a real temporary game.
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
 * collection stays engine-free: the file only defines paths until the live
 * test body runs. Enable with GODOT_SCENARIO_LAYOUT_LIVE=1 on a machine with
 * the pinned toolchain installed. The fixture moves a control off the
 * viewport AFTER physical input, so a passing run proves the runtime probes
 * observe post-input geometry, not just the boot menu.
 */
const liveEnabled =
  process.env.GODOT_SCENARIO_LAYOUT_LIVE === "1" && NodeFS.existsSync(godotExecutable);

it.skipIf(!liveEnabled)(
  "runtime probes catch a control moved off-viewport by physical input",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-scenario-layout-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      NodeFS.mkdirSync(projectDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(projectDir, "project.godot"),
        [
          "config_version=5",
          "[application]",
          'config/name="Layout shift"',
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
        NodePath.join(projectDir, "mover.gd"),
        [
          "extends Control",
          "",
          "func _physics_process(_delta: float) -> void:",
          '	if Input.is_action_just_pressed("nudge"):',
          '		var target := get_node_or_null("TargetButton") as Button',
          "		if target != null:",
          "			target.position = Vector2(100, 900)",
          "",
        ].join("\n"),
      );
      NodeFS.writeFileSync(
        NodePath.join(projectDir, "main.tscn"),
        [
          "[gd_scene load_steps=2 format=3]",
          "",
          '[ext_resource type="Script" path="res://mover.gd" id="1"]',
          "",
          '[node name="Main" type="Control"]',
          "anchors_preset = 15",
          "anchor_right = 1.0",
          "anchor_bottom = 1.0",
          "grow_horizontal = 2",
          "grow_vertical = 2",
          'script = ExtResource("1")',
          "",
          '[node name="CleanButton" type="Button" parent="."]',
          "offset_left = 100.0",
          "offset_top = 100.0",
          "offset_right = 300.0",
          "offset_bottom = 144.0",
          'text = "Clean"',
          "",
          '[node name="TargetButton" type="Button" parent="."]',
          "offset_left = 100.0",
          "offset_top = 300.0",
          "offset_right = 300.0",
          "offset_bottom = 344.0",
          'text = "Target"',
          "",
        ].join("\n"),
      );
      const scenarioPath = NodePath.join(parent, "layout-shift.json");
      NodeFS.writeFileSync(
        scenarioPath,
        JSON.stringify({ id: "layout-shift", steps: [{ press: "nudge" }, { wait: 30 }] }),
      );
      const requestPath = NodePath.join(parent, "request.json");
      const request = {
        scenarioPath,
        observations: [{ id: "ticks", key: "ticks", expect: "changes" }],
        sampleEvery: 6,
        bootFrames: 30,
        recordLayout: true,
      };
      NodeFS.writeFileSync(requestPath, JSON.stringify(request));
      const resultPath = NodePath.join(parent, "result.json");
      const scriptPath = NodePath.join(parent, "scenario.gd");
      NodeFS.writeFileSync(scriptPath, GODOT_SCENARIO_SCRIPT);
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
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const decoded = decodeScenarioEvidence(NodeFS.readFileSync(resultPath, "utf8"));
      expect(decoded).not.toBeNull();
      expect(decoded?.error).toBeNull();
      const layout = decoded?.layout;
      expect(layout).toBeDefined();
      // The boot probe plus at least one post-input step boundary ran.
      expect(layout?.coverage.probes).toBeGreaterThanOrEqual(2);
      expect(layout?.coverage.viewport).toEqual({ width: 1152, height: 648 });
      const moved = (layout?.findings ?? []).filter((finding) =>
        finding.nodePath.includes("TargetButton"),
      );
      // The moved control is caught after the input that moved it: the probe
      // records the route step and a later scenario frame, not boot geometry.
      expect(moved.length).toBeGreaterThanOrEqual(1);
      expect(moved[0]?.kind).toBe("viewport");
      expect(moved[0]?.step).toBe(0);
      expect(moved[0]?.scenarioFrame).toBeGreaterThan(decoded?.firstInputFrame ?? -1);
      expect(moved[0]?.viewport).toEqual({ width: 1152, height: 648 });
      // The untouched control stays silent: probes do not invent findings.
      expect(
        (layout?.findings ?? []).some((finding) => finding.subject.includes("CleanButton")),
        JSON.stringify(layout?.findings ?? [], null, 2),
      ).toBe(false);
      NodeFS.writeFileSync(requestPath, JSON.stringify({ ...request, recordLayout: false }));
      const baselineRun = NodeChildProcess.spawnSync(
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
      expect(baselineRun.status, `${baselineRun.stdout}\n${baselineRun.stderr}`).toBe(0);
      const baseline = decodeScenarioEvidence(NodeFS.readFileSync(resultPath, "utf8"));
      const ticks = decoded?.observations.find((entry) => entry.key === "ticks");
      const baselineTicks = baseline?.observations.find((entry) => entry.key === "ticks");
      expect(typeof ticks?.first).toBe("number");
      expect(typeof ticks?.last).toBe("number");
      expect(typeof baselineTicks?.first).toBe("number");
      expect(typeof baselineTicks?.last).toBe("number");
      expect(
        ticks?.first,
        "inspection must not advance autoload physics before loading the scene",
      ).toBe(baselineTicks?.first);
      expect(
        Number(ticks?.last) - Number(ticks?.first),
        "layout probes must not add game physics ticks",
      ).toBe(Number(baselineTicks?.last) - Number(baselineTicks?.first));
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);
