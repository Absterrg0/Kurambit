import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import {
  GAME_EXPLORE_BOUNDS,
  GameActionResult,
  GameBlenderCodeInput,
  GameBlenderCodeResult,
  GameBlenderExportInput,
  GameBlenderExportResult,
  GameBlenderLookInput,
  GameBlenderLookResult,
  GameBlenderRenderSpritesInput,
  GameBlenderRenderSpritesResult,
  GameBlenderSceneInput,
  GameBlenderSceneResult,
  GameBlenderAssetsSearchInput,
  GameBlenderAssetsSearchResult,
  GameBlenderAssetsImportInput,
  GameBlenderAssetsImportResult,
  GameAssetsAddInput,
  GameAssetsAddResult,
  GameAssetsSearchInput,
  GameAssetsSearchResult,
  GameCheckResult,
  GameUnityConsoleInput,
  GameUnityEditInput,
  GameUnityEvalInput,
  GameUnityPlayInput,
  GameUnityRecompileResult,
  GameUnityScreenshotInput,
  GameUnityScreenshotResult,
  GameUnityTextResult,
  GameUnityToolsResult,
  GameOperationFailure,
  GameRunRoundDetail,
  GameRunStatusResult,
  GameRunChecksResult,
  GameRunStartResult,
  GameRunRestoreResult,
  GameRunStopResult,
  GameRunSteerResult,
  GameRunDecideInput,
  GameRunDecideResult,
  GameRunProfile,
  GameRunProfileResult,
  GameRunSubmitInput,
  GameRunSubmitResult,
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
  GameMediaSaveFields,
  GameSavedDeleteFields,
  GameSavedListResult,
  GameSavedMedia,
  GameWebPackage,
  GameWindowsPackage,
  OrchestratorMcpFailure,
} from "@kurambit/contracts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
const dependencies = [
  GameService.GameService,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([GameOperationFailure, OrchestratorMcpFailure]);
/**
 * Run threads from the production run get play-level tools only
 * (status, check, import, export, explore, game_bot_*, game_blender_*, game_unity_*, game_assets_*).
 * Every other game tool hides from them, as non-game tools do by default.
 */
const visibleToRunThreads = () => true;
const hiddenFromRunThreads = () => !McpInvocationContext.isGameRunThread();
const onlyForRunThreads = () => McpInvocationContext.isGameRunThread();
const GameStatusTool = Tool.make("game_status", {
  description:
    "Inspect this thread's Kurambit project: brief path, toolchain readiness and actionable repair instructions, assets with derived scene usage, scenes, builds, managed processes, log directory and playable preview URL. Requires game.json in this thread's workspace. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
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
    "Run Python bpy code in this game's live Blender scene (pinned mcp-for-blender execute_blender_code, adapted). The scene stays alive across calls on a private display; the first call starts it. Anything Blender can do, you can do, including rendering PNGs and writing WAVs with numpy and wave. Relative paths resolve from the game root; print every path you write. A Python error fails the call with its traceback. The .blend source is saved in the game after each successful call. Use game_blender_look to see the result and game_blender_scene for counts, sizes and positions.",
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
    "Download a library asset into the live Blender scene (pinned mcp-for-blender import_asset, adapted). Afterwards the .blend source is saved in the game (art/blender/live.blend) and a GLB is exported under <engine dir>/assets/blender/ (godot/ or web/; unity/Assets/Blender/ for Unity) that the game can load; run game_import after. Polyhaven textures need applyTo object names to be used, otherwise the material is unused. Imported models arrive at arbitrary scale: check the reported bounding box, put them on the ground, and look at them.",
  parameters: GameBlenderAssetsImportInput,
  success: GameBlenderAssetsImportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const BlenderExportTool = Tool.make("game_blender_export", {
  description:
    "Export the live Blender scene (or the named objects) as a GLB under the game's engine directory (godot/ or web/, the manifest's godotProject) that the game can load: pass objects to export only those, or nothing to export every mesh. Defaults to <engine dir>/assets/blender/scene.glb (unity/Assets/Blender/scene.glb for Unity). The .blend source is saved in the game with the export. Run game_import after.",
  parameters: GameBlenderExportInput,
  success: GameBlenderExportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameBlenderLookToolkit = Toolkit.make(GameBlenderLookTool);
export const GameBlenderRenderSpritesTool = Tool.make("game_blender_render_sprites", {
  description:
    "Render 2D sprites from the live Blender scene, framed correctly by construction: use this instead of writing camera, light and render code. Each view gets a fixed orthographic camera fitted to the objects across every frame of the animation, so nothing is cut off, the scale is the same in every frame and view, and the feet stand on the same pixel row in every frame, with the root object's origin on the centre column. A clip that moves the character (root motion) is refused: render an in-place clip. Pass objects (object or collection names; children come along; may be left out only when the scene holds one top-level object), pixelsPerUnit (leave it out for a character's first strip, then pass the value that strip reports to all its other strips so the body is the same size in each), views (front, back, left, right, top, isometric, or {name, azimuth, elevation}; default right; elevation tilts the side views down, 30-45 for a top-down 3/4 look), an animation (action, which plays over its own frame range in frameCount frames, default 8; or frameStart/frameEnd; or an explicit frames list; nothing renders the current pose), size (canvas px, default 64; height for non-square), anchor (feet, default, or center; top views centre), margin (px) and lighting (studio key/fill/rim that reads at small size, default, or scene). For a pixel-art game pass pixelArt: renders large, downscales, makes alpha hard, quantizes every frame to one shared palette (palette: the style pack's id or a PNG or folder in this game, colors: how many, default 16; without palette, the frames' own colours), and outline: true or #rrggbb adds a 1 px outline. Writes <output>_0.png ... <output>_N.png under the engine directory (a Unity game: under unity/Assets/, capital A, the only folder Unity imports) (<output>_<view>_N.png with several views), optionally <output>_sheet.png, records provenance in ASSETS.md and returns the files, the anchor and a contact sheet image to look at. The .blend stays the source and is not changed. Run game_import after.",
  parameters: GameBlenderRenderSpritesInput,
  success: GameBlenderRenderSpritesResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameBlenderRenderSpritesToolkit = Toolkit.make(GameBlenderRenderSpritesTool);
export const GameAssetsSearchTool = Tool.make("game_assets_search", {
  description:
    "Search Kurambit's pinned CC0 asset library: 2D sprites, tilesets, UI kits, icons, fonts, sound effects, music, animated 3D characters, 3D kits and PBR textures from Kenney, Quaternius, ambientCG and others. Public domain, no key, no attribution needed. Without pack it lists matching packs with their style, or every pack on one line each when you pass no query and no kind; pass pack to look inside one: the pack is downloaded once (checked against its pinned SHA-256) and matching files come with a contact sheet image numbered like the list (models are shown by their pictures), or the pack's own preview pictures when you pass no query and no kind. Page through long lists with offset. Only formats this game's engine loads are listed. Look at the sheet before adding, and keep one pack style per game. Add files with game_assets_add by the exact paths listed.",
  parameters: GameAssetsSearchInput,
  success: GameAssetsSearchResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameAssetsSearchToolkit = Toolkit.make(GameAssetsSearchTool);
const AssetsAddTool = Tool.make("game_assets_add", {
  description:
    "Copy files or whole folders from a library pack (paths as game_assets_search lists them) into this game: godot/assets/library/<pack>/, web/assets/library/<pack>/ or unity/Assets/Library/<pack>/, with names made path-safe. Models bring the textures they load; a folder add keeps one format per model, the one search shows. Never overwrites a file that differs; files already there are left alone. Appends each file's pack, source page and CC0 licence to ASSETS.md. Run game_import after.",
  parameters: GameAssetsAddInput,
  success: GameAssetsAddResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityToolsTool = Tool.make("game_unity_tools", {
  description:
    "List the editing tools of this Unity game's live editor (Unity's official `unity mcp`): scene, GameObject, component, prefab, material, settings and lighting tools, each with its input schema. Call one with game_unity_edit. The first game_unity_* call opens the editor on a private display, which can take a few minutes on a fresh project.",
  success: GameUnityToolsResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityEditTool = Tool.make("game_unity_edit", {
  description:
    "Call one editing tool from game_unity_tools in this Unity game's live editor, such as gameobject_create, gameobject_set_transform, component_add, component_set_field, script_attach or scene_get_hierarchy, with its arguments. Open scenes are saved after every call. Never hand-edit .unity, .prefab or .asset YAML; edit through this.",
  parameters: GameUnityEditInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityEvalTool = Tool.make("game_unity_eval", {
  description:
    "Evaluate C# in this Unity game's live editor on its main thread (Pipeline script eval); `return <value>;` sends a value back. UnityEngine and UnityEditor are available, and in play mode the running game is reachable. Use it for anything the editing tools do not cover; save scenes you change with UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes().",
  parameters: GameUnityEvalInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityRecompileTool = Tool.make("game_unity_recompile", {
  description:
    "Import changed files and recompile this Unity game's scripts in the live editor. Returns every C# compiler error with file and line. Run it after writing C# and fix errors before anything else.",
  success: GameUnityRecompileResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityPlayTool = Tool.make("game_unity_play", {
  description:
    "Enter (start) or leave (stop) play mode in this Unity game's live editor, for a quick look with game_unity_screenshot, game_unity_console or game_unity_eval. Real playtests with input use game_explore_*.",
  parameters: GameUnityPlayInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const UnityConsoleTool = Tool.make("game_unity_console", {
  description:
    "Read recent console entries of this Unity game's live editor, with stack traces. level is a minimum severity (log, warn, error).",
  parameters: GameUnityConsoleInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameUnityScreenshotTool = Tool.make("game_unity_screenshot", {
  description:
    "See this Unity game's Game view through its main camera as one image (Pipeline capture game_view, camera source). Works in and out of play mode; Screen Space Overlay UI only shows in game_explore_* pictures.",
  parameters: GameUnityScreenshotInput,
  success: GameUnityScreenshotResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
export const GameUnityScreenshotToolkit = Toolkit.make(GameUnityScreenshotTool);
const ImportTool = Tool.make("game_import", {
  description:
    "Run a real headless engine import in this thread's game. Call after every asset transfer or engine change. Returns success=false on parse errors, missing resources, import errors or nonzero exit, with stdout/stderr and log path. Fix failures before export.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const CheckTool = Tool.make("game_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest. On a three.js game this loads the static page in headless Chromium and reports console and page errors instead.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExportTool = Tool.make("game_export", {
  description:
    "Import and export this thread's game. Godot games take the Web, Windows or Linux release preset: Windows produces builds/windows/game.exe, a 64-bit x86_64 executable. The standard preset embeds the game data, so the executable alone is enough; a custom preset that does not embed it also produces builds/windows/game.pck, so heed the result and copy both files together. It has not been run on Windows. Linux produces builds/linux/game.x86_64. three.js games export Web only (a static copy of the game); Windows and Linux are refused. Web exports to a content-addressed build the export selects for Play at once. Verifies the actual artifact. Missing Windows templates are an actionable error naming how the user adds them in Godot. Web uses Compatibility rendering and single-threaded export. Returns actual paths and command output or errors. Use game_preview to build and serve a playable browser URL.",
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
const MediaSaveTool = Tool.make("game_media_save", {
  description:
    "Keep a video or image Kurambit generated when the creator wants it: a bot run's run.mp4 or frames, an explore session's screenshots, a comparison frame sheet, the run's final video. The storage cleanup deletes game logs after a while; this copies the file into the game's saved/ folder (ignored by git) under a readable dated name, and the original keeps working until the cleanup removes it. source is the game-relative or absolute path a game tool returned, inside builds/logs, .studio/comparisons or .studio; label gives the words after the date (\"round 2 bot run\"). Nothing in saved/ is overwritten: a taken name gets a number.",
  parameters: Schema.Struct(GameMediaSaveFields),
  success: GameSavedMedia,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const SavedListTool = Tool.make("game_saved_list", {
  description:
    "The videos and images saved in this game's saved/ folder with game_media_save or the Save button, newest first, with absolute paths.",
  success: GameSavedListResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const SavedDeleteTool = Tool.make("game_saved_delete", {
  description:
    "Delete one saved video or image from this game's saved/ folder when the creator asks, by the name game_saved_list gives. Only files directly in saved/ can be deleted.",
  parameters: Schema.Struct(GameSavedDeleteFields),
  success: Schema.Struct({}),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
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
    "Stop only this game's processes spawned by Kurambit, including running Blender/Godot operations and native play, and close its Web preview server. Returns after managed processes exit. Does not kill external editors or other games.",
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
    "Open a bounded exploration session on this thread's game: Godot games run natively with the game paused between acts; three.js games load the static folder in headless Chromium and play in real time. Probes, visible text, interactive controls, errors and a picture (native games need a window for it: Xvfb on Linux, a window kept off-screen on Windows and macOS; web games always have one). Nothing is exported. Pass target native or web to pick the runner, or omit it for the game's own engine. Returns a session id for game_explore_act. Only one live session exists per game: its owning thread must close it before that game starts another. Sessions start with no saved data; saves keep reuses one save location across kept sessions, to check that what the game saves (best scores, settings, unlocks) survives a relaunch.",
  parameters: GameExploreStartInput,
  success: GameExploreStartResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExploreActTool = Tool.make("game_explore_act", {
  description: `Run one input batch (1–${GAME_EXPLORE_BOUNDS.maxStepsPerCall} steps, at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall / 1000} s nominal) in an exploration session and observe what happened: the current probe, one persisted screenshot path (null with a reason when the session has no display) and bounded console text, plus visible screenText, interactive ui controls, script/engine errors, per-ui-step receipt and per-inspect-step read-only values; use ui {id, action} for real mouse input at a listed control and inspect {path} for read-only reflection. A session allows ${GAME_EXPLORE_BOUNDS.maxCalls} calls, ${GAME_EXPLORE_BOUNDS.maxTotalSteps} steps and ${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s of input, so the calls spend that input only at about ${Math.round(GAME_EXPLORE_BOUNDS.maxTotalNominalMs / GAME_EXPLORE_BOUNDS.maxCalls / 1000)} s per call: after one short hold shows how a control responds, send 2–3 held steps per call, at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall / 1000} s of input per call in total. Each result says the input used and the seconds per remaining call that spend the rest. Native games stay paused between calls; three.js games keep running in real time. Descriptive only, never a verdict.`,
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
    "Play this thread's game in real time with a model-written bot file under .studio/bot/ (goal, observe, options with facts and executors, status, optional policy). Godot games run continuously at normal speed in a window the user never sees, Unity games as a player of the current sources in one; three.js games run in headless Chromium. Holds and releases go out at 10 Hz, one continuous video per run is recorded from the game's own frames, and in-game detectors report findings with time and position. decider policy (default) uses the bot's own policy; jev asks the optional Jev route, which decides asynchronously without stopping play and falls back to policy on failure. mode play (default) tries to finish with a win bot; mode explore wanders with an exploration bot (broad options, no win goal) and may make several sequential runs when runs is set (1-10, default 1), writing a facts-only player report to .studio/player-report.md. The service records every run itself, with a readable copy in .studio/bot-results.jsonl. The bot may write state only through an explicit set-state call; a run that did is marked and is not pure play. Runs start with no saved data; saves keep carries the game's saved data across kept runs and exploration sessions, to check it survives a relaunch. Pass the bot file, seconds budget, decider, mode and runs.",
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
const runDependencies = [
  GameRunControl.GameRunControl,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const RunStatusTool = Tool.make("game_run_status", {
  description:
    "Whether this game's production run is live, what it is doing now (step), its profile (guided or autopilot), its rounds with verdicts and the creator notes waiting for the next round. While a Guided run waits for the creator, decision holds what to present: the evidence files (absolute paths), what goes with them, the answers the run accepts, its default and when the default fires; record the creator's answer with game_run_decide. Read-only. While a run is live, do not edit the game's files; pass the creator's requests to it with game_run_steer.",
  success: GameRunStatusResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const RunRoundTool = Tool.make("game_run_round", {
  description:
    "One finished round of this game's production run, read from the run's records: the move, the outcome (kept, inconclusive, rejected, unjudged, or abandoned by a restore), each blind comparator's verdict and reasoning, the blind players' reports, bot facts and bot runs, the tester's note and the reviewer's direction for the next round. Long texts are cut and end in an ellipsis. Read-only; use game_run_status for the round numbers.",
  parameters: Schema.Struct({
    round: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  success: GameRunRoundDetail,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const RunChecksTool = Tool.make("game_run_checks", {
  description:
    "Score the current rung's state checks on the build in this game folder now: the harness boots it, plays each check's scenario and reads the game's state, as the run does after a build. Returns pass or fail per check with the values it read and the scenario's last frame. Use it while building to know the rung holds before you stop. Look checks are a tester's; this scores state checks only. Takes a minute or two.",
  success: GameRunChecksResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  // The run's builder scores its rung with it; it names no build, so blind roles may see it too.
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);

const commandId = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
    description:
      "Any id of yours for this request. Pass the same one when you retry a call that may have gone through, so it applies once.",
  }),
);
const RunSteerTool = Tool.make("game_run_steer", {
  description:
    "Pass the creator's request to this game's production run. The note leads the direction of the run's next round; a round already in progress finishes as planned. A run that reached its goal (its ladder done or shipped), or whose plan wrote no ladder, comes back for one round on the note, then stops again: this is how the creator asks for polish after the run's goal is met. A stopped or interrupted run keeps the note for when it is resumed with game_run_start. Fails plainly when the game never had a run: then work on the game directly. Say the creator's request in their words, one request per call.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
    commandId,
  }),
  success: GameRunSteerResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const RunDecideTool = Tool.make("game_run_decide", {
  description:
    "Record the creator's answer to the decision this game's Guided production run is waiting on (game_run_status shows it). decisionId is the decision's id; answer is one of its answers (for a prototype pick-<n>, retry or run; for the style approve or redo; for the ladder approve, edit or rewrite). notes carries the creator's own words: what to take from the other prototype, what to change on a redo, retry or rewrite (required there), or for a ladder edit the full ladder JSON. An answer that does not fit is refused with the reason, so fix it and call again. Only after the creator answered; when nobody does, the run takes its default by itself.",
  parameters: Schema.Struct({
    decisionId: GameRunDecideInput.fields.decisionId,
    answer: GameRunDecideInput.fields.answer,
    notes: GameRunDecideInput.fields.notes,
    commandId,
  }),
  success: GameRunDecideResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const RunStartTool = Tool.make("game_run_start", {
  description:
    "Start this game's production run, or resume a stopped or ended one, when the creator asks. A new run needs the creator's brief; an empty brief resumes the existing run where it left off (an ended run whose ladder is done stays done; pass the creator's polish request with game_run_steer instead). budgetMinutes and profile (guided or autopilot) only when the creator gives them. The run plays in its own threads; tell the creator it started and that they can watch it on the Run tab.",
  parameters: Schema.Struct({
    brief: Schema.String.check(Schema.isMaxLength(8000)),
    budgetMinutes: Schema.optionalKey(Schema.Number),
    profile: Schema.optionalKey(GameRunProfile),
    commandId,
  }),
  success: GameRunStartResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);

const RunStopTool = Tool.make("game_run_stop", {
  description:
    "Stop this game's live production run when the creator asks. The run finishes saving its current step and can be resumed later with game_run_start and an empty brief.",
  parameters: Schema.Struct({ commandId }),
  success: GameRunStopResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);

const RunRestoreTool = Tool.make("game_run_restore", {
  description:
    "Put this game back to an earlier build when the creator asks, with no run live (stop it first). Pass `round` for a kept round's build: it becomes the run's best, and a resumed run judges its next round against it. Or pass `build` with a name from game_run_status `builds` (the game as the run left it, a round's unfinished work, the game before an earlier restore, a round's build that was not kept): it comes back to the folder but the run's best stays as it was, so a resume starts from the best. Either way the engine project, art and ASSETS.md return, and what the folder held before is saved first as a build of its own (it shows in `builds`, so a restore can be undone the same way). A stopped run's round in progress is abandoned. A restore that does not fit is refused with the reason.",
  parameters: Schema.Struct({
    round: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    build: Schema.optionalKey(Schema.String),
  }),
  success: GameRunRestoreResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);

const RunProfileTool = Tool.make("game_run_profile", {
  description:
    "Switch this game's live production run between guided (it asks the creator in this chat at its decision points and takes a default when nobody answers in time) and autopilot (it decides everything itself; a question it is waiting on takes its default now). Only when the creator asks for it.",
  parameters: Schema.Struct({ profile: GameRunProfile, commandId }),
  success: GameRunProfileResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
// A run role's result: the run reads this, never a file the role wrote, so a
// slip in its shape is refused in the role's own turn and fixed there.
const RunSubmitTool = Tool.make("game_run_submit", {
  description:
    'Hand your role\'s result to this game\'s production run, in the shape your prompt names: {"_tag":"checks",...}, {"_tag":"ladder",...}, {"_tag":"verdict",...}, {"_tag":"select",...}, {"_tag":"ship",...}, {"_tag":"ledger",...}, {"_tag":"report",...} or {"_tag":"art",...}. A submission that does not fit what your step asks for is refused with the reason: fix it and submit again. A later submission replaces an earlier one. Then finish your turn.',
  parameters: GameRunSubmitInput,
  success: GameRunSubmitResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, onlyForRunThreads);
/** The studio toolkit: status, export and play-level tools for every thread. */
export const GameToolkit = Toolkit.make(
  GameStatusTool,
  BlenderCodeTool,
  BlenderSceneTool,
  BlenderAssetsSearchTool,
  BlenderAssetsImportTool,
  BlenderExportTool,
  AssetsAddTool,
  UnityToolsTool,
  UnityEditTool,
  UnityEvalTool,
  UnityRecompileTool,
  UnityPlayTool,
  UnityConsoleTool,
  ImportTool,
  CheckTool,
  ExportTool,
  PackageWindowsTool,
  PackageWebTool,
  MediaSaveTool,
  SavedListTool,
  SavedDeleteTool,
  PreviewTool,
  StopTool,
  ExploreStartTool,
  ExploreActTool,
  ExploreCloseTool,
  BotRunTool,
  BotViewTool,
  BotReportTool,
  RunStatusTool,
  RunRoundTool,
  RunSteerTool,
  RunChecksTool,
  RunStartTool,
  RunStopTool,
  RunDecideTool,
  RunProfileTool,
  RunRestoreTool,
  RunSubmitTool,
);
