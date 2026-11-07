import * as Schema from "effect/Schema";

// A module of its own so gameBlender.ts can name it without importing gameLibrary.ts,
// which imports gameBlender.ts.
/** A library pack's id, as game_assets_search lists it. */
export const GameLibraryPackId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,63}$/));
