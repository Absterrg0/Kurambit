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
export const GameTemplateId = Schema.Literals(["3d-explorer", "2d-platformer", "blank"]);
export type GameTemplateId = typeof GameTemplateId.Type;
export const GameTemplate = Schema.Struct({
  id: GameTemplateId,
  name: Schema.String,
  description: Schema.String,
  dimension: Schema.Literals(["2d", "3d"]),
});
export type GameTemplate = typeof GameTemplate.Type;
/**
 * The starter templates the New game dialog offers. Template files live under
 * apps/server/templates/<id>/; a server test keeps this list and those folders in step.
 */
export const GAME_TEMPLATES: readonly GameTemplate[] = [
  {
    id: "3d-explorer",
    name: "3D Explorer",
    description:
      "Third-person exploration with real collision: collect the relics, cross the lava, unlock the gate.",
    dimension: "3d",
  },
  {
    id: "2d-platformer",
    name: "2D Platformer",
    description:
      "Side-scrolling platformer with real pixel art: run, jump and stomp through two levels of coins, spikes and slimes.",
    dimension: "2d",
  },
  {
    id: "blank",
    name: "Blank",
    description: "An empty Godot project: a camera, a light, and Web and Linux export presets.",
    dimension: "3d",
  },
];
export const DEFAULT_GAME_TEMPLATE: GameTemplateId = "3d-explorer";
/**
 * The design phase recorded in the manifest. A `draft` design is the only thing
 * the agent may work on; `approved` releases the build turns.
 */
export const GameDesign = Schema.Struct({
  status: Schema.Literals(["draft", "approved"]),
  approvedAt: Schema.optionalKey(Schema.String),
});
export type GameDesign = typeof GameDesign.Type;
export const GameManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  brief: Schema.String,
  artDirection: Schema.String,
  // Games created before starter templates existed have no template key.
  template: Schema.optionalKey(GameTemplateId),
  // Games created before the design step existed have no design key.
  design: Schema.optionalKey(GameDesign),
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
      "unknown-template",
      "starter-templates-missing",
      "command-failed",
      "busy",
      "unsupported-platform",
      "checksum",
      "download",
      "project-not-found",
      "design-already-approved",
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
        "The executable is missing, is not a file, or cannot be executed. Fix its path in Settings > General > Game tools or GAME_STUDIO_BLENDER / GAME_STUDIO_GODOT. To use the managed version, clear the override and click Install tools in Settings > General > Game tools.",
      "wrong-version":
        "Use Godot 4.7.x and Blender 4.2 or later. Fix the executable path in Settings > General > Game tools. To use the managed version, clear the override and click Install tools in Settings > General > Game tools.",
      "templates-missing":
        "Install Godot export templates matching this executable's exact version at the path below. For managed tools, clear executable overrides in Settings > General > Game tools, then click Install tools in Settings > General > Game tools.",
      "unknown-template": "Pick a starter template from the New game dialog.",
      "starter-templates-missing":
        "Game Studio's starter template files are missing. Reinstall or update the app.",
      "command-failed":
        "The command failed. Read builds/logs for stdout and stderr, fix the reported error, and retry.",
      busy: "Another operation is running for this game. Wait for it or press Stop.",
      checksum: "The downloaded artifact failed its published checksum. Retry the install.",
      download: "The tool download failed. Check network access and retry the install.",
      io: "Check that the path exists and is writable. Read the server log for the underlying error.",
      "unsupported-platform": "Managed installation currently supports Linux x86_64 only.",
      "project-not-found":
        "Open this game as a project and start a thread before using game tools.",
      "design-already-approved": "The design is already approved.",
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
export const GameViewport = Schema.Struct({ width: Schema.Number, height: Schema.Number });
export type GameViewport = typeof GameViewport.Type;
export const GamePlaytestFrame = Schema.Struct({
  label: Schema.String,
  path: Schema.String,
});
export type GamePlaytestFrame = typeof GamePlaytestFrame.Type;
export const GameLastPlaytest = Schema.Struct({
  at: Schema.String,
  directory: Schema.String,
  success: Schema.Boolean,
  responded: Schema.Boolean,
  changedPercent: Schema.Number,
  consoleErrorCount: Schema.Number,
  frames: Schema.Array(GamePlaytestFrame),
  /** The web build was rebuilt after this run. */
  stale: Schema.Boolean,
});
export type GameLastPlaytest = typeof GameLastPlaytest.Type;
export const GameStatus = Schema.Struct({
  root: Schema.String,
  manifest: GameManifest,
  /** The design phase, or null for games created before it existed. */
  design: Schema.NullOr(GameDesign),
  /** Game-relative paths, when the file exists on disk. */
  designPath: Schema.NullOr(Schema.String),
  briefPath: Schema.NullOr(Schema.String),
  toolchain: GameToolchainStatus,
  assets: Schema.Array(Schema.Struct({ ...GameAsset.fields, usedBy: Schema.Array(Schema.String) })),
  scenes: Schema.Array(Schema.String),
  /**
   * The design resolution from `godot/project.godot`, in which the web preview
   * is framed. Falls back to Godot's own default when the project does not set one.
   */
  viewport: GameViewport,
  /** A web build exists but game sources changed after it: play would be out of date. */
  webBuildStale: Schema.Boolean,
  builds: Schema.Array(
    Schema.Struct({ target: Schema.String, path: Schema.String, updatedAt: Schema.String }),
  ),
  processes: Schema.Array(
    Schema.Struct({ pid: Schema.Number, operation: Schema.String, logPath: Schema.String }),
  ),
  previewUrl: Schema.NullOr(Schema.String),
  logsDirectory: Schema.String,
  lastPlaytest: Schema.NullOr(GameLastPlaytest),
  operation: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["running", "succeeded", "failed"]),
      message: Schema.String,
      /** When the operation started, so clients can show elapsed time honestly. */
      at: Schema.String,
    }),
  ),
});
export type GameStatus = typeof GameStatus.Type;
export const GameCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  parentDirectory: Schema.String,
  template: Schema.optionalKey(GameTemplateId),
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Write and approve a design before the first build turn. Defaults to true. */
  planFirst: Schema.optionalKey(Schema.Boolean),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type GameCreateInput = typeof GameCreateInput.Type;
export const GameDesignApprovalResult = Schema.Struct({ approvedAt: Schema.String });
export type GameDesignApprovalResult = typeof GameDesignApprovalResult.Type;
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
  Schema.Struct({
    keys: Schema.Array(Schema.String).annotate({
      description:
        'Keys to hold at the same time, such as ["Shift", "w"] for a running jump or ["w", "Space"].',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold every key for this long." }),
  }),
  Schema.Struct({ waitMs: Schema.Number.annotate({ description: "Wait before the next step." }) }),
  Schema.Struct({
    click: Schema.Literals(["left", "middle", "right"]).annotate({
      description:
        "Click this mouse button at the centre of the game canvas. Web games need a click before they can capture the pointer, and menu buttons need a click to press them.",
    }),
  }),
  Schema.Struct({
    mouseMove: Schema.Struct({ dx: Schema.Number, dy: Schema.Number }).annotate({
      description:
        "Move the pointer by dx/dy pixels from its current position, for mouse-look and camera controls.",
    }),
  }),
  Schema.Struct({
    screenshot: Schema.String.check(Schema.isMaxLength(80)).annotate({
      description: "Capture a frame mid-sequence and label it, for evidence between steps.",
    }),
  }),
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
  responded: Schema.Boolean,
  /** Share of sampled pixels that changed between the boot and after-steps frames. */
  changedPercent: Schema.Number,
  message: Schema.String,
  consoleMessages: Schema.Array(GameConsoleMessage),
  screenshots: Schema.Array(GamePlaytestScreenshot),
  /** Game-relative evidence directory, when the service persisted this run. */
  evidenceDirectory: Schema.optionalKey(Schema.String),
});
export type GameWebPlaytestResult = typeof GameWebPlaytestResult.Type;
export const GameCheckIssue = Schema.Struct({
  file: Schema.String,
  line: Schema.optionalKey(Schema.Number),
  message: Schema.String,
});
export type GameCheckIssue = typeof GameCheckIssue.Type;
export const GameCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(GameCheckIssue),
  warnings: Schema.Array(GameCheckIssue),
  durationMs: Schema.Number,
});
export type GameCheckResult = typeof GameCheckResult.Type;
export const GameSceneNode = Schema.Struct({
  /** Scene-relative node path; "." is the scene root. */
  path: Schema.String,
  name: Schema.String,
  type: Schema.String,
  script: Schema.optionalKey(Schema.String),
  groups: Schema.Array(Schema.String),
  position: Schema.optionalKey(Schema.Array(Schema.Number)),
  collisionLayer: Schema.optionalKey(Schema.Number),
  collisionMask: Schema.optionalKey(Schema.Number),
  /** Direct child names, in scene order. */
  children: Schema.Array(Schema.String),
});
export type GameSceneNode = typeof GameSceneNode.Type;
export const GameSceneInspectInput = Schema.Struct({ scenePath: Schema.String });
export const GameSceneInspectResult = Schema.Struct({
  scenePath: Schema.String,
  nodes: Schema.Array(GameSceneNode),
  nodeCount: Schema.Number,
  truncated: Schema.Boolean,
});
export type GameSceneInspectResult = typeof GameSceneInspectResult.Type;
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
