import * as Schema from "effect/Schema";

const libraryText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));
const librarySlug = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_]{1,80}$/),
  Schema.isMaxLength(80),
);
const md5Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const sha256Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/**
 * The Poly Haven request identity. The public API requires a User-Agent naming
 * the app, and surfaced content carries a visible credit. Assets are CC0.
 */
export const GAME_LIBRARY_USER_AGENT = "GameStudio/0.1.0 (asset-pipeline development)";
export const GAME_LIBRARY_CREDIT =
  "Powered by Poly Haven (https://polyhaven.com) — assets CC0, https://polyhaven.com/license";
export const GAME_LIBRARY_API = "https://api.polyhaven.com";

/**
 * Bounded upstream budgets. Downloads are small props and 1k PBR maps, never
 * multi-gigabyte scans: sizes are checked from the files API before any byte
 * is fetched, and the fetch streams to disk with per-file and total caps.
 */
export const GAME_LIBRARY_BOUNDS = {
  maxSearchLimit: 10,
  defaultSearchLimit: 5,
  maxFilesPerImport: 8,
  maxFileBytes: 12_000_000,
  maxTotalBytes: 25_000_000,
  jsonTimeoutMs: 20_000,
  downloadTimeoutMs: 120_000,
  defaultResolution: "1k",
} as const;

export const GameLibrarySearchType = Schema.Literals(["models", "textures", "all"]);
export type GameLibrarySearchType = typeof GameLibrarySearchType.Type;

export const GameLibraryResolution = Schema.Literals(["1k", "2k"]);
export type GameLibraryResolution = typeof GameLibraryResolution.Type;

export const GameLibrarySearchInput = Schema.Struct({
  /** Plain-language query, sent trimmed and lower-cased to share the API cache. */
  q: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  type: Schema.optionalKey(GameLibrarySearchType),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  ),
});
export type GameLibrarySearchInput = typeof GameLibrarySearchInput.Type;

export const GameLibrarySearchHit = Schema.Struct({
  slug: librarySlug,
  score: Schema.Number,
  name: libraryText(120),
  kind: Schema.Literals(["model", "texture"]),
  category: libraryText(160),
  tags: Schema.Array(libraryText(48)),
  thumbnailUrl: libraryText(500),
  authors: Schema.Array(libraryText(80)),
});
export type GameLibrarySearchHit = typeof GameLibrarySearchHit.Type;

export const GameLibrarySearchResult = Schema.Struct({
  query: libraryText(100),
  type: GameLibrarySearchType,
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hits: Schema.Array(GameLibrarySearchHit),
  credit: Schema.String,
});
export type GameLibrarySearchResult = typeof GameLibrarySearchResult.Type;

export const GameLibraryLicense = Schema.Struct({
  name: libraryText(40),
  url: libraryText(300),
  attribution: libraryText(300),
});
export type GameLibraryLicense = typeof GameLibraryLicense.Type;

export const GameLibrarySource = Schema.Struct({
  title: libraryText(160),
  url: libraryText(500),
  archiveUrl: libraryText(600),
  archiveSha256: Schema.optionalKey(sha256Hash),
  retrievedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
});
export type GameLibrarySource = typeof GameLibrarySource.Type;

/** One pinned download: the exact URL, byte count and MD5 the files API names. */
export const GameLibraryPlannedFile = Schema.Struct({
  /** Destination-relative path, using forward slashes. */
  path: libraryText(200),
  url: libraryText(600),
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  md5: md5Hash,
});
export type GameLibraryPlannedFile = typeof GameLibraryPlannedFile.Type;

export const GameLibraryAssetDetail = Schema.Struct({
  id: librarySlug,
  name: libraryText(120),
  type: Schema.Literals(["model", "texture"]),
  description: libraryText(700),
  category: libraryText(160),
  tags: Schema.Array(libraryText(48)),
  authors: Schema.Array(libraryText(80)),
  license: GameLibraryLicense,
  source: GameLibrarySource,
  pageUrl: libraryText(500),
  thumbnailUrl: libraryText(500),
  /** Physical footprint in millimetres when the API reports it. */
  dimensionsMm: Schema.optionalKey(Schema.Array(Schema.Number)),
  polycount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  maxResolution: Schema.Array(Schema.Number),
  downloadCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type GameLibraryAssetDetail = typeof GameLibraryAssetDetail.Type;

export const GameLibraryGetInput = Schema.Struct({ id: librarySlug });
export type GameLibraryGetInput = typeof GameLibraryGetInput.Type;

/**
 * One asset with its default small download plan. `files` is the exact
 * 1k set the import fetches (a glTF plus its textures, or the PBR maps);
 * larger resolutions are named in `availableResolutions` but never fetched
 * unless the caller explicitly asks for 2k.
 */
export const GameLibraryGetResult = Schema.Struct({
  asset: GameLibraryAssetDetail,
  defaultResolution: GameLibraryResolution,
  defaultFormat: Schema.String,
  files: Schema.Array(GameLibraryPlannedFile),
  totalBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  availableResolutions: Schema.Array(Schema.String),
  availableFormats: Schema.Array(Schema.String),
  credit: Schema.String,
  message: Schema.String,
});
export type GameLibraryGetResult = typeof GameLibraryGetResult.Type;

export const GameLibraryImportModelInput = Schema.Struct({
  id: librarySlug,
  resolution: Schema.optionalKey(GameLibraryResolution),
});
export type GameLibraryImportModelInput = typeof GameLibraryImportModelInput.Type;

export const GameLibraryInstalledFileRole = Schema.Literals([
  "gltf",
  "bin",
  "texture",
  "material",
  "provenance",
]);
export type GameLibraryInstalledFileRole = typeof GameLibraryInstalledFileRole.Type;

export const GameLibraryInstalledFile = Schema.Struct({
  /** Game-relative path, using forward slashes. */
  path: Schema.String,
  /** The same file as a Godot resource path, when it lives under godot/. */
  resPath: Schema.NullOr(Schema.String),
  role: GameLibraryInstalledFileRole,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: sha256Hash,
});
export type GameLibraryInstalledFile = typeof GameLibraryInstalledFile.Type;

export const GameLibraryImportModelResult = Schema.Struct({
  slug: librarySlug,
  /** Game-relative destination directory, using forward slashes. */
  destination: Schema.String,
  files: Schema.Array(GameLibraryInstalledFile),
  gltfResPath: Schema.String,
  license: GameLibraryLicense,
  source: GameLibrarySource,
  alreadyPresent: Schema.Boolean,
  credit: Schema.String,
  message: Schema.String,
});
export type GameLibraryImportModelResult = typeof GameLibraryImportModelResult.Type;

export const GameLibraryImportMaterialInput = Schema.Struct({
  id: librarySlug,
  resolution: Schema.optionalKey(GameLibraryResolution),
});
export type GameLibraryImportMaterialInput = typeof GameLibraryImportMaterialInput.Type;

export const GameLibraryImportMaterialResult = Schema.Struct({
  slug: librarySlug,
  /** Game-relative destination directory, using forward slashes. */
  destination: Schema.String,
  files: Schema.Array(GameLibraryInstalledFile),
  materialResPath: Schema.String,
  maps: Schema.Array(Schema.String),
  /** Physical size in metres the texture covers, when the API reports it. */
  physicalSizeM: Schema.NullOr(Schema.Array(Schema.Number)),
  license: GameLibraryLicense,
  source: GameLibrarySource,
  alreadyPresent: Schema.Boolean,
  credit: Schema.String,
  message: Schema.String,
  /** How to assign the material to several meshes. */
  usage: Schema.String,
});
export type GameLibraryImportMaterialResult = typeof GameLibraryImportMaterialResult.Type;
