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
  GamePlayToolInput,
  OrchestratorMcpFailure,
} from "@kurambit/contracts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameLibrary from "../../../game/GameLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import * as GameCopies from "../../../game/GameCopies.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GamePlays from "../../../game/GamePlays.ts";
import * as GameProjectService from "../../../game/GameProjectService.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import { fill, STUDIO_TEXT } from "../../../game/studioText.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { listedFor } from "./placement.ts";
import { GameToolRefusal } from "./results.ts";

const failure = Schema.Union([GameToolRefusal, OrchestratorMcpFailure]);

/** Every game op acts as the calling thread's agent. */
const caller = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
] as const;
/** Each op's answer is encoded by its own schema in the handler; the tool passes it on as it is. */
const answers = { success: Schema.Unknown, failure, failureMode: "return" } as const;

/** A tool's description, from the harness text (templates/studio/harness/tools.json). */
const describe = (name: Exclude<keyof typeof STUDIO_TEXT.tools, "oneOp">) =>
  fill(STUDIO_TEXT.tools[name], { oneOp: STUDIO_TEXT.tools.oneOp });

export const GameCheckTool = Tool.make("game_check", {
  description: describe("game_check"),
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
  description: describe("game_play"),
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
  description: describe("game_assets"),
  parameters: GameAssetsToolInput,
  ...answers,
  dependencies: [
    GameAssetLibrary.GameAssetLibrary,
    GameLibrary.GameLibrary,
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
  description: describe("game_blender"),
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
  description: describe("game_builds"),
  parameters: GameBuildsToolInput,
  ...answers,
  dependencies: [
    GameBuilds.GameBuilds,
    GameCopies.GameCopies,
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
  description: describe("game_keep_going"),
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
