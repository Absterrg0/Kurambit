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
  game_check: { look: ["play"], final: ["play"] },
  game_play: {
    act: ["play"],
    close: ["play"],
    bot: ["play"],
    replay: ["tune"],
    eval: ["play"],
    model_sheet: ["tune"],
  },
  game_assets: {
    search: ["play"],
    add: ["play"],
    lock: ["play"],
    generate: ["play"],
    wait: ["play"],
    pictures: ["play"],
  },
  game_blender: {
    code: ["blender"],
    look: ["blender"],
    export: ["blender"],
    character: ["blender"],
    paint: ["blender"],
    sprites: ["blender"],
    animate: ["blender"],
    asset_search: ["blender"],
    asset_import: ["blender"],
    addon: ["blender"],
  },
  game_builds: { list: [], undo: [], export: ["play"] },
  game_copy: { copies: [], bring_in: [], update: [] },
  game_keep_going: { set: ["turnLoop"] },
} as const satisfies Record<`game_${string}`, Record<string, ReadonlyArray<GameEngineCapability>>>;
export type GameToolName = keyof typeof GAME_TOOL_OPS;

/**
 * Whether the person's model choice makes models in Blender: the Blender route, and code with the
 * library on, where Blender
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

/**
 * Whether the calling thread's game runs any of the tool's ops; a missing Blender still lists it.
 * A copy's ops are listed only to a chat working in a copy.
 */
const listed = (name: GameToolName, scope: McpInvocationScope | undefined) =>
  (name !== "game_copy" || scope?.gameInCopy === true) &&
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
  game_status: "game_check op final (its status line)",
  game_facts: "game_builds op list {build}",
  game_preview: "the person's Stage; game_check op look",
  game_explore_start: "game_play op act with no sessionId (it opens one)",
  game_explore_act: "game_play op act",
  game_explore_close: "game_play op close",
  game_bot_run: "game_play op bot",
  game_bot_view: "game_play op replay {run, at}",
  game_replay: "game_play op replay",
  game_model_sheet: "game_play op model_sheet",
  game_assets_search: "game_assets op search",
  game_assets_add: "game_assets op add",
  game_generate: "nothing: generated art is gone; make it in Blender or code",
  game_generate_wait: "nothing: generated art is gone; make it in Blender or code",
  game_image_edit: "nothing: generated art is gone; make it in Blender or code",
  game_import:
    "nothing: a three.js game loads its files from web/ as they are, with no import step",
  game_blender_assets_search: "game_blender op asset_search",
  game_blender_assets_import: "game_blender op asset_import",
  game_blender_code: "game_blender op code",
  game_blender_look: "game_blender op look",
  game_blender_scene: "game_blender op code, printing what it needs",
  game_blender_export: "game_blender op export",
  game_blender_character: "game_blender op character",
  game_blender_paint: "game_blender op paint",
  game_blender_carve:
    "game_blender op code: model the prop in bpy as parts (studio-skills/recipes)",
  game_blender_render_sprites: "game_blender op sprites",
  game_animate: "game_blender op animate",
  game_build_restore: "game_builds op undo {build, to: true}",
  game_saved: "nothing for agents: the person keeps media in the Game panel",
  game_export: "game_builds op export",
  game_package: "game_builds op export {zip: true}",
  game_stop: "nothing: the harness stops what it started",
  game_tune:
    "an edit of the game's tune file (web/tune.json for three.js): write the values the person asked to keep there; the turn's build keeps them",
  game_models_route:
    "an edit of game.json's `characters` (code or blender) and `library` (true or false), only when the person asks you to in chat",
  game_more: "the game tool it reached, now listed itself",
};

/** What a call to a retired tool answers: a refusal whose `next` is where its work went. */
export const retiredTool = (name: string) => ({
  refused: `${name} is gone from Kurambit's game tools.`,
  next: `${RETIRED_GAME_TOOLS[name]}.`,
});

/** The ops older chats still name, by "tool.op", with what does their work now. */
const RETIRED_GAME_OPS: Readonly<Record<string, string>> = {
  "game_check.facts": "game_builds op list {build}",
  "game_check.status": "game_check op final (its status line)",
  "game_play.preview": "the person's Stage; game_check op look",
  "game_play.start": "game_play op act with no sessionId (it opens one)",
  "game_play.bot_view": "game_play op replay {run, at}",
  "game_assets.image_edit": "nothing: generated art is gone; make it in Blender or code",
  "game_assets.import": "nothing: a three.js game loads web/ files as they are",
  "game_assets.mine": "nothing: the personal Library is gone",
  "game_blender.scene": "game_blender op code, printing what it needs",
  "game_blender.carve":
    "game_blender op code: model the prop in bpy as parts (studio-skills/recipes)",
  "game_builds.compare": "game_builds op list {build} for each",
  "game_builds.restore": "game_builds op undo {build, to: true}",
  "game_builds.saved": "nothing for agents: the person keeps media in the Game panel",
  "game_builds.package": "game_builds op export {zip: true}",
  "game_builds.stop": "nothing: the harness stops what it started",
  "game_builds.copies": "game_copy op copies (listed in a copy)",
  "game_builds.bring_in": "game_copy op bring_in (listed in a copy)",
  "game_builds.update": "game_copy op update (listed in a copy)",
};

/** What a call naming a retired op answers, in at most 300 characters; null for a live op. */
export const retiredOp = (tool: string, op: string) => {
  const now = RETIRED_GAME_OPS[`${tool}.${op}`];
  return now === undefined ? null : { refused: `${tool} op ${op} is gone.`, next: `${now}.` };
};
