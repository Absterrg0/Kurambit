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
  GameStatus,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameKeepGoingInput,
  GameKeepGoingStatus,
  GameKeepGoingSteerInput,
  GameKeepGoingSteerResult,
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
  description: `Import and export this thread's game for one target; a target its engine does not make is refused. ${perEngine((t) => t.export)} A release is staged and checked, then replaces the previous one only when the sources did not change while it was made, so a failed export leaves the last good build in place. Web exports to a content-addressed build. On an engine that plays its Web export (Godot) the export becomes Play's build at once; on an engine whose folder is served live (three.js) it is a release only, and Play keeps serving the folder. Returns the published artifact's path and the command output, or why it failed. Use game_preview to play the latest sources.`,
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
    "Package the Windows release this game already exported as a downloadable ZIP, for an engine whose Windows release Kurambit packages (a game whose Windows release is a whole folder is refused: ship the folder). It never exports: if builds/windows/game.exe is missing, is not a checked x86_64 executable with the game's pack, or changes while packaging, it returns the exact reason and leaves existing release files and any earlier package untouched. The ZIP contains game.exe and, only for a non-embedded preset, game.pck, at the archive root so extraction is runnable. Returns the absolute archive path, byte count, SHA-256, per-file hashes and notes; the creator downloads it from Export… in the Stage's More menu. Packaging does not prove Windows booted.",
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
    "Package the exact immutable Web build Play currently serves as a downloadable ZIP for an ordinary static game host. It never exports, never rebuilds and never packages a draft: if no build is selected, or the selected build is missing or its bytes changed, it returns the exact reason and leaves the selection, sources and any earlier package untouched. The ZIP contains every served build file at its relative path with index.html at the archive root. The archive is bound to the selected build id and its own SHA-256. Upload and serve the extracted files over HTTP; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP. Returns the absolute archive path, byte count, SHA-256, per-file hashes, entry and notes; the creator downloads it from Export… in the Stage's More menu. An engine with no Web build is refused.",
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
    "A playable build of this thread's current sources. For a three.js game the folder is served live: it returns the loopback URL of web/ itself, which reloads on the person's Stage as you save, with no export (game_export Web makes a release without changing what Play shows). For an engine with a Web build (Godot): when the selected build is missing, damaged or exported from other sources than the folder holds now, it exports Web again (the same export the Stage's Rebuild runs), then serves it from a managed loopback static server and returns the playable URL; a build of the current sources is served without another export. This is the actual game, not a screenshot. For an engine whose games play as a built player (Unity), it prepares that player of the current sources and returns its path; game_explore_start and game_bot_run play it. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Kurambit, including running operations, live editors, bot runs and native play, and close its Web preview server. On a three.js game this also stops the live game on the person's Stage: it stays stopped, for every client, until Play opens it again. Returns after managed processes exit and says which did not stop (success false). While a production run holds the game it stops only the caller's own work, explore session and Play; the run's builds, bots and editors keep running until the run is stopped. Does not kill external editors or other games.",
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
const commandId = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
    description:
      "Any id of yours for this request. Pass the same one when you retry a call that may have gone through, so it applies once.",
  }),
);
/** The studio toolkit: status, export and play-level tools for every thread. */
const buildDependencies = [
  GameBuilds.GameBuilds,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const BuildsTool = Tool.make("game_builds", {
  description:
    "This game's builds, newest first: every turn of any chat that changed the engine project, art or ASSETS.md, and every round and saved build of a production run an earlier Kurambit made, each with when, which turn or round, what changed (files and a line), its `base` and its facts once measured (`facts.chips`, the few that matter, and how many were not measured). `base` is the build it was made from (a turn's: the game as the turn began), so restoring `base` with game_build_restore undoes that build; null when unknown. `current` is the build the folder was last made from; `restore` is the latest restore, whose `undo` build, restored with game_build_restore, undoes it (a redo after an undo). A three.js chat turn's build is played and measured by itself when the turn ends. Pass `before` with a `next` cursor for older builds. Pass `compare` with two build ids instead to diff their facts: each delta reads up, down, same or changed, or not-comparable with why (a side not measured, or measured by another harness or another tester bot); both builds play side by side in the Game panel. Facts are read as measured; game_facts measures. Read-only.",
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
    "Put one of this game's builds (an id from game_builds) back in the game folder when the creator asks: its engine project, art and ASSETS.md return, and what the folder held before is kept first as a build of its own, so restoring that one undoes it (game_builds `restore.undo`). To undo a turn, restore its build's `base`; to go back to an older build, restore that build. The result says whether the folder has moved (`done`).",
  parameters: Schema.Struct({ build: GameBuildId, commandId }),
  success: GameBuildRestoreResult,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);

/** Keep going: the same service the composer control and the banner reach. */
const keepGoingDependencies = [
  GameRunControl.GameRunControl,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const KeepGoingTool = Tool.make("game_keep_going", {
  description:
    "Turn Keep going on or off for this chat, only when the person asks. off stops it; a step's turn in flight ends and still becomes a build. guided proposes each next step in the composer and starts it after a minute unless the person changes it. autopilot takes each next step itself, and undoes one that makes a measured fact worse (the person can redo it). Choosing a mode while it is paused resumes it, keeping the steps it set aside and the notes waiting for it. budgetMinutes (null for no limit; a new run's is 60) applies when it starts or resumes. Keep going runs only on games Kurambit plays after every turn (three.js); elsewhere, or while it is on in another chat of the game, it is refused with why. Returns what game_keep_going_status returns.",
  parameters: Schema.Struct({
    mode: GameKeepGoingInput.fields.mode,
    budgetMinutes: GameKeepGoingInput.fields.budgetMinutes,
    commandId,
  }),
  success: GameKeepGoingStatus,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const KeepGoingStatusTool = Tool.make("game_keep_going_status", {
  description:
    "Keep going on this game: off, guided or autopilot; what it is doing now (waiting for a turn to end, reading the build's facts, a proposal and when it starts, a step's turn, measuring, undoing); its last 10 steps with each verdict, reason and fact changes; the person's notes waiting for the next step; the steps it set aside and why; when its budget ends; and why it last stopped and whether choosing a mode resumes it. A message in this chat that starts \"Keep going · step N\" is a step: do that one change as it asks, like any turn. The person's own messages always come first. Read-only.",
  success: GameKeepGoingStatus,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromRunThreads);
const KeepGoingSteerTool = Tool.make("game_keep_going_steer", {
  description:
    "Give Keep going the person's words for its next step, when they ask for that from another chat of the game, or want it taken up after the step in flight: the next step carries them as they said them, before anything keep going would choose. One request per call, in their words. Returns how many notes are waiting. In the chat keep going runs in, the person's own message goes first anyway.",
  parameters: Schema.Struct({ text: GameKeepGoingSteerInput.fields.text, commandId }),
  success: GameKeepGoingSteerResult,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
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
  BuildsTool,
  FactsTool,
  BuildRestoreTool,
  KeepGoingTool,
  KeepGoingStatusTool,
  KeepGoingSteerTool,
);
