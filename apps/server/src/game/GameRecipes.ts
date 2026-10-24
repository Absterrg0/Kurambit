import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DEFAULT_GAME_RECIPE_ENGINE,
  GAME_RECIPE_PAGE_SIZE,
  type GameRecipeCatalogEntry,
  type GameRecipeGetInput,
  type GameRecipeGetResult,
  type GameRecipeSearchInput,
  type GameRecipeSearchResult,
  type GameRecipeSummary,
} from "@t3tools/contracts";
import { gameRecipeCatalog } from "./recipeCatalog.ts";

const listOrNone = (values: ReadonlyArray<string>): string =>
  values.length === 0 ? "none" : values.join(", ");

export class GameRecipeUnknownIdError extends Schema.TaggedError<GameRecipeUnknownIdError>()(
  "GameRecipeUnknownIdError",
  {
    id: Schema.String,
    availableIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No recipe with id '${this.id}'. Available ids: ${listOrNone(this.availableIds)}.`;
  }
}

export class GameRecipeUnsupportedEngineError extends Schema.TaggedError<GameRecipeUnsupportedEngineError>()(
  "GameRecipeUnsupportedEngineError",
  {
    id: Schema.String,
    engine: Schema.String,
    availableEngines: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Recipe '${this.id}' has no adapter for engine '${this.engine}'. Available engines: ${listOrNone(this.availableEngines)}.`;
  }
}

export class GameRecipeInvalidCursorError extends Schema.TaggedError<GameRecipeInvalidCursorError>()(
  "GameRecipeInvalidCursorError",
  { cursor: Schema.String },
) {
  override get message(): string {
    return `Invalid recipe cursor '${this.cursor}'. Pass the nextCursor value from a previous search, or omit cursor to start at the first page.`;
  }
}

/**
 * Retrieval is a closed vocabulary lookup. It never reads a brief, game source,
 * critic prose, or the filesystem: the injected catalog is its whole world, so
 * a search cannot start an agent, build, export, or model call.
 */
export class GameRecipes extends Context.Service<
  GameRecipes,
  {
    readonly search: (
      input: GameRecipeSearchInput,
    ) => Effect.Effect<GameRecipeSearchResult, GameRecipeInvalidCursorError>;
    readonly get: (
      input: GameRecipeGetInput,
    ) => Effect.Effect<
      GameRecipeGetResult,
      GameRecipeUnknownIdError | GameRecipeUnsupportedEngineError
    >;
  }
>()("t3/game/GameRecipes") {}

const CURSOR_PATTERN = /^(0|[1-9]\d*)$/;

const fold = (value: string): string => value.trim().toLowerCase();

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const hasTerm = (term: string | undefined): term is string =>
  term !== undefined && term.trim() !== "";

const uniqueTags = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = fold(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const enginesOf = (entry: GameRecipeCatalogEntry): ReadonlyArray<string> =>
  [...new Set(entry.adapters.map((adapter) => adapter.engine))].sort(compareIds);

/**
 * A filter term must equal one authored tag (or alias) in its own field, so an
 * unknown word matches nothing instead of guessing related recipes.
 */
const matchingTags = (
  term: string,
  groups: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const wanted = fold(term);
  return groups.flatMap((values) => values.filter((value) => fold(value) === wanted));
};

const matchingAliases = (aliases: ReadonlyArray<string>, text: string): ReadonlyArray<string> => {
  const wanted = fold(text);
  return aliases.filter((alias) => fold(alias).includes(wanted));
};

interface RankedRecipe {
  readonly entry: GameRecipeCatalogEntry;
  readonly score: number;
  readonly matchingTags: ReadonlyArray<string>;
}

/**
 * Each provided field the recipe matched adds one to the score; ties fall back
 * to the id so the same query always returns the same page order. Fields union:
 * a recipe that matches fewer filters can still surface below the best matches.
 */
const rankRecipe = (
  entry: GameRecipeCatalogEntry,
  input: GameRecipeSearchInput,
): RankedRecipe | null => {
  const { recipe } = entry;
  const filters = [
    { term: input.genre, groups: [recipe.genres, recipe.aliases] },
    { term: input.mechanic, groups: [recipe.mechanics, recipe.aliases] },
    { term: input.defect, groups: [recipe.defects, recipe.aliases] },
  ];
  const browsing = filters.every((filter) => !hasTerm(filter.term)) && !hasTerm(input.text);
  let score = 0;
  const tags: string[] = [];
  for (const filter of filters) {
    if (!hasTerm(filter.term)) continue;
    const found = matchingTags(filter.term, filter.groups);
    if (found.length === 0) continue;
    score += 1;
    tags.push(...found);
  }
  if (hasTerm(input.text)) {
    const found = matchingAliases(recipe.aliases, input.text);
    if (found.length > 0) {
      score += 1;
      tags.push(...found);
    }
  }
  if (!browsing && score === 0) return null;
  return { entry, score, matchingTags: uniqueTags(tags) };
};

const summarize = (ranked: RankedRecipe): GameRecipeSummary => ({
  id: ranked.entry.recipe.id,
  title: ranked.entry.recipe.title,
  matchingTags: ranked.matchingTags,
  engines: enginesOf(ranked.entry),
});

export const make = (catalog: ReadonlyArray<GameRecipeCatalogEntry>): GameRecipes["Service"] => {
  const entries = [...catalog].sort((left, right) => compareIds(left.recipe.id, right.recipe.id));
  const byId = new Map(entries.map((entry) => [entry.recipe.id, entry]));
  const availableIds = entries.map((entry) => entry.recipe.id);

  const search: GameRecipes["Service"]["search"] = Effect.fn("GameRecipes.search")(
    function* (input) {
      // `query` is the same literal alias filter as `text`; the input contract
      // refuses two different values, so either one names the whole text filter.
      const terms: GameRecipeSearchInput =
        input.text === undefined && input.query !== undefined
          ? { ...input, text: input.query }
          : input;
      let offset = 0;
      if (input.cursor !== undefined) {
        if (!CURSOR_PATTERN.test(input.cursor)) {
          return yield* new GameRecipeInvalidCursorError({ cursor: input.cursor });
        }
        const parsed = Number(input.cursor);
        if (!Number.isSafeInteger(parsed)) {
          return yield* new GameRecipeInvalidCursorError({ cursor: input.cursor });
        }
        offset = parsed;
      }

      const ranked = entries
        .map((entry) => rankRecipe(entry, terms))
        .filter((ranked): ranked is RankedRecipe => ranked !== null)
        .sort(
          (left, right) =>
            right.score - left.score || compareIds(left.entry.recipe.id, right.entry.recipe.id),
        );
      const page = ranked.slice(offset, offset + GAME_RECIPE_PAGE_SIZE);
      const nextOffset = offset + page.length;
      return {
        recipes: page.map(summarize),
        nextCursor: nextOffset < ranked.length ? String(nextOffset) : null,
      };
    },
  );

  const get: GameRecipes["Service"]["get"] = Effect.fn("GameRecipes.get")(function* (input) {
    const entry = byId.get(input.id);
    if (entry === undefined) {
      return yield* new GameRecipeUnknownIdError({
        id: input.id,
        availableIds,
      });
    }
    const engine = input.engine ?? DEFAULT_GAME_RECIPE_ENGINE;
    const adapter = entry.adapters.find((candidate) => candidate.engine === engine);
    if (adapter === undefined) {
      return yield* new GameRecipeUnsupportedEngineError({
        id: input.id,
        engine,
        availableEngines: enginesOf(entry),
      });
    }
    return {
      recipe: entry.recipe,
      engine,
      adapter: input.includeReference === false ? null : adapter,
    };
  });

  return GameRecipes.of({ search, get });
};

export const layer = Layer.succeed(GameRecipes, make(gameRecipeCatalog));
