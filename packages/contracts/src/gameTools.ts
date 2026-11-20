// The game tools' inputs, as an agent calls them. Each tool takes one op per call, named by its
// key ({"look": {...}}): an MCP tool's input must be one object at the top (providers refuse a
// top-level union), and the key keeps every op's own typed input whole beside the others.
import * as Schema from "effect/Schema";
import { GameAddonId, GameModelSheetInput } from "./game.ts";
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
} from "./gameBlender.ts";
import { GameBotRunInput } from "./gameBot.ts";
import { ThreadId } from "./baseSchemas.ts";
import { GameBuildId } from "./gameBuildId.ts";
import { GameEvalInput, GameExploreCloseInput, GamePlayActInput } from "./gameExplore.ts";
import { GameAssetsAddInput, GameAssetsSearchInput } from "./gameLibrary.ts";
import { GameKeepGoingInput, GameKeepGoingSteerInput } from "./gameRun.ts";

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
});
export type GameCheckToolInput = typeof GameCheckToolInput.Type;

export const GamePlayToolInput = Schema.Struct({
  act: op(GamePlayActInput),
  close: op(GameExploreCloseInput),
  bot: op(GameBotRunInput),
  replay: op(
    Schema.Struct({
      save: Schema.optionalKey(Schema.String),
      delete: Schema.optionalKey(Schema.String),
      run: Schema.optionalKey(Schema.String),
      at: Schema.optionalKey(Schema.Finite),
    }),
  ),
  eval: op(GameEvalInput),
  model_sheet: op(GameModelSheetInput),
});
export type GamePlayToolInput = typeof GamePlayToolInput.Type;

export const GameAssetsToolInput = Schema.Struct({
  search: op(GameAssetsSearchInput),
  add: op(GameAssetsAddInput),
  // Published as a bare object: the fields are GameStyleLockInput's, decoded by the service and
  // taught by the art skill, so the look's schema is not paid for with every tool call.
  lock: op(Schema.Record(Schema.String, Schema.Unknown)),
  generate: op(
    Schema.Struct({
      ...GameGenerateInput.fields,
      // What op image_edit did: the prompt is the one change to this game image.
      edit: Schema.optionalKey(
        GameImageEditInput.fields.path.annotate({
          description: "A game image the prompt changes, for the person's pick.",
        }),
      ),
      transparent: GameImageEditInput.fields.transparent,
    }),
  ),
  wait: op(GameGenerateWaitInput),
  // Published bare like lock: GamePicturesInput, decoded by the service and taught by its skill.
  pictures: op(Schema.Record(Schema.String, Schema.Unknown)),
});
export type GameAssetsToolInput = typeof GameAssetsToolInput.Type;

export const GameBlenderToolInput = Schema.Struct({
  code: op(GameBlenderCodeInput),
  look: op(GameBlenderLookInput),
  export: op(GameBlenderExportInput),
  character: op(GameBlenderCharacterInput),
  // The art helpers stay until the art phase measures Blender's own tools against them (TOOLS §4).
  paint: op(GameBlenderPaintInput),
  carve: op(GameBlenderCarveInput),
  sprites: op(GameBlenderRenderSpritesInput),
  animate: op(GameAnimateInput),
  asset_search: op(GameBlenderAssetsSearchInput),
  asset_import: op(GameBlenderAssetsImportInput),
  addon: op(
    Schema.Struct({
      install: GameAddonId,
      /** The person said yes in the chat: required for an add-on that asks first or that they removed. */
      asked: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type GameBlenderToolInput = typeof GameBlenderToolInput.Type;

export const GameBuildsToolInput = Schema.Struct({
  list: op(
    Schema.Struct({
      before: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
      build: Schema.optionalKey(
        GameBuildId.annotate({ description: "One build, with what the harness measured on it." }),
      ),
    }),
  ),
  undo: op(
    Schema.Struct({
      build: GameBuildId,
      to: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Go back to this build: every later one goes." }),
      ),
      commandId,
    }),
  ),
  // A three.js game exports Web only (threeProfile.exportTargets).
  export: op(
    Schema.Struct({
      zip: Schema.optionalKey(
        Schema.Boolean.annotate({ description: "Also a ZIP of the Web build to hand out." }),
      ),
    }),
  ),
});
export type GameBuildsToolInput = typeof GameBuildsToolInput.Type;

/** A chat's copy of the game: listed only to a chat working in one. */
export const GameCopyToolInput = Schema.Struct({
  copies: op(Nothing),
  bring_in: op(Schema.Struct({ chat: Schema.optionalKey(ThreadId) })),
  update: op(Nothing),
});
export type GameCopyToolInput = typeof GameCopyToolInput.Type;

/** Keep going is one operation: its status, or a mode, a budget or the person's words for it. */
export const GameKeepGoingToolInput = Schema.Struct({
  mode: Schema.optionalKey(GameKeepGoingInput.fields.mode),
  budgetMinutes: GameKeepGoingInput.fields.budgetMinutes,
  steer: Schema.optionalKey(GameKeepGoingSteerInput.fields.text),
  commandId,
});
export type GameKeepGoingToolInput = typeof GameKeepGoingToolInput.Type;
