import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const familyText = (cap: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(cap));
const familyName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);
const familyPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/**
 * An authorable asset target: one named family the game actually needs, such
 * as a playable character, a tileset, a UI screen or an audio bed. Families
 * are explicitly authored on the manifest; nothing is inferred from genre or
 * template, so an undeclared need is never reported as missing.
 */
export const GameAssetFamilyKind = Schema.Literals([
  "character",
  "environment",
  "prop",
  "ui",
  "audio",
  "vfx",
  "other",
]);
export type GameAssetFamilyKind = typeof GameAssetFamilyKind.Type;

export const GameAssetFamilyAnimation = Schema.Struct({
  /** Animation name the resource must carry, e.g. `walk` or `idle`. */
  name: familyText(64),
  /** Expected looping; absent means the family does not constrain it. */
  loop: Schema.optionalKey(Schema.Boolean),
});
export type GameAssetFamilyAnimation = typeof GameAssetFamilyAnimation.Type;

export const GameAssetFamilyTransition = Schema.Struct({
  /** Animation the transition leaves. */
  from: familyText(64),
  /** Animation the transition enters. */
  to: familyText(64),
  /** Plain-language trigger, e.g. `speed > 0`; absent means any wiring counts. */
  condition: Schema.optionalKey(familyText(280)),
});
export type GameAssetFamilyTransition = typeof GameAssetFamilyTransition.Type;

export const GameAssetFamily = Schema.Struct({
  /** Stable slug, e.g. `hero`, `tileset-grass`, `ui-hud`, `music-bed`. */
  name: familyName,
  kind: GameAssetFamilyKind,
  /** What this family is for in this game; absent means paths alone define it. */
  description: Schema.optionalKey(familyText(280)),
  /**
   * Expected resource locations as `res://` paths or game-relative paths.
   * Empty means the target is declared but no file is named yet, so every
   * existence check reports missing with the family name as evidence.
   */
  paths: Schema.Array(familyPath).check(Schema.isMaxLength(16)),
  /** What the family must do in play; absent means no role promise to check. */
  role: Schema.optionalKey(familyText(280)),
  /** Standing height in metres the family holds to; absent means unmeasured. */
  targetHeight: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
  /**
   * Origin convention. `ground` is the bottom-centre on the floor (3D props
   * and characters); `center` is the centred Sprite2D/Control convention.
   * Absent means the family does not constrain it.
   */
  pivot: Schema.optionalKey(Schema.Literals(["ground", "center"])),
  /** Animation names the family requires; absent or empty means unmeasured. */
  animations: Schema.optionalKey(
    Schema.Array(GameAssetFamilyAnimation).check(Schema.isMaxLength(16)),
  ),
  /** Transitions the family requires between its animations. */
  transitions: Schema.optionalKey(
    Schema.Array(GameAssetFamilyTransition).check(Schema.isMaxLength(16)),
  ),
  /**
   * Collision promise. `required` needs an enabled shape on the family's
   * scene, `none` needs no shape, `optional` never fails. Absent means the
   * family does not constrain it and reports unknown.
   */
  collision: Schema.optionalKey(Schema.Literals(["required", "none", "optional"])),
  /**
   * Provenance promise. `required` needs a readable PROVENANCE.md or license
   * beside the family's files; `optional` never fails. Absent reports unknown.
   */
  provenance: Schema.optionalKey(Schema.Literals(["required", "optional"])),
});
export type GameAssetFamily = typeof GameAssetFamily.Type;

// ─── The Workbench's Art tab ──────────────────────────────────────────────────

const AssetPathText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const GameArtAssetKind = Schema.Literals(["model", "texture", "audio", "font"]);
export type GameArtAssetKind = typeof GameArtAssetKind.Type;

/**
 * Where a file came from, as the game's own records say: a sidecar's source, an ASSETS.md line,
 * a library credit. `unrecorded` is a file nothing names; models made in code are not files and
 * come from the running game's things instead.
 */
export const GameArtAssetRoute = Schema.Literals([
  "code",
  "blender",
  "generated",
  "library",
  "unrecorded",
]);
export type GameArtAssetRoute = typeof GameArtAssetRoute.Type;

/** A sprite sheet's grid, from the line ASSETS.md gives it. */
export const GameArtSpriteSheet = Schema.Struct({
  columns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
});

export const GameArtAsset = Schema.Struct({
  /** Game-relative. */
  path: AssetPathText,
  /** Where the game's page fetches it, relative to the folder the game is served from. */
  url: AssetPathText,
  kind: GameArtAssetKind,
  bytes: Schema.Number,
  /** Its content, for a thumbnail cached by what it is rather than where. */
  sha256: Sha256,
  /** A model's triangles, from its glTF JSON (or its sidecar, which names the shipped bytes). */
  triangles: Schema.optionalKey(Schema.Number),
  route: GameArtAssetRoute,
  /** The licence or credit the records give it, in their words. */
  credit: Schema.optionalKey(Schema.String),
  /** What ASSETS.md says of it, after its path. */
  note: Schema.optionalKey(Schema.String),
  /** A model's sidecar, game-relative: three.js loads the model through it. */
  sidecar: Schema.optionalKey(AssetPathText),
  /** The library pack it came from. */
  pack: Schema.optionalKey(Schema.String),
  sheet: Schema.optionalKey(GameArtSpriteSheet),
  /** Its cached thumbnail, game-relative, once one was drawn for these bytes. */
  thumbnail: Schema.optionalKey(AssetPathText),
});
export type GameArtAsset = typeof GameArtAsset.Type;

/** A character's or creature's kept sheet (art/sheets/<name>.png), shown by Art beside the model. */
export const GameHeroSheet = Schema.Struct({
  /** Its file name's stem: a model file's stem, or a code thing's name (gameHeroSheetName). */
  name: Schema.String,
  /** Game-relative. */
  image: AssetPathText,
});
export type GameHeroSheet = typeof GameHeroSheet.Type;
/** The hero sheet name for a model file's stem or a thing's name. */
export const gameHeroSheetName = (name: string) =>
  name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "hero";

/**
 * A model being made in Blender: reviewed there (a sheet was drawn of it) and not exported yet.
 * `path` is where its export lands, so Art shows it where its file will be.
 */
export const GameArtMaking = Schema.Struct({
  /** Game-relative: the model file it becomes. */
  path: AssetPathText,
  /** Its review's sheet, game-relative. */
  sheet: AssetPathText,
});
export type GameArtMaking = typeof GameArtMaking.Type;

export const GameArtAssetsInput = Schema.Struct({ threadId: ThreadId });
export type GameArtAssetsInput = typeof GameArtAssetsInput.Type;
export const GameArtAssetsResult = Schema.Struct({
  assets: Schema.Array(GameArtAsset),
  /** Files past the list's cap, counted only. */
  more: Schema.Number,
  /** The game's Blender source, game-relative, when it has one. */
  blend: Schema.optionalKey(AssetPathText),
  heroSheets: Schema.optionalKey(Schema.Array(GameHeroSheet)),
  /** Models reviewed in Blender whose files are not in the game yet. */
  making: Schema.optionalKey(Schema.Array(GameArtMaking)),
});
export type GameArtAssetsResult = typeof GameArtAssetsResult.Type;

/**
 * Where Art's thumbnails are kept, game-relative: beside the build evidence, out of every build.
 * A model file's is named by its content; a thing the game's code makes, by its build and name.
 * `2x`: drawn 384 px across, for a tile on a 2× display; the folder above holds the 192 px ones
 * earlier versions drew, which are left alone.
 */
export const GAME_ART_THUMBNAIL_DIR = "builds/thumbnails/2x";

/** A model's thumbnail as the Art tab's viewer drew it once: a small PNG, cached by content. */
export const GameArtThumbnailInput = Schema.Struct({
  threadId: ThreadId,
  sha256: Sha256,
  png: Schema.String.check(
    Schema.isPattern(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
    Schema.isMaxLength(1_200_000),
  ),
});
export type GameArtThumbnailInput = typeof GameArtThumbnailInput.Type;
export const GameArtThumbnailResult = Schema.Struct({ thumbnail: AssetPathText });
export type GameArtThumbnailResult = typeof GameArtThumbnailResult.Type;
