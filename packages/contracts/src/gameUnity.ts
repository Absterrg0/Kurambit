import * as Schema from "effect/Schema";
import { GameCheckIssue } from "./game.ts";

/** The live Unity editor through Unity's official `unity mcp` server, behind GameUnity. */

export const GameUnityEditInput = Schema.Struct({
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)).annotate({
    description:
      "One editor tool from game_unity_tools, such as a gameobject or component tool. Builds, tests, packages and editor lifecycle are not reachable here.",
  }),
  arguments: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "The tool's arguments, exactly as game_unity_tools describes its input schema.",
    }),
  ),
});
export type GameUnityEditInput = typeof GameUnityEditInput.Type;

export const GameUnityEvalInput = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(20_000)).annotate({
    description:
      "C# statements run on the editor's main thread; `return <value>;` sends a value back. UnityEngine and UnityEditor are available.",
  }),
});
export type GameUnityEvalInput = typeof GameUnityEvalInput.Type;

export const GameUnityPlayInput = Schema.Struct({
  action: Schema.Literals(["start", "stop"]),
});
export type GameUnityPlayInput = typeof GameUnityPlayInput.Type;

export const GameUnityConsoleInput = Schema.Struct({
  level: Schema.optionalKey(Schema.Literals(["log", "warn", "error"])),
  tail: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type GameUnityConsoleInput = typeof GameUnityConsoleInput.Type;

export const GameUnityScreenshotInput = Schema.Struct({
  maxSize: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 1920 }))),
});
export type GameUnityScreenshotInput = typeof GameUnityScreenshotInput.Type;

export const GameUnityToolsResult = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      /** The tool's JSON input schema, as the editor publishes it. */
      input: Schema.Unknown,
    }),
  ),
});
export type GameUnityToolsResult = typeof GameUnityToolsResult.Type;

export const GameUnityTextResult = Schema.Struct({ text: Schema.String });
export type GameUnityTextResult = typeof GameUnityTextResult.Type;

export const GameUnityRecompileResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(GameCheckIssue),
  warnings: Schema.Array(GameCheckIssue),
  text: Schema.String,
});
export type GameUnityRecompileResult = typeof GameUnityRecompileResult.Type;

export const GameUnityScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export const GameUnityScreenshotResult = Schema.Struct({
  text: Schema.String,
  screenshot: Schema.optionalKey(GameUnityScreenshot),
});
export type GameUnityScreenshotResult = typeof GameUnityScreenshotResult.Type;
