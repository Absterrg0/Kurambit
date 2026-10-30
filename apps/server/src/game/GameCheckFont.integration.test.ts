// @effect-diagnostics nodeBuiltinImport:off -- Opt-in native probe: runs the real pinned Godot against a real temporary game.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
 * test body runs. Enable with GODOT_FONT_CHECK_LIVE=1 on a machine with the
 * pinned toolchain installed.
 */
const liveEnabled = process.env.GODOT_FONT_CHECK_LIVE === "1" && NodeFS.existsSync(godotExecutable);

const sha256 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

it.skipIf(!liveEnabled)(
  "reports a missing default-font glyph as a warning without engine errors",
  () => {
    const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "godot-font-check-"));
    const projectDir = NodePath.join(parent, "project");
    try {
      NodeFS.mkdirSync(projectDir, { recursive: true });
      const projectGodot = [
        "config_version=5",
        "[application]",
        'config/name="Font coverage holdout"',
        'run/main_scene="res://main.tscn"',
        "[rendering]",
        'renderer/rendering_method="gl_compatibility"',
        "",
      ].join("\n");
      // A default-font Label with an unsupported check mark (live path), an
      // ASCII/accented control Label the fallback does support (silence
      // control), and a draw_string mention of the same check mark (source
      // path, since dynamic draw text may never appear on boot).
      const mainTscn = [
        "[gd_scene load_steps=4 format=3]",
        '[ext_resource type="Script" path="res://main.gd" id="1"]',
        '[sub_resource type="SystemFont" id="CustomFont"]',
        'font_names=PackedStringArray("DejaVu Sans")',
        '[sub_resource type="LabelSettings" id="CustomSettings"]',
        'font=SubResource("CustomFont")',
        '[node name="Main" type="Node2D"]',
        'script=ExtResource("1")',
        '[node name="Status" type="Label" parent="."]',
        'text="Delivered ✓"',
        '[node name="Control" type="Label" parent="."]',
        'text="A é 123"',
        '[node name="Custom" type="Label" parent="."]',
        'text="Custom →"',
        'label_settings=SubResource("CustomSettings")',
        "",
      ].join("\n");
      const mainGd = [
        "extends Node2D",
        `const UNUSED_SYMBOLS = "${Array.from({ length: 32 }, (_, index) => String.fromCodePoint(0x2600 + index)).join("")}"`,
        "func _draw() -> void:",
        '  draw_string(ThemeDB.fallback_font, Vector2(20, 60), "✓")',
        "",
      ].join("\n");
      NodeFS.writeFileSync(NodePath.join(projectDir, "project.godot"), projectGodot);
      NodeFS.writeFileSync(NodePath.join(projectDir, "main.tscn"), mainTscn);
      NodeFS.writeFileSync(NodePath.join(projectDir, "main.gd"), mainGd);
      const before = {
        tscn: sha256(mainTscn),
        gd: sha256(mainGd),
      };

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
      const fontWarnings = decoded.warnings.filter(
        (warning) => /2713/i.test(warning.message) && /font|glyph/i.test(warning.message),
      );
      expect(fontWarnings.length).toBeGreaterThan(0);
      // The live Label diagnostic names the control and says what it shows.
      expect(
        decoded.warnings.some(
          (warning) => warning.message.includes("shows") && warning.message.includes("Label"),
        ),
      ).toBe(true);
      expect(
        decoded.warnings.filter((warning) => /font|glyph/i.test(warning.message)).length,
      ).toBeLessThanOrEqual(10);
      // The source mention stays honest: potential risk, not proof on screen.
      expect(
        decoded.warnings.some(
          (warning) =>
            warning.message.includes("Source mentions") && warning.message.includes("not proof"),
        ),
      ).toBe(true);
      // Supported ASCII/accented control stays silent: no diagnostic names é.
      expect(decoded.warnings.some((warning) => /00E9|00C9/i.test(warning.message))).toBe(false);
      expect(decoded.warnings.some((warning) => warning.message.includes('Label "Custom"'))).toBe(
        false,
      );
      expect(decoded.warnings.some((warning) => warning.message.includes("U+2192"))).toBe(false);
      // The probe never rewrites the game it inspects.
      expect(sha256(NodeFS.readFileSync(NodePath.join(projectDir, "main.tscn"), "utf8"))).toBe(
        before.tscn,
      );
      expect(sha256(NodeFS.readFileSync(NodePath.join(projectDir, "main.gd"), "utf8"))).toBe(
        before.gd,
      );
    } finally {
      NodeFS.rmSync(parent, { recursive: true, force: true });
    }
  },
  120_000,
);
