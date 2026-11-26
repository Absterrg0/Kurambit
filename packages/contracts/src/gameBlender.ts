import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { GameLibraryPackId } from "./gameLibraryPackId.ts";
import { GameModelMeasure, GameModelRefusal } from "./gameModel.ts";

/** Live Blender through the pinned mcp-for-blender server, behind GameBlender. */

/**
 * A scene name (a character's collection and armature, a prop): lower case, as the export
 * stems and sidecars are. Agents name heroes "Bram"; the capital is taken, not refused.
 */
const BlenderName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)).pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/)),
    SchemaTransformation.toLowerCase(),
  ),
);
/** A look's view: a named side (front, back, left, right, top, three_quarter) or an [x, y, z] direction. */
const BlenderLookView = Schema.Union([
  Schema.String,
  Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
]);

export const GameBlenderCodeInput = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description: "bpy Python; relative paths are from the game root.",
  }),
});
export type GameBlenderCodeInput = typeof GameBlenderCodeInput.Type;
export const GameBlenderCodeResult = Schema.Struct({ output: Schema.String });
export type GameBlenderCodeResult = typeof GameBlenderCodeResult.Type;

export const GameBlenderLookInput = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["viewport", "camera", "angles", "frames", "review"])),
  target: Schema.optionalKey(Schema.Array(Schema.String)),
  views: Schema.optionalKey(Schema.Array(BlenderLookView)),
  distance: Schema.optionalKey(Schema.Number),
  shading: Schema.optionalKey(
    Schema.Literals(["solid", "material", "rendered", "wireframe", "xray"]),
  ),
  frames: Schema.optionalKey(Schema.Array(Schema.Number)),
  frameCount: Schema.optionalKey(Schema.Number),
  view: Schema.optionalKey(Schema.String),
  maxSize: Schema.optionalKey(Schema.Number),
  /** review: the character's height on screen at game distance, px. Default from STYLE.json view: perspective 96, side 96, top-down 64, isometric 64. */
  gamePx: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 512 }))),
  reference: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(300)).annotate({
      description:
        "review: a picture set beside the model to look at (the person's, or a sheet drawn for this subject). A game-relative PNG, JPEG or WebP.",
    }),
  ),
  /**
   * Fresh eyes: a separate model that knows only `about` and the game's brief sees the picture
   * and names its biggest visible defects. Your own looks show what you meant; this shows what is there.
   */
  fresh: Schema.optionalKey(Schema.Boolean),
  /** With fresh: what the picture is meant to show ("the goblin thief, the game's main enemy"). */
  about: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
});
export type GameBlenderLookInput = typeof GameBlenderLookInput.Type;
export const GameBlenderLookScreenshot = Schema.Struct({
  /** JPEG for a play's small frames, which cost an agent a fraction of a PNG's bytes. */
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type GameBlenderLookScreenshot = typeof GameBlenderLookScreenshot.Type;
export const GameBlenderReview = Schema.Struct({
  /** The pass's key: game_blender op export of the same objects, unchanged, ships exactly this. */
  key: Schema.String,
  objects: Schema.Array(Schema.String),
  /** Game-relative composite PNG under builds/logs/blender-pipeline/<key>/ (also the screenshot). */
  image: Schema.String,
  measured: GameModelMeasure,
  /** What would make the file broken in the game; empty when the export goes through. */
  refusals: Schema.Array(GameModelRefusal),
  /** The concept set beside it, or null. */
  concept: Schema.NullOr(Schema.String),
});
export type GameBlenderReview = typeof GameBlenderReview.Type;
export const GameBlenderLookResult = Schema.Struct({
  text: Schema.String,
  /** With fresh: the separate model's view of the picture's biggest visible defects. */
  fresh: Schema.optionalKey(Schema.String),
  screenshot: Schema.optionalKey(GameBlenderLookScreenshot),
  review: Schema.optionalKey(GameBlenderReview),
});
export type GameBlenderLookResult = typeof GameBlenderLookResult.Type;

export const GameBlenderSceneInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  root: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  limit: Schema.optionalKey(Schema.Number),
});
export type GameBlenderSceneInput = typeof GameBlenderSceneInput.Type;
export const GameBlenderSceneResult = Schema.Struct({ text: Schema.String });
export type GameBlenderSceneResult = typeof GameBlenderSceneResult.Type;

export const GameBlenderAssetsSearchInput = Schema.Struct({
  source: Schema.Literals(["polyhaven", "sketchfab", "polypizza"]),
  query: Schema.optionalKey(Schema.String),
  assetType: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});
export type GameBlenderAssetsSearchInput = typeof GameBlenderAssetsSearchInput.Type;
export const GameBlenderAssetsSearchResult = Schema.Struct({ text: Schema.String });
export type GameBlenderAssetsSearchResult = typeof GameBlenderAssetsSearchResult.Type;

export const GameBlenderAssetsImportInput = Schema.Struct({
  /** library: a model file of a game_assets op search entry (`id` the entry, `path` the file). */
  source: Schema.Literals(["polyhaven", "sketchfab", "polypizza", "library"]),
  /** The source's asset id, or the library entry id. */
  id: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/))),
  /** library: the entry's file. */
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  assetType: Schema.optionalKey(Schema.String),
  targetSize: Schema.optionalKey(Schema.Number),
  resolution: Schema.optionalKey(Schema.String),
  applyTo: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GameBlenderAssetsImportInput = typeof GameBlenderAssetsImportInput.Type;
export const GameBlenderAssetsImportResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative .blend source that stays in the game. */
  blend: Schema.optionalKey(Schema.String),
  /** Game-relative GLB under the engine directory the game can load; run game_assets op import after. */
  export: Schema.optionalKey(Schema.String),
});
export type GameBlenderAssetsImportResult = typeof GameBlenderAssetsImportResult.Type;

export const GameBlenderExportInput = Schema.Struct({
  /**
   * Scene object names to export. Omitted means every mesh in the current
   * scene. A name that matches nothing fails the call with the close names.
   */
  objects: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Game-relative destination, which must sit under the engine directory
   * (`web/`) and end with `.glb`. Omitted means
   * `<engine dir>/assets/blender/scene.glb`.
   */
  file: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  /**
   * three.js: the most triangles the shipped model keeps. The export simplifies it toward that
   * count, keeping its outline and seams; the result says how many it kept. Omitted: all of them.
   */
  simplify: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10_000_000 })),
  ),
});
export type GameBlenderExportInput = typeof GameBlenderExportInput.Type;
export const GameBlenderExportResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative .blend source that stays in the game. */
  blend: Schema.String,
  /** Game-relative GLB under the engine directory the game can load; run game_assets op import after. */
  export: Schema.String,
  /** Game-relative sidecar written beside the GLB. */
  sidecar: Schema.String,
});
export type GameBlenderExportResult = typeof GameBlenderExportResult.Type;

const Unit = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const GameBlenderBody = Schema.Union([
  /** A library body on the standard skeleton (UBC, a UAL mannequin): pack-relative path as game_assets op search lists it. */
  Schema.Struct({
    library: Schema.Struct({
      pack: GameLibraryPackId,
      file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    }),
  }),
  /** An MPFB2 human (needs MPFB2 installed). age 0 is a toddler, 0.5 an adult; gender 0 female, 1 male. */
  Schema.Struct({
    mpfb: Schema.Struct({
      age: Unit,
      gender: Unit,
      weight: Unit,
      muscle: Schema.optionalKey(Unit),
      height: Schema.optionalKey(Unit),
      proportions: Schema.optionalKey(Unit),
    }),
  }),
  /** A rigged humanoid in this game, such as an earlier export (UE, Mixamo or other common bone names). */
  Schema.Struct({ game: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)) }),
  /** Blender Studio's drawn stylised human (CC0, ships with the kit, no install): a big skull, simple hands. gender 0 female, 1 male. */
  Schema.Struct({ studio: Schema.Struct({ gender: Schema.optionalKey(Unit) }) }),
  /** Retired: model the body static, then rig it. Kept so an earlier call gets that pointer. */
  Schema.Literal("none"),
]);
export type GameBlenderBody = typeof GameBlenderBody.Type;

const HeroHeight = Schema.Number.check(Schema.isBetween({ minimum: 0.05, maximum: 20 }));

export const GameBlenderChain = Schema.Struct({
  /** Bones are <name>_01..; mirrored chains <name>_l_01.. and <name>_r_01... */
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,15}$/)),
  /** The standard joint it hangs from (pelvis for a tail, Head for ears). */
  parent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  bones: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  /** Rest direction in Blender's axes, the character facing -Y: +Z up, +Y behind, +X its left. */
  direction: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  /** Whole chain length in metres at the body's built size. */
  length: Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 5 })),
  /** Also make the chain mirrored across X (ears). */
  mirror: Schema.optionalKey(Schema.Boolean),
});

/** The Mesh2Motion skeletons a model is rigged on, and "chains" for one no template fits. */
const GAME_BLENDER_RIGS = [
  "human",
  "fox",
  "horse",
  "bird",
  "dragon",
  "kaiju",
  "spider",
  "snake",
  "fish",
  "chains",
] as const;
export const GameBlenderRig = Schema.Literals(GAME_BLENDER_RIGS);

/** An object in the live scene, as Blender names it. */
const SceneObject = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(63));
const Point = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);

/** One chain of a model no template fits; parents come before their children, the body first. */
export const GameBlenderRigChain = Schema.Struct({
  /** Its bones are <name>_0, <name>_1, ... */
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,23}$/)),
  /** What it is, which picks its motion. */
  kind: Schema.Literals([
    "spine",
    "neck",
    "tail",
    "tentacle",
    "leg",
    "arm",
    "wing",
    "fin",
    "jaw",
    "antenna",
    "rigid",
  ]),
  /** The chain it hangs from (its bone nearest this chain's first point); none for the body. */
  parent: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24))),
  /** The objects it moves, each weighted only to this chain and the bone it hangs from. */
  part: Schema.optionalKey(
    Schema.Union([SceneObject, Schema.Array(SceneObject).check(Schema.isMaxLength(16))]),
  ),
  /** Joint positions in Blender axes (Z up, facing -Y), root first: hip, knee, ankle, toe. */
  points: Schema.optionalKey(
    Schema.Array(Point).check(Schema.isMinLength(2), Schema.isMaxLength(33)),
  ),
  /** Without points: how many bones to place along the part. */
  bones: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 }))),
  /** Each part moves with one bone and never bends (a robot's plates). */
  rigid: Schema.optionalKey(Schema.Boolean),
});
export type GameBlenderRigChain = typeof GameBlenderRigChain.Type;

export const GameBlenderCharacterInput = Schema.Struct({
  /** The collection, the armature's name and the export's default stem. */
  name: BlenderName,
  /**
   * Rig a model already in the scene: a Mesh2Motion template whose layout matches it (its
   * skeleton fitted inside, its clips by name), or "chains" for one none fits.
   */
  rig: Schema.optionalKey(GameBlenderRig),
  /** The model's meshes or collections in the scene. Omitted: the object or collection called name (with body: none beside it). */
  objects: Schema.optionalKey(
    Schema.Array(SceneObject).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
  /** Where template joints are, by bone name ({hand_r: [x, y, z]}); the fit moves the rest with them. */
  joints: Schema.optionalKey(Schema.Record(Schema.String.check(Schema.isMaxLength(40)), Point)),
  /** Parts moved by one bone, never bent (props, armour plates): {object: bone}, or names for the nearest bone. */
  rigid: Schema.optionalKey(
    Schema.Union([
      Schema.Array(SceneObject).check(Schema.isMaxLength(64)),
      Schema.Record(
        SceneObject,
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
      ),
    ]),
  ),
  /** A human body to build as a static mesh and rig on the human template, with any objects beside it. */
  body: Schema.optionalKey(GameBlenderBody),
  /**
   * The template's clips by name (human: Idle_A, Walk, Jog, Sword_Attack, of its 234; fox: Walk,
   * Run, Bite), or on chains the roles (Idle, Walk, Attack). Omitted: idle, a move and an attack.
   */
  clips: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))).check(
      Schema.isMaxLength(48),
    ),
  ),
  /** With rig "chains": the chain spec (none: guessed from the parts). Spring chains on the standard skeleton are retired: an earlier call's get a pointer. */
  chains: Schema.optionalKey(
    Schema.Union([
      Schema.Array(GameBlenderRigChain).check(Schema.isMinLength(1), Schema.isMaxLength(48)),
      Schema.Array(GameBlenderChain).check(Schema.isMaxLength(16)),
    ]),
  ),
  /** With body: its standing height in metres, scaled to before it is rigged. */
  height: Schema.optionalKey(HeroHeight),
});
export type GameBlenderCharacterInput = typeof GameBlenderCharacterInput.Type;

/** How one baked clip moves the model: notes for the agent, never a refusal. */
export const GameBlenderRigFact = Schema.Struct({
  clip: Schema.String,
  frames: Schema.Number,
  /** The worst edge's length over its rest length, either way (the 99.9th percentile edge). */
  stretch: Schema.Number,
  stretchFrame: Schema.Number,
  stretchBone: Schema.String,
  /** The mesh that edge belongs to. */
  stretchPart: Schema.optionalKey(Schema.String),
  /** An IK gait's speed over the ground, m/s. */
  groundSpeed: Schema.optionalKey(Schema.Number),
  /** Feet on the ground: the share of frames, and how fast they move then (m/s, median and 90th percentile). */
  plantedFeet: Schema.optionalKey(
    Schema.Struct({ share: Schema.Number, slide: Schema.Number, slideMax: Schema.Number }),
  ),
  /** The deepest part other than a leg goes under the floor. */
  underFloor: Schema.optionalKey(
    Schema.Struct({ depth: Schema.Number, frame: Schema.Number, bone: Schema.String }),
  ),
  /** Chains that come far closer than at rest (through each other). */
  crossing: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        chains: Schema.Array(Schema.String),
        gap: Schema.Number,
        rest: Schema.Number,
        frame: Schema.Number,
      }),
    ),
  ),
});
export type GameBlenderRigFact = typeof GameBlenderRigFact.Type;

export const GameBlenderCharacterResult = Schema.Struct({
  text: Schema.String,
  armature: Schema.String,
  meshes: Schema.Array(Schema.String),
  clips: Schema.Array(Schema.String),
  /** Chain name to its bones. */
  chains: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Per clip, how it moves the model. */
  facts: Schema.Array(GameBlenderRigFact),
});
export type GameBlenderCharacterResult = typeof GameBlenderCharacterResult.Type;

/**
 * game_blender op animate: a move written as poses on beats, compiled onto a standard-skeleton character as a
 * clip, then measured and pictured beside a library clip.
 */
export const GameAnimateInput = Schema.Struct({
  /** The character's armature in the live scene: game_blender op character's name. */
  character: BlenderName,
  /** The clip's name in the game; animating it again replaces it. */
  clip: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,47}$/)),
  /** The move: {start?, poses?, craft?, beats: [{at, pose?, ease?, ...pose keys}]}, as the kit's animate module describes it (op code: print(sys.modules["kurambit.animate"].__doc__)). */
  spec: Schema.Record(Schema.String, Schema.Unknown),
  /**
   * The library clip measured beside it: "Sword_Regular_Combo" or "<pack-id>:<clip>". Omitted:
   * the clip in the lock's animation packs whose name shares the most words with clip.
   */
  bar: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))),
});
export type GameAnimateInput = typeof GameAnimateInput.Type;
export const GameAnimateResult = Schema.Struct({
  text: Schema.String,
  /** The clip as the scene names it: <character>|<clip>; the export names it clip. */
  action: Schema.String,
  /** Game-relative folder of this pass: spec.json, bundle.json and the pictures. */
  pass: Schema.String,
  /** Game-relative PNGs: the contact sheet, the onion strip, the footprint and the curves (the screenshots, in order). */
  images: Schema.Array(Schema.String),
  /** Hip drop, reach, clearance, slide, joint limits and the prop through the body: facts, never silently fixed. */
  warnings: Schema.Array(Schema.String),
  screenshots: Schema.optionalKey(Schema.Array(GameBlenderLookScreenshot)),
});
export type GameAnimateResult = typeof GameAnimateResult.Type;

/** A turnaround sheet's views, left to right: which side of the subject each shows. */
const SheetViews = Schema.Array(Schema.Literals(["front", "back", "left", "right"])).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(4),
);
const SheetPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const AtlasSize = Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 4096 }));

export const GameBlenderPaintInput = Schema.Struct({
  /** Meshes to paint, or a character's armature (its meshes), in the live scene. */
  objects: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  /** Game path of the turnaround sheet: the person's own image. */
  sheet: SheetPath,
  /** The sheet's views left to right, when the measured reading is wrong. */
  views: Schema.optionalKey(SheetViews),
  /** Sheet pixel boxes [x0, y0, x1, y1] the mirrored side view must not copy (a scabbard on one hip). */
  noMirror: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])).check(
      Schema.isMaxLength(16),
    ),
  ),
  /**
   * A standard-skeleton character posed as the sheet for the projection only: arms degrees below
   * horizontal, legs degrees apart. Omitted: painted as the live scene poses it.
   */
  pose: Schema.optionalKey(
    Schema.Struct({
      arms: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 90 })),
      legs: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
    }),
  ),
  /** The atlas side in px (the head's own atlas is half); at most STYLE.json's budget.texture, its default. */
  size: Schema.optionalKey(AtlasSize),
});
export type GameBlenderPaintInput = typeof GameBlenderPaintInput.Type;
export const GameBlenderPaintResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative image of each view with the model's outline over it. */
  alignment: Schema.String,
  blend: Schema.String,
});
export type GameBlenderPaintResult = typeof GameBlenderPaintResult.Type;
