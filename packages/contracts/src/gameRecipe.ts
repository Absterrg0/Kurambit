import * as Schema from "effect/Schema";

import { GAME_TRY_INPUT_BOUNDS, GamePlaytestStep } from "./game.ts";

/**
 * A recipe id names a mechanism, never a game, asset, or engine node. The
 * two-part shape keeps the catalog readable in search results and logs.
 */
export const GameRecipeId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
);
export type GameRecipeId = typeof GameRecipeId.Type;

/**
 * Engines stay open so a later adapter adds a variant without changing the
 * search contract, the get contract, or the recipe metadata. The catalog
 * decides which engines actually exist.
 */
export const GameRecipeEngine = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));
export type GameRecipeEngine = typeof GameRecipeEngine.Type;

/** Godot is the first engine, so `get` uses it when the caller names none. */
export const DEFAULT_GAME_RECIPE_ENGINE: GameRecipeEngine = "godot";

/** The first catalog distinguishes original writing from adapted third-party work. */
export const GameRecipeSourceKind = Schema.Literals(["write-original", "adapted"]);
export type GameRecipeSourceKind = typeof GameRecipeSourceKind.Type;

export const GameRecipeSource = Schema.Struct({
  kind: GameRecipeSourceKind,
  license: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  /** The local evidence or standard technique the entry was written from. */
  reference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});
export type GameRecipeSource = typeof GameRecipeSource.Type;

const recipeText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));

/**
 * Engine-neutral metadata. Tags are authored explicitly; retrieval only compares
 * them, so nothing here may describe a Godot node, property, or path.
 */
export const GameRecipe = Schema.Struct({
  id: GameRecipeId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  title: recipeText(120),
  genres: Schema.Array(recipeText(48)),
  mechanics: Schema.Array(recipeText(48)),
  defects: Schema.Array(recipeText(48)),
  aliases: Schema.Array(recipeText(120)),
  intent: recipeText(400),
  why: recipeText(700),
  failure: recipeText(700),
  restyle: recipeText(700),
  verificationQuestion: recipeText(400),
  source: GameRecipeSource,
});
export type GameRecipe = typeof GameRecipe.Type;

/**
 * The input route a reference expects on a fresh boot, in the same vocabulary
 * `game_try_input` already accepts so the model can run it unchanged.
 */
export const GameRecipeTryInput = Schema.Struct({
  steps: Schema.Array(GamePlaytestStep).check(Schema.isMaxLength(GAME_TRY_INPUT_BOUNDS.maxSteps)),
  captureEveryMs: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(GAME_TRY_INPUT_BOUNDS.minCaptureEveryMs)),
  ),
});
export type GameRecipeTryInput = typeof GameRecipeTryInput.Type;

/**
 * One engine's complete, self-contained illustration of a mechanism. `setup`
 * carries both the first boot and the reset back to a clean run.
 */
export const GameRecipeAdapter = Schema.Struct({
  engine: GameRecipeEngine,
  engineVersion: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  setup: recipeText(2_000),
  referenceCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  tryInput: GameRecipeTryInput,
});
export type GameRecipeAdapter = typeof GameRecipeAdapter.Type;

/** A catalog entry keeps engine code out of the metadata module. */
export const GameRecipeCatalogEntry = Schema.Struct({
  recipe: GameRecipe,
  adapters: Schema.Array(GameRecipeAdapter),
});
export type GameRecipeCatalogEntry = typeof GameRecipeCatalogEntry.Type;

/** Search returns a page small enough to stay a hint, not a catalog dump. */
export const GAME_RECIPE_PAGE_SIZE = 5;

const recipeSearchText = recipeText(200);
const foldSearchText = (value: string): string => value.trim().toLowerCase();

export const GameRecipeSearchInput = Schema.Struct({
  genre: Schema.optionalKey(recipeText(48)),
  mechanic: Schema.optionalKey(recipeText(48)),
  defect: Schema.optionalKey(recipeText(48)),
  /** Ranked token lookup over catalog text, with bounded explicit negation; never reads game files. */
  text: Schema.optionalKey(recipeSearchText),
  /**
   * An accepted synonym for text because callers reach for `query`; it ranks
   * the same token overlap and never becomes a browse or a semantic search.
   */
  query: Schema.optionalKey(recipeSearchText),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
}).check(
  Schema.makeFilter(
    (input) =>
      input.text === undefined ||
      input.query === undefined ||
      foldSearchText(input.text) === foldSearchText(input.query) ||
      "Pass text or query for one recipe search, not two different values.",
  ),
);
export type GameRecipeSearchInput = typeof GameRecipeSearchInput.Type;

export const GameRecipeSummary = Schema.Struct({
  id: GameRecipeId,
  title: recipeText(120),
  /** The authored tags or aliases this query matched; empty when browsing. */
  matchingTags: Schema.Array(recipeText(120)),
  /** Engines that ship a runnable variant for this recipe. */
  engines: Schema.Array(GameRecipeEngine),
});
export type GameRecipeSummary = typeof GameRecipeSummary.Type;

export const GameRecipeSearchResult = Schema.Struct({
  recipes: Schema.Array(GameRecipeSummary),
  /** Pass back verbatim for the next page; null when this page is the last. */
  nextCursor: Schema.NullOr(Schema.String),
});
export type GameRecipeSearchResult = typeof GameRecipeSearchResult.Type;

export const GameRecipeGetInput = Schema.Struct({
  id: GameRecipeId,
  engine: Schema.optionalKey(GameRecipeEngine),
  /** false returns the guidance only; omitting it returns the complete variant. */
  includeReference: Schema.optionalKey(Schema.Boolean),
});
export type GameRecipeGetInput = typeof GameRecipeGetInput.Type;

export const GameRecipeGetResult = Schema.Struct({
  recipe: GameRecipe,
  engine: GameRecipeEngine,
  /** null when the caller asked for guidance only. */
  adapter: Schema.NullOr(GameRecipeAdapter),
});
export type GameRecipeGetResult = typeof GameRecipeGetResult.Type;
