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

/**
 * Small closed stopwords for free-text queries. A query that names only these
 * matches nothing instead of returning the whole catalog as "related".
 */
const RECIPE_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "with",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "is",
  "are",
  "be",
  "as",
  "by",
  "from",
  "that",
  "this",
  "it",
  "its",
  "into",
  "over",
  "under",
  "my",
  "our",
  "your",
  "how",
  "what",
  "when",
  "make",
  "need",
  "want",
  "game",
  // Negation operators never score on their own: "without", "no" and "not"
  // name the exclusion (handled below), they do not describe a mechanism.
  // A query of only these still matches nothing, never browses.
  "without",
  "no",
  "not",
  "never",
  "none",
]);

const singularizeRecipeToken = (token: string): string => {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
};

/**
 * Bounded verb-form recall without a semantic parser: the haystack also
 * carries the naive "doing" and "did" spellings of each catalog word, so
 * "jumping" reaches "jump" and "pressed" reaches "press". Only plain
 * suffixing is generated ("press" -> "pressing"); e-drop ("ride" ->
 * "riding") and doubled-consonant ("hit" -> "hitting") forms are not, so an
 * unrelated query can still match nothing. Query tokens are never expanded,
 * so long-standing matched-tag reports keep working.
 */
const haystackForms = (token: string): ReadonlyArray<string> =>
  token.length >= 4 ? [token, `${token}ing`, `${token}ed`] : [token];

const splitRecipeTokens = (value: string): ReadonlyArray<string> =>
  fold(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
    .map(singularizeRecipeToken);

/** Meaningful query tokens: split, singularize, drop stopwords. Empty means no text filter. */
const queryTextTokens = (text: string): ReadonlyArray<string> => {
  const seen = new Set<string>();
  for (const token of splitRecipeTokens(text)) {
    if (RECIPE_STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
};

/**
 * Explicit negated technique words, bounded and honest: only "without X",
 * "with no X", "no X", "not X" or "never X" with the single following word,
 * matched literally against catalog vocabulary. A two-word technique is
 * caught through its first word ("without camera shake" negates "camera",
 * which the shake recipe names). Scope, double negation and paraphrase
 * ("steady camera" for "without shake") are not understood: a negated word
 * with no catalog match excludes nothing, and exclusion is deliberately
 * broad — any recipe mentioning the negated word is filtered, even when the
 * word is only one of its aliases.
 */
const NEGATION_PATTERN = /\b(?:without(?:\s+any)?|with\s+no|no|not|never)\s+([a-z][a-z0-9-]*)/g;

const negatedQueryTokens = (text: string): ReadonlySet<string> => {
  const negated = new Set<string>();
  NEGATION_PATTERN.lastIndex = 0;
  for (let match = NEGATION_PATTERN.exec(fold(text)); match !== null;) {
    for (const token of splitRecipeTokens(match[1]!)) {
      if (RECIPE_STOPWORDS.has(token)) continue;
      negated.add(token);
    }
    match = NEGATION_PATTERN.exec(fold(text));
  }
  return negated;
};

const haystackTokens = (entry: GameRecipeCatalogEntry): ReadonlySet<string> =>
  new Set(
    [
      entry.recipe.title,
      ...entry.recipe.genres,
      ...entry.recipe.mechanics,
      ...entry.recipe.defects,
      ...entry.recipe.aliases,
      entry.recipe.intent,
      // Deliberately not the why/failure/restyle/verification narratives:
      // story prose ("feel like", "jumps nodes", "does the character jump",
      // "and sound") outranks the true mechanism or breaks exact lookups.
      // get(includeReference:false) already serves that guidance verbatim.
    ].flatMap((value) => splitRecipeTokens(value).flatMap(haystackForms)),
  );

/**
 * The authored tags or aliases a text query matched, for the summary. A tag
 * matches when one of its own tokens equals a query token, so a full sentence
 * still reports the concrete vocabulary ("jump", "coyote time") it hit.
 */
const matchingTextTags = (
  recipe: GameRecipeCatalogEntry["recipe"],
  tokens: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const wanted = new Set(tokens);
  const tags = [...recipe.genres, ...recipe.mechanics, ...recipe.defects, ...recipe.aliases];
  return uniqueTags(
    tags.filter((tag) => splitRecipeTokens(tag).some((token) => wanted.has(token))),
  );
};

interface RankedRecipe {
  readonly entry: GameRecipeCatalogEntry;
  readonly score: number;
  readonly matchingTags: ReadonlyArray<string>;
}

/**
 * Structured fields stay exact closed-vocabulary filters; free text is a
 * ranked token overlap over titles, tags, aliases and intent, plus naive
 * verb-form variants of those same words. Each structured field
 * the recipe matched adds one to the score and each distinct query token it
 * contains adds one more; ties fall back to the id so the same query always
 * returns the same page order. Fields union: a recipe that matches fewer
 * filters can still surface below the best matches. Explicit negated technique
 * words ("without shake", "no jumping") filter out any recipe mentioning
 * them, before pagination; structured filters, union and pagination are
 * unchanged, and unknown or paraphrased negations exclude nothing. A text
 * query with no meaningful tokens (empty or stopwords only) matches nothing,
 * never browses.
 */
const rankRecipe = (
  entry: GameRecipeCatalogEntry,
  input: GameRecipeSearchInput,
  negated?: ReadonlySet<string>,
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
    const tokens = queryTextTokens(input.text);
    if (tokens.length === 0) {
      if (!browsing && score === 0) return null;
    } else {
      const haystack = haystackTokens(entry);
      if (negated !== undefined) {
        for (const token of negated) {
          if (haystack.has(token)) return null;
        }
      }
      const matched = tokens.filter((token) => haystack.has(token));
      if (matched.length === 0) {
        if (!browsing && score === 0) return null;
      } else {
        score += matched.length;
        tags.push(...matchingTextTags(recipe, matched));
      }
    }
    if (!browsing && score === 0) return null;
    return { entry, score, matchingTags: uniqueTags(tags) };
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
        .map((entry) =>
          rankRecipe(
            entry,
            terms,
            hasTerm(terms.text) ? negatedQueryTokens(terms.text!) : undefined,
          ),
        )
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
