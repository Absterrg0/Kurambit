// The game tools an agent is handed: six, each one schema whose keys are its ops (gameTools.ts in
// contracts), plus game_unity in Unity games. A tool earns its place only with what an agent
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
  GameUnityToolInput,
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
import * as GameUnity from "../../../game/GameUnity.ts";
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

const ONE_OP = 'Pass one op as the only key, with its input: {"<op>": {...}}.';

export const GameCheckTool = Tool.make("game_check", {
  description: `Facts on this game, measured in its running build. ${ONE_OP} With no op, look. look: a quick check: a moment of random input, errors and warnings with file:line, frame rate, and play's frame as an image, beside the reference picture when the game has one. final: the full check to run before you end a turn: also the entry the player opens, the scene report (what may look wrong, with frames) and the QA play (every control in ACTIONS, Retry, the HUD at 16:9 and 4:3), whose problems are bugs to fix. facts: what the harness measured on a build (the newest when omitted), as the Builds rail shows it; skilled also plays the game's play bot. status: the manifest, engine tool readiness, managed processes, the preview URL, how the person chose to make models and which art providers they set up.`,
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
  description: `Drive this game as it runs. ${ONE_OP} preview: the playable URL of the current sources (a three.js game's folder is served live on the person's Stage). start, act, close: a bounded session that sends input batches and returns each moment's picture path, visible text, controls and errors. bot: plays the game in real time with a bot file under .studio/bot/, recording a video and findings; bot_view: a finished run. replay: the person's last run on the Stage played again on the folder as it is now, and the first second it plays differently. model_sheet: named models drawn by the running game from six sides beside a 1.8 m figure, with size and cost, as images.`,
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
  description: `Art and sound from outside the game's code. ${ONE_OP} search: Kurambit's pinned open library (CC0, or CC BY with its credit), with a contact sheet image; add: copies its files into the game, credited in ASSETS.md. generate: starts art with the providers the person set up (lanes image, texture, character, creature, model, motion, sfx, music, voice) and answers with an id at once; each start is paid, so never start one twice. wait: waits for a generation, or says its candidates wait for the person's pick in the chat. image_edit: changes an image the game has from words, for the person to pick changed or as it was. import: the engine's import step. blender_search, blender_import: Poly Haven, Sketchfab or Poly Pizza assets, or a library or generated model, into the live Blender scene. A refusal names the key, limit or route missing: say so to the person.`,
  parameters: GameAssetsToolInput,
  ...answers,
  dependencies: [
    GameAssetLibrary.GameAssetLibrary,
    GameArt.GameArt,
    GameEngine.GameEngine,
    GameBlender.GameBlender,
    GameRunControl.GameRunControl,
    GameProjectService.GameProjectService,
    ...caller,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_assets"));

export const GameBlenderTool = Tool.make("game_blender", {
  description: `This game's managed Blender: a live scene on a private display, saved as the game's .blend after each change. ${ONE_OP} code: runs bpy Python in it. look: the scene as an image; mode review shows what export would write, measured. scene: object counts, sizes and positions as text. export: the reviewed objects as a GLB with its sidecar, refused when they changed since review or break the budget or rig. character: a rigged humanoid on the standard skeleton that plays the library's clips. paint: textures models from a turnaround sheet. carve: an organic prop from a three-view sheet. sprites: 2D sprite strips framed by construction. animate: keys a move written as poses on beats, with pictures and numbers beside a library clip. How to use each: studio-skills/art-pipeline.md.`,
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
  description: `This game's builds and undo. ${ONE_OP} With no op, list. list: every turn that changed the game, newest first, with its base, facts and the latest restore. compare: two builds' facts, each up, down or same. restore: puts a build back in the folder when the person asks, keeping what was there as a build, so restoring a build's base undoes it. saved: the videos and images kept in saved/; save keeps one a tool made, delete removes one when the person asks. export: a release for Web, Linux or Windows. package: a release as a downloadable ZIP. stop: stops the processes Kurambit started for this game, the Stage's live game included.`,
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
    'Keep going, only when the person asks about it. With nothing it says what Keep going is doing and its last steps. mode turns it off, guided (proposes each step) or autopilot; budgetMinutes (null for none) applies when it starts or resumes; steer gives its next step the person\'s words. A message that starts "Keep going · step N" is a step: do that one change.',
  parameters: GameKeepGoingToolInput,
  ...answers,
  dependencies: [GameRunControl.GameRunControl, ...caller],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_keep_going"));

export const GameUnityTool = Tool.make("game_unity", {
  description: `This Unity game's live editor on a private display. ${ONE_OP} tools: its editing tools with their schemas; edit: calls one, saving open scenes. eval: C# on its main thread. recompile: imports and compiles, with every C# error at file:line. play: enters or leaves play mode. console: recent entries. screenshot: the Game view as an image.`,
  parameters: GameUnityToolInput,
  ...answers,
  dependencies: [GameUnity.GameUnity, GameEngine.GameEngine, ...caller],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity"));

/**
 * Tools whose answers carry pictures are registered over the HTTP transport so they become image
 * content (McpHttpServer.registerGameImageTool); the rest go through the plain toolkit.
 */
export const GameCheckToolkit = Toolkit.make(GameCheckTool);
export const GamePlayToolkit = Toolkit.make(GamePlayTool);
export const GameAssetsToolkit = Toolkit.make(GameAssetsTool);
export const GameBlenderToolkit = Toolkit.make(GameBlenderTool);
export const GameUnityToolkit = Toolkit.make(GameUnityTool);
export const GameToolkit = Toolkit.make(GameBuildsTool, GameKeepGoingTool);
