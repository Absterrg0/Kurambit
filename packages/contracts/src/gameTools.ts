// The game tools' inputs, as an agent calls them. Each tool takes one op per call, named by its
// key ({"look": {...}}): an MCP tool's input must be one object at the top (providers refuse a
// top-level union), and the key keeps every op's own typed input whole beside the others.
import * as Schema from "effect/Schema";
import { GameModelSheetInput, GameMediaSaveFields, GameSavedDeleteFields } from "./game.ts";
import { GameGenerateInput, GameGenerateWaitInput, GameImageEditInput } from "./gameArt.ts";
import {
  GameAnimateInput,
  GameBlenderAssetsImportInput,
  GameBlenderAssetsSearchInput,
  GameBlenderCarveInput,
  GameBlenderCharacterInput,
  GameBlenderCodeInput,
  GameBlenderExportInput,
  GameBlenderLookInput,
  GameBlenderPaintInput,
  GameBlenderRenderSpritesInput,
  GameBlenderSceneInput,
} from "./gameBlender.ts";
import { GameBotRunInput, GameBotViewInput } from "./gameBot.ts";
import { GameBuildId } from "./gameBuildId.ts";
import {
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartInput,
} from "./gameExplore.ts";
import { GameAssetsAddInput, GameAssetsSearchInput } from "./gameLibrary.ts";
import { GameKeepGoingInput, GameKeepGoingSteerInput } from "./gameRun.ts";
import {
  GameUnityConsoleInput,
  GameUnityEditInput,
  GameUnityEvalInput,
  GameUnityPlayInput,
  GameUnityScreenshotInput,
} from "./gameUnity.ts";

/** An op that takes nothing: `{}`. An empty Struct's JSON Schema would not say it is an object. */
const Nothing = Schema.Record(Schema.String, Schema.Never);

const commandId = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
    description: "Your id for this request: a retry with the same id applies once.",
  }),
);

const op = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

export const GameCheckToolInput = Schema.Struct({
  look: op(Nothing),
  final: op(
    Schema.Struct({
      critique: Schema.optionalKey(
        Schema.Struct({
          major: Schema.Boolean,
          biggest: Schema.String.check(Schema.isMaxLength(400)),
        }).annotate({
          description:
            "The biggest difference from the reference picture left, and whether it is major.",
        }),
      ),
    }),
  ),
  facts: op(
    Schema.Struct({
      build: Schema.optionalKey(GameBuildId),
      skilled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  status: op(Schema.Struct({ checkSources: Schema.optionalKey(Schema.Boolean) })),
});
export type GameCheckToolInput = typeof GameCheckToolInput.Type;

export const GamePlayToolInput = Schema.Struct({
  preview: op(Nothing),
  start: op(GameExploreStartInput),
  act: op(GameExploreActInput),
  close: op(GameExploreCloseInput),
  bot: op(GameBotRunInput),
  bot_view: op(GameBotViewInput),
  replay: op(Nothing),
  model_sheet: op(GameModelSheetInput),
});
export type GamePlayToolInput = typeof GamePlayToolInput.Type;

export const GameAssetsToolInput = Schema.Struct({
  search: op(GameAssetsSearchInput),
  add: op(GameAssetsAddInput),
  generate: op(GameGenerateInput),
  wait: op(GameGenerateWaitInput),
  image_edit: op(GameImageEditInput),
  import: op(Nothing),
});
export type GameAssetsToolInput = typeof GameAssetsToolInput.Type;

export const GameBlenderToolInput = Schema.Struct({
  code: op(GameBlenderCodeInput),
  look: op(GameBlenderLookInput),
  scene: op(GameBlenderSceneInput),
  export: op(GameBlenderExportInput),
  character: op(GameBlenderCharacterInput),
  paint: op(GameBlenderPaintInput),
  carve: op(GameBlenderCarveInput),
  sprites: op(GameBlenderRenderSpritesInput),
  animate: op(GameAnimateInput),
  asset_search: op(GameBlenderAssetsSearchInput),
  asset_import: op(GameBlenderAssetsImportInput),
});
export type GameBlenderToolInput = typeof GameBlenderToolInput.Type;

export const GameBuildsToolInput = Schema.Struct({
  list: op(
    Schema.Struct({
      before: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    }),
  ),
  compare: op(Schema.Struct({ from: GameBuildId, to: GameBuildId })),
  restore: op(Schema.Struct({ build: GameBuildId, commandId })),
  saved: op(
    Schema.Struct({
      save: Schema.optionalKey(Schema.Struct(GameMediaSaveFields)),
      delete: Schema.optionalKey(GameSavedDeleteFields.name),
    }),
  ),
  export: op(Schema.Struct({ target: Schema.Literals(["Web", "Linux", "Windows"]) })),
  package: op(Schema.Struct({ target: Schema.Literals(["web", "windows"]) })),
  stop: op(Nothing),
});
export type GameBuildsToolInput = typeof GameBuildsToolInput.Type;

/** Keep going is one operation: its status, or a mode, a budget or the person's words for it. */
export const GameKeepGoingToolInput = Schema.Struct({
  mode: Schema.optionalKey(GameKeepGoingInput.fields.mode),
  budgetMinutes: GameKeepGoingInput.fields.budgetMinutes,
  steer: Schema.optionalKey(GameKeepGoingSteerInput.fields.text),
  commandId,
});
export type GameKeepGoingToolInput = typeof GameKeepGoingToolInput.Type;

export const GameUnityToolInput = Schema.Struct({
  tools: op(Nothing),
  edit: op(GameUnityEditInput),
  eval: op(GameUnityEvalInput),
  recompile: op(Nothing),
  play: op(GameUnityPlayInput),
  console: op(GameUnityConsoleInput),
  screenshot: op(GameUnityScreenshotInput),
});
export type GameUnityToolInput = typeof GameUnityToolInput.Type;
