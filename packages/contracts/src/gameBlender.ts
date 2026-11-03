import * as Schema from "effect/Schema";

/** Live Blender through the pinned mcp-for-blender server, behind GameBlender. */

export const GameBlenderCodeInput = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type GameBlenderCodeInput = typeof GameBlenderCodeInput.Type;
export const GameBlenderCodeResult = Schema.Struct({ output: Schema.String });
export type GameBlenderCodeResult = typeof GameBlenderCodeResult.Type;

export const GameBlenderLookInput = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["viewport", "camera", "angles", "frames"])),
  target: Schema.optionalKey(Schema.Array(Schema.String)),
  views: Schema.optionalKey(Schema.Array(Schema.String)),
  distance: Schema.optionalKey(Schema.Number),
  shading: Schema.optionalKey(
    Schema.Literals(["solid", "material", "rendered", "wireframe", "xray"]),
  ),
  frames: Schema.optionalKey(Schema.Array(Schema.Number)),
  frameCount: Schema.optionalKey(Schema.Number),
  view: Schema.optionalKey(Schema.String),
  maxSize: Schema.optionalKey(Schema.Number),
});
export type GameBlenderLookInput = typeof GameBlenderLookInput.Type;
export const GameBlenderLookScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type GameBlenderLookScreenshot = typeof GameBlenderLookScreenshot.Type;
export const GameBlenderLookResult = Schema.Struct({
  text: Schema.String,
  screenshot: Schema.optionalKey(GameBlenderLookScreenshot),
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
  source: Schema.Literals(["polyhaven", "sketchfab", "polypizza"]),
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/)),
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
  /** Game-relative GLB under the engine directory the game can load; run game_import after. */
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
   * (`godot/` or `web/`) and end with `.glb`. Omitted means
   * `<engine dir>/assets/blender/scene.glb` (`unity/Assets/Blender/scene.glb` for Unity).
   */
  file: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
});
export type GameBlenderExportInput = typeof GameBlenderExportInput.Type;
export const GameBlenderExportResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative .blend source that stays in the game. */
  blend: Schema.String,
  /** Game-relative GLB under the engine directory the game can load; run game_import after. */
  export: Schema.String,
});
export type GameBlenderExportResult = typeof GameBlenderExportResult.Type;

/** Named views; the four sides take `elevation`, top looks straight down, isometric is 45° round and 30° down. */
export const GameBlenderSpriteViewName = Schema.Literals([
  "front",
  "back",
  "left",
  "right",
  "top",
  "isometric",
]);
export const GameBlenderSpriteView = Schema.Union([
  GameBlenderSpriteViewName,
  Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,16}$/)),
    /** Degrees round the subject: 0 sees its front (-Y), 90 shows it facing screen right. */
    azimuth: Schema.Number.check(Schema.isBetween({ minimum: -360, maximum: 360 })),
    /** Degrees the camera looks down: 0 level, 90 straight down. */
    elevation: Schema.Number.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  }),
]);
export type GameBlenderSpriteView = typeof GameBlenderSpriteView.Type;

const SpriteSize = Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 512 }));

export const GameBlenderRenderSpritesInput = Schema.Struct({
  /** Game-relative path prefix under the engine directory; frames are `<output>_0.png`, `<output>_1.png`, ... */
  output: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  /** Object or collection names; children come along. Omitted means every visible object in the scene. */
  objects: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(64))),
  views: Schema.optionalKey(
    Schema.Array(GameBlenderSpriteView).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
  /** Degrees the front/back/left/right/isometric cameras look down; 30-45 for a top-down 3/4 look. */
  elevation: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: -89, maximum: 89 })),
  ),
  action: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  frames: Schema.optionalKey(
    Schema.Array(Schema.Number).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
  frameStart: Schema.optionalKey(Schema.Number),
  frameEnd: Schema.optionalKey(Schema.Number),
  frameCount: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  /** A looping cycle leaves out the end frame, which repeats the start. Default true. */
  loop: Schema.optionalKey(Schema.Boolean),
  /** Canvas width in pixels, and height unless `height` is given. Default 64. */
  size: Schema.optionalKey(SpriteSize),
  height: Schema.optionalKey(SpriteSize),
  /** feet: the lowest point across all frames sits on the bottom margin; center: the subject is centred. */
  anchor: Schema.optionalKey(Schema.Literals(["feet", "center"])),
  /** Clear pixels kept on every side of the subject. */
  margin: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))),
  lighting: Schema.optionalKey(Schema.Literals(["studio", "scene"])),
  pixelArt: Schema.optionalKey(
    Schema.Struct({
      /** A game-relative PNG or folder of PNGs, or a library pack id added to this game. */
      palette: Schema.optionalKey(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
      ),
      colors: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 64 }))),
      downscale: Schema.optionalKey(Schema.Literals(["area", "nearest"])),
      /** true for the palette's darkest colour, or a #rrggbb colour. */
      outline: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
      supersample: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
      ),
    }),
  ),
  /** Also write `<output>_sheet.png`: frames in a row, one row per view. */
  sheet: Schema.optionalKey(Schema.Boolean),
});
export type GameBlenderRenderSpritesInput = typeof GameBlenderRenderSpritesInput.Type;
export const GameBlenderRenderSpritesResult = Schema.Struct({
  text: Schema.String,
  /** Game-relative PNGs written, in view then frame order. */
  files: Schema.Array(Schema.String),
  sheet: Schema.optionalKey(Schema.String),
  /** Game-relative contact sheet of every frame, enlarged; attached as the image. */
  contactSheet: Schema.String,
  screenshot: Schema.optionalKey(GameBlenderLookScreenshot),
});
export type GameBlenderRenderSpritesResult = typeof GameBlenderRenderSpritesResult.Type;
