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
  /** A library pack id, "mpfb2", "polyhaven", "sketchfab", "polypizza", an art provider id (GameArtProviderId), or "made" (modelled or keyed in this game). */
  from: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  licence: Schema.String.check(Schema.isMaxLength(200)),
  /** Made by a generative model. */
  ai: Schema.Boolean,
  /** What it cost, in USD (a generation's cost); null when free or not measured. */
  credits: Schema.NullOr(Schema.Number),
  /** The game_assets op generate generation that delivered it, so its card can tell whether it is in the game. */
  generation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
export type GameAssetPart = typeof GameAssetPart.Type;

export const GameAssetSource = Schema.Struct({
  /** The game's character route when it was exported; where each part came from is in parts. */
  route: Schema.Literals(["code", "blender", "library", "generated"]),
  parts: Schema.Array(GameAssetPart).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** The named subject a placeholder stands in for; null when it is the real thing. Nothing writes one yet. */
  standIn: Schema.NullOr(Schema.String.check(Schema.isMaxLength(140))),
  /** The concept it was reviewed beside: "art/CONCEPT.md#<name>" and/or "art/concepts/<name>.png"; null when none. */
  concept: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
});
export type GameAssetSource = typeof GameAssetSource.Type;

/** A foot's planted span in a clip, in the clip's seconds. */
export const GameModelStance = Schema.Struct({
  foot: Schema.Literals(["foot_l", "foot_r"]),
  from: Schema.Number,
  to: Schema.Number,
});
export type GameModelStance = typeof GameModelStance.Type;

/** A strike in a clip: the moment something is fastest (at), its window, and what strikes. */
export const GameModelStrike = Schema.Struct({
  at: Schema.Number,
  from: Schema.Number,
  to: Schema.Number,
  /** prop: a held prop's tip; otherwise the hand or foot bone. */
  by: Schema.Literals(["prop", "hand_l", "hand_r", "foot_l", "foot_r"]),
  /** m/s at its peak. */
  speed: Schema.Number,
});
export type GameModelStrike = typeof GameModelStrike.Type;

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
  /** Arm skin inside the torso's, mm² per sampled frame; null: not a humanoid, or not measured. */
  armThroughBody: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** The loop's last-to-first pose step over its mean frame step: about 1 is seamless; null: not a loop. */
  seam: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** One-frame knee snaps of 8° or more; null: no knees. */
  kneePops: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  /** Where each foot is planted (standard skeleton): foot IK holds a foot only through these. */
  stances: Schema.optionalKey(Schema.Array(GameModelStance).check(Schema.isMaxLength(32))),
  /** Hit windows (standard skeleton, not locomotion): a held prop's tip, a free hand or a foot at speed. */
  strikes: Schema.optionalKey(Schema.Array(GameModelStrike).check(Schema.isMaxLength(16))),
});
export type GameModelClip = typeof GameModelClip.Type;

/** A separate part whose nearest surface is this far from every other part's. */
export const GameModelFloating = Schema.Struct({
  part: Schema.String.check(Schema.isMaxLength(128)),
  gap: Metres,
});
export type GameModelFloating = typeof GameModelFloating.Type;

const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/**
 * How a face blinks, by bones (never morph targets): turn a lid bone about its own axis, squash
 * a flat eye's bone along one, or hide a highlight's bone. The engine keys these over the clips.
 */
export const GameModelBlink = Schema.Struct({
  bone: Schema.String.check(Schema.isMaxLength(64)),
  kind: Schema.Literals(["turn", "squash", "hide"]),
  /** The bone's own axis it turns about or squashes along; ignored for hide. */
  axis: Schema.Literals(["x", "y", "z"]),
  /** Closed: radians turned (turn), or the scale left along the axis (squash, about 0.1). */
  amount: Schema.Number,
});
export type GameModelBlink = typeof GameModelBlink.Type;
export const GameModelFace = Schema.Struct({
  blink: Schema.Array(GameModelBlink).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type GameModelFace = typeof GameModelFace.Type;

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
/** A hero's measured gate: height, deformation, cloth, feet or budget, with its number and why. */
export const GameModelGate = Schema.Struct({
  name: Schema.Literals(["height", "deformation", "cloth", "feet", "budget"]),
  pass: Schema.Boolean,
  /** Metres (height), the 99.9th percentile edge stretch (deformation), mm (cloth), cm of slide (feet), triangles (budget). */
  value: Schema.Number,
  text: Schema.String.check(Schema.isMaxLength(600)),
});
export type GameModelGate = typeof GameModelGate.Type;

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
  springs: Schema.Array(GameModelSpring).check(Schema.isMaxLength(32)),
  /** Separate parts not touching the rest, over 0.5 mm away; omitted on a single mesh. */
  floating: Schema.optionalKey(Schema.Array(GameModelFloating).check(Schema.isMaxLength(32))),
  /** Parts off the ground that touch others only from the side, with nothing under them; on models without a skeleton. */
  unsupported: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ part: Schema.String.check(Schema.isMaxLength(128)), height: Metres }),
    ).check(Schema.isMaxLength(32)),
  ),
  /** The most bones a skinned vertex follows in the scene; the export keeps its four strongest. */
  influences: Schema.optionalKey(NonNegativeInt),
  /** Joints of the exported skin hanging from no other joint, beside its main root: chains that do not reach the spine. */
  detachedChains: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(32)),
  ),
  /** Share of the skin's area passing through other skin, %: at rest, and on one fixed bent pose (null off the standard skeleton). */
  skinThrough: Schema.optionalKey(Schema.Struct({ rest: Percent, bent: Schema.NullOr(Percent) })),
  face: Schema.optionalKey(GameModelFace),
  /**
   * The colours Art lists by name: the swatches of the model's gradient atlas in its order (with
   * `atlas`), or, in exports made before it, the flat colours painted per vertex.
   */
  paints: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        colour: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/)),
        name: Schema.String.check(Schema.isMaxLength(64)),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
  /** The gradient atlas the plain colours were packed into: `paints` fill its cells row by row from the top. */
  atlas: Schema.optionalKey(
    Schema.Struct({
      columns: PositiveInt.check(Schema.isLessThanOrEqualTo(64)),
      rows: PositiveInt.check(Schema.isLessThanOrEqualTo(64)),
    }),
  ),
  /** The look's facts: the model's role and the packs' triangle budget for it, its hue families and flat-shaded share. */
  style: Schema.optionalKey(
    Schema.Struct({
      role: Schema.Literals([
        "prop",
        "rock",
        "plant",
        "tree",
        "building",
        "vehicle",
        "creature",
        "hero",
      ]),
      /** False when the role was guessed from the model's kind. */
      roleNamed: Schema.Boolean,
      roleBudget: NonNegativeInt,
      hues: NonNegativeInt,
      flat: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  ),
  /** A character's gates, measured on its clips before the style pass joins its meshes. */
  gates: Schema.optionalKey(Schema.Array(GameModelGate).check(Schema.isMaxLength(8))),
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
    /** The Blender kit's content hash. */
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
  "unweighted", // character vertices bound to no bone: they never move with it
  "frozen-clips", // a character none of whose clips moves a bone
  "hero-height", // a character outside its height range
  "hero-deformation", // edges torn past the deformation gate on a clip
  "hero-cloth", // clothing sunk into the body on a clip
  "hero-feet", // planted feet off the ground or skating on a walk or run
  "hero-budget", // over the triangles or texture size a hero may have
]);
export const GameModelRefusal = Schema.Struct({
  code: GameModelRefusalCode,
  text: Schema.String.check(Schema.isMaxLength(400)),
});
export type GameModelRefusal = typeof GameModelRefusal.Type;
