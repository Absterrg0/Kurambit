import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  GameActionResult,
  GameBlenderCodeInput,
  GameBlenderCodeResult,
  GameBlenderExportInput,
  GameBlenderExportResult,
  GameBlenderLookInput,
  GameBlenderLookResult,
  GameBlenderSceneInput,
  GameBlenderSceneResult,
  GameBlenderAssetsSearchInput,
  GameBlenderAssetsSearchResult,
  GameBlenderAssetsImportInput,
  GameBlenderAssetsImportResult,
  GameBlenderGenerateInput,
  GameBlenderGenerateResult,
  GameCheckResult,
  GameOperationFailure,
  GameStatus,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameBotRunInput,
  GameBotRunResult,
  GameBotReportResult,
  GameBotViewInput,
  GameBotViewResult,
  GameWebPackage,
  GameWindowsPackage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
const dependencies = [
  GameService.GameService,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([GameOperationFailure, OrchestratorMcpFailure]);
void Context;
void Fiber;
/**
 * Run threads from the GameRun production loop get play-level tools only
 * (status, check, import, export, explore, game_bot_*, game_blender_*).
 * Everything else hides from them through this check.
 */
const isGameRunThread = () => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined) return false;
  return (
    Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)
      ?.gameRunRole === "run"
  );
};
/** Play-level tools stay visible to run threads; the rest hide from them. */
const visibleToRunThreads = () => true;
const hiddenFromRunThreads = () => !isGameRunThread();
const GameStatusTool = Tool.make("game_status", {
  description:
    "Inspect this thread's Game Studio project: brief path, toolchain readiness and actionable repair instructions, assets with derived scene usage, scenes, builds, managed processes, log directory and playable preview URL. Requires game.json in this thread's workspace. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
  parameters: Schema.Struct({ checkSources: Schema.optionalKey(Schema.Boolean) }),
  success: GameStatus,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderCodeTool = Tool.make("game_blender_code", {
  description:
    "Run Python bpy code in this game's live Blender scene (pinned mcp-for-blender execute_blender_code, adapted). The scene stays alive across calls on a private display; the first call starts it. Anything Blender can do, you can do. The .blend source is saved in the game after each call. Use game_blender_look to see the result and game_blender_scene for counts, sizes and positions.",
  parameters: GameBlenderCodeInput,
  success: GameBlenderCodeResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameBlenderLookTool = Tool.make("game_blender_look", {
  description:
    "See the live Blender scene as one image (pinned mcp-for-blender look, adapted). Choose where from: viewport (what the scene shows; default), camera (through the scene camera), angles (the target from several sides) or frames (a strip over the animation). Shading: solid, material, rendered, wireframe or xray. Use it as much as you need; for counts, sizes and positions, use game_blender_scene. Every setting changed to take the picture is restored afterwards.",
  parameters: GameBlenderLookInput,
  success: GameBlenderLookResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderSceneTool = Tool.make("game_blender_scene", {
  description:
    "Facts about the live Blender scene as text (pinned mcp-for-blender get_scene_info, adapted): object counts, active object, then one line per object with location, size and children. No image; use game_blender_look to see the scene. For anything else about an object, read it with game_blender_code.",
  parameters: GameBlenderSceneInput,
  success: GameBlenderSceneResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderAssetsSearchTool = Tool.make("game_blender_assets_search", {
  description:
    "Search a library of existing assets for the live Blender scene (pinned mcp-for-blender search_assets, adapted). Sources: polyhaven (HDRIs, PBR textures and realistic models, all CC0, no key), sketchfab (user-made models; needs the user's Sketchfab API key in the scene) and polypizza (stylised low-poly, CC0 or CC-BY; needs the user's Poly Pizza API key). Pass the result id to game_blender_assets_import.",
  parameters: GameBlenderAssetsSearchInput,
  success: GameBlenderAssetsSearchResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderAssetsImportTool = Tool.make("game_blender_assets_import", {
  description:
    "Download a library asset into the live Blender scene (pinned mcp-for-blender import_asset, adapted). Afterwards the .blend source is saved in the game (art/blender/live.blend) and a GLB is exported under godot/assets/blender/ that the game can load; run game_import after so Godot sees it. Polyhaven textures need applyTo object names to be used, otherwise the material is unused. Imported models arrive at arbitrary scale: check the reported bounding box, put them on the ground, and look at them.",
  parameters: GameBlenderAssetsImportInput,
  success: GameBlenderAssetsImportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderGenerateTool = Tool.make("game_blender_generate", {
  description:
    "Forward to the upstream 3D generator (pinned mcp-for-blender generate_3d, adapted): one new textured model from a text prompt or an image. No generator is configured on this machine (no Premium, no Tripo/Hunyuan/Hyper3D/Meshy key), so this reports that clearly instead of generating. Wire a key to enable it later; the seam already forwards prompt, image, name and provider.",
  parameters: GameBlenderGenerateInput,
  success: GameBlenderGenerateResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderExportTool = Tool.make("game_blender_export", {
  description:
    "Export the live Blender scene (or the named objects) as a GLB under godot/ that the game can load: pass objects to export only those, or nothing to export every mesh. Defaults to godot/assets/blender/scene.glb. The .blend source is saved in the game with the export. Run game_import after so Godot sees it.",
  parameters: GameBlenderExportInput,
  success: GameBlenderExportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameBlenderLookToolkit = Toolkit.make(GameBlenderLookTool);
const ImportTool = Tool.make("game_godot_import", {
  description:
    "Run a real headless editor import in this thread's game. Call after every asset transfer or engine change. game_import is the preferred neutral name and behaves identically. Returns success=false on parse errors, missing resources, import errors or nonzero exit, with stdout/stderr and log path. Fix failures before export.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
/** Preferred neutral name for the editor import; the godot-named tool is its legacy alias. */
const ImportNeutralTool = Tool.make("game_import", {
  description:
    "Run a real headless engine import in this thread's game. Call after every asset transfer or engine change. Identical to game_godot_import (its legacy alias): returns success=false on parse errors, missing resources, import errors or nonzero exit, with stdout/stderr and log path. Fix failures before export.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const CheckTool = Tool.make("game_godot_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. game_check is the preferred neutral name and behaves identically. Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
/** Preferred neutral name for the static and boot check; the godot-named tool is its legacy alias. */
const CheckNeutralTool = Tool.make("game_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. Identical to game_godot_check (its legacy alias). Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest. On a three.js game this loads the static page in headless Chromium and reports console and page errors instead.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExportTool = Tool.make("game_export", {
  description:
    "Import and export this thread's game. Godot games take the Web, Windows or Linux release preset: Windows produces builds/windows/game.exe, a 64-bit x86_64 executable. The standard preset embeds the game data, so the executable alone is enough; a custom preset that does not embed it also produces builds/windows/game.pck, so heed the result and copy both files together. It has not been run on Windows. Linux produces builds/linux/game.x86_64. three.js games export Web only (a static copy of the game); Windows and Linux are refused. Web exports to a content-addressed build the export selects for Play at once. Verifies the actual artifact. Missing Windows templates are an actionable error; Install tools adds them without replacing the Godot binary. Web uses Compatibility rendering and single-threaded export. Returns actual paths and command output or errors. Use game_preview to build and serve a playable browser URL.",
  parameters: Schema.Struct({ target: Schema.Literals(["Web", "Linux", "Windows"]) }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const PackageWindowsTool = Tool.make("game_package_windows", {
  description:
    "Package the Windows release this game already exported as a downloadable ZIP. It never exports: if builds/windows/game.exe is missing, is not a checked x86_64 executable with the game's Godot pack, or changes while packaging, it returns the exact reason and leaves existing release files and any earlier package untouched. The ZIP contains game.exe and, only for a non-embedded preset, game.pck, at the archive root so extraction is runnable. Returns the absolute archive path, byte count, SHA-256, per-file hashes and notes; the Builds panel also receives a short-lived signed download URL. Packaging does not prove Windows booted.",
  // No `parameters`: an explicit empty Schema.Struct({}) serializes to a root
  // anyOf, which no MCP client accepts, and the whole server fails to register.
  success: GameWindowsPackage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const PackageWebTool = Tool.make("game_package_web", {
  description:
    "Package the exact immutable Web build Play currently serves as a downloadable ZIP for an ordinary static game host. It never exports, never rebuilds and never packages a draft: if no build is selected, or the selected build is missing or its bytes changed, it returns the exact reason and leaves the selection, sources and any earlier package untouched. The ZIP contains every served build file at its relative path with index.html at the archive root. The archive is bound to the selected build id and its own SHA-256. Upload and serve the extracted files over HTTP; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP. Returns the absolute archive path, byte count, SHA-256, per-file hashes, entry and notes; the Builds panel also receives a short-lived signed download URL.",
  // No `parameters` here either; see game_package_windows.
  success: GameWebPackage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const PreviewTool = Tool.make("game_preview", {
  description:
    "Build this thread's Web release when it is missing or older than the game sources, start its managed loopback static server, and return the playable URL. A fresh existing build is served without another export. This is an actual WebAssembly game, not a screenshot. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Game Studio, including running Blender/Godot operations and native play, and close its Web preview server. Returns after managed processes exit. Does not kill external editors or other games.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
/**
 * Bounded persistent exploration: open one paused session on the current game sources, poke it with short act/observe cycles across turns, then close it
 */
const ExploreStartTool = Tool.make("game_explore_start", {
  description:
    "Open a bounded exploration session on this thread's game: Godot games run natively with the game paused between acts; three.js games load the static folder in headless Chromium and play in real time. Probes, visible text, interactive controls, errors and (with xvfb on PATH for native, always for web) a picture. Nothing is exported. Pass target native or web to pick the runner, or omit it for the game's own engine. Returns a session id for game_explore_act. Only one live session exists per game: its owning thread must close it before that game starts another.",
  parameters: GameExploreStartInput,
  success: GameExploreStartResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExploreActTool = Tool.make("game_explore_act", {
  description:
    "Run one short input batch (1–6 steps, at most 10 s nominal) in an exploration session and observe what happened: the current probe, one persisted screenshot path (null with a reason when the session has no display) and bounded console text, plus visible screenText, interactive ui controls, script/engine errors, per-ui-step receipt and per-inspect-step read-only values; use ui {id, action} for real mouse input at a listed control and inspect {path} for read-only reflection. The player stays paused between calls, so observations cost no game time. Descriptive only, never a verdict.",
  parameters: GameExploreActInput,
  success: GameExploreActResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExploreCloseTool = Tool.make("game_explore_close", {
  description:
    "Close an exploration session, releasing its runner and profile. Idle and wall-clock expiry close the same way with the reason saved.",
  parameters: GameExploreCloseInput,
  success: GameExploreCloseResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BotRunTool = Tool.make("game_bot_run", {
  description:
    "Play this thread's game in real time with a model-written bot file under .studio/bot/ (goal, observe, options with facts and executors, status, optional policy). Godot games run continuously at normal speed on a private display; three.js games run in headless Chromium. Holds and releases go out at 10 Hz, one continuous video per run is recorded, and in-game detectors report findings with time and position. decider policy (default) uses the bot's own policy; jev asks the optional Jev route, which decides asynchronously without stopping play and falls back to policy on failure. mode play (default) tries to finish with a win bot; mode explore wanders with an exploration bot (broad options, no win goal) and may make several sequential runs when runs is set (1-10, default 1), writing a facts-only player report to .studio/player-report.md. Every run is recorded in .studio/bot-results.jsonl by the service. The bot may write state only through an explicit set-state call; a run that did is marked and is not pure play. Pass the bot file, seconds budget, decider, mode and runs.",
  parameters: GameBotRunInput,
  success: GameBotRunResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BotReportTool = Tool.make("game_bot_report", {
  description:
    "Rebuild the facts-only player report across this game's recorded bot runs and save it to .studio/player-report.md: run endings, what was picked and how often, offered-but-never-picked and rarely-picked options, first-action times, death/stall position clusters, sampled areas, detector findings and explicit state writes. Code states facts and interprets nothing.",
  success: GameBotReportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BotViewTool = Tool.make("game_bot_view", {
  description:
    "Take a quick look at a finished bot run: goal status, measured tick rate and game/wall ratio, decisions, findings and server-owned paths to the trace, video and frames. Pass the runId from game_bot_run.",
  parameters: GameBotViewInput,
  success: GameBotViewResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
/** The studio toolkit: status, export and play-level tools for every thread. */
export const GameToolkit = Toolkit.make(
  GameStatusTool,
  BlenderCodeTool,
  BlenderSceneTool,
  BlenderAssetsSearchTool,
  BlenderAssetsImportTool,
  BlenderGenerateTool,
  BlenderExportTool,
  ImportTool,
  ImportNeutralTool,
  CheckTool,
  CheckNeutralTool,
  ExportTool,
  PackageWindowsTool,
  PackageWebTool,
  PreviewTool,
  StopTool,
  ExploreStartTool,
  ExploreActTool,
  ExploreCloseTool,
  BotRunTool,
  BotViewTool,
  BotReportTool,
);
