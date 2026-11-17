// Which game tools a thread's agent is offered, and which of their ops its game can run. A tool is
// listed from a game thread's first turn whenever its game runs any of its ops: its engine, and for
// Blender the person's model choice. A missing Blender never changes the listing; an op the game
// or machine cannot run is refused when called, with why. The thread's game, engine, model choice
// and Blender come from the MCP invocation (McpHttpServer's auth middleware). A tool the listing
// hides is also refused when called by name, by Effect's MCP core.
import { engineDisplayName, isAvailableEngine } from "@kurambit/contracts";
import { engineCapabilities, type GameEngineCapability } from "../../../game/engineProfile.ts";
import { currentInvocation, type McpInvocationScope } from "../../McpInvocationContext.ts";

/** Each op, by tool, with what it needs of the game's engine (empty: any game). */
export const GAME_TOOL_OPS = {
  game_check: { look: ["play"], final: ["play"], facts: ["play"], status: [] },
  game_play: {
    preview: ["play"],
    start: ["play"],
    act: ["play"],
    close: ["play"],
    bot: ["play"],
    bot_view: ["play"],
    replay: ["tune"],
    model_sheet: ["tune"],
  },
  game_assets: {
    search: ["play"],
    add: ["play"],
    generate: ["play"],
    wait: ["play"],
    image_edit: ["play"],
    import: ["import"],
    mine: [],
  },
  game_blender: {
    code: ["blender"],
    look: ["blender"],
    scene: ["blender"],
    export: ["blender"],
    character: ["blender"],
    paint: ["blender"],
    carve: ["blender"],
    sprites: ["blender"],
    animate: ["blender"],
    asset_search: ["blender"],
    asset_import: ["blender"],
  },
  game_builds: {
    list: [],
    compare: [],
    restore: [],
    saved: [],
    export: ["play"],
    package: ["play"],
    stop: ["play"],
  },
  game_keep_going: { set: ["turnLoop"] },
} as const satisfies Record<`game_${string}`, Record<string, ReadonlyArray<GameEngineCapability>>>;
export type GameToolName = keyof typeof GAME_TOOL_OPS;

/**
 * Whether the person's model choice makes models in Blender: the Blender route; generated, whose
 * humanoids are put on the standard skeleton there; and code with the library on, where Blender
 * makes what the library lacks (gameStyle's makesInBlender). Code with the library off, the
 * default, makes every model in code, so its chats are never handed Blender's schemas.
 */
const choiceUsesBlender = (models: McpInvocationScope["gameModels"]) =>
  models == null || models.route !== "code" || models.library;

/**
 * Why the calling thread's game refuses the op, or null when it may run it; with `machine`, also
 * why this machine cannot (a missing Blender), which never changes the listing.
 */
const refusalOf = (
  needs: ReadonlyArray<GameEngineCapability>,
  scope: McpInvocationScope | undefined,
  machine: boolean,
): string | null => {
  const engine = scope?.gameEngine;
  if (scope === undefined || engine == null) return "it works in no game";
  const capabilities = engineCapabilities(engine);
  if (!needs.every((need) => capabilities.has(need)))
    return isAvailableEngine(engine)
      ? `this ${engineDisplayName(engine)} game's engine does not support it`
      : `${engineDisplayName(engine)} games are not available in this version of Kurambit`;
  if (!needs.includes("blender")) return null;
  if (!choiceUsesBlender(scope.gameModels))
    return "the person chose to make this game's models in code with the library off, so nothing is made in Blender. Say so if the request needs Blender: the person changes it in the game's \"Make models with\" setting";
  if (machine && scope.blenderMissing != null)
    return `it runs in Blender, which Kurambit cannot use on this machine. ${scope.blenderMissing}`;
  return null;
};

/** Why the calling thread's game or machine refuses the op, or null when it may run it. */
export const opRefusal = (
  needs: ReadonlyArray<GameEngineCapability>,
  scope: McpInvocationScope | undefined,
) => refusalOf(needs, scope, true);

/** Whether the calling thread's game runs any of the tool's ops; a missing Blender still lists it. */
const listed = (name: GameToolName, scope: McpInvocationScope | undefined) =>
  Object.values<ReadonlyArray<GameEngineCapability>>(GAME_TOOL_OPS[name]).some(
    (needs) => refusalOf(needs, scope, false) === null,
  );

/** The `McpSchema.EnabledWhen` of a game tool: listed for the calling thread. */
export const listedFor = (name: GameToolName) => () => listed(name, currentInvocation());

/**
 * The game tools older games and chats still name, with the tool and op that does their work now.
 * Each stays callable, never listed, only to answer with where its work went.
 */
export const RETIRED_GAME_TOOLS: Readonly<Record<string, string>> = {
  game_status: "game_check op status",
  game_facts: "game_check op facts",
  game_preview: "game_play op preview",
  game_explore_start: "game_play op start",
  game_explore_act: "game_play op act",
  game_explore_close: "game_play op close",
  game_bot_run: "game_play op bot",
  game_bot_view: "game_play op bot_view",
  game_replay: "game_play op replay",
  game_model_sheet: "game_play op model_sheet",
  game_assets_search: "game_assets op search",
  game_assets_add: "game_assets op add",
  game_generate: "game_assets op generate",
  game_generate_wait: "game_assets op wait",
  game_image_edit: "game_assets op image_edit",
  game_import: "game_assets op import",
  game_blender_assets_search: "game_blender op asset_search",
  game_blender_assets_import: "game_blender op asset_import",
  game_blender_code: "game_blender op code",
  game_blender_look: "game_blender op look",
  game_blender_scene: "game_blender op scene",
  game_blender_export: "game_blender op export",
  game_blender_character: "game_blender op character",
  game_blender_paint: "game_blender op paint",
  game_blender_carve: "game_blender op carve",
  game_blender_render_sprites: "game_blender op sprites",
  game_animate: "game_blender op animate",
  game_build_restore: "game_builds op restore",
  game_saved: "game_builds op saved",
  game_export: "game_builds op export",
  game_package: "game_builds op package",
  game_stop: "game_builds op stop",
  game_tune:
    "an edit of the game's tune file (web/tune.json for three.js): write the values the person asked to keep there; the turn's build keeps them",
  game_models_route:
    "an edit of game.json's `characters` (code, blender or generated) and `library` (true or false), only when the person asks you to in chat",
  game_more: "the game tool it reached, now listed itself",
};

/** What a call to a retired tool answers. */
export const retiredToolMessage = (name: string) =>
  `${name} is gone from Kurambit's game tools: its work is now ${RETIRED_GAME_TOOLS[name]}.`;
