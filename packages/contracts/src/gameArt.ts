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

export const GameArtKitFileRole = Schema.Literals(["atlas", "license", "provenance"]);
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
  alreadyPresent: Schema.Boolean,
  message: Schema.String,
});
export type GameArtImportResult = typeof GameArtImportResult.Type;
