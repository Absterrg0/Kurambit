import * as Schema from "effect/Schema";
import { GameBlenderLookScreenshot } from "./gameBlender.ts";
import { GameLibraryPackId } from "./gameLibraryPackId.ts";
import { GameStyleLock } from "./gameStyle.ts";

export { GameLibraryPackId } from "./gameLibraryPackId.ts";

/** The pinned open asset library behind game_assets_search and game_assets_add. */
export const GameLibraryKind = Schema.Literals([
  "sprite",
  "tile",
  "character",
  "model",
  "animation",
  "texture",
  "hdri",
  "ui",
  "icon",
  "font",
  "sfx",
  "music",
]);
export type GameLibraryKind = typeof GameLibraryKind.Type;

const packPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const GameAssetsSearchInput = Schema.Struct({
  /** Words matched against pack titles, styles and tags, or file paths inside one pack. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  kind: Schema.optionalKey(GameLibraryKind),
  /** Only entries of this style family (the browse lists them). */
  family: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  /** Only entries with models that carry clips of their own. */
  animated: Schema.optionalKey(Schema.Boolean),
  /** cc0: only public-domain entries; any (the default) also lists those that ask for credit. */
  licence: Schema.optionalKey(Schema.Literals(["cc0", "any"])),
  /** Look inside this pack: it is fetched once, and matching files come with a contact sheet. */
  pack: Schema.optionalKey(GameLibraryPackId),
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
  pack: GameLibraryPackId,
  /** Pack-relative files or folders, as game_assets_search lists them. */
  paths: Schema.Array(packPath).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /**
   * Lock the game's look to a style family before these files come in: writes STYLE.json
   * (packs, rig, mode and palette from the family), keeping what else a lock there holds.
   */
  lock: Schema.optionalKey(GameStyleLock),
});
export type GameAssetsAddInput = typeof GameAssetsAddInput.Type;

export const GameAssetsAddResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative directory the pack's files were copied under. */
  directory: Schema.String,
  added: Schema.Int,
});
export type GameAssetsAddResult = typeof GameAssetsAddResult.Type;
