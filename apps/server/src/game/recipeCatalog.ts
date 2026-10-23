import type { GameRecipeCatalogEntry } from "@t3tools/contracts";
import { godotRecipeAdapters } from "./recipes/godot/index.ts";
import { gameRecipeMetadata } from "./recipes/metadata.ts";

/**
 * The shipped recipes. Search and get serve exactly this data, never a
 * filesystem path or anything found in a game. A recipe without an adapter is a
 * catalog bug: fail at load instead of serving guidance that cannot run.
 */
export const gameRecipeCatalog: ReadonlyArray<GameRecipeCatalogEntry> = gameRecipeMetadata.map(
  (recipe) => {
    const adapter = godotRecipeAdapters.get(recipe.id);
    if (adapter === undefined)
      throw new Error(`Recipe '${recipe.id}' has no Godot adapter in the catalog.`);
    return { recipe, adapters: [adapter] };
  },
);
