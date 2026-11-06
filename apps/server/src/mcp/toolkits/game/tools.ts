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
  GameBuildComparison,
  GameBuildFacts,
  GameBuildId,
  GameBuildRestoreResult,
  GameBuildsResult,
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
import { PROFILES, type GameEngineProfile } from "../../../game/engineProfile.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
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
/** Each engine's own sentence for a tool whose behaviour differs by engine, from its profile. */
const perEngine = (line: (tools: GameEngineProfile["tools"]) => string) =>
  PROFILES.map((profile) => line(profile.tools)).join(" ");
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
    "Inspect this thread's Kurambit project: the manifest, the engine tool's readiness (`engineTool`, with repair instructions), the release targets its engine exports, its builds, managed processes and playable preview URL. Requires game.json in this thread's workspace. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
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
    "Search a library of existing assets for the live Blender scene (pinned mcp-for-blender search_assets, adapted). Sources: polyhaven (HDRIs, PBR textures and realistic models, all CC0, no key), sketchfab (user-made models; needs the user's Sketchfab API key in the scene) and polypizza (stylised low-poly, CC0 or CC-BY; needs the user's Poly Pizza API key). Pass the result id to game_blender_assets_import. With a STYLE.json, only sources its imports list may be imported, and the result says when an import would be refused.",
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
    "Download a library asset into the live Blender scene (pinned mcp-for-blender import_asset, adapted). Afterwards the .blend source is saved in the game (art/blender/live.blend) and a GLB of only the objects the import added is exported under <engine dir>/assets/blender/ (godot/ or web/; unity/Assets/Blender/ for Unity) that the game can load, with its source and licence recorded in ASSETS.md (CC-BY models must be credited); an HDRI or texture import adds no object, so no GLB. Run game_import after. Polyhaven textures need applyTo object names to be used, otherwise the material is unused. Imported models arrive at arbitrary scale: check the reported bounding box, put them on the ground, and look at them. With a STYLE.json, a source its imports does not list is refused before anything downloads, and a rigged model not on its rig (or any rigged model when it names no rig) is refused and taken out of the scene again.",
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
    "Export the live Blender scene (or the named objects) as a GLB under the game's engine directory (godot/ or web/, the manifest's project) that the game can load: pass objects to export only those, or nothing to export every mesh. Defaults to <engine dir>/assets/blender/scene.glb (unity/Assets/Blender/scene.glb for Unity). The .blend source is saved in the game with the export. With a STYLE.json, an export carrying an armature not on its rig (or any armature when it names no rig) is refused before anything is written: characters come from the lock's packs. Run game_import after.",
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
    "Render 2D sprites from the live Blender scene, framed correctly by construction: use this instead of writing camera, light and render code. Each view gets a fixed orthographic camera fitted to the objects across every frame of the animation, so nothing is cut off, the scale is the same in every frame and view, and the feet stand on the same pixel row in every frame, with the root object's origin on the centre column. A clip that moves the character (root motion) is refused: render an in-place clip. Pass objects (object or collection names; children come along; may be left out only when the scene holds one top-level object), pixelsPerUnit (leave it out for a character's first strip, then pass the value that strip reports to all its other strips so the body is the same size in each), views (front, back, left, right, top, isometric, or {name, azimuth, elevation}; default right; elevation tilts the side views down, 30-45 for a top-down 3/4 look), an animation (action, which plays over its own frame range in frameCount frames, default 8; or frameStart/frameEnd; or an explicit frames list; nothing renders the current pose), size (canvas px, default 64; height for non-square), anchor (feet, default, or center; top views centre), margin (px) and lighting (studio key/fill/rim that reads at small size, default, or scene). For a pixel-art game pass pixelArt: renders large, downscales, makes alpha hard, quantizes every frame to one shared palette (palette: the style pack's id or a PNG or folder in this game, colors: how many, default 16; without palette, the frames' own colours), and outline: true or #rrggbb adds a 1 px outline. Writes <output>_0.png ... <output>_N.png under the engine directory (a Unity game: under unity/Assets/, capital A, the only folder Unity imports) (<output>_<view>_N.png with several views), optionally <output>_sheet.png, records provenance in ASSETS.md and returns the files, the anchor and a contact sheet image to look at. With a STYLE.json, a pixel lock fills pixelArt (its palette and outline), size (two tiles) and views (from its view) when you leave them out, and refuses another palette; a smooth lock refuses pixelArt. The .blend stays the source and is not changed. Run game_import after.",
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
    "Search Kurambit's pinned CC0 asset library: 2D sprites, tilesets, UI kits, icons, fonts, sound effects, music, animated 3D characters, 3D kits and PBR textures from Kenney, KayKit, Quaternius, ambientCG and others. Public domain, no key, no attribution needed. Without pack it lists matching packs with their style, family and rig, or the whole library grouped by style family when you pass no query and no kind (choose one family and lock it in STYLE.json at the game root; with a lock, its packs come first); pass pack to look inside one: the pack is downloaded once (checked against its pinned SHA-256) and matching files come with a contact sheet image numbered like the list (models are shown by their pictures), or the pack's own preview pictures when you pass no query and no kind. Page through long lists with offset. Only formats this game's engine loads are listed. Look at the sheet before adding, and keep one family's look per game. Add files with game_assets_add by the exact paths listed.",
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
    "Copy files or whole folders from a library pack (paths as game_assets_search lists them) into this game: godot/assets/library/<pack>/, web/assets/library/<pack>/ or unity/Assets/Library/<pack>/, with names made path-safe. Models bring the textures they load; a folder add keeps one format per model, the one search shows. Never overwrites a file that differs; files already there are left alone. Appends each file's pack, source page and CC0 licence to ASSETS.md, and measures each added sound's loudness against STYLE.json's targets. With a STYLE.json, a pack outside its packs (or audio.packs) is refused, and so are animated characters on a rig other than its rig; the refusal says how to change the lock. Run game_import after.",
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
  description: `Import this thread's game in its engine. ${perEngine((t) => t.import)} Call after every asset transfer or engine change. Returns success=false on parse errors, missing resources, compile or import errors, with the output and log path; a tool Kurambit runs failing on its own is an error with reason tool-failed instead, which says nothing about the game. Fix failures before export.`,
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const CheckTool = Tool.make("game_check", {
  description: `Fast static and boot check for this thread's game: it imports, then boots the entry the player opens and the gameplay entry game.json declares, and reports what the game did as errors and warnings with file:line, and which entries ran. ${perEngine((t) => t.check)} Everything the game does is in the result; the call fails only when the check could not be made (reason tool-failed, tool-missing, busy or low-memory). Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest.`,
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, visibleToRunThreads);
const ExportTool = Tool.make("game_export", {
  description: `Import and export this thread's game for one target; a target its engine does not make is refused. ${perEngine((t) => t.export)} A release is staged and checked, then replaces the previous one only when the sources did not change while it was made, so a failed export leaves the last good build in place. Web exports to a content-addressed build the export selects for Play at once. Returns the published artifact's path and the command output, or why it failed. Use game_preview to play the latest sources.`,
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
    "Package the Windows release this game already exported as a downloadable ZIP, for an engine whose Windows release Kurambit packages (a game whose Windows release is a whole folder is refused: ship the folder). It never exports: if builds/windows/game.exe is missing, is not a checked x86_64 executable with the game's pack, or changes while packaging, it returns the exact reason and leaves existing release files and any earlier package untouched. The ZIP contains game.exe and, only for a non-embedded preset, game.pck, at the archive root so extraction is runnable. Returns the absolute archive path, byte count, SHA-256, per-file hashes and notes; the creator downloads it from the Builds panel. Packaging does not prove Windows booted.",
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
    "Package the exact immutable Web build Play currently serves as a downloadable ZIP for an ordinary static game host. It never exports, never rebuilds and never packages a draft: if no build is selected, or the selected build is missing or its bytes changed, it returns the exact reason and leaves the selection, sources and any earlier package untouched. The ZIP contains every served build file at its relative path with index.html at the archive root. The archive is bound to the selected build id and its own SHA-256. Upload and serve the extracted files over HTTP; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP. Returns the absolute archive path, byte count, SHA-256, per-file hashes, entry and notes; the creator downloads it from the Builds panel. An engine with no Web build is refused.",
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
    "A playable build of this thread's current sources. For an engine with a Web build: when the selected build is missing, damaged or exported from other sources than the folder holds now, it exports Web again (the same export the Builds panel's Rebuild runs), then serves it from a managed loopback static server and returns the playable URL; a build of the current sources is served without another export. This is the actual game, not a screenshot. For an engine whose games play as a built player (Unity), it prepares that player of the current sources and returns its path; game_explore_start and game_bot_run play it. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Kurambit, including running operations, live editors, bot runs and native play, and close its Web preview server. Returns after managed processes exit and says which did not stop (success false). While a production run holds the game it stops only the caller's own work, explore session and Play; the run's builds, bots and editors keep running until the run is stopped. Does not kill external editors or other games.",
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
    `Open a bounded exploration session on this thread's game. ${perEngine((t) => t.explore)}` +
    " Probes, visible text, interactive controls, errors and a picture (native games need a window for it: Xvfb on Linux, a window kept off-screen on Windows and macOS; web games always have one). Nothing is exported. Pass target native or web to pick the runner, or omit it for the game's own engine. Returns a session id for game_explore_act. Only one live session exists per game: its owning thread must close it before that game starts another. Sessions start with no saved data; saves keep reuses one save location across kept sessions, to check that what the game saves (best scores, settings, unlocks) survives a relaunch.",
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
    "Whether this game's production run is live, what it is doing now (step), its profile (guided or autopilot), its rounds with their verdicts (the comparators' reasons and the tester's note are in game_run_round) and the creator notes waiting for the next round. While a Guided run waits for the creator, decision holds what to present: the evidence files (absolute paths), what goes with them, the answers the run accepts, its default and when the default fires; record the creator's answer with game_run_decide. A run that ended says why in message and whether it can be resumed: tool-failed (a program Kurambit runs kept failing), low-memory and busy are pauses in which nothing was judged, resumed with game_run_start and an empty brief once the cause is fixed. Read-only. While a run is live, do not edit the game's files; pass the creator's requests to it with game_run_steer.",
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
    "Start this game's production run, or resume a stopped or ended one, when the creator asks. A new run needs the creator's brief; an empty brief resumes the existing run where it left off (an ended run whose ladder is done stays done; pass the creator's polish request with game_run_steer instead). While a run is live a new brief is refused: pass it on with game_run_steer, or stop the run first. A run paused as tool-failed, low-memory or busy resumes with an empty brief once the cause in game_run_status is fixed. budgetMinutes, profile (guided or autopilot), artDirection and the provider, model and variant its roles run on only when the creator gives them; by default the roles run on this chat's model. The run plays in its own threads and asks its questions in the chat the creator last used for it; tell the creator it started and that they can watch it on the Run tab.",
  parameters: Schema.Struct({
    brief: Schema.String.check(Schema.isMaxLength(8000)),
    artDirection: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8000))),
    budgetMinutes: Schema.optionalKey(Schema.Number),
    profile: Schema.optionalKey(GameRunProfile),
    provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    variant: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
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
    "Stop this game's live production run when the creator asks. The run keeps its current step, which a resume with game_run_start and an empty brief runs again.",
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
    "Put this game back to an earlier build when the creator asks, with no run live (stop it first). Pass `round` for a kept round's build: it becomes the run's best, and a resumed run judges its next round against it. Or pass `build` with a name from game_run_status `builds` (the game as the run left it, a round's unfinished work, the game before an earlier restore, a round's build that was not kept): it comes back to the folder but the run's best stays as it was, so a resume starts from the best. Either way the engine project, art and ASSETS.md return, and what the folder held before is saved first as a build of its own in `builds`. Restoring the build saved before the latest restore, while no round has run since, undoes that restore: the run's best and the line it was continuing come back too, though a round in progress that restore abandoned stays abandoned. Restoring an older one brings back only its folder. A stopped run's round in progress is abandoned. The result says whether the folder has moved (`done`); a restore still moving after half a minute goes on, and game_run_status `restore` shows its outcome. A restore that does not fit is refused with the reason.",
  parameters: Schema.Struct({
    round: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    build: Schema.optionalKey(Schema.String),
    commandId,
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
    'Hand your role\'s result to this game\'s production run, in the shape your prompt names: {"_tag":"checks",...}, {"_tag":"ladder",...}, {"_tag":"rungs",...}, {"_tag":"verdict",...}, {"_tag":"select",...}, {"_tag":"ship",...}, {"_tag":"ledger",...}, {"_tag":"report",...} or {"_tag":"art",...}. A submission that does not fit what your step asks for is refused with the reason: fix it and submit again. A later submission replaces an earlier one. Then finish your turn.',
  parameters: GameRunSubmitInput,
  success: GameRunSubmitResult,
  failure,
  failureMode: "return",
  dependencies: runDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, onlyForRunThreads);
/** The studio toolkit: status, export and play-level tools for every thread. */
const buildDependencies = [
  GameBuilds.GameBuilds,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const BuildsTool = Tool.make("game_builds", {
  description:
    "This game's builds, newest first: every turn of any chat that changed the engine project, art or ASSETS.md, and every round and saved build of its production run, each with when, which turn or round, what changed (files and a line), its `base` and its facts once measured (`facts.chips`, the few that matter, and how many were not measured). `base` is the build it was made from (a turn's: the game as the turn began), so restoring `base` with game_build_restore undoes that build; null when unknown. `current` is the build the folder was last made from; `restore` is the latest restore, whose `undo` build, restored with game_build_restore, undoes it (a redo after an undo). A three.js chat turn's build is played and measured by itself when the turn ends. Pass `before` with a `next` cursor for older builds. Pass `compare` with two build ids instead to diff their facts: each delta reads up, down, same or changed, or not-comparable with why (a side not measured, or measured by another harness or another tester bot); both builds play side by side in the Game panel. Facts are read as measured; game_facts measures. Read-only.",
  parameters: Schema.Struct({
    compare: Schema.optionalKey(Schema.Tuple([GameBuildId, GameBuildId])),
    before: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Union([GameBuildsResult, GameBuildComparison]),
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const FactsTool = Tool.make("game_facts", {
  description:
    "What the harness measured on one build of this game (the newest when `build` is omitted), the same facts the Builds rail shows: whether it boots; how it ends with no input (idle), with random input (masher) and with the game's latest play-mode bot (skilled), and when; whether it is winnable without skill; still stretches, motion, detail and colour over the random-input play video; and the time from a held key to the player moving. Each is measured, or not measured with why. A build is measured once, in a copy of its own (the game folder is never touched), in about 3 to 5 minutes; this call measures what is missing, waits up to 30 s, and otherwise returns with the rest pending: call again later. Facts are of builds (a turn's end), not of uncommitted work; for that, use game_bot_run.",
  parameters: Schema.Struct({ build: Schema.optionalKey(GameBuildId) }),
  success: GameBuildFacts,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const BuildRestoreTool = Tool.make("game_build_restore", {
  description:
    "Put one of this game's builds (an id from game_builds) back in the game folder when the creator asks: its engine project, art and ASSETS.md return, and what the folder held before is kept first as a build of its own, so restoring that one undoes it (game_builds `restore.undo`). To undo a turn, restore its build's `base`; to go back to an older build, restore that build. Refused while a production run is live (stop it first). With a run, it goes through the run's restore: a kept round becomes the run's best, any other build leaves the best as it is. The result says whether the folder has moved (`done`).",
  parameters: Schema.Struct({ build: GameBuildId, commandId }),
  success: GameBuildRestoreResult,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);

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
  BuildsTool,
  FactsTool,
  BuildRestoreTool,
);
