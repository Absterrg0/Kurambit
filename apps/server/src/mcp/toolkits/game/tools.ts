import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  GameActionResult,
  GameArtGetInput,
  GameArtGetResult,
  GameArtImportInput,
  GameArtImportResult,
  GameArtSearchInput,
  GameArtSearchResult,
  GameBlenderInput,
  GameBlenderResult,
  GameCheckResult,
  GameOperationFailure,
  GameRecipeGetInput,
  GameRecipeGetResult,
  GameRecipeSearchInput,
  GameRecipeSearchResult,
  GameSceneInspectInput,
  GameSceneInspectResult,
  GameScenariosRunResult,
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
  GameWebPlaytestResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as GameRecipes from "../../../game/GameRecipes.ts";
import * as GameArtKits from "../../../game/GameArtKits.ts";
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
const GameStatusTool = Tool.make("game_status", {
  description:
    "Inspect this thread's Game Studio project: design status and the DESIGN.md/BRIEF.md paths, toolchain readiness and actionable repair instructions, assets with derived scene usage, scenes, builds, managed processes, log directory, playable preview URL, and the builder's production phase (first playable, this turn's accepted submits, budget and time left). Requires game.json in this thread's workspace. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
  parameters: Schema.Struct({ checkSources: Schema.optionalKey(Schema.Boolean) }),
  success: GameStatus,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const reviewDependencies = [...dependencies, GameReviewApi.GameReviewApi];
const ReviewStatusTool = Tool.make("game_review_status", {
  description:
    "Read the current review phase, remaining repairs/time, frozen builder/reviewer models, usage, interruption and restore availability. Existing games have no review until the builder submits a verified build (or a turn ends with one). Restart never resumes a review.",
  success: GameReviewStatus,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
}).annotate(Tool.Readonly, true);
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
}).annotate(Tool.Readonly, true);
const ReviewStopTool = Tool.make("game_review_stop", {
  description:
    "Stop this game's review and wait for its owned child sessions to stop. The selected build remains playable. Fails if a session may still write; no Resume mid-round.",
  success: GameReviewStatus,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
}).annotate(Tool.Readonly, false);
const ReviewRestoreTool = Tool.make("game_review_restore", {
  description:
    "Explicitly restore the previous game-folder version from the latest review. Stops review sessions first and preserves the folder's current version before restoring. Keeps the selected build and live preview directories. Check game_review_status for availability.",
  success: GameReviewRestoreResult,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
}).annotate(Tool.Readonly, false);
const SubmitTool = Tool.make("game_submit", {
  description:
    "Hand a build to the studio. The first accepted submit is the game's first playable: Play shows it at once and your turn keeps going. Keep producing — deepen the game toward the brief and its art direction with recipes and game_try_input — and submit each improved build; every accepted submit replaces what Play shows, and the last one is what review starts on when your turn ends. Name the Web export you stand behind (default: this game's latest export) and give a one-line note on what the game is; a repair child instead names the defects it believes it fixed. The server checks only facts: the build exists, its bytes match their hash and are the current export, and a playtest of those exact bytes booted with no console errors and responded to input. Refused, the result lists the exact failed check and Play keeps the previous build; fix it and submit again.",
  parameters: GameSubmitInput,
  success: GameSubmitResult,
  failure,
  failureMode: "return",
  dependencies: reviewDependencies,
}).annotate(Tool.Readonly, false);
const BlenderTool = Tool.make("game_blender_run", {
  description:
    "Build or revise a model in this thread's game. Supply a stable id and Python bpy script. Opens art/blender/<id>.blend if present, otherwise an empty factory scene. Set reset=true to rebuild from an empty scene at the same source/export paths; false/default modifies the existing file, so edit objects by name to avoid duplicates. Executes the script, preserves the .blend source, saves the script, exports GLB with applied modifiers to the same godot/assets/models/<id>.glb path, renders a small CPU thumbnail unless thumbnail=false, and updates game.json. Returns mesh/material counts, bounds, warnings and real output. Script exceptions return their traceback and a log path. Follow with game_godot_import.",
  parameters: GameBlenderInput,
  success: GameBlenderResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const ImportTool = Tool.make("game_godot_import", {
  description:
    "Run a real headless Godot editor import in this thread's game. Call after every asset transfer or engine change. Returns success=false on parse errors, missing resources, import errors or nonzero exit, with stdout/stderr and log path. Fix failures before export.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const CheckTool = Tool.make("game_godot_check", {
  description:
    "Fast static and boot check for this thread's game. Imports, then loads every .gd, .tscn and .tres, runs the main scene and the gameplay scene game.json declares for 120 physics frames each, and reports parse/load/runtime errors with file:line. Also returns lint warnings for InputMap actions used but not defined, and errors for a player in the `player` group without a direct, enabled CollisionShape with a shape, or a CharacterBody without a CollisionShape. Reports which entries ran. Start every build or fix loop with this; it catches more than a bare import and much faster than a playtest.",
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const InspectSceneTool = Tool.make("game_scene_inspect", {
  description:
    "Dump a scene's node tree headlessly: scene-relative path, name, type, script path, groups, position, collision layer/mask and child names, capped at 400 nodes with truncation reported. Use the res:// path shown by game_status, such as res://scenes/main_menu.tscn. Read-only; use it to debug scene wiring without opening the Godot editor.",
  parameters: GameSceneInspectInput,
  success: GameSceneInspectResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const TestTool = Tool.make("game_godot_test", {
  description:
    "Run a headless GDScript in this thread's Godot project. The script must extend SceneTree and quit explicitly, using a nonzero code for failures. Supply a Godot-project-relative .gd path, such as tests/smoke_test.gd. Use this to simulate and assert the core gameplay loop. Returns real exit status, stdout/stderr and log path. Timeout defaults to 60 seconds and is bounded at 300 seconds.",
  parameters: Schema.Struct({
    script: Schema.String,
    timeoutMs: Schema.optionalKey(Schema.Number),
  }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const ScenariosTool = Tool.make("game_scenarios_run", {
  description:
    "Run every route in godot/tests/scenarios/*.json through the real game, starting from the main menu under normal physics with only injected input. Grades each approved DESIGN.md observation from the first sample after the route's first input, so a value already true at play start fails; records the state qualification stage with proven/failed/missing coverage per kind. Also lists the scenarios' per-criterion proving scenario and frame. A route is pure data: press, hold or wait steps using actions from project.godot's InputMap. Returns frames run, route errors and per-criterion pass/fail with the values actually observed. Routes cannot call game functions or set state; fix the route or the game, never the exam. A run must press a control and move a player in group \"player\"; a wait-only route proves nothing.",
  success: GameScenariosRunResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const ExportTool = Tool.make("game_export", {
  description:
    "Import and export this thread's game with the Web or Linux release preset. Verifies matching Godot export templates and nonempty build output. Web uses Compatibility rendering and single-threaded export. Returns actual paths and command output or errors. A Web export is immediately playable; game_submit makes a build the first playable and publishes each improved one. Use game_preview to build and serve a playable browser URL.",
  parameters: Schema.Struct({ target: Schema.Literals(["Web", "Linux"]) }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const PreviewTool = Tool.make("game_preview", {
  description:
    "Build this thread's Web release when it is missing or older than the game sources, start its managed loopback static server, and return the playable URL. A fresh existing build is served without another export. This is an actual WebAssembly game, not a screenshot. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const NativeTool = Tool.make("game_run_native", {
  description:
    "Import and launch this thread's Godot game natively with a tracked PID and output log. The agent's run is headless: it opens no window and inherits no display; only the creator's own Play action may open a window. Use game_stop to stop it; unrelated processes are never terminated.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Game Studio, including running Blender/Godot operations and native play, and close its Web preview server. Returns after managed processes exit. Does not kill external editors or other games.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, false);
const WebPlaytestTool = Tool.make("game_web_playtest", {
  description:
    "Load this game's real Web export in a headless browser, wait for Godot to boot, optionally hold keys and click the canvas, and return screenshots plus console errors. Template games also report a read-only state probe: GameState values and the player position before and after the steps, with a short diff. Use this as the final web check instead of building your own browser tooling.",
  parameters: GameWebPlaytestInput,
  success: GameWebPlaytestResult,
  failure,
  // Default "error" failureMode: the HTTP transport registers this tool behind
  // McpHttpServer.registerImageTool, which turns failures into text results.
  dependencies,
}).annotate(Tool.Readonly, false);
// Exported for the image-content transport registration in McpHttpServer.
export const GameWebPlaytestTool = WebPlaytestTool;
export const GameTryInputTool = Tool.make("game_try_input", {
  description:
    "Test a gameplay hypothesis from a fresh headless boot. Defaults to the frozen build under review for critics, or the current game for builders/repair children. Use press, hold + holdMs, click (+ x/y), drag {from,to} + holdMs, or waitMs. Returns labelled before/after frames, pixel deltas, bridge snapshot changes and console errors. Critic frames have citable frameId values and are recorded in the round evidence. Limits: 12 steps, 10 seconds per step, 30 seconds total, 32 frames, 6 calls per provider run; captureEveryMs defaults to 1000 and must be at least 100. Ballots cannot use this tool.",
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
export const GamePlaytestToolkit = Toolkit.make(GameWebPlaytestTool, GameTryInputTool);

const recipeDependencies = [GameRecipes.GameRecipes];
/** Ballots keep frozen comparison context; retrieval is hidden and refused. */
const hiddenFromBallots = () => {
  const fiber = Fiber.getCurrent();
  return (
    fiber === undefined ||
    Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)
      ?.gameReviewRole !== "ballot"
  );
};
const GameRecipeSearchTool = Tool.make("game_recipe_search", {
  description:
    "Search the optional game know-how catalog when an unfamiliar genre or mechanic blocks progress. genre, mechanic and defect match authored tags exactly; text matches a declared alias literally. Returns at most five ids, titles, matching tags, engines and nextCursor. Read-only; it reads no game files and starts no agent, build or model call.",
  parameters: GameRecipeSearchInput,
  success: GameRecipeSearchResult,
  failure: Schema.String,
  failureMode: "return",
  dependencies: recipeDependencies,
})
  .annotate(Tool.Readonly, true)
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
const hiddenFromReviewChildren = () => {
  const fiber = Fiber.getCurrent();
  if (fiber === undefined) return true;
  const role = Context.getOrUndefined(
    fiber.context,
    McpInvocationContext.McpInvocationContext,
  )?.gameReviewRole;
  return role === null || role === undefined;
};
const GameArtSearchTool = Tool.make("game_art_search", {
  description:
    "Search Game Studio's optional pinned CC0 art kits before choosing art. style matches an authored tag exactly (pixel-art, top-down, dungeon, fantasy, roguelike); text matches a declared word or phrase literally. Returns stable kit ids, contents, atlas dimensions, license and source. Nothing is imported and no kit is picked for you: use a kit only when it fits BRIEF.md and the game's art direction. Read-only; reads no game files and starts no work.",
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
    "Read one art kit's complete declared files, byte sizes, SHA-256 hashes, atlas layout, license and source provenance before importing it. Read-only; reads no game files.",
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
    "Copy one chosen art kit's declared atlas, license and provenance files into this game under godot/assets/art/kits/<kitId>/, and return exact res:// paths and atlas layout. It copies no scripts, scenes, levels or acceptance, changes no game.json and changes no mechanics. Repeated import of the unchanged kit writes nothing; if a destination file exists with different bytes it refuses and leaves every existing file untouched. Run game_godot_import afterward. Hidden from read-only critic and ballot sessions.",
  parameters: GameArtImportInput,
  success: GameArtImportResult,
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, hiddenFromReviewChildren);
export const GameArtToolkit = Toolkit.make(GameArtSearchTool, GameArtGetTool, GameArtImportTool);
export const GameToolkit = Toolkit.make(
  GameStatusTool,
  ReviewStatusTool,
  ReviewHistoryTool,
  ReviewStopTool,
  ReviewRestoreTool,
  SubmitTool,
  BlenderTool,
  ImportTool,
  CheckTool,
  TestTool,
  ScenariosTool,
  InspectSceneTool,
  ExportTool,
  PreviewTool,
  NativeTool,
  StopTool,
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
