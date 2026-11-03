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
