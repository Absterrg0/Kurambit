import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const GameAsset = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("model"),
  source: Schema.String,
  script: Schema.String,
  export: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
});
export const GameManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  brief: Schema.String,
  artDirection: Schema.String,
  engine: Schema.Struct({ name: Schema.Literal("godot"), version: Schema.String }),
  godotProject: Schema.String,
  assets: Schema.Array(GameAsset),
});
export type GameManifest = typeof GameManifest.Type;
export type GameAsset = typeof GameAsset.Type;
export class GameOperationError extends Schema.TaggedError<GameOperationError>()(
  "GameOperationError",
  {
    operation: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      "io",
      "invalid-project",
      "invalid-path",
      "tool-missing",
      "wrong-version",
      "templates-missing",
      "command-failed",
      "busy",
      "unsupported-platform",
      "checksum",
      "download",
      "project-not-found",
    ]),
    detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const fixes = {
      "invalid-project": "Open a folder containing a valid game.json, or create a new game.",
      "invalid-path": "Use a relative path inside the game project.",
      "tool-missing":
        "The executable is missing, is not a file, or cannot be executed. Fix its path in Settings > General > Game tools or GAME_STUDIO_BLENDER / GAME_STUDIO_GODOT. To use the managed version, clear the override and click Install tools in Game panel > Toolchain.",
      "wrong-version":
        "Use Godot 4.7.x and Blender 4.2 or later. Fix the executable path in Settings > General > Game tools. To use the managed version, clear the override and click Install tools in Game panel > Toolchain.",
      "templates-missing":
        "Install Godot export templates matching this executable's exact version at the path below. For managed tools, clear executable overrides in Settings > General > Game tools, then click Install tools in Game panel > Toolchain.",
      "command-failed":
        "The command failed. Read builds/logs for stdout and stderr, fix the reported error, and retry.",
      busy: "Another operation is running for this game. Wait for it or press Stop.",
      checksum: "The downloaded artifact failed its published checksum. Retry the install.",
      download: "The tool download failed. Check network access and retry the install.",
      io: "Check that the path exists and is writable. Read the server log for the underlying error.",
      "unsupported-platform": "Managed installation currently supports Linux x86_64 only.",
      "project-not-found":
        "Open this game as a project and start a thread before using game tools.",
    };
    return `${this.operation}: ${fixes[this.reason]} Path: ${this.path}${this.detail ? `\n${this.detail}` : ""}`;
  }
}
// Tool failures are JSON objects, so include the computed recovery message explicitly.
export const GameOperationFailure = Schema.Struct({
  _tag: GameOperationError.fields._tag,
  operation: GameOperationError.fields.operation,
  path: GameOperationError.fields.path,
  reason: GameOperationError.fields.reason,
  detail: GameOperationError.fields.detail,
  message: Schema.String,
});
export const GameToolStatus = Schema.Struct({
  tool: Schema.Literals(["blender", "godot"]),
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  ready: Schema.Boolean,
  verified: Schema.Boolean,
  message: Schema.String,
});
export const GameToolchainStatus = Schema.Struct({
  toolsDirectory: Schema.String,
  installing: Schema.Boolean,
  tools: Schema.Array(GameToolStatus),
});
export type GameToolchainStatus = typeof GameToolchainStatus.Type;
export const GameProcessResult = Schema.Struct({
  pid: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  logPath: Schema.String,
});
export type GameProcessResult = typeof GameProcessResult.Type;
export const GameStatus = Schema.Struct({
  root: Schema.String,
  manifest: GameManifest,
  toolchain: GameToolchainStatus,
  assets: Schema.Array(Schema.Struct({ ...GameAsset.fields, usedBy: Schema.Array(Schema.String) })),
  scenes: Schema.Array(Schema.String),
  builds: Schema.Array(
    Schema.Struct({ target: Schema.String, path: Schema.String, updatedAt: Schema.String }),
  ),
  processes: Schema.Array(
    Schema.Struct({ pid: Schema.Number, operation: Schema.String, logPath: Schema.String }),
  ),
  previewUrl: Schema.NullOr(Schema.String),
  logsDirectory: Schema.String,
  operation: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["running", "succeeded", "failed"]),
      message: Schema.String,
    }),
  ),
});
export type GameStatus = typeof GameStatus.Type;
export const GameCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  parentDirectory: Schema.String,
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.optionalKey(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type GameCreateInput = typeof GameCreateInput.Type;
export const GameOpenInput = Schema.Struct({ path: Schema.String, modelSelection: ModelSelection });
export const GameProjectResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  root: Schema.String,
});
export const GameThreadInput = Schema.Struct({ threadId: ThreadId });
export const GameAction = Schema.Literals([
  "verify",
  "preview",
  "rebuild",
  "native",
  "stop",
  "export-linux",
]);
export type GameAction = typeof GameAction.Type;
export const GameActionInput = Schema.Struct({ threadId: ThreadId, action: GameAction });
export const GameActionResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
  path: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  process: Schema.NullOr(GameProcessResult),
});
export type GameActionResult = typeof GameActionResult.Type;
export const GameConsoleMessage = Schema.Struct({
  level: Schema.Literals(["log", "info", "warning", "error"]),
  text: Schema.String,
});
export type GameConsoleMessage = typeof GameConsoleMessage.Type;
export const GamePlaytestStep = Schema.Union([
  Schema.Struct({
    key: Schema.String.annotate({
      description: 'Key to hold while playing, such as "ArrowUp", "w", "Space".',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold the key for this long." }),
  }),
  Schema.Struct({ waitMs: Schema.Number.annotate({ description: "Wait before the next step." }) }),
]);
export type GamePlaytestStep = typeof GamePlaytestStep.Type;
export const GamePlaytestScreenshot = Schema.Struct({
  label: Schema.String,
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type GamePlaytestScreenshot = typeof GamePlaytestScreenshot.Type;
export const GameWebPlaytestInput = Schema.Struct({
  steps: Schema.optionalKey(Schema.Array(GamePlaytestStep)),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  bootTimeoutMs: Schema.optionalKey(Schema.Number),
});
export type GameWebPlaytestInput = typeof GameWebPlaytestInput.Type;
export const GameWebPlaytestResult = Schema.Struct({
  success: Schema.Boolean,
  booted: Schema.Boolean,
  bootMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
  consoleMessages: Schema.Array(GameConsoleMessage),
  screenshots: Schema.Array(GamePlaytestScreenshot),
});
export type GameWebPlaytestResult = typeof GameWebPlaytestResult.Type;
export const GameBlenderInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
  script: Schema.String,
  thumbnail: Schema.optionalKey(Schema.Boolean),
  reset: Schema.optionalKey(Schema.Boolean),
});
export const GameBlenderResult = Schema.Struct({
  asset: GameAsset,
  objects: Schema.Number,
  meshes: Schema.Number,
  materials: Schema.Number,
  dimensions: Schema.Array(Schema.Number),
  warnings: Schema.Array(Schema.String),
  process: GameProcessResult,
});
