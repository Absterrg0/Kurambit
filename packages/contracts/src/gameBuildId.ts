import * as Schema from "effect/Schema";

/**
 * A build: a playable version of the game the person and the agent can list,
 * play, compare and go back to. Every turn that changed the game is one (its
 * T3 checkpoint), and so is every run round and saved build. The id is the
 * build's commit oid; the UI treats it as opaque.
 */
export const GameBuildId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
).pipe(Schema.brand("GameBuildId"));
export type GameBuildId = typeof GameBuildId.Type;
