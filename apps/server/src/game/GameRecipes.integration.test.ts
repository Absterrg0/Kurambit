// @effect-diagnostics globalTimers:off -- The Godot timeout is a wall-clock guard around a tracked child process, not an Effect workflow timer.
// @effect-diagnostics nodeBuiltinImport:off -- Generates real Godot projects, runs the pinned headless engine, exports Web builds and plays them in the headless browser.
import { it, expect } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  type GamePlaytestProbe,
  type GamePlaytestScreenshot,
  type GamePlaytestStateValue,
  type GameRecipeAdapter,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import * as GamePreview from "./GamePreview.ts";
import * as GameRecipes from "./GameRecipes.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { GODOT_CHECK_SCRIPT } from "./godotCheckScript.ts";
import { RawCheckResult, parseGodotIssues } from "./godotCheckOutput.ts";
import { gameRecipeCatalog } from "./recipeCatalog.ts";
import { GODOT_RECIPE_ENGINE_VERSION } from "./recipes/godot/index.ts";

/**
 * Every shipped reference, in catalog id order. Each one is run against a
 * generated project: the catalog must stay a set of references a model can
 * actually boot, not code that merely looks plausible in a review.
 */
const RECIPE_IDS = [
  "feel.buffer",
  "feel.coyote",
  "feel.hit-stop",
  "feel.pickup",
  "feel.shake",
  "look.lighting-2d",
  "loop.card",
  "loop.dialogue",
  "loop.first-person",
  "loop.platformer",
  "loop.puzzle",
  "loop.racing",
  "loop.top-down",
  "loop.tower",
  "read.hud",
  "read.onboarding",
  "read.silhouette",
  "state.world",
] as const;
type RecipeId = (typeof RECIPE_IDS)[number];

/** The spec's maximum GDScript lines per recipe, setup included. */
const LINE_BUDGETS: Record<RecipeId, number> = {
  "feel.buffer": 60,
  "feel.coyote": 60,
  "feel.hit-stop": 60,
  "feel.shake": 60,
  "feel.pickup": 70,
  "read.silhouette": 70,
  "state.world": 70,
  "read.hud": 70,
  "read.onboarding": 70,
  "loop.platformer": 130,
  "loop.top-down": 130,
  "loop.card": 150,
  "loop.dialogue": 130,
  "loop.tower": 150,
  "loop.racing": 150,
  "loop.puzzle": 130,
  "loop.first-person": 130,
  "look.lighting-2d": 110,
};

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
/** Same install layouts the preview browser and template integration test use. */
const findBrowserExecutable = (): string | null => {
  const roots = [
    NodePath.join(workspaceRoot, ".t3", "tools", "chrome-headless-shell"),
    NodePath.join(NodeOS.homedir(), ".local/share/game-studio/tools", "chrome-headless-shell"),
  ];
  for (const root of roots) {
    if (!NodeFS.existsSync(root)) continue;
    for (const platform of NodeFS.readdirSync(root)) {
      const platformPath = NodePath.join(root, platform);
      if (!NodeFS.statSync(platformPath).isDirectory()) continue;
      for (const version of NodeFS.readdirSync(platformPath)) {
        for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const candidate = NodePath.join(platformPath, version, name);
          if (NodeFS.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
};
const decodeCheckResult = Schema.decodeUnknownSync(RawCheckResult);
const browserExecutable = findBrowserExecutable();
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
        for (const name of ["web_nothreads_release.zip", "linux_release.x86_64"])
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

/** Frames stay outside the checkout for the operator and reviewer. */
const framesRoot = () =>
  process.env.GAME_STUDIO_RECIPE_FRAMES?.trim() ||
  NodePath.join(NodeOS.homedir(), ".gs-tmp", "t62b", "frames");

const PROJECT_GODOT = `config_version=5

[application]

config/name="Recipe reference"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")

[autoload]

RecipeProbe="*res://probe.gd"

[display]

window/size/viewport_width=640
window/size/viewport_height=360
window/size/window_width_override=640
window/size/window_height_override=360
window/stretch/mode="viewport"
window/stretch/aspect="keep"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;

const MAIN_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1_main"]

[node name="Main" type="Node2D"]
script = ExtResource("1_main")
`;

const EXPORT_PRESETS = `[preset.0]

name="Web"
platform="Web"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path="build/index.html"
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false

[preset.0.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/canvas_resize_policy=2
progressive_web_app/enabled=false
`;

/**
 * Test-only bridge. The reference already exposes `snapshot()`; this autoload
 * parks it on `window.__studioProbe`, which is exactly where the production
 * playtest reads the StudioProbe, so the existing measurement code sees the
 * reference's own state without the reference depending on a probe.
 */
const PROBE_GD = `extends Node
## Test-only bridge: forwards the root scene's snapshot() through the playtest's
## window.__studioProbe path. No gameplay logic lives here.

var _callback: JavaScriptObject = null
var _window: JavaScriptObject = null

func _ready() -> void:
	if not OS.has_feature("web"):
		return
	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return
	_callback = JavaScriptBridge.create_callback(_read)
	_window.__studioProbeCallback = _callback
	JavaScriptBridge.eval("window.__studioProbe = function () { window.__studioProbeLast = null; window.__studioProbeCallback(); return window.__studioProbeLast; };", true)

func _read(_args: Array) -> String:
	var text := JSON.stringify(snapshot())
	JavaScriptBridge.eval("window.__studioProbeLast = %s" % JSON.stringify(text), true)
	return text

func snapshot() -> Dictionary:
	var scene := get_tree().current_scene
	var state: Dictionary = {}
	if scene != null and scene.has_method("snapshot"):
		state = scene.snapshot()
	var player: Variant = null
	if state.has("player_x") and state.has("player_y"):
		player = {"x": state["player_x"], "y": state["player_y"], "z": 0.0}
	return {"gameState": state, "player": player}
`;

interface GodotRun {
  readonly exitCode: number | null;
  readonly output: string;
}

/** One tracked child at a time; a timeout kills only that child. */
const runGodot = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Effect.Effect<GodotRun, GameOperationError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<GodotRun>((resolve, reject) => {
        const child = NodeChildProcess.spawn(executable, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          output += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          output += chunk;
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `Godot timed out after ${timeoutMs} ms: ${args.join(" ")}\n${output.slice(-4000)}`,
            ),
          );
        }, timeoutMs);
        child.once("error", (cause) => {
          clearTimeout(timer);
          reject(cause);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code, output });
        });
      }),
    catch: (cause) =>
      new GameOperationError({
        operation: "godot-recipe",
        path: executable,
        reason: "command-failed",
        cause,
      }),
  });

const expectNoEngineErrors = (run: GodotRun, label: string) => {
  expect(run.exitCode, `${label} exited ${String(run.exitCode)}\n${run.output.slice(-4000)}`).toBe(
    0,
  );
  const issues = parseGodotIssues(run.output);
  expect(issues, `${label} printed engine errors:\n${run.output.slice(-4000)}`).toEqual([]);
};

const writeProject = async (directory: string, adapter: GameRecipeAdapter) => {
  const godot = NodePath.join(directory, "godot");
  await NodeFSP.mkdir(godot, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(godot, "project.godot"), PROJECT_GODOT);
  await NodeFSP.writeFile(NodePath.join(godot, "main.tscn"), MAIN_SCENE);
  await NodeFSP.writeFile(NodePath.join(godot, "main.gd"), adapter.referenceCode);
  await NodeFSP.writeFile(NodePath.join(godot, "probe.gd"), PROBE_GD);
  await NodeFSP.writeFile(NodePath.join(godot, "export_presets.cfg"), EXPORT_PRESETS);
};

const checkProject = (directory: string, parent: string) =>
  Effect.gen(function* () {
    const scriptPath = NodePath.join(parent, "check.gd");
    const resultPath = NodePath.join(parent, "check.json");
    yield* Effect.promise(() => NodeFSP.writeFile(scriptPath, GODOT_CHECK_SCRIPT));
    const run = yield* runGodot(
      godotExecutable,
      [
        "--headless",
        "--path",
        NodePath.join(directory, "godot"),
        "--script",
        scriptPath,
        "--",
        resultPath,
        "",
      ],
      120_000,
    );
    expectNoEngineErrors(run, "check");
    const result = yield* Effect.promise(() =>
      NodeFSP.readFile(resultPath, "utf8").catch(() => ""),
    );
    const decoded = decodeCheckResult(result);
    expect(decoded.errors, `${JSON.stringify(decoded.errors, null, 2)}`).toEqual([]);
    // A reference installs its own actions in _ready, which the checker's static
    // InputMap lint cannot see; the camera warning is the same 2D heuristic.
    const unexpected = decoded.warnings.filter(
      (warning) =>
        !warning.message.includes("is used but not defined in the InputMap") &&
        !warning.message.includes("No Camera2D or Camera3D"),
    );
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });

const exportProject = (directory: string) =>
  Effect.gen(function* () {
    const build = NodePath.join(directory, "build");
    yield* Effect.promise(() => NodeFSP.mkdir(build, { recursive: true }));
    const run = yield* runGodot(
      godotExecutable,
      [
        "--headless",
        "--path",
        NodePath.join(directory, "godot"),
        "--export-release",
        "Web",
        NodePath.join(build, "index.html"),
      ],
      300_000,
    );
    expectNoEngineErrors(run, "web export");
    for (const name of ["index.html", "index.js", "index.wasm", "index.pck"]) {
      const stat = yield* Effect.promise(() => NodeFSP.stat(NodePath.join(build, name)));
      expect(stat.size, `${name} was empty`).toBeGreaterThan(0);
    }
    return build;
  });

const probeState = (probe: GamePlaytestProbe | null): Record<string, GamePlaytestStateValue> => {
  expect(probe).not.toBeNull();
  return probe!.gameState;
};

const frameProbes = (screenshots: readonly GamePlaytestScreenshot[]) =>
  screenshots.flatMap((shot) => (shot.probe === undefined ? [] : [shot.probe]));

const frameName = (index: number, label: string) =>
  `${String(index + 1).padStart(2, "0")}-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}.png`;

const saveEvidence = async (id: string, result: GameWebPlaytestResult) => {
  const directory = NodePath.join(framesRoot(), id);
  // A run owns its frame directory: stale frames from an earlier route would
  // otherwise sit beside the current ones and mislead the reviewer.
  await NodeFSP.rm(directory, { recursive: true, force: true });
  await NodeFSP.mkdir(directory, { recursive: true });
  const frames: string[] = [];
  for (const [index, shot] of result.screenshots.entries()) {
    const file = NodePath.join(directory, frameName(index, shot.label));
    await NodeFSP.writeFile(file, Buffer.from(shot.data, "base64"));
    frames.push(file);
  }
  await NodeFSP.writeFile(
    NodePath.join(directory, "report.json"),
    JSON.stringify(
      {
        id,
        message: result.message,
        booted: result.booted,
        bootMs: result.bootMs,
        responded: result.responded,
        changedPercent: result.changedPercent,
        executedInputSteps: result.executedInputSteps,
        state: result.state,
        frames: result.screenshots.map((shot, index) => ({
          file: frames[index],
          label: shot.label,
          probe: shot.probe ?? null,
        })),
        consoleMessages: result.consoleMessages,
      },
      null,
      2,
    ),
  );
  return frames;
};

/**
 * What "meaningful before/after change" means for each mechanism. The state is
 * read from the reference's own snapshot() through the bridge, so a frame that
 * merely changed pixels cannot pass: the mechanism's own numbers have to move.
 */
const assertMechanism = (id: RecipeId, result: GameWebPlaytestResult) => {
  const before = probeState(result.state?.before ?? null);
  const after = probeState(result.state?.after ?? null);
  const during = frameProbes(result.screenshots);
  switch (id) {
    case "feel.buffer":
      // The playtest baseline is the first sample after player input, so the
      // first press has already produced jump 1; the buffered press adds jump 2.
      expect(before.jumps).toBe(1);
      expect(after.jumps).toBe(2);
      expect(after.queued_ms).toBe(0);
      // The counter proves the second jump was the queued press spent on the
      // landing, not a fresh press after touchdown.
      expect(after.buffered_jumps).toBe(1);
      expect(during.some((probe) => probe.gameState.jumps === 2)).toBe(true);
      break;
    case "feel.coyote":
      expect(before.jumps).toBe(0);
      expect(after.jumps).toBe(1);
      expect(after.coyote_jumps).toBe(1);
      expect(after.ignored).toBe(1);
      expect(during.some((probe) => probe.gameState.coyote_jumps === 1)).toBe(true);
      break;
    case "feel.hit-stop":
      expect(before.strikes).toBe(0);
      expect(after.strikes).toBe(1);
      expect(after.pause_ms).toBe(0);
      expect(after.player_x).toBe(120);
      expect(
        during.some(
          (probe) => probe.gameState.strikes === 1 && Number(probe.gameState.pause_ms) > 0,
        ),
      ).toBe(true);
      // The marker lives outside the pause branch: its own counter moved during
      // the hold, and a captured frame shows the hold and that movement together.
      expect(Number(after.hold_motion)).toBeGreaterThan(0);
      expect(
        during.some(
          (probe) =>
            Number(probe.gameState.pause_ms) > 0 && Number(probe.gameState.hold_motion) > 0,
        ),
      ).toBe(true);
      break;
    case "feel.shake":
      // The baseline is the impact sample itself: it is already shaking.
      expect(before.impacts).toBe(1);
      expect(during.some((probe) => Number(probe.gameState.amplitude) > 0)).toBe(true);
      expect(after.impacts).toBe(1);
      expect(after.amplitude).toBe(0);
      expect(after.offset_x).toBe(0);
      expect(after.offset_y).toBe(0);
      break;
    case "feel.pickup":
      expect(before.collected).toBe(0);
      expect(before.gem_present).toBe(true);
      expect(before.effects).toBe(0);
      expect(after.collected).toBe(1);
      expect(after.score).toBe(1);
      expect(after.gem_present).toBe(false);
      expect(after.effects).toBe(0);
      expect(during.some((probe) => probe.gameState.effects === 1)).toBe(true);
      break;
    case "loop.platformer":
      // The baseline is after the first small step: no pickup, no retry yet.
      expect(before.score).toBe(0);
      expect(before.gem_present).toBe(true);
      expect(before.retries).toBe(0);
      expect(after.score).toBe(1);
      expect(after.gem_present).toBe(false);
      expect(after.jumps).toBe(1);
      expect(after.retries).toBe(1);
      expect(after.on_floor).toBe(true);
      expect(after.under_ledge).toBe(true);
      // The retry respawns at the start and the held key keeps control.
      expect(Number(after.player_x)).toBeGreaterThan(120);
      expect(Number(after.player_x)).toBeLessThan(280);
      expect(during.some((probe) => probe.gameState.score === 1)).toBe(true);
      break;
    case "loop.top-down":
      expect(before.target_hp).toBe(3);
      expect(before.shots).toBe(0);
      expect(after.target_hp).toBe(0);
      expect(after.target_down).toBe(true);
      expect(after.hits).toBe(3);
      expect(after.score).toBe(1);
      expect(during.some((probe) => probe.gameState.target_hp === 2)).toBe(true);
      expect(during.some((probe) => Number(probe.gameState.shots_in_flight) > 0)).toBe(true);
      break;
    case "loop.card":
      // The empty click is the baseline: an untouched turn.
      expect(before.energy).toBe(3);
      expect(before.turn).toBe(0);
      expect(before.enemy_hp).toBe(10);
      expect(before.played).toBe(0);
      expect(before.rejected).toBe(0);
      expect(after.enemy_hp).toBe(7);
      expect(after.played).toBe(1);
      expect(after.rejected).toBe(1);
      expect(after.energy).toBe(3);
      expect(after.turn).toBe(1);
      expect(after.hand_size).toBe(3);
      expect(
        during.some((probe) => probe.gameState.energy === 2 && probe.gameState.enemy_hp === 7),
      ).toBe(true);
      break;
    case "loop.dialogue":
      // The first answer is the locked one: the node and its flags must not move.
      expect(before.node).toBe("start");
      expect(before.trust).toBe(0);
      expect(before.blocked).toBe(1);
      expect(after.node).toBe("end");
      expect(after.trust).toBe(1);
      expect(after.lantern).toBe(true);
      expect(after.rope).toBe(false);
      expect(after.blocked).toBe(1);
      expect(during.some((probe) => probe.gameState.node === "help")).toBe(true);
      expect(during.some((probe) => probe.gameState.node === "reward")).toBe(true);
      break;
    case "loop.tower":
      // The pad click is the purchase, so the baseline already paid for it; the
      // pre-click 60 gold and zero towers live in the paired frames.
      expect(before.gold).toBe(20);
      expect(before.spent).toBe(40);
      expect(before.towers).toBe(1);
      expect(before.kills).toBe(0);
      expect(after.kills).toBe(2);
      expect(after.wave).toBe(2);
      expect(after.gold).toBe(30);
      expect(after.towers).toBe(1);
      expect(during.some((probe) => probe.gameState.gold === 60)).toBe(true);
      expect(during.some((probe) => probe.gameState.towers === 0)).toBe(true);
      expect(during.some((probe) => Number(probe.gameState.shots_in_flight) > 0)).toBe(true);
      break;
    case "loop.racing":
      // The wrong-way press crosses the finish with no checkpoints: no lap.
      expect(before.laps).toBe(0);
      expect(before.out_of_order).toBe(1);
      expect(before.checkpoints).toBe(0);
      expect(after.laps).toBe(1);
      expect(after.checkpoints).toBe(3);
      expect(after.next_checkpoint).toBe(0);
      expect(Number(after.out_of_order)).toBeGreaterThanOrEqual(1);
      expect(during.some((probe) => probe.gameState.laps === 1)).toBe(true);
      break;
    case "loop.puzzle":
      expect(before.pushes).toBe(0);
      expect(before.box_x).toBe(3);
      expect(before.player_cell_x).toBe(2);
      expect(after.pushes).toBe(1);
      expect(after.undos).toBe(1);
      expect(after.blocked).toBe(1);
      expect(after.box_x).toBe(3);
      expect(after.player_cell_x).toBe(2);
      expect(after.boxes_on_target).toBe(0);
      expect(
        during.some(
          (probe) =>
            probe.gameState.pushes === 1 &&
            probe.gameState.box_x === 4 &&
            probe.gameState.boxes_on_target === 1,
        ),
      ).toBe(true);
      break;
    case "loop.first-person":
      // The click captures; the baseline is captured with the view at rest.
      expect(before.captured).toBe(true);
      expect(before.yaw_deg).toBe(0);
      expect(before.pitch_deg).toBe(0);
      expect(after.captured).toBe(false);
      expect(Number(after.yaw_deg)).not.toBe(0);
      expect(Number(after.pitch_deg)).not.toBe(0);
      expect(Number(after.walked)).toBeGreaterThan(100);
      expect(
        during.some(
          (probe) => probe.gameState.captured === true && Number(probe.gameState.yaw_deg) !== 0,
        ),
      ).toBe(true);
      break;
    case "read.silhouette":
      expect(before.in_contact).toBe(false);
      expect(after.contacts).toBeGreaterThanOrEqual(1);
      expect(after.in_contact).toBe(true);
      expect(Number(after.actor_value) - Number(after.background_value)).toBeGreaterThanOrEqual(40);
      expect(Number(after.background_value) - Number(after.hazard_value)).toBeGreaterThanOrEqual(
        20,
      );
      // The actor's fill is the advertised tunable itself, not a separate literal.
      expect(after.actor_fill).toBe("f2f2f2");
      break;
    case "look.lighting-2d":
      // The first press is the baseline: the lamp is already off. The later
      // presses bring it back and off again, so the counter records all three.
      expect(before.lamp_on).toBe(false);
      expect(before.toggles).toBe(1);
      expect(after.lamp_on).toBe(false);
      expect(after.toggles).toBe(3);
      expect(during.some((probe) => probe.gameState.lamp_on === true)).toBe(true);
      expect(during.some((probe) => probe.gameState.toggles === 2)).toBe(true);
      // The boot frame was lit and the run ends dark: rendered pixels changed.
      expect(result.responded).toBe(true);
      break;
    case "state.world":
      expect(before.locked).toBe(true);
      expect(before.gate_open).toBe(false);
      expect(after.locked).toBe(false);
      expect(after.gate_open).toBe(true);
      expect(after.lever_pulled).toBe(true);
      expect(Number(after.player_x)).toBeGreaterThan(500);
      break;
    case "read.hud":
      // The baseline follows the hit; the pre-hit 3 lives in the frames before it.
      expect(before.health).toBe(2);
      expect(Number(before.feedback_ms)).toBeGreaterThan(0);
      expect(after.health).toBe(2);
      expect(after.goal).toBe(2);
      expect(after.feedback_ms).toBe(0);
      expect(during.some((probe) => probe.gameState.health === 3)).toBe(true);
      expect(during.some((probe) => Number(probe.gameState.feedback_ms) > 0)).toBe(true);
      // The instruction line was measured: it stays inside the bottom band at a
      // readable size, during the flash as well.
      expect(Number(after.hint_font_size)).toBeGreaterThanOrEqual(10);
      expect(Number(after.hint_height)).toBeLessThanOrEqual(40);
      expect(
        during.some(
          (probe) =>
            Number(probe.gameState.feedback_ms) > 0 && Number(probe.gameState.hint_height) <= 40,
        ),
      ).toBe(true);
      break;
    case "read.onboarding": {
      expect(before.prompt).toBe(false);
      expect(after.prompt).toBe(false);
      expect(after.opened).toBe(true);
      expect(after.prompts_shown).toBe(1);
      expect(during.some((probe) => probe.gameState.prompt === true)).toBe(true);
      // Hover, keyboard focus and press each have a distinct captured state.
      const promptStates = during.map((probe) => probe.gameState.prompt_state);
      expect(promptStates).toContain("focus");
      expect(promptStates).toContain("hover");
      expect(promptStates).toContain("pressed");
      break;
    }
  }
};

const recipeLayer = Layer.merge(
  Layer.succeed(GameRecipes.GameRecipes, GameRecipes.make(gameRecipeCatalog)),
  GamePreview.layer,
);

const recipeJourney = (id: RecipeId) =>
  Effect.scoped(
    Effect.gen(function* () {
      const recipes = yield* GameRecipes.GameRecipes;
      const preview = yield* GamePreview.GamePreview;
      const entry = yield* recipes.get({ id });
      expect(entry.adapter, `${id} has no Godot adapter`).not.toBeNull();
      const adapter = entry.adapter!;
      expect(adapter.engineVersion).toBe(GameToolchain.GODOT_VERSION);

      const parent = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-recipe-")),
      );
      return yield* Effect.gen(function* () {
        const directory = NodePath.join(parent, id.replace(/\./g, "-"));
        yield* Effect.promise(() => writeProject(directory, adapter));
        // 1. The real checker compiles the script, instantiates the scene and
        //    steps 120 physics frames: the reference boots, not just parses.
        yield* checkProject(directory, parent);
        // 2. A real web export, then the existing headless playtest drives the
        //    recorded input route in a real browser.
        const build = yield* exportProject(directory);
        const url = yield* preview.open(directory, "build");
        const result = yield* GameWebPlaytest.playtest({
          executable: browserExecutable!,
          url,
          profileDirectory: NodePath.join(parent, "browser-profile"),
          width: 640,
          height: 360,
          bootTimeoutMs: 30_000,
          steps: adapter.tryInput.steps,
          captureAllSteps: true,
          ...(adapter.tryInput.captureEveryMs === undefined
            ? {}
            : { captureEveryMs: adapter.tryInput.captureEveryMs }),
          probeRequired: false,
          acceptance: null,
        });
        const frames = yield* Effect.promise(() => saveEvidence(id, result));
        expect(result.booted, result.message).toBe(true);
        expect(result.consoleMessages.filter((message) => message.level === "error")).toEqual([]);
        expect(result.executedInputSteps, result.message).toBe(
          adapter.tryInput.steps.filter(
            (step) =>
              "key" in step ||
              "keys" in step ||
              "press" in step ||
              "click" in step ||
              "mouseMove" in step ||
              "drag" in step,
          ).length,
        );
        assertMechanism(id, result);
        yield* Effect.log(
          `${id}: ${result.message}\n  frames: ${frames.join(", ")}\n  build: ${build}`,
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(() =>
            process.env.GAME_STUDIO_KEEP_TEST === "1"
              ? Promise.resolve()
              : NodeFSP.rm(parent, { recursive: true, force: true }),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(recipeLayer));

it.effect("serves every reference within its line budget and at the pinned Godot version", () =>
  Effect.gen(function* () {
    expect(GODOT_RECIPE_ENGINE_VERSION).toBe(GameToolchain.GODOT_VERSION);
    const recipes = yield* GameRecipes.GameRecipes;
    const first = yield* recipes.search({});
    expect(first.recipes.length).toBeLessThanOrEqual(5);
    // Browse every page, so the check holds whether the catalog fits one page
    // (a partial catalog while references land) or needs a cursor.
    const discovered = [...first.recipes];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = yield* recipes.search({ cursor });
      discovered.push(...page.recipes);
      cursor = page.nextCursor;
    }
    expect(discovered.map((recipe) => recipe.id)).toEqual([...RECIPE_IDS]);

    for (const id of RECIPE_IDS) {
      const entry = yield* recipes.get({ id });
      expect(entry.engine).toBe("godot");
      expect(entry.adapter?.engineVersion).toBe(GameToolchain.GODOT_VERSION);
      const code = entry.adapter!.referenceCode.replace(/\n$/, "");
      expect(code.split("\n").length, `${id} exceeds its GDScript line budget`).toBeLessThanOrEqual(
        LINE_BUDGETS[id],
      );
      expect(entry.adapter!.setup.length).toBeGreaterThan(20);
      expect(entry.adapter!.tryInput.steps.length).toBeGreaterThan(0);
      expect(entry.adapter!.tryInput.steps.length).toBeLessThanOrEqual(12);
      expect(entry.adapter!.referenceCode).toContain("func snapshot() -> Dictionary:");
      // The guidance stays a hint: 120 words is the authoring budget, not a gate,
      // but a paragraph that long would no longer be guidance.
      const guidance = [
        entry.recipe.intent,
        entry.recipe.why,
        entry.recipe.failure,
        entry.recipe.restyle,
      ].join(" ");
      expect(guidance.split(/\s+/).length).toBeLessThanOrEqual(120);
    }
  }).pipe(Effect.provide(recipeLayer)),
);

for (const id of RECIPE_IDS) {
  it.live.skipIf(!available)(
    `runs ${id} from a generated project and records its frames`,
    () => recipeJourney(id),
    300_000,
  );
}
