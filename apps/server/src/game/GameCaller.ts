import * as Context from "effect/Context";

/**
 * Who is calling a game operation: a coding agent through the game MCP tools,
 * or a person through the client. Unprovided, a call is the client's.
 */
export type GameCallerValue = { readonly kind: "agent" } | { readonly kind: "client" };

export class GameCaller extends Context.Reference<GameCallerValue>("kurambit/game/GameCaller", {
  defaultValue: (): GameCallerValue => ({ kind: "client" }),
}) {}
