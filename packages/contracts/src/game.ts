import * as Schema from "effect/Schema";
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
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const fixes = {
      "invalid-project": "Open a folder containing a valid game.json, or create a new game.",
      "invalid-path": "Use a relative path inside the game project.",
      "tool-missing":
        "Install the managed tools, or fix the executable path in server settings or GAME_STUDIO_BLENDER / GAME_STUDIO_GODOT.",
      "wrong-version":
        "Use Godot 4.7.x and Blender 4.2 or later. Fix the configured executable path or install the managed tools.",
      "templates-missing":
        "Install export templates matching this Godot executable's exact version, or use the managed install.",
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
    return `${this.operation}: ${fixes[this.reason]} Path: ${this.path}`;
  }
}
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
export const GameBlenderInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
  script: Schema.String,
  thumbnail: Schema.optionalKey(Schema.Boolean),
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
