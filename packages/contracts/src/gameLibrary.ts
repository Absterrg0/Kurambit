import * as Schema from "effect/Schema";
import { GameBlenderLookScreenshot } from "./gameBlender.ts";

/** The pinned CC0 asset library behind game_assets_search and game_assets_add. */
export const GameLibraryKind = Schema.Literals([
  "sprite",
  "tile",
  "character",
  "model",
  "animation",
  "texture",
  "ui",
  "icon",
  "font",
  "sfx",
  "music",
]);
export type GameLibraryKind = typeof GameLibraryKind.Type;

const packId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,63}$/));
const packPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const GameAssetsSearchInput = Schema.Struct({
  /** Words matched against pack titles, styles and tags, or file paths inside one pack. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  kind: Schema.optionalKey(GameLibraryKind),
  /** Look inside this pack: it is fetched once, and matching files come with a contact sheet. */
  pack: Schema.optionalKey(packId),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(24)),
  ),
  /** Inside a pack: skip this many matching files, to page through a long list. */
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100_000)),
  ),
});
export type GameAssetsSearchInput = typeof GameAssetsSearchInput.Type;

export const GameAssetsSearchResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative contact sheet PNG, also attached as the image. */
  sheet: Schema.optionalKey(Schema.String),
  screenshot: Schema.optionalKey(GameBlenderLookScreenshot),
});
export type GameAssetsSearchResult = typeof GameAssetsSearchResult.Type;

export const GameAssetsAddInput = Schema.Struct({
  pack: packId,
  /** Pack-relative files or folders, as game_assets_search lists them. */
  paths: Schema.Array(packPath).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type GameAssetsAddInput = typeof GameAssetsAddInput.Type;

export const GameAssetsAddResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative directory the pack's files were copied under. */
  directory: Schema.String,
  added: Schema.Int,
});
export type GameAssetsAddResult = typeof GameAssetsAddResult.Type;
