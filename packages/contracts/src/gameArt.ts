import * as Schema from "effect/Schema";

/**
 * A kit id names one shipped art kit, never a path or a pack format. The
 * catalog owns the id, so an agent cannot ask the server to copy an arbitrary
 * directory.
 */
export const GameArtKitId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(80),
);
export type GameArtKitId = typeof GameArtKitId.Type;

const artText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));
const artHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const artHexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

/**
 * The shared look one game's assets are built against. It is a small,
 * optional convention, not a mandatory style schema: legacy games and games
 * whose brief needs no palette work without one. `game_blender_run` applies
 * the profile when it exports and warns when an asset drifts from it, so
 * related assets share choices instead of sharing only a prompt.
 */
export const GameArtProfile = Schema.Struct({
  /** Palette roles as hex colours; the exporter ensures a material per entry. */
  palette: Schema.optionalKey(
    Schema.Array(artHexColor).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  /** The height in metres assets should stand at; exports warn past 20% drift. */
  targetHeight: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type GameArtProfile = typeof GameArtProfile.Type;

/** The license the kit is actually distributed under. */
export const GameArtLicense = Schema.Struct({
  name: artText(40),
  url: artText(300),
  /** The author's requested credit line; optional under CC0 but kept here. */
  attribution: artText(200),
});
export type GameArtLicense = typeof GameArtLicense.Type;

/**
 * Where the shipped bytes came from. The archive hash is the identity of the
 * exact download, even if the publisher later replaces a versioned file.
 */
export const GameArtSource = Schema.Struct({
  title: artText(120),
  url: artText(300),
  archiveUrl: artText(300),
  archiveSha256: artHash,
  retrievedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});
export type GameArtSource = typeof GameArtSource.Type;

/**
 * Atlas layout in engine-neutral terms. Rows are counted from the top, cells
 * are row-major, and margin/spacing are pixels, so an engine adapter can turn
 * this into its own tile or atlas resource without guessing.
 */
export const GameArtAtlas = Schema.Struct({
  /** Kit-relative path of the atlas image; also one of the declared files. */
  image: artText(160),
  /** Original pixel dimensions of the atlas image. */
  imageWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  imageHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  tileWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  tileHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  columns: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
  tileCount: Schema.Int.check(Schema.isGreaterThan(0)),
  margin: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  spacing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GameArtAtlas = typeof GameArtAtlas.Type;

/**
 * One authored animation on a sprite sheet: named cells on the sheet grid plus
 * the playback the game uses. Agents build SpriteFrames from these entries
 * with game_art_frames instead of guessing cell positions or frame rates.
 */
export const GameArtAnimation = Schema.Struct({
  /** Animation name used for the SpriteFrames entry. */
  name: artText(40),
  /** Sheet cells in playback order, in grid coordinates. */
  cells: Schema.Array(
    Schema.Struct({
      col: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** Frames per second. */
  fps: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60)),
  /** Whether the animation loops. */
  loop: Schema.Boolean,
});
export type GameArtAnimation = typeof GameArtAnimation.Type;

/**
 * An additional sprite sheet beyond the primary atlas. A platformer kit often
 * separates terrain from characters, and the character sheet has its own cell
 * size and animation frames. `use` carries the authored coordinates a caller
 * needs; `animations` names the playback the sheet was drawn for, so a caller
 * never invents frame ranges.
 */
export const GameArtSheet = Schema.Struct({
  /** Short authored name, unique within a kit. */
  name: artText(40),
  /** Kit-relative path of the sheet image; also one of the declared files. */
  image: artText(160),
  /** How to read this sheet, including named cells and frames. */
  use: artText(700),
  imageWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  imageHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  tileWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  tileHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  columns: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
  tileCount: Schema.Int.check(Schema.isGreaterThan(0)),
  margin: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  spacing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Authored animations on this sheet; absent on sheets with no animation. */
  animations: Schema.optionalKey(Schema.Array(GameArtAnimation)),
});
export type GameArtSheet = typeof GameArtSheet.Type;

export const GameArtKitFileRole = Schema.Literals(["atlas", "sheet", "license", "provenance"]);
export type GameArtKitFileRole = typeof GameArtKitFileRole.Type;

/**
 * One shipped file. Import copies exactly this list, so a catalog bug can never
 * pull a game script, scene or level into the art folder.
 */
export const GameArtKitFile = Schema.Struct({
  /** Kit-relative, flat file name. */
  path: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  role: GameArtKitFileRole,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: artHash,
  width: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type GameArtKitFile = typeof GameArtKitFile.Type;

/**
 * Everything an agent needs to decide whether a kit fits the brief, without
 * reading the game, importing anything or seeing an engine-specific path.
 */
export const GameArtKitSummary = Schema.Struct({
  id: GameArtKitId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: artText(120),
  summary: artText(300),
  styles: Schema.Array(artText(48)),
  contents: Schema.Array(artText(120)),
  license: GameArtLicense,
  source: GameArtSource,
  atlas: GameArtAtlas,
  /** Character or background sheets the kit also ships, beyond the atlas. */
  additionalSheets: Schema.Array(GameArtSheet),
  /** How to read the atlas, without naming an engine resource type. */
  usage: artText(700),
});
export type GameArtKitSummary = typeof GameArtKitSummary.Type;

/** The complete catalog entry, including the exact files import will copy. */
export const GameArtKit = Schema.Struct({
  ...GameArtKitSummary.fields,
  files: Schema.Array(GameArtKitFile),
});
export type GameArtKit = typeof GameArtKit.Type;

export const GameArtSearchInput = Schema.Struct({
  /** Matches an authored style tag exactly, case-folded. */
  style: Schema.optionalKey(artText(48)),
  /** Matches a declared word or phrase literally, case-folded. */
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type GameArtSearchInput = typeof GameArtSearchInput.Type;

export const GameArtSearchResult = Schema.Struct({
  kits: Schema.Array(GameArtKitSummary),
});
export type GameArtSearchResult = typeof GameArtSearchResult.Type;

export const GameArtGetInput = Schema.Struct({ id: GameArtKitId });
export type GameArtGetInput = typeof GameArtGetInput.Type;

export const GameArtGetResult = Schema.Struct({ kit: GameArtKit });
export type GameArtGetResult = typeof GameArtGetResult.Type;

export const GameArtImportInput = Schema.Struct({ id: GameArtKitId });
export type GameArtImportInput = typeof GameArtImportInput.Type;

/** A declared kit file after it was written into the game. */
export const GameArtInstalledFile = Schema.Struct({
  /** Game-relative path, using forward slashes. */
  path: Schema.String,
  /** The same file as a Godot resource path. */
  resPath: Schema.String,
  role: GameArtKitFileRole,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: artHash,
});
export type GameArtInstalledFile = typeof GameArtInstalledFile.Type;

export const GameArtImportedAtlas = Schema.Struct({
  imageResPath: Schema.String,
  imageWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  imageHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  tileWidth: Schema.Int.check(Schema.isGreaterThan(0)),
  tileHeight: Schema.Int.check(Schema.isGreaterThan(0)),
  columns: Schema.Int.check(Schema.isGreaterThan(0)),
  rows: Schema.Int.check(Schema.isGreaterThan(0)),
  tileCount: Schema.Int.check(Schema.isGreaterThan(0)),
  margin: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  spacing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GameArtImportedAtlas = typeof GameArtImportedAtlas.Type;

/** One additional sheet after install, with the Godot path it now has. */
export const GameArtImportedSheet = Schema.Struct({
  ...GameArtSheet.fields,
  imageResPath: Schema.String,
});
export type GameArtImportedSheet = typeof GameArtImportedSheet.Type;

/**
 * The installed result. `alreadyPresent` is true only when every declared file
 * was already there byte for byte, so a retry writes nothing.
 */
export const GameArtImportResult = Schema.Struct({
  kit: GameArtKitSummary,
  /** Game-relative destination directory, using forward slashes. */
  destination: Schema.String,
  files: Schema.Array(GameArtInstalledFile),
  atlas: GameArtImportedAtlas,
  additionalSheets: Schema.Array(GameArtImportedSheet),
  alreadyPresent: Schema.Boolean,
  message: Schema.String,
});
export type GameArtImportResult = typeof GameArtImportResult.Type;

export const GameArtFramesInput = Schema.Struct({
  id: GameArtKitId,
  /** The sheet name from the kit catalog, such as "characters". */
  sheet: artText(40),
  /**
   * Animation names from the sheet's authored list. Defaults to every entry;
   * unknown names fail instead of building a partial set.
   */
  animations: Schema.optionalKey(
    Schema.Array(artText(40)).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
});
export type GameArtFramesInput = typeof GameArtFramesInput.Type;

/** One animation the frames resource carries. */
export const GameArtFramesAnimation = Schema.Struct({
  name: Schema.String,
  frames: Schema.Int.check(Schema.isGreaterThan(0)),
  fps: Schema.Number,
  loop: Schema.Boolean,
});
export type GameArtFramesAnimation = typeof GameArtFramesAnimation.Type;

/**
 * A generated Godot SpriteFrames resource built from a kit sheet's authored
 * grid and animations. Matching requests reuse an existing resource; subsets
 * have separate paths and modified resources are not overwritten.
 * The license and source travel with the result so the reuse terms stay with
 * the builder and repair, not only in the kit folder.
 */
export const GameArtFramesResult = Schema.Struct({
  kit: GameArtKitSummary,
  /** The sheet the frames were built from. */
  sheet: Schema.String,
  /** Game-relative path of the generated resource, using forward slashes. */
  framesPath: Schema.String,
  /** The same resource as a Godot resource path. */
  framesResPath: Schema.String,
  animations: Schema.Array(GameArtFramesAnimation),
  license: GameArtLicense,
  source: GameArtSource,
  message: Schema.String,
});
export type GameArtFramesResult = typeof GameArtFramesResult.Type;
