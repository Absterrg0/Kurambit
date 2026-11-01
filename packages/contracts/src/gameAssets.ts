import * as Schema from "effect/Schema";

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
