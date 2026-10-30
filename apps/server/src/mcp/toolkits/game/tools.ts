import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  GAME_PLAYTEST_BOUNDS,
  GAME_TRY_INPUT_BOUNDS,
  GameActionResult,
  GameArtGetInput,
  GameArtGetResult,
  GameArtFramesInput,
  GameArtFramesResult,
  GameArtImportInput,
  GameArtImportResult,
  GameArtSearchInput,
  GameArtSearchResult,
  GameBlenderInput,
  GameBlenderResult,
  GameCheckResult,
  GameLibraryGetInput,
  GameLibraryGetResult,
  GameLibraryImportMaterialInput,
  GameLibraryImportMaterialResult,
  GameLibraryImportModelInput,
  GameLibraryImportModelResult,
  GameLibrarySearchInput,
  GameLibrarySearchResult,
  GameOperationFailure,
  GameRecipeGetInput,
  GameRecipeGetResult,
  GameRecipeSearchInput,
  GameRecipeSearchResult,
  GameReviewDetailInput,
  GameReviewDetailResult,
  GameSceneInspectInput,
  GameSceneInspectResult,
  GameAssetsInspectInput,
  GameAssetsInspectResult,
  GameGodotApiInput,
  GameGodotApiResult,
  GameScenariosRunResult,
  GameNativeCaptureInput,
  GameNativeCaptureResult,
  GameRuntimeCalibrateInput,
  GameRuntimeCalibrateResult,
  GameAudioInspectInput,
  GameAudioInspectResult,
  GameStatus,
  GameReviewStatus,
  GameReviewCriticAnswer,
  GameReviewBallotInput,
  GameReviewReportResult,
  GameReviewHistory,
  GameReviewHistoryInput,
  GameReviewRestoreResult,
  GameSubmitInput,
  GameSubmitResult,
  GameWebPlaytestInput,
  GameTryInput,
  GameVerifyInput,
  GameWebPlaytestResult,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreReplayInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameExploreReplayResult,
  GameVerifyResult,
  GameWebPackage,
  GameWindowsPackage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as GameRecipes from "../../../game/GameRecipes.ts";
import * as GameArtKits from "../../../game/GameArtKits.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameReviewSessions from "../../../game/GameReviewSessions.ts";
import * as GameReviewApi from "../../../game/GameReviewApi.ts";
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
 * Critic and ballot children judge frozen evidence; they never build, edit or
 * control the review. Repair children have no review role and keep the builder
 * toolkit, so this hides from those two roles only.
 */
const hiddenFromCriticAndBallot = () => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined) return true;
  const role = Context.getOrUndefined(
    fiber.context,
    McpInvocationContext.McpInvocationContext,
  )?.gameReviewRole;
  return role === null || role === undefined;
};
/**
 * Review management belongs to the builder's turn. A repair child fixes the
 * isolated game copy and must leave checks and review records alone, so those
 * four schemas stay out of its catalog while every build tool stays in.
 */
const reviewControlVisible = () => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined) return true;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  if (scope?.gameReviewRole !== null && scope?.gameReviewRole !== undefined) return false;
  return scope?.gameRepairChild !== true;
};
const GameStatusTool = Tool.make("game_status", {
  description:
    "Inspect this thread's Game Studio project: design status and the DESIGN.md/BRIEF.md paths, toolchain readiness and actionable repair instructions, assets with derived scene usage, scenes, builds, managed processes, log directory, playable preview URL, and the builder's production phase (first playable, this turn's accepted submits, budget and time left). Requires game.json in this thread's workspace. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
  parameters: Schema.Struct({ checkSources: Schema.optionalKey(Schema.Boolean) }),
  success: GameStatus,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const reviewDependencies = [...dependencies, GameReviewApi.GameReviewApi];
const ReviewStatusTool = Tool.make("game_review_status", {
  description:
    "Read the current review phase, remaining repairs/time, frozen builder/reviewer models, usage, interruption and restore availability. Existing games have no review until the builder submits a verified build (or a turn ends with one). Restart never resumes a review.",
  success: GameReviewStatus,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, reviewControlVisible);
const ReviewHistoryTool = Tool.make("game_review_history", {
  description:
    "Read a bounded page of repair rounds, defects and fixes, frozen checks, decisions and exact reasons, ballots, session IDs and evidence frame references. Use nextCursor as before for the next page.",
  parameters: Schema.Struct({
    before: GameReviewHistoryInput.fields.before,
    limit: GameReviewHistoryInput.fields.limit,
  }),
  success: GameReviewHistory,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, reviewControlVisible);
const ReviewStopTool = Tool.make("game_review_stop", {
  description:
    "Stop this game's review and wait for its owned child sessions to stop. The selected build remains playable. Fails if a session may still write; no Resume mid-round.",
  success: GameReviewStatus,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, reviewControlVisible);
const ReviewRestoreTool = Tool.make("game_review_restore", {
  description:
    "Explicitly restore the previous game-folder version from the latest review. Stops review sessions first and preserves the folder's current version before restoring. Keeps the selected build and live preview directories. Check game_review_status for availability.",
  success: GameReviewRestoreResult,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, reviewControlVisible);
const SubmitTool = Tool.make("game_submit", {
  description:
    "Hand a build to the studio. The first accepted submit is the game's first playable: Play shows it at once and your turn keeps going. Keep producing — deepen the game toward the brief and its art direction with recipes and game_try_input — and submit each improved build; every accepted submit replaces what Play shows, and the last one is what review starts on when your turn ends. Name the Web export you stand behind (default: this game's latest export) and give a one-line note on what the game is; a repair child instead names the defects it believes it fixed. The server checks only facts: the build exists, its bytes match their hash and are the current export, and a playtest of those exact bytes booted with no console errors and responded to input. Refused, the result lists the exact failed check and Play keeps the previous build; fix it and submit again.",
  parameters: GameSubmitInput,
  success: GameSubmitResult,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const BlenderTool = Tool.make("game_blender_run", {
  description:
    'Build or revise a model in this thread\'s game. Supply a stable id and Python bpy script. Opens art/blender/<id>.blend if present, otherwise an empty factory scene. Set reset=true to rebuild from an empty scene at the same source/export paths; false/default modifies the existing file, so edit objects by name to avoid duplicates. The run executes off to the side and publishes only after the export validates: a failure or interruption keeps the last good .blend, .glb, script and manifest. Pass art once to set this game\'s shared profile (palette hex colours and a standing height in metres); the exporter ensures one StudioPalette_<hex> material per colour and later runs reuse the profile. Assign those shared materials instead of inventing colours, keep the standing height, and stand the mesh on the origin. Pass inputs to reuse local models/textures by name, e.g. {name:"base", path:"godot/assets/library/models/crate/crate.gltf"} or a res:// path; the staged file appears as ASSET_INPUTS["base"] for bpy.ops.import_scene.gltf or bpy.data.images.load, and images are packed into the saved .blend. Recorded names never prove use or quality. Exports GLB with applied modifiers to the same godot/assets/models/<id>.glb path, renders a small CPU thumbnail unless thumbnail=false, refreshes the set\'s contact sheet, and updates game.json. Returns mesh/material/animation/triangle counts, bounds, material details, profile warnings and real output. Script exceptions return their traceback and a log path. Follow with game_godot_import.',
  parameters: GameBlenderInput,
  success: GameBlenderResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ImportTool = Tool.make("game_godot_import", {
  description:
    "Run a real headless editor import in this thread's game. Call after every asset transfer or engine change. game_import is the preferred neutral name and behaves identically. Returns success=false on parse errors, missing resources, import errors or nonzero exit, with stdout/stderr and log path. Fix failures before export.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
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
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const CheckTool = Tool.make("game_godot_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. game_check is the preferred neutral name and behaves identically. Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
/** Preferred neutral name for the static and boot check; the godot-named tool is its legacy alias. */
const CheckNeutralTool = Tool.make("game_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. Identical to game_godot_check (its legacy alias). Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const InspectSceneTool = Tool.make("game_scene_inspect", {
  description:
    "Dump a scene's node tree headlessly: scene-relative path, name, type, script path, groups, position, collision layer/mask and child names, capped at 400 nodes with truncation reported. Use the res:// path shown by game_status, such as res://scenes/main_menu.tscn. Read-only; use it to debug scene wiring without opening the Godot editor.",
  parameters: GameSceneInspectInput,
  success: GameSceneInspectResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const GodotApiTool = Tool.make("game_godot_api", {
  description:
    "Query the installed Godot version's built-in ClassDB for one engine class and an optional member substring filter. Returns engine-native method signatures, properties, signals, enums/constants and inheritance with counts and truncation, plus the installed engine version. No network, no extra server, no guessed APIs: one bounded headless query in an isolated scratch project that never loads the game's scenes or autoloads and never edits sources. ClassDB covers engine classes only, not script-defined classes or Variant builtin types. Use it before calling an engine API you have not verified.",
  parameters: GameGodotApiInput,
  success: GameGodotApiResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const AssetsInspectTool = Tool.make("game_assets_inspect", {
  description:
    "Inventory this thread's game: bounded files, declared manifest/family references, source mentions, native dependencies/animations/collisions/scales, family checks and provenance. Whole-project image/model preflight runs before editor import; unbounded inputs leave native facts unknown. Check named res:// paths against the exact recorded Web pack in an isolated Godot project. Pack inclusion is separate from runtime use or visibility, which remain unknown. Mentions never prove loading. Read-only apart from engine import sidecars and builds/logs scratch. No art-quality certification.",
  parameters: GameAssetsInspectInput,
  success: GameAssetsInspectResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const TestTool = Tool.make("game_godot_test", {
  description:
    "Run a headless GDScript in this thread's game project. The script must extend SceneTree and quit explicitly, using a nonzero code for failures. Supply a project-relative .gd path, such as tests/smoke_test.gd. game_test is the preferred neutral name and behaves identically. Use this to simulate and assert the core gameplay loop. Returns real exit status, stdout/stderr and log path. Timeout defaults to 60 seconds and is bounded at 300 seconds.",
  parameters: Schema.Struct({
    script: Schema.String,
    timeoutMs: Schema.optionalKey(Schema.Number),
  }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
/** Preferred neutral name for the script test run; the godot-named tool is its legacy alias. */
const TestNeutralTool = Tool.make("game_test", {
  description:
    "Run a headless GDScript in this thread's game project. The script must extend SceneTree and quit explicitly, using a nonzero code for failures. Supply a project-relative .gd path, such as tests/smoke_test.gd. Identical to game_godot_test (its legacy alias). Use this to simulate and assert the core gameplay loop. Returns real exit status, stdout/stderr and log path. Timeout defaults to 60 seconds and is bounded at 300 seconds.",
  parameters: Schema.Struct({
    script: Schema.String,
    timeoutMs: Schema.optionalKey(Schema.Number),
  }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ScenariosTool = Tool.make("game_scenarios_run", {
  description:
    "Run every route in godot/tests/scenarios/*.json through the real game for diagnosis, starting from the main menu under normal physics with only injected input. Grades each approved DESIGN.md observation from the first sample after the route's first input, so a value already true at play start fails; records the state qualification stage with proven/failed/missing coverage per kind, where a declared no-loss criterion is not-applicable rather than missing. Also lists the scenarios' per-criterion proving scenario and frame. Each run also takes a small bounded set of native headless layout probes near input step boundaries; their findings ride the result as diagnostic hints for Web-frame inspection, never as verdicts. A route is pure data: press, hold or wait steps using actions from project.godot's InputMap. Returns frames run, route errors and per-criterion pass/fail/not-applicable with the values actually observed. Routes cannot call game functions or set state; fix the route or the game, never the exam. A run must press a control; a wait-only route proves nothing. game_verify already refreshes this exam for an approved design with acceptance, so do not run it again after a passing verify; use this only to diagnose a state failure. With an approved design no player node or movement is required: a no-player game marks play with a typed GameState.state (0/false before play, another value once play starts), and every applicable approved observation must become true after that baseline. A legacy game without an approved design instead needs a player in group \"player\" to move and GameState to reach its playing state.",
  success: GameScenariosRunResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const NativeCaptureTool = Tool.make("game_native_capture", {
  description:
    "Record a short native diagnostic clip for one validated route in godot/tests/scenarios/<id>.json: replays it through the real game under Godot MovieWriter on a private virtual display, then transcodes with the installed FFmpeg. Returns game-relative paths to clip.mp4, a native poster frame, the runner result and the input/frame timeline plus actual size, render rate, encoded rate and frame counts from ffprobe. A diagnostic timing aid only: it never proves gameplay, never writes a qualification record, and its source identity is the native game sources, not an exported Web build. Missing Linux tooling (xvfb, ffmpeg) is an actionable error; Web playtests and scenario runs are unaffected. fps sets the engine render cadence (keep it fixed for comparisons because route outcomes can vary); outputFps only converts the encoding without rerunning the game and never proves another cadence behaves the same. Each run uses fresh per-run user:// isolation. Use it when static frames cannot show a timing problem; prefer game_web_playtest for shipped-Web behavior.",
  parameters: GameNativeCaptureInput,
  success: GameNativeCaptureResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const RuntimeCalibrateTool = Tool.make("game_runtime_calibrate", {
  description:
    "Replay one validated route in godot/tests/scenarios/<id>.json headlessly at 2-3 render cadences (default 30+60) with 2 repeats each, under one fixed seed and fresh per-run user:// isolation. No videos: it measures baseline/final player transforms, engine physics/render counters, nominal physics seconds and final GameState, then compares same-rate repeats before cross-rate pairs within documented tolerances. Returns per-run evidence paths, compared/unknown counts, concrete differences and a measured verdict for the tested route and settings only (equivalent/different/unknown) — never a global determinism certificate. A named jump/coin counter alone is not physical proof; displacement is measured from observed positions. Missing values, unobserved probes, errors and partial timeouts are unknown, never equivalent. Diagnostic only: it never qualifies, promotes or edits scenes/scripts. Builder/repair only; critics and ballots never reach it.",
  parameters: GameRuntimeCalibrateInput,
  success: GameRuntimeCalibrateResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const AudioInspectTool = Tool.make("game_audio_inspect", {
  description:
    "Measure one local audio asset or one recorded native clip with the installed FFmpeg: peak/RMS level, silence, near-clipping and opposite-phase cancellation, plus codec, sample rate, channels and duration. The path is game-relative (e.g. godot/assets/theme.ogg or a builds/native-capture/<id>/clip.mp4 audio stream); symlinks escaping the game are refused. Size, duration, segment, output-byte and time limits run before any decode; the PCM stays in the filter graph. Returns concrete metrics plus honest unknowns, never a quality verdict: it does not prove exported Web audio, composition, taste, spatial mix or good audio. Native-clip audio is the engine mixer from the native sources, never the exported Web build. Missing FFmpeg is an actionable error; Web playtests and scenario runs are unaffected.",
  parameters: GameAudioInspectInput,
  success: GameAudioInspectResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ExportTool = Tool.make("game_export", {
  description:
    "Import and export this thread's game with the Web, Windows or Linux release preset. Windows produces builds/windows/game.exe, a 64-bit x86_64 executable. The standard preset embeds the game data, so the executable alone is enough; a custom preset that does not embed it also produces builds/windows/game.pck, so heed the result and copy both files together. It has not been run on Windows. Linux produces builds/linux/game.x86_64. Both native targets export the current sources and never replace the Web build Play serves. Verifies matching Godot export templates and the actual artifact. Missing Windows templates are an actionable error; Install tools adds them without replacing the Godot binary. Web uses Compatibility rendering and single-threaded export. Returns actual paths and command output or errors. A Web export is immediately playable; game_submit makes a build the first playable and publishes each improved one. Use game_preview to build and serve a playable browser URL.",
  parameters: Schema.Struct({ target: Schema.Literals(["Web", "Linux", "Windows"]) }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
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
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const PackageWebTool = Tool.make("game_package_web", {
  description:
    "Package the exact immutable Web build Play currently serves as a downloadable ZIP for an ordinary static game host. It never exports, never rebuilds and never packages a draft, legacy builds/web, an unselected candidate or later source edits: if no build is selected, or the selected build is missing or its bytes changed, it returns the exact reason and leaves the selection, sources and any earlier package untouched. The ZIP contains every served build file at its relative path with index.html at the archive root (a root-level custom HTML entry is stored as index.html without changing its bytes). The archive is bound to the selected build id and its own SHA-256. Upload and serve the extracted files over HTTP; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP. Returns the absolute archive path, byte count, SHA-256, per-file hashes, entry and notes; the Builds panel also receives a short-lived signed download URL.",
  // No `parameters` here either; see game_package_windows.
  success: GameWebPackage,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const PreviewTool = Tool.make("game_preview", {
  description:
    "Build this thread's Web release when it is missing or older than the game sources, start its managed loopback static server, and return the playable URL. A fresh existing build is served without another export. This is an actual WebAssembly game, not a screenshot. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const NativeTool = Tool.make("game_run_native", {
  description:
    "Import and launch this thread's Godot game natively with a tracked PID and output log. The agent's run is headless: it opens no window and inherits no display; only the creator's own Play action may open a window. Use game_stop to stop it; unrelated processes are never terminated.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Game Studio, including running Blender/Godot operations and native play, and close its Web preview server. Returns after managed processes exit. Does not kill external editors or other games.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
/**
 * Bounded persistent exploration: open one paused browser on the frozen
 * export, poke it with short act/observe cycles across turns, close to save
 * the trace, then replay the trace in a fresh browser for independent
 * confirmation. Exploration itself never qualifies the build; only the replay
 * counts, and only for the traced steps. One live session per host: close
 * before starting another or replaying.
 */
const ExploreStartTool = Tool.make("game_explore_start", {
  description:
    "Open a bounded exploration session on this game's already-exported Web build (default: the build Play serves), or pass target native to play the current game sources natively with no export. Native runs the real main scene under Godot with the game paused between acts, and observes probe, visible text, interactive controls, errors and (with xvfb on PATH) a picture. Verifies the recorded bytes and freezes the viewport; nothing is re-exported, promoted or qualified. Returns a session id for game_explore_act. Only one live session exists per host: close it before starting another or replaying.",
  parameters: GameExploreStartInput,
  success: GameExploreStartResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ExploreActTool = Tool.make("game_explore_act", {
  description:
    "Run one short input batch (1–6 steps, at most 10 s nominal) in an exploration session and observe what happened: the current probe, one persisted screenshot path (null with a reason when a native session has no display) and bounded console text. Native sessions additionally return visible screenText, interactive ui controls, script/engine errors, per-ui-step receipt and per-inspect-step read-only values; use ui {id, action} for real mouse input at a listed control and inspect {path} for read-only reflection. The player stays paused between calls, so observations cost no game time. Descriptive only, never a verdict; replay the saved trace for independent confirmation.",
  parameters: GameExploreActInput,
  success: GameExploreActResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ExploreCloseTool = Tool.make("game_explore_close", {
  description:
    "Close an exploration session, saving its trace to a server-owned path and releasing its browser and profile. The trace stays inspectable and replayable after close. Idle and wall-clock expiry close the same way with the reason saved.",
  parameters: GameExploreCloseInput,
  success: GameExploreCloseResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const ExploreReplayTool = Tool.make("game_explore_replay", {
  description:
    "Replay a saved exploration trace in a fresh player: a web trace against its same immutable export in a fresh browser and viewport, a native trace against the same game sources natively. Refuses a missing or changed build (or changed sources) without rebuilding, and needs the exploratory session closed first. Returns the fresh run's own evidence paths and probe, never the exploratory observations. Covers only the traced sequence; unexplored parts remain unknown.",
  parameters: GameExploreReplayInput,
  success: GameExploreReplayResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
/** Ballots keep frozen comparison context; retrieval and play are hidden. */
const hiddenFromBallots = () => {
  const fiber = Fiber.getCurrent();
  return (
    fiber === undefined ||
    Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)
      ?.gameReviewRole !== "ballot"
  );
};
const VerifyTool = Tool.make("game_verify", {
  description: `Run one complete build iteration in a single call: Godot check, the canonical suite from the server-owned policy, the approved scenario exam when DESIGN.md binds nonempty acceptance, then a Web export (a normal publish outside a review round, the round's candidate during one) and a recorded playtest of those exact exported bytes with the steps you supply. steps is required and must contain at least one real input step (press, hold, key/keys, click, drag or mouseMove); a wait-only or boot-only route proves nothing and game_submit needs a responding playtest. This tool records the build's playtest, so it takes no exactSize layout override; use game_web_playtest for review-only window evidence. Interval captures are planned before any stage runs and must fit ${GAME_TRY_INPUT_BOUNDS.maxFrames} frames; increase captureEveryMs or shorten the route instead of retrying the same plan. It stops at the first failing stage and returns that stage's result, errors and log paths; later stages do not run. For approved games this is the only scenario run you need; use game_scenarios_run only to diagnose a state failure. Inspect the returned frames, then game_submit the build you stand behind. The result is path-first: every frame is saved under evidenceDirectory with a per-frame path and no inline images; read chosen PNGs with file tools (result.json in the same folder maps labels to files) and reserve includeImage:true for a small deliberate route, since repeated full-sequence image results can exceed the provider's image limit and end the turn. Mechanical success is not a quality verdict, a visual check, or proof beyond the measured observations. Individual game_* tools remain available for narrower fixes and diagnostics.`,
  parameters: GameVerifyInput,
  success: GameVerifyResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  // Unknown options must fail instead of being stripped: exactSize belongs to
  // the review-only web playtest, not to a recorded verification.
  .annotate(Tool.Strict, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const WebPlaytestTool = Tool.make("game_web_playtest", {
  description: `Load this game's real Web export in a headless browser, wait for Godot to boot, optionally hold keys and click the canvas, and return screenshots plus console errors. Template games also report a read-only state probe: GameState values and the player position before and after the steps, with a short diff. Interval captures are planned before the browser launches and must fit ${GAME_TRY_INPUT_BOUNDS.maxFrames} frames; increase captureEveryMs or shorten the route instead of retrying the same plan. The result is path-first: every frame is saved under evidenceDirectory with a per-frame path and no inline images; read chosen PNGs with file tools (result.json in the same folder maps labels to files) and reserve includeImage:true for a small deliberate route, since repeated full-sequence image results can exceed the provider's image limit and end the turn. Use this as the final web check instead of building your own browser tooling.`,
  parameters: GameWebPlaytestInput,
  success: GameWebPlaytestResult,
  failure,
  // Default "error" failureMode: the HTTP transport registers this tool behind
  // McpHttpServer.registerImageTool, which turns failures into text results.
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
// Exported for the image-content transport registration in McpHttpServer.
export const GameWebPlaytestTool = WebPlaytestTool;
export const GameVerifyTool = VerifyTool;
export const GameTryInputTool = Tool.make("game_try_input", {
  description: `Test a gameplay hypothesis from a fresh headless boot. Defaults to the frozen build under review for critics, or the current game for builders/repair children. Use press, hold + holdMs, click (+ x/y), drag {from,to} + holdMs, or waitMs. Use setupSteps for a bounded uncaptured prelude (at most ${GAME_TRY_INPUT_BOUNDS.maxSetupSteps} inputs/waits, no screenshots) that reaches a later question before the observed steps; only the observed suffix is captured and citable. Returns labelled before/after frames, pixel deltas, bridge snapshot changes and console errors. Critic frames have citable frameId values and are recorded in the round evidence. The result is path-first: every frame is saved with a persisted per-frame path and no inline images; read chosen frames with file tools (result.json beside the frames maps labels to files), or pass includeImage:true on a small deliberate route, since repeated full-sequence image results can exceed the provider's image limit and end the turn. Limits: 1–${GAME_TRY_INPUT_BOUNDS.maxSteps} observed steps plus optional setup (60 total), ${GAME_PLAYTEST_BOUNDS.maxStepMs / 1000} seconds per step, ${GAME_TRY_INPUT_BOUNDS.maxSequenceMs / 1000} seconds setup+steps total, ${GAME_TRY_INPUT_BOUNDS.maxFrames} planned frames (2 boot frames, plus 2 per observed step, 1 for a screenshot, plus max(0, ceil(stepMs / captureEveryMs) - 1) interval frames; setup adds none), ${GAME_TRY_INPUT_BOUNDS.maxCalls} calls per provider run; captureEveryMs defaults to 1000 and must be at least ${GAME_TRY_INPUT_BOUNDS.minCaptureEveryMs}. Ballots cannot use this tool.`,
  parameters: GameTryInput,
  success: GameWebPlaytestResult,
  failure,
  dependencies: [GameReviewSessions.GameReviewSessions, McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, () => {
    const fiber = Fiber.getCurrent();
    return (
      fiber === undefined ||
      Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)
        ?.gameReviewRole !== "ballot"
    );
  });
/**
 * Critic and ballot children judge frozen frames; only those two roles may
 * crop them. Builders and repairs never see review evidence, so the tool stays
 * out of their catalog the same way the answer tools do.
 */
const visibleToReviewers = () => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined) return true;
  const role = Context.getOrUndefined(
    fiber.context,
    McpInvocationContext.McpInvocationContext,
  )?.gameReviewRole;
  return role === "critic" || role === "ballot";
};
export const GameReviewDetailTool = Tool.make("game_review_detail", {
  description: `Crop a native-resolution detail of one evidence frame you already have, at 1–4x scale with per-region mean-colour measurements. Coordinates are frame pixels; the manifest's width/height are the frame size. Use it when a small effect (a glow edge, halo boundary, text) is unreadable at full-frame size: compare the numbers against the surrounding surface instead of guessing from the wide view. For a before/after card the same region is cut from both halves and returned as one card with a pixel delta. Measurements are not verdicts and citations still name the original frameId. Read-only; at most 6 calls per review session.`,
  parameters: GameReviewDetailInput,
  success: GameReviewDetailResult,
  failure,
  failureMode: "return",
  dependencies: [GameReviewSessions.GameReviewSessions, McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, visibleToReviewers);
export const GamePlaytestToolkit = Toolkit.make(
  GameWebPlaytestTool,
  GameTryInputTool,
  GameReviewDetailTool,
  VerifyTool,
);

const recipeDependencies = [GameRecipes.GameRecipes];
const GameRecipeSearchTool = Tool.make("game_recipe_search", {
  description:
    "Search optional game know-how with a short phrase about the creator's desired experience or a mechanic. genre, mechanic and defect match authored tags exactly; text or query ranks token matches across titles, tags, aliases and intent. Explicit no/without technique words exclude matching entries; paraphrased constraints are not understood. Suggestions never override the original brief or require adding a system. Use game_recipe_get includeReference:false to inspect fit, trade-offs and verification before choosing code. Accepted parameters are genre, mechanic, defect, text, query and cursor; any other name is rejected. Returns at most five ids, titles, matching tags, engines and nextCursor. Read-only; it reads no game files and starts no agent, build or model call.",
  parameters: GameRecipeSearchInput,
  success: GameRecipeSearchResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: recipeDependencies,
})
  .annotate(Tool.Readonly, true)
  // Unknown filter names must fail instead of being stripped into a browse page.
  .annotate(Tool.Strict, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
const GameRecipeGetTool = Tool.make("game_recipe_get", {
  description:
    "Read one recipe by id. Returns the complete Godot reference, setup, input route, provenance and version, or guidance only with includeReference:false. Adapt the mechanism to this game's brief and verify the observed behaviour; fetching never copies code into the game. Read-only; reads no game files.",
  parameters: GameRecipeGetInput,
  success: GameRecipeGetResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: recipeDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
export const GameRecipeToolkit = Toolkit.make(GameRecipeSearchTool, GameRecipeGetTool);

const artDependencies = [GameArtKits.GameArtKits];
const GameArtSearchTool = Tool.make("game_art_search", {
  description:
    "Search Game Studio's optional pinned CC0 art kits before choosing art. style matches an authored tag exactly (pixel-art, top-down, dungeon, fantasy, roguelike, platformer, side-view); text matches a declared word or phrase literally. Returns stable kit ids, contents, atlas and sheet dimensions, license and source. Nothing is imported and no kit is picked for you: use a kit only when it fits BRIEF.md and the game's art direction. Read-only; reads no game files and starts no work.",
  parameters: GameArtSearchInput,
  success: GameArtSearchResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: artDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
const GameArtGetTool = Tool.make("game_art_get", {
  description:
    "Read one art kit's complete declared files, byte sizes, SHA-256 hashes, atlas and additional sheet layouts, license and source provenance before importing it. Read-only; reads no game files.",
  parameters: GameArtGetInput,
  success: GameArtGetResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: artDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
const GameArtImportTool = Tool.make("game_art_import", {
  description:
    "Copy one chosen art kit's declared atlas, additional sheets, license and provenance files into this game under godot/assets/art/kits/<kitId>/, and return exact res:// paths and atlas/sheet layouts. It copies no scripts, scenes, levels or acceptance, changes no game.json and changes no mechanics. Repeated import of the unchanged kit writes nothing; if a destination file exists with different bytes it refuses and leaves every existing file untouched. Run game_godot_import afterward. Hidden from read-only critic and ballot sessions.",
  parameters: GameArtImportInput,
  success: GameArtImportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const GameArtFramesTool = Tool.make("game_art_frames", {
  description:
    "Build a Godot SpriteFrames resource from a shipped art kit's authored sheet animations. Give the kit id and sheet name from game_art_get (such as the pixel-platformer kit's characters sheet); animations defaults to every authored entry, or name a subset. Imports the project and builds AtlasTexture frames using Godot, returning the exact res:// resource path plus license and source. Subsets get separate paths, matching requests reuse existing resources, and modified resources are refused rather than overwritten. The kit must already be imported with game_art_import; its PNGs are never touched. Use the returned path with AnimatedSprite2D and nearest texture filtering. Hidden from read-only critic and ballot sessions.",
  parameters: GameArtFramesInput,
  success: GameArtFramesResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const libraryDependencies = [GameAssetLibrary.GameAssetLibrary];
const GameLibrarySearchTool = Tool.make("game_library_search", {
  description:
    "Search the Poly Haven CC0 library (no key) for game-ready models and PBR textures before choosing upstream art. Returns at most ten stable slugs with names, categories, tags and authors, plus the total match count. Nothing is downloaded and no game files are read. Use game_library_get for formats, resolutions and byte costs. Results carry a Powered by Poly Haven credit. Read-only; starts no work.",
  parameters: GameLibrarySearchInput,
  success: GameLibrarySearchResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: libraryDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
const GameLibraryGetTool = Tool.make("game_library_get", {
  description:
    "Read one Poly Haven asset's metadata and its default small download plan (1k glTF plus pinned textures for models; 1k albedo plus OpenGL normal and roughness JPEGs for PBR textures) with exact byte costs, resolutions and formats. Read-only; downloads nothing and reads no game files. A large asset fails its budget here, before any byte is fetched.",
  parameters: GameLibraryGetInput,
  success: GameLibraryGetResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: libraryDependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromBallots);
const GameLibraryImportModelTool = Tool.make("game_library_import_model", {
  description:
    "Download one Poly Haven model's bounded 1k glTF set (default; or 2k) into this game's godot/assets/library/models/<slug>/ and return the exact res:// glTF path. The raw download is the preserved source and is never reserialized; provenance with license, authors and pinned checksums stays beside it. Re-importing the unchanged asset writes nothing; edited destinations refuse instead of being overwritten. Run game_godot_import afterward. Hidden from read-only critic and ballot sessions.",
  parameters: GameLibraryImportModelInput,
  success: GameLibraryImportModelResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
const GameLibraryImportMaterialTool = Tool.make("game_library_import_material", {
  description:
    "Download one Poly Haven PBR texture's bounded 1k maps and build a reusable StandardMaterial3D with Godot itself (albedo colour plus OpenGL normal and roughness as non-colour data). Returns the exact res:// material path plus usage for sharing it across several MeshInstance3D nodes. The real PBR maps are never repainted. Matching requests reuse the resource; edited resources refuse instead of being overwritten. Hidden from read-only critic and ballot sessions.",
  parameters: GameLibraryImportMaterialInput,
  success: GameLibraryImportMaterialResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromCriticAndBallot);
export const GameArtToolkit = Toolkit.make(
  GameArtSearchTool,
  GameArtGetTool,
  GameArtImportTool,
  GameArtFramesTool,
  GameLibrarySearchTool,
  GameLibraryGetTool,
  GameLibraryImportModelTool,
  GameLibraryImportMaterialTool,
);
/**
 * The builder and repair toolkit. A repair child sees every build tool but not
 * review control. Critic and ballot children get the evidence-only toolkits
 * instead, so a fresh review is never offered a build, export or review-control
 * tool it must spend context ignoring.
 */
export const GameToolkit = Toolkit.make(
  GameStatusTool,
  ReviewStatusTool,
  ReviewHistoryTool,
  ReviewStopTool,
  ReviewRestoreTool,
  SubmitTool,
  BlenderTool,
  ImportTool,
  ImportNeutralTool,
  CheckTool,
  CheckNeutralTool,
  TestTool,
  TestNeutralTool,
  ScenariosTool,
  NativeCaptureTool,
  RuntimeCalibrateTool,
  AudioInspectTool,
  InspectSceneTool,
  GodotApiTool,
  AssetsInspectTool,
  ExportTool,
  PackageWindowsTool,
  PackageWebTool,
  PreviewTool,
  NativeTool,
  StopTool,
  ExploreStartTool,
  ExploreActTool,
  ExploreCloseTool,
  ExploreReplayTool,
);

// The service validates raw calls so schema failures count toward the same retry budget.
const reviewAnswerTool = <const Name extends "game_critic_report" | "game_ballot">(
  name: Name,
  role: "critic" | "ballot",
  parameters: Schema.Constraint,
) =>
  Tool.dynamic(name, {
    description:
      "Record this review session's answer. Fix the returned exact validation error and retry, at most three attempts. The first valid answer ends this session.",
    parameters: Tool.getJsonSchemaFromSchema(parameters),
    success: GameReviewReportResult,
    failure,
    failureMode: "return",
  })
    .addDependency(GameReviewSessions.GameReviewSessions)
    .addDependency(McpInvocationContext.McpInvocationContext)
    .annotate(Tool.Readonly, true)
    .annotate(McpSchema.EnabledWhen, () => {
      const fiber = Fiber.getCurrent();
      return (
        fiber !== undefined &&
        Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)
          ?.gameReviewRole === role
      );
    });

export const GameReviewAnswerToolkit = Toolkit.make(
  reviewAnswerTool("game_critic_report", "critic", GameReviewCriticAnswer),
  reviewAnswerTool("game_ballot", "ballot", GameReviewBallotInput),
);
