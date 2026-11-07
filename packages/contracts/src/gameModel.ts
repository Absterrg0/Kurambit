import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

/** The skeleton every made character is conformed to: Quaternius' 65-joint UE-named rig. */
export const STANDARD_SKELETON = "standard-humanoid";
/** A model's sidecar sits beside it: `<stem>.glb` and `<stem>.asset.json`. */
export const GAME_MODEL_SIDECAR_SUFFIX = ".asset.json";

const Metres = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

/** One part of an asset and where it came from: the ledger's unit. */
export const GameAssetPart = Schema.Struct({
  what: Schema.Literals(["body", "clips", "mesh", "parts", "texture"]),
  /** A library pack id, "mpfb2", "polyhaven", "sketchfab", "polypizza", "tripo", or "made" (modelled or keyed in this game). */
  from: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  licence: Schema.String.check(Schema.isMaxLength(200)),
  /** Made by a generative model. */
  ai: Schema.Boolean,
  /** Credits spent, measured; null when free or not measured. */
  credits: Schema.NullOr(Schema.Number),
});
export type GameAssetPart = typeof GameAssetPart.Type;

export const GameAssetSource = Schema.Struct({
  /** The route its body (or, for a prop, its first part) came by. */
  route: Schema.Literals(["blender", "library", "tripo"]),
  parts: Schema.Array(GameAssetPart).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** The named subject a placeholder stands in for; null when it is the real thing. (Phase 2 writes it.) */
  standIn: Schema.NullOr(Schema.String.check(Schema.isMaxLength(140))),
  /** The concept it was reviewed beside: "art/CONCEPT.md#<name>" and/or "art/concepts/<name>.png"; null when none. */
  concept: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
});
export type GameAssetSource = typeof GameAssetSource.Type;

export const GameModelClip = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  seconds: Schema.Number,
  /** First and last pose agree: feet and hips within 2 cm per 1.8 m of height. */
  loops: Schema.Boolean,
  /** Horizontal pelvis travel over the clip, metres; an in-place clip has about 0. */
  rootDrift: Schema.Number,
  /** m/s the support foot travels backward: play at moveSpeed / groundSpeed. Null: not a locomotion clip (walk, run, jog, sprint), or not measurable. */
  groundSpeed: Schema.NullOr(Schema.Number),
  /** stance: from the planted foot; stride: stride length over the cycle (a clip with a flight phase). */
  groundSpeedFrom: Schema.NullOr(Schema.Literals(["stance", "stride"])),
});
export type GameModelClip = typeof GameModelClip.Type;

/** Bones no clip keys, root to tip, that the engine springs on top of the clips. */
export const GameModelSpring = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,23}$/)),
  bones: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
});
export type GameModelSpring = typeof GameModelSpring.Type;

/** What the pipeline measured on a styled model: shared by the review and the sidecar. */
export const GameModelMeasure = Schema.Struct({
  kind: Schema.Literals(["character", "prop"]),
  /** The rig id whose joints it holds; null for a prop or an unknown rig. */
  skeleton: Schema.NullOr(Schema.String),
  /** Largest rest-frame difference from the standard skeleton over its joints, degrees; null off the standard skeleton. */
  restDeviation: Schema.NullOr(Schema.Number),
  /** Standing height at rest after the style pass, metres. */
  height: Metres,
  footprint: Schema.Struct({ width: Metres, depth: Metres }),
  triangles: NonNegativeInt,
  materials: NonNegativeInt,
  textures: Schema.Array(Schema.Struct({ width: PositiveInt, height: PositiveInt })).check(
    Schema.isMaxLength(32),
  ),
  clips: Schema.Array(GameModelClip).check(Schema.isMaxLength(128)),
  springs: Schema.Array(GameModelSpring).check(Schema.isMaxLength(8)),
});
export type GameModelMeasure = typeof GameModelMeasure.Type;

/** `<stem>.asset.json`: the engine-agnostic contract, and the ASSETS entry three.js loads. */
export const GameModelSidecar = Schema.Struct({
  version: Schema.Literal(1),
  /** The GLB beside this file, by file name: never a path. */
  model: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,120}\.glb$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  bytes: NonNegativeInt,
  ...GameModelMeasure.fields,
  measured: Schema.Struct({
    /** The kit's content hash (§2.8). */
    kit: Schema.String,
    /** The review key the export promoted. */
    key: Schema.String,
    reviewedAt: IsoDateTime,
  }),
  source: GameAssetSource,
});
export type GameModelSidecar = typeof GameModelSidecar.Type;

/** Why an export refuses a candidate; the review shows the same as "would refuse". */
export const GameModelRefusalCode = Schema.Literals([
  "off-rig", // an armature not on the lock's rig (lockArmatureRefusal)
  "rest-frames", // restDeviation > 2° on a standard joint
  "triangles", // over budget.character / budget.prop
  "texture", // a side over budget.texture
  "no-idle", // a character with no idle clip
]);
export const GameModelRefusal = Schema.Struct({
  code: GameModelRefusalCode,
  text: Schema.String.check(Schema.isMaxLength(400)),
});
export type GameModelRefusal = typeof GameModelRefusal.Type;
