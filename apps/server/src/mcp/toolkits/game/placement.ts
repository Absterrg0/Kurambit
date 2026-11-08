// Which game tools a thread's agent is offered. Each tool says what it needs
// of its game's engine and when it belongs; the thread's game, engine,
// character route and Blender come from the MCP invocation (McpHttpServer's
// auth middleware). A tool the listing hides is also refused when called by
// name, by Effect's MCP core.
import { ACTIVE_GAME_ENGINES, type GameCharacterRoute } from "@kurambit/contracts";
import {
  engineCapabilities,
  engineProfile,
  type GameEngineCapability,
} from "../../../game/engineProfile.ts";
import { currentInvocation, type McpInvocationScope } from "../../McpInvocationContext.ts";

export interface GameToolPlacement {
  /** What the tool needs of the game's engine; empty for a tool any game's agent may use. */
  readonly needs: ReadonlyArray<GameEngineCapability>;
  /**
   * chat: a game's chats, keep going's steps among them (they are chat
   * turns). run: a production run's role threads. both.
   */
  readonly moment: "chat" | "run" | "both";
  /**
   * In a chat, listed only when asked for: the tool stays reachable through
   * game_more, whose description names it with this line, said as when to use it.
   */
  readonly asked?: string;
}

const chat = (needs: ReadonlyArray<GameEngineCapability>, asked?: string): GameToolPlacement =>
  asked === undefined ? { needs, moment: "chat" } : { needs, moment: "chat", asked };
const both = (needs: ReadonlyArray<GameEngineCapability>, asked?: string): GameToolPlacement =>
  asked === undefined ? { needs, moment: "both" } : { needs, moment: "both", asked };

export const GAME_TOOL_PLACEMENTS = {
  game_status: both([]),
  game_check: both(["play"]),
  game_import: both(["import"]),
  game_export: both(["play"]),
  game_builds: chat([]),
  game_facts: chat(["play"]),
  game_build_restore: chat([], "when the person asks to undo a change or go back to a build"),
  game_tune: chat(["tune"], "when the person asks to keep the values they tried on the Stage"),
  game_preview: chat(["play"], "when the person asks for a playable URL or player of the sources"),
  game_stop: chat(["play"], "when the person asks to stop the game's processes"),
  game_package_web: chat(["packageWeb"], "when the person asks for a downloadable Web ZIP"),
  game_package_windows: chat(
    ["packageWindows"],
    "when the person asks for a downloadable Windows ZIP",
  ),
  game_media_save: chat([], "when the person asks to keep a video or image Kurambit made"),
  game_saved_list: chat([], "when the person asks what is saved"),
  game_saved_delete: chat([], "when the person asks to delete a saved file"),
  game_keep_going: chat(["turnLoop"], "when the person asks to turn Keep going on or off"),
  game_keep_going_status: chat(["turnLoop"], "when the person asks what Keep going is doing"),
  game_keep_going_steer: chat(
    ["turnLoop"],
    "when the person asks to give Keep going's next step their words",
  ),
  game_explore_start: both(
    ["play"],
    "when the person asks you to play it, or a fact names something the code cannot show",
  ),
  game_explore_act: both(["play"], "in a session game_explore_start opened"),
  game_explore_close: both(["play"], "to end that session"),
  game_bot_run: both(["play"], "when the person asks for a bot to play the game"),
  game_bot_view: both(["play"], "to look at a finished bot run"),
  game_bot_report: both(["play"], "to rebuild the player report across bot runs"),
  game_generate: both(["play"]),
  game_generate_wait: both(["play"]),
  // Listed: agents asked to change an image must find it by name (see game_generate).
  game_image_edit: both(["play"]),
  game_assets_search: both(["play"]),
  game_assets_add: both(["play"]),
  game_blender_code: both(["blender"]),
  game_blender_look: both(["blender"]),
  game_blender_scene: both(["blender"]),
  game_blender_export: both(["blender"]),
  game_blender_character: both(["blender"]),
  game_blender_paint: both(["blender"], "to paint a model from its turnaround sheet"),
  game_blender_carve: both(["blender"], "for an organic hard prop carved from a three-view sheet"),
  game_blender_assets_search: both(
    ["blender"],
    "for a Poly Haven, Sketchfab or Poly Pizza asset the CC0 library lacks",
  ),
  game_blender_assets_import: both(["blender"]),
  game_blender_render_sprites: both(["blender"]),
  game_animate: both(["blender"]),
  game_unity_tools: both(["unity"]),
  game_unity_edit: both(["unity"]),
  game_unity_eval: both(["unity"]),
  game_unity_recompile: both(["unity"]),
  game_unity_play: both(["unity"]),
  game_unity_console: both(["unity"]),
  game_unity_screenshot: both(["unity"]),
  game_more: chat([]),
} satisfies Record<`game_${string}`, GameToolPlacement>;
export type GameToolName = keyof typeof GAME_TOOL_PLACEMENTS;

const inMoment = (placement: GameToolPlacement, scope: McpInvocationScope) =>
  scope.gameRunRole === "run" ? placement.moment !== "chat" : placement.moment !== "run";

/** Why the calling thread's game, moment or machine refuses the tool, or null when it may use it. */
export const refusal = (
  placement: GameToolPlacement,
  scope: McpInvocationScope | undefined,
): string | null => {
  const engine = scope?.gameEngine;
  if (scope === undefined || engine == null) return "it works in no game";
  if (!inMoment(placement, scope)) return "it is not for this thread";
  const capabilities = engineCapabilities(engine);
  if (!placement.needs.every((need) => capabilities.has(need)))
    return `this ${engineProfile(engine).displayName} game's engine does not support it`;
  if (placement.needs.includes("blender") && scope.blenderMissing != null)
    return `it runs in Blender, which Kurambit cannot use on this machine. ${scope.blenderMissing}`;
  return null;
};

/** Whether the calling thread's game, moment and machine allow the tool at all. */
export const fits = (placement: GameToolPlacement, scope: McpInvocationScope | undefined) =>
  refusal(placement, scope) === null;

/**
 * Routes whose characters go through Blender: built there, or generated and conformed to the
 * standard skeleton there. On the library route a chat asks for the Blender tools first.
 */
const BLENDER_ROUTES: ReadonlySet<GameCharacterRoute> = new Set(["blender", "generated"]);
const BLENDER_ASKED =
  "when the person asks for a model, sprite render or animation made in Blender rather than taken from the library";

/** In a chat, the line game_more names it with, or undefined when it is listed. */
const askedIn = (placement: GameToolPlacement, scope: McpInvocationScope | undefined) =>
  placement.asked ??
  (placement.needs.includes("blender") && !BLENDER_ROUTES.has(scope?.gameCharacters ?? "library")
    ? BLENDER_ASKED
    : undefined);

/** Whether it is in the listing: it fits, and a chat asks for it first when it waits to be asked. */
export const listed = (placement: GameToolPlacement, scope: McpInvocationScope | undefined) =>
  fits(placement, scope) &&
  (scope?.gameRunRole === "run" || askedIn(placement, scope) === undefined);

/** The `McpSchema.EnabledWhen` of a game tool: listed for the calling thread now. */
export const listedFor = (name: GameToolName) => () =>
  listed(GAME_TOOL_PLACEMENTS[name], currentInvocation());

/**
 * The tools game_more can reach for a chat on some active engine, with when to use each:
 * those always asked for, and the Blender tools on a route that makes no characters there.
 */
export const ASKABLE_TOOLS: ReadonlyArray<readonly [GameToolName, string]> = (
  Object.entries(GAME_TOOL_PLACEMENTS) as Array<[GameToolName, GameToolPlacement]>
).flatMap(([name, placement]) => {
  const asked = askedIn(placement, undefined);
  return asked !== undefined &&
    placement.moment !== "run" &&
    ACTIVE_GAME_ENGINES.some((engine) =>
      placement.needs.every((need) => engineCapabilities(engine).has(need)),
    )
    ? [[name, asked] as const]
    : [];
});
