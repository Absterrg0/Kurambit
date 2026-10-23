import type { GameRecipeCatalogEntry } from "@t3tools/contracts";

/**
 * The shipped recipes. Search and get serve exactly this data, never a
 * filesystem path or anything found in a game.
 */
export const gameRecipeCatalog: ReadonlyArray<GameRecipeCatalogEntry> = [];
