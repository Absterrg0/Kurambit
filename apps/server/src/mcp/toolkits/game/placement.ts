// Which game tools a thread's agent is offered, and which of their ops its game can run. A tool is
// listed from a game thread's first turn whenever its game runs any of its ops: its engine, and for
// Blender the person's model choice. A missing Blender never changes the listing; an op the game
// or machine cannot run is refused when called, with why. The thread's game, engine, model choice
// and Blender come from the MCP invocation (McpHttpServer's auth middleware). A tool the listing
// hides is also refused when called by name, by Effect's MCP core.
import { GAME_ENGINES } from "@kurambit/contracts";
import { engineCapabilities, type GameEngineCapability } from "../../../game/engineProfile.ts";
import { currentInvocation, type McpInvocationScope } from "../../McpInvocationContext.ts";

/** Each op, by tool, with what it needs of the game's engine (empty: any game). */
export const GAME_TOOL_OPS = {
  game_check: { look: ["play"], final: ["play"] },
  game_play: {
    act: ["play"],
    close: ["play"],
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
    return `this ${GAME_ENGINES[engine].name} game's engine does not support it`;
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
