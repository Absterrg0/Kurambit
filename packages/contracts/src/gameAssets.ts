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

/**
 * Bounded inventory budgets. The walk stops at `maxFiles` and names the cut;
 * one file over `maxFileBytes` is skipped for native loads with an honest
 * note; source text is only ever read in `maxSourceBytesPerFile` heads.
 */
export const GAME_ASSET_INVENTORY_BOUNDS = {
  maxFiles: 2000,
  maxTotalBytes: 200_000_000,
  maxNativeTargets: 32,
  maxNativeBytes: 50_000_000,
  maxSourceFiles: 200,
  maxSourceBytesPerFile: 65_536,
  maxResources: 300,
  maxDeclaredRefs: 200,
  maxMentions: 200,
  maxEdges: 200,
  maxEvidencePaths: 8,
  timeoutMs: 60_000,
  /**
   * Export-pack inclusion bounds. The pack itself must fit in memory-safe
   * reading and only a bounded target set is ever checked against it; the
   * rest counts as uninspected, never as included or used.
   */
  maxPackBytes: 200_000_000,
  maxExportedPaths: 32,
  /**
   * Whole-project import preflight budgets. Direct raster headers fail cheap
   * before any decode; the aggregate decoded-image budget covers every
   * importable texture the editor would decode on `--editor --import`, not
   * just the narrowed native targets.
   */
  maxFileBytes: 20_000_000,
  maxImagePixels: 16_777_216,
  maxTotalImagePixels: 33_554_432,
  maxImageDimension: 8192,
} as const;

export const GameAssetsInspectInput = Schema.Struct({
  /** Skip the headless Godot pass and return filesystem evidence only. */
  includeNative: Schema.optionalKey(Schema.Boolean),
  /**
   * Skip the export-pack inclusion probe and return unknown inclusion.
   * Defaults to checking when a selected/latest Web build exists.
   */
  includeExported: Schema.optionalKey(Schema.Boolean),
  /**
   * Narrow the native and export-inclusion passes to these `res://` paths
   * (at most 32). Only these paths load or are checked in the pack; every
   * other family counts as uninspected and its engine-dependent checks
   * report unknown. The filesystem walk stays complete; only the engine
   * loads narrow. Absent means the service picks up to the bound itself,
   * family paths first.
   */
  paths: Schema.optionalKey(Schema.Array(familyPath).check(Schema.isMaxLength(32))),
});
export type GameAssetsInspectInput = typeof GameAssetsInspectInput.Type;

export const GameAssetResourceKind = Schema.Literals([
  "model",
  "texture",
  "audio",
  "scene",
  "font",
  "script",
  "resource",
  "other",
]);
export type GameAssetResourceKind = typeof GameAssetResourceKind.Type;

/** One file the bounded walk saw, with its native verdict when inspected. */
export const GameAssetResourceEntry = Schema.Struct({
  /** Game-relative path with forward slashes. */
  path: familyText(500),
  /** Godot resource path when the file lives under the Godot project. */
  resPath: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  kind: GameAssetResourceKind,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Named by a manifest asset export or a family path. */
  declared: Schema.Boolean,
  /** Who named it, e.g. `manifest:coin` or `family:hero`. */
  declaredBy: Schema.Array(familyText(120)).check(Schema.isMaxLength(8)),
  /** Engine class the native pass loaded, e.g. `PackedScene` or `SpriteFrames`. */
  godotClass: Schema.NullOr(familyText(128)),
  inspect: Schema.Literals(["inspected", "skipped", "unknown"]),
  /** Bounded reason for `skipped`/`unknown`, e.g. overlarge or tool-missing. */
  note: Schema.optionalKey(familyText(500)),
});
export type GameAssetResourceEntry = typeof GameAssetResourceEntry.Type;

/** One authored reference and whether its file exists. */
export const GameAssetDeclaredReference = Schema.Struct({
  /** Who named it, e.g. `manifest:coin` or `family:hero`. */
  from: familyText(120),
  /** The authored path, as written (`res://` or game-relative). */
  target: familyText(500),
  exists: Schema.Boolean,
  /** Game-relative path when it exists. */
  resolvedPath: Schema.NullOr(familyText(500)),
});
export type GameAssetDeclaredReference = typeof GameAssetDeclaredReference.Type;

/**
 * One `res://` string seen in a `.gd`/`.tscn` source file. A mention is not
 * usage: only the native dependency edges below prove a load. Counted per
 * (file, target) pair and bounded.
 */
export const GameAssetSourceMention = Schema.Struct({
  file: familyText(500),
  target: familyText(500),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type GameAssetSourceMention = typeof GameAssetSourceMention.Type;

/** One native load edge: `from` loaded `to` through the engine. */
export const GameAssetDependencyEdge = Schema.Struct({
  from: familyText(500),
  to: familyText(500),
});
export type GameAssetDependencyEdge = typeof GameAssetDependencyEdge.Type;

export const GameAssetNativeAnimations = Schema.Struct({
  resource: familyText(500),
  animations: Schema.Array(familyText(64)).check(Schema.isMaxLength(64)),
  /** Subset of `animations` the engine reports as looping. Absent means the probe did not report loop flags. */
  loops: Schema.optionalKey(Schema.Array(familyText(64)).check(Schema.isMaxLength(64))),
});
export type GameAssetNativeAnimations = typeof GameAssetNativeAnimations.Type;

export const GameAssetNativeCollisions = Schema.Struct({
  scene: familyText(500),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabledWithShape: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type GameAssetNativeCollisions = typeof GameAssetNativeCollisions.Type;

/** One engine-observed state-machine edge: `resource` wires `from` to `to`. */
export const GameAssetNativeTransition = Schema.Struct({
  resource: familyText(500),
  from: familyText(64),
  to: familyText(64),
  /** Advance condition the engine reports, or empty when the edge has none. */
  condition: familyText(280),
});
export type GameAssetNativeTransition = typeof GameAssetNativeTransition.Type;

export const GameAssetNativeScale = Schema.Struct({
  resource: familyText(500),
  heightM: Schema.NullOr(Schema.Number),
  pivot: Schema.NullOr(Schema.Literals(["ground", "center"])),
  detail: familyText(500),
});
export type GameAssetNativeScale = typeof GameAssetNativeScale.Type;

/**
 * The engine pass over bounded `res://` targets. `complete` means every
 * target loaded; `partial` means some loaded and the rest are named in
 * `skipped`/`missing`/`errors`; `unknown` means no target could be checked
 * (Godot missing, probe failed) and every family check that needs the engine
 * reports unknown rather than guessing.
 */
export const GameAssetNativeEvidence = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "unknown"]),
  checkedPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  missingPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  overlargePaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  edges: Schema.Array(GameAssetDependencyEdge).check(
    Schema.isMaxLength(GAME_ASSET_INVENTORY_BOUNDS.maxEdges),
  ),
  animations: Schema.Array(GameAssetNativeAnimations).check(Schema.isMaxLength(32)),
  collisions: Schema.Array(GameAssetNativeCollisions).check(Schema.isMaxLength(32)),
  scales: Schema.Array(GameAssetNativeScale).check(Schema.isMaxLength(32)),
  /** Engine-observed state-machine edges, scoped to the resource that owns them. */
  transitions: Schema.Array(GameAssetNativeTransition).check(Schema.isMaxLength(64)),
  errors: Schema.Array(familyText(500)).check(Schema.isMaxLength(16)),
  message: familyText(2000),
});
export type GameAssetNativeEvidence = typeof GameAssetNativeEvidence.Type;

/** One yes/no/unknown verdict with the concrete paths that decided it. */
export const GameAssetRequirement = Schema.Struct({
  status: Schema.Literals(["yes", "no", "unknown"]),
  evidence: Schema.Array(familyText(500)).check(
    Schema.isMaxLength(GAME_ASSET_INVENTORY_BOUNDS.maxEvidencePaths),
  ),
  detail: familyText(500),
});
export type GameAssetRequirement = typeof GameAssetRequirement.Type;

/** Measured consistency for one authored family. Never an art-quality verdict. */
export const GameAssetFamilyCheck = Schema.Struct({
  family: familyName,
  kind: GameAssetFamilyKind,
  status: Schema.Literals(["complete", "incomplete", "unknown"]),
  scale: GameAssetRequirement,
  pivot: GameAssetRequirement,
  animations: GameAssetRequirement,
  transitions: GameAssetRequirement,
  collision: GameAssetRequirement,
  provenance: GameAssetRequirement,
  /** Human-readable missing items, e.g. `animation "walk"`. */
  missing: Schema.Array(familyText(200)).check(Schema.isMaxLength(32)),
});
export type GameAssetFamilyCheck = typeof GameAssetFamilyCheck.Type;

export const GameAssetCoverage = Schema.Struct({
  installedKits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kitFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  framesBuilt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  libraryModels: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  libraryMaterials: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  audioFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  audioReferencedNatively: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  provenanceFiles: Schema.Array(familyText(500)).check(Schema.isMaxLength(64)),
  unreadableProvenance: Schema.Array(familyText(500)).check(Schema.isMaxLength(64)),
  suppliedInputs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mentionedInputs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  message: familyText(2000),
});
export type GameAssetCoverage = typeof GameAssetCoverage.Type;

/**
 * Pack inclusion in the exact recorded Web build. `checked` means the
 * engine opened the immutable candidate's `.pck` through
 * `ProjectSettings.load_resource_pack` in an empty bootstrap project and
 * asked `ResourceLoader.exists` for each checked `res://` path — no scene
 * instantiation, no script execution, no game project or autoload. Inclusion
 * proves the pack contains the bytes; it never proves runtime, visible or
 * audible use. `unknown` means no selected/latest Web build, a missing or
 * changed pack, or a probe that could not run — filesystem facts still hold.
 */
export const GameAssetExportedInclusion = Schema.Struct({
  status: Schema.Literals(["checked", "unknown"]),
  /** Content hash of the candidate directory the pack was read from. */
  buildId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  sourceId: Schema.NullOr(familyText(200)),
  directory: Schema.NullOr(familyText(400)),
  /** Game-relative pack file inside `directory`, e.g. `game.pck`. */
  packFile: Schema.NullOr(familyText(500)),
  checkedPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  includedPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  /** Checked paths the pack does not contain. */
  missingPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  /** Checked strings that are not checkable `res://` paths. */
  unresolvedPaths: Schema.Array(familyText(500)).check(Schema.isMaxLength(32)),
  errors: Schema.Array(familyText(500)).check(Schema.isMaxLength(16)),
  message: familyText(2000),
});
export type GameAssetExportedInclusion = typeof GameAssetExportedInclusion.Type;

/**
 * Complete local visibility. Filesystem facts, declared references and
 * source mentions are separate from native load evidence; `exportedUsage`
 * stays `unknown` because no export `.pck` is parsed here for use — a string
 * occurrence is never reported as exported or visible usage. Pack inclusion
 * is separate: `exportedInclusion` names exact bytes in the recorded Web
 * `.pck` when one can be opened safely, and stays unknown otherwise.
 */
export const GameAssetsInspectResult = Schema.Struct({
  scannedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scannedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  incomplete: Schema.Array(familyText(500)).check(Schema.isMaxLength(16)),
  resources: Schema.Array(GameAssetResourceEntry).check(
    Schema.isMaxLength(GAME_ASSET_INVENTORY_BOUNDS.maxResources),
  ),
  resourcesTruncated: Schema.Boolean,
  declaredReferences: Schema.Array(GameAssetDeclaredReference).check(
    Schema.isMaxLength(GAME_ASSET_INVENTORY_BOUNDS.maxDeclaredRefs),
  ),
  sourceMentions: Schema.Array(GameAssetSourceMention).check(
    Schema.isMaxLength(GAME_ASSET_INVENTORY_BOUNDS.maxMentions),
  ),
  sourceMentionsTruncated: Schema.Boolean,
  native: GameAssetNativeEvidence,
  families: Schema.Array(GameAssetFamilyCheck).check(Schema.isMaxLength(16)),
  coverage: GameAssetCoverage,
  exportedUsage: Schema.Literals(["unknown"]),
  exportedInclusion: GameAssetExportedInclusion,
  message: familyText(2000),
});
export type GameAssetsInspectResult = typeof GameAssetsInspectResult.Type;
