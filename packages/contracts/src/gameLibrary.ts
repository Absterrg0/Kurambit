import * as Schema from "effect/Schema";
import { GameBlenderLookScreenshot } from "./gameBlender.ts";
import { GameLibraryPackId } from "./gameLibraryPackId.ts";
import { GameStyleLock } from "./gameStyle.ts";

export { GameLibraryPackId } from "./gameLibraryPackId.ts";

/** The pinned open asset library behind game_assets op search and game_assets op add. */
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
  /** Pack-relative files or folders, as game_assets op search lists them. */
  paths: Schema.Array(packPath).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /**
   * Record the game's look as a style family before these files come in: writes STYLE.json
   * (packs, rig, mode and palette from the family), keeping what else one there holds.
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

/**
 * game_assets op pictures: a template the agent wrote (HTML and CSS, or SVG) drawn once per row of
 * data in the server's headless browser, with no network, into texture sheets under the game's
 * assets with a .sheet.json map; `frames` draws each row as an animation.
 */
export const GamePicturesInput = Schema.Struct({
  /** Sheet name: <assets>/sheets/<output>.sheet.json. */
  output: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  /** Inline HTML or SVG, or a game path to one; {{key}} is the row's value, window.row the row. */
  template: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  /** One picture (or animation) per row; `name` names its frame. */
  rows: Schema.Array(
    Schema.Record(Schema.String, Schema.Unknown).check(
      Schema.makeFilter((row) =>
        typeof row.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(row.name)
          ? undefined
          : "each row needs a name: letters, digits, _ . -",
      ),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  /** Pixels wide and tall. */
  size: Schema.Tuple([
    Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 2048 })),
    Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 2048 })),
  ]),
  /** Frames per row, drawn at time i / fps (CSS and SVG animations, window.frame(t, i)). */
  frames: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  fps: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
  loop: Schema.optionalKey(Schema.Boolean),
  /** The point placed at the object's origin, 0..1 from the left and the bottom. Default centre. */
  pivot: Schema.optionalKey(
    Schema.Tuple([
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    ]),
  ),
});
export type GamePicturesInput = typeof GamePicturesInput.Type;
export const GamePicturesResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative .sheet.json. */
  sheet: Schema.String,
  images: Schema.Array(Schema.String),
  /** Game-relative contact sheet of every picture; attached as the image. */
  contactSheet: Schema.String,
  screenshot: Schema.optionalKey(GameBlenderLookScreenshot),
});
export type GamePicturesResult = typeof GamePicturesResult.Type;
