// @effect-diagnostics nodeBuiltinImport:off -- Opt-in native probe: runs the real pinned Godot against a real temporary game.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { RawCheckResult } from "./godotCheckOutput.ts";
import * as GameToolchain from "./GameToolchain.ts";

const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);

const godotExecutable = NodePath.join(
  GameToolchain.toolsDirectory(),
  `godot-${GameToolchain.GODOT_VERSION}/Godot_v${GameToolchain.GODOT_VERSION}-stable_linux.x86_64`,
);

/**
 * Root-owned native validation, guarded by an explicit env opt-in so default
 * collection stays engine-free: the file only defines paths until the live
 * test body runs. Enable with GODOT_LAYOUT_CHECK_LIVE=1 on a machine with the
 * pinned toolchain installed.
 */
const liveEnabled =
  process.env.GODOT_LAYOUT_CHECK_LIVE === "1" && NodeFS.existsSync(godotExecutable);

it.skipIf(!liveEnabled)(
  "warns about clipped or overlapped interactive controls without false all-clear",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-layout-check-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      NodeFS.mkdirSync(projectDir, { recursive: true });
      const projectGodot = [
        "config_version=5",
        "[application]",
        'config/name="Layout holdout"',
        'run/main_scene="res://main.tscn"',
        "[display]",
        "window/size/viewport_width=960",
        "window/size/viewport_height=540",
        "[rendering]",
        'renderer/rendering_method="gl_compatibility"',
        "",
      ].join("\n");
      // One static scene covers every verdict: ScrollAction straddles the
      // ScrollContainer edge (partial, needs scroll), Covered sits under the
      // later Footer ColorRect (overlap risk), OffRight hangs off the viewport
      // edge, OffScreen is unreachable without a scroll, and Clean proves a
      // healthy control stays silent. SteadyButton sits under a rotated
      // occluder and FadedTarget under an opaque cover inside a fully
      // transparent ancestor: both are skipped as unknown, never reported.
      // Hidden, disabled, rotated, deep-scroll, and layered controls prove the
      // remaining skip paths stay silent too.
      const mainTscn = [
        "[gd_scene load_steps=1 format=3]",
        "",
        '[node name="Main" type="Control"]',
        "anchors_preset = 15",
        "anchor_right = 1.0",
        "anchor_bottom = 1.0",
        "grow_horizontal = 2",
        "grow_vertical = 2",
        "",
        '[node name="ScrollList" type="ScrollContainer" parent="."]',
        "offset_right = 400.0",
        "offset_bottom = 200.0",
        "",
        '[node name="Content" type="VBoxContainer" parent="ScrollList"]',
        "layout_mode = 2",
        "",
        '[node name="FillerTop" type="Control" parent="ScrollList/Content"]',
        "custom_minimum_size = Vector2(400, 180)",
        "layout_mode = 2",
        "",
        '[node name="ScrollAction" type="Button" parent="ScrollList/Content"]',
        "custom_minimum_size = Vector2(200, 44)",
        "layout_mode = 2",
        'text = "Scroll action"',
        "",
        '[node name="FillerBottom" type="Control" parent="ScrollList/Content"]',
        "custom_minimum_size = Vector2(400, 460)",
        "layout_mode = 2",
        "",
        '[node name="DeepItem" type="Button" parent="ScrollList/Content"]',
        "custom_minimum_size = Vector2(200, 44)",
        "layout_mode = 2",
        'text = "Deep item"',
        "",
        '[node name="Covered" type="Button" parent="."]',
        "offset_left = 100.0",
        "offset_top = 100.0",
        "offset_right = 300.0",
        "offset_bottom = 144.0",
        'text = "Covered"',
        "",
        '[node name="Footer" type="ColorRect" parent="."]',
        "offset_left = 100.0",
        "offset_top = 120.0",
        "offset_right = 300.0",
        "offset_bottom = 180.0",
        "color = Color(0.72, 0.45, 0.2, 1)",
        "",
        '[node name="OffRight" type="Button" parent="."]',
        "offset_left = 900.0",
        "offset_top = 500.0",
        "offset_right = 1100.0",
        "offset_bottom = 544.0",
        'text = "Off right"',
        "",
        '[node name="OffScreen" type="Button" parent="."]',
        "offset_left = 100.0",
        "offset_top = 600.0",
        "offset_right = 300.0",
        "offset_bottom = 644.0",
        'text = "Off screen"',
        "",
        '[node name="Clean" type="Button" parent="."]',
        "offset_left = 100.0",
        "offset_top = 300.0",
        "offset_right = 300.0",
        "offset_bottom = 344.0",
        'text = "Clean"',
        "",
        '[node name="HiddenAction" type="Button" parent="."]',
        "visible = false",
        "offset_left = 100.0",
        "offset_top = 600.0",
        "offset_right = 300.0",
        "offset_bottom = 644.0",
        'text = "Hidden action"',
        "",
        '[node name="DisabledAction" type="Button" parent="."]',
        "disabled = true",
        "offset_left = 400.0",
        "offset_top = 600.0",
        "offset_right = 600.0",
        "offset_bottom = 644.0",
        'text = "Disabled action"',
        "",
        '[node name="RotatedAction" type="Button" parent="."]',
        "rotation = 0.5",
        "offset_left = 620.0",
        "offset_top = 600.0",
        "offset_right = 820.0",
        "offset_bottom = 644.0",
        'text = "Rotated action"',
        "",
        '[node name="Overlay" type="CanvasLayer" parent="."]',
        "layer = 2",
        "",
        '[node name="LayeredButton" type="Button" parent="Overlay"]',
        "offset_left = 500.0",
        "offset_top = 300.0",
        "offset_right = 700.0",
        "offset_bottom = 344.0",
        'text = "Layered"',
        "",
        '[node name="SteadyButton" type="Button" parent="."]',
        "offset_left = 500.0",
        "offset_top = 400.0",
        "offset_right = 700.0",
        "offset_bottom = 444.0",
        'text = "Steady"',
        "",
        '[node name="RotOccluder" type="ColorRect" parent="."]',
        "offset_left = 500.0",
        "offset_top = 410.0",
        "offset_right = 700.0",
        "offset_bottom = 470.0",
        "color = Color(0.2, 0.5, 0.8, 1)",
        "rotation = 0.5",
        "",
        '[node name="FadedTarget" type="Button" parent="."]',
        "offset_left = 700.0",
        "offset_top = 300.0",
        "offset_right = 900.0",
        "offset_bottom = 344.0",
        'text = "Faded"',
        "",
        '[node name="TransparentBox" type="Control" parent="."]',
        "offset_left = 700.0",
        "offset_top = 300.0",
        "offset_right = 900.0",
        "offset_bottom = 360.0",
        "modulate = Color(1, 1, 1, 0)",
        "",
        '[node name="OpaqueCover" type="ColorRect" parent="TransparentBox"]',
        "offset_left = 0.0",
        "offset_top = 10.0",
        "offset_right = 200.0",
        "offset_bottom = 60.0",
        "color = Color(0.8, 0.2, 0.2, 1)",
        "",
        ...["SelfFade", "PaintFade"].flatMap((name, index) => [
          `[node name="${name}Target" type="Button" parent="."]`,
          `offset_left = ${500 + index * 220}.0`,
          "offset_top = 100.0",
          `offset_right = ${650 + index * 220}.0`,
          "offset_bottom = 144.0",
          `text = "${name}"`,
          `[node name="${name}Parent" type="${index === 0 ? "Control" : "ColorRect"}" parent="."]`,
          `offset_left = ${500 + index * 220}.0`,
          "offset_top = 100.0",
          `offset_right = ${650 + index * 220}.0`,
          "offset_bottom = 144.0",
          index === 0 ? "self_modulate = Color(1, 1, 1, 0)" : "color = Color(1, 1, 1, 0)",
          `[node name="${name}Child" type="ColorRect" parent="${name}Parent"]`,
          "offset_right = 150.0",
          "offset_bottom = 44.0",
          "color = Color(0.8, 0.2, 0.2, 1)",
          "",
        ]),
      ].join("\n");
      NodeFS.writeFileSync(NodePath.join(projectDir, "project.godot"), projectGodot);
      NodeFS.writeFileSync(NodePath.join(projectDir, "main.tscn"), mainTscn);

      const scriptPath = NodePath.join(parent, "check.gd");
      const resultPath = NodePath.join(parent, "result.json");
      NodeFS.writeFileSync(scriptPath, GODOT_CHECK_SCRIPT);
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
          resultPath,
          "",
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 1_048_576,
          env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1", LP_NUM_THREADS: "2" },
        },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const decoded = decodeCheckResult(NodeFS.readFileSync(resultPath, "utf8"));
      expect(decoded.errors).toEqual([]);
      const layout = decoded.warnings.filter((warning) =>
        /% visible|outside the|overlap risk|ScrollContainer/.test(warning.message),
      );
      // Self modulation and a parent's paint alpha do not fade its children.
      expect(
        layout.map((warning) => warning.message),
        JSON.stringify(decoded.warnings, null, 2),
      ).toHaveLength(6);
      for (const name of ["SelfFade", "PaintFade"]) {
        expect(
          layout.some(
            (warning) =>
              warning.message.includes(`"${name}Target"`) &&
              warning.message.includes(`"${name}Child"`),
          ),
        ).toBe(true);
      }
      expect(
        layout.some(
          (warning) =>
            warning.message.includes('"ScrollAction"') &&
            warning.message.includes("ScrollContainer"),
        ),
      ).toBe(true);
      expect(
        layout.some(
          (warning) =>
            warning.message.includes('"Covered"') &&
            warning.message.includes("overlap risk") &&
            warning.message.includes("Footer"),
        ),
      ).toBe(true);
      expect(
        layout.some(
          (warning) =>
            warning.message.includes('"OffRight"') && warning.message.includes("viewport"),
        ),
      ).toBe(true);
      expect(
        layout.some(
          (warning) =>
            warning.message.includes('"OffScreen"') && warning.message.includes("outside the"),
        ),
      ).toBe(true);
      for (const name of [
        "Clean",
        "HiddenAction",
        "DeepItem",
        "DisabledAction",
        "RotatedAction",
        "LayeredButton",
        "SteadyButton",
        "FadedTarget",
      ]) {
        expect(
          decoded.warnings.some((warning) => warning.message.includes(`"${name}"`)),
          `expected silence for ${name}`,
        ).toBe(false);
      }
      // A missing camera stays a camera note, not a layout verdict: layout
      // diagnostics still run without one.
      expect(decoded.warnings.some((warning) => /Camera2D|Camera3D/.test(warning.message))).toBe(
        true,
      );
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);
