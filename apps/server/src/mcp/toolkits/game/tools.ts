// The game tools an agent is handed: six, each one schema whose keys are its ops (gameTools.ts in
// contracts). A tool earns its place only with what an agent
// cannot get from its files, shell and code: the running game, measurements, builds and undo,
// the person's keys, and managed Blender. Each op's answer is encoded by its own schema in the
// handler, so the tool's success is that answer as it is.
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import {
  GameAssetsToolInput,
  GameBlenderToolInput,
  GameBuildsToolInput,
  GameCheckToolInput,
  GameKeepGoingToolInput,
  GameOperationFailure,
  GamePlayToolInput,
  OrchestratorMcpFailure,
} from "@kurambit/contracts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GamePlays from "../../../game/GamePlays.ts";
import * as GameProjectService from "../../../game/GameProjectService.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { listedFor } from "./placement.ts";

const failure = Schema.Union([GameOperationFailure, OrchestratorMcpFailure]);

/** Every game op acts as the calling thread's agent. */
const caller = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
] as const;
/** Each op's answer is encoded by its own schema in the handler; the tool passes it on as it is. */
const answers = { success: Schema.Unknown, failure, failureMode: "return" } as const;

const ONE_OP = 'One op per call, as the only key: {"<op>": {...}}.';

export const GameCheckTool = Tool.make("game_check", {
  description: `Facts on this game's running build. ${ONE_OP} No op: look. look: a moment of play: errors with file:line, frame rate, and the frame as an image beside the reference picture. final: the full check before you end a turn: also the player's entry, the scene report and the QA play, whose problems are bugs to fix. facts: what the harness measured on a build. status: toolchain, preview URL, model choice and art providers.`,
  parameters: GameCheckToolInput,
  ...answers,
  dependencies: [
    GameEngine.GameEngine,
    GameProjectService.GameProjectService,
    GameBuilds.GameBuilds,
    GameStatusService.GameStatusService,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_check"));

export const GamePlayTool = Tool.make("game_play", {
  description: `Drive the running game. ${ONE_OP} preview: the playable URL. start, act, close: a session of input batches, each answered with a frame, text, controls, errors. bot: a real-time run of a .studio/bot/ file, with video and findings; bot_view: a past one. replay: test plays every build replays; save names the last ended run; run, at: a run (id or name) at a second as an image. model_sheet: named models from six sides, with size and cost.`,
  parameters: GamePlayToolInput,
  ...answers,
  dependencies: [
    GameStage.GameStage,
    GameExplore.GameExplore,
    GameBot.GameBot,
    GamePlays.GamePlays,
    GameEngine.GameEngine,
    GameProjectService.GameProjectService,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_play"));

export const GameAssetsTool = Tool.make("game_assets", {
  description: `Art and sound from outside the code. ${ONE_OP} search: the pinned open library, with a contact sheet; add: copies its files in, credited. generate: starts art with the person's providers and answers with an id (each start is paid: never start one twice); wait: its files, or that it waits for the person's pick. image_edit: changes a game image from words, for the person to pick. import: the engine's import step. A refusal names what is missing: tell the person.`,
  parameters: GameAssetsToolInput,
  ...answers,
  dependencies: [
    GameAssetLibrary.GameAssetLibrary,
    GameArt.GameArt,
    GameEngine.GameEngine,
    GameRunControl.GameRunControl,
    GameProjectService.GameProjectService,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_assets"));

export const GameBlenderTool = Tool.make("game_blender", {
  description: `This game's managed Blender: a live scene, saved as the game's .blend after each change. ${ONE_OP} code: runs bpy Python. look: the scene as an image; mode review shows what export writes. scene: objects as text. export: the reviewed objects as a GLB with its sidecar. character: a rigged humanoid on the standard skeleton. paint: textures from a turnaround sheet. carve: a prop from a three-view sheet. sprites: framed 2D strips. animate: keys a move from poses on beats. asset_search, asset_import: Poly Haven, Sketchfab, Poly Pizza, library or generated assets into the scene. How: studio-skills/art-pipeline.md.`,
  parameters: GameBlenderToolInput,
  ...answers,
  dependencies: [
    GameBlender.GameBlender,
    GameRunControl.GameRunControl,
    GameProjectService.GameProjectService,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender"));

export const GameBuildsTool = Tool.make("game_builds", {
  description: `This game's builds and undo. ${ONE_OP} No op: list. list: turns that changed the game, newest first, with facts. compare: two builds' facts. restore: puts a build back when the person asks (a build's base undoes it). saved: kept videos and images; save or delete one. export: a release. package: a release as a ZIP. stop: stops what Kurambit runs for this game.`,
  parameters: GameBuildsToolInput,
  ...answers,
  dependencies: [
    GameBuilds.GameBuilds,
    GameSavedMediaService.GameSavedMediaService,
    GameExport.GameExport,
    GameStage.GameStage,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_builds"));

export const GameKeepGoingTool = Tool.make("game_keep_going", {
  description:
    'Keep going, only when the person asks. No input: what it is doing. mode: off, guided or autopilot; budgetMinutes (null for none) on start or resume; steer: the person\'s words for its next step. A message starting "Keep going · step N" is a step: do that one change.',
  parameters: GameKeepGoingToolInput,
  ...answers,
  dependencies: [GameRunControl.GameRunControl, ...caller],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_keep_going"));

/**
 * Each tool is registered over the HTTP transport, so pictures become image content and its schema
 * is published compacted (McpHttpServer.registerGameImageTool).
 */
export const GameCheckToolkit = Toolkit.make(GameCheckTool);
export const GamePlayToolkit = Toolkit.make(GamePlayTool);
export const GameAssetsToolkit = Toolkit.make(GameAssetsTool);
export const GameBlenderToolkit = Toolkit.make(GameBlenderTool);
export const GameToolkit = Toolkit.make(GameBuildsTool, GameKeepGoingTool);
