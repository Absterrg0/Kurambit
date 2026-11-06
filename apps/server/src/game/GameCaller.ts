import * as Context from "effect/Context";

/**
 * Who is calling a game operation: a coding agent through the game MCP tools
 * (and whether it is a production run's own role), or a person through the
 * client. A write's admission trusts this, never the thread being viewed, so a
 * person looking at a role's chat does not act as that role. Unprovided, a
 * call is the client's.
 */
export type GameCallerValue =
  | { readonly kind: "agent"; readonly runRole: boolean }
  | { readonly kind: "client" };

export class GameCaller extends Context.Reference<GameCallerValue>("kurambit/game/GameCaller", {
  defaultValue: (): GameCallerValue => ({ kind: "client" }),
}) {}
