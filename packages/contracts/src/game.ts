import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { GameAssetFamily } from "./gameAssets.ts";
import { GameRunErrorReason, GameRunProfile } from "./gameRun.ts";

export const GameBlenderInputSource = Schema.Struct({
  /** Local handle the bpy script reads as `ASSET_INPUTS[name]`. */
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  /**
   * Where the source lives in this game: a game-relative path such as
   * `godot/assets/library/models/crate/crate.gltf`, or a Godot resource path
   * such as `res://assets/library/models/crate/crate.gltf`. Never a URL.
   */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type GameBlenderInputSource = typeof GameBlenderInputSource.Type;

/**
 * Bounded reference inputs for one Blender run. At most a few local models
 * and images, each small enough to stage beside the run. Supplying a source
 * only records it on the asset; it never claims the script used it or that
 * the result looks a certain way.
 */
export const GAME_BLENDER_INPUT_BOUNDS = {
  maxInputs: 4,
  maxFileBytes: 12_000_000,
  maxTotalBytes: 25_000_000,
  maxImageDimension: 8192,
  /**
   * Decoded pixels one staged image may hold (16 MP, e.g. 4096x4096). The
   * 8192px dimension bound alone permits 64 MP, whose single RGBA buffer is
   * 256 MB, so the header area rejects oversized images before any decode.
   */
  maxImagePixels: 16_777_216,
  /**
   * Decoded pixels all images in one run's named inputs may hold together
   * (direct images, glTF dependencies/data URIs and embedded GLB textures).
   */
  maxTotalImagePixels: 33_554_432,
  /** Extra files one .gltf may pull in (.bin, images); the rest is rejected. */
  maxDependencies: 16,
} as const;

export const GameAsset = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("model"),
  source: Schema.String,
  script: Schema.String,
  export: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String),
  /**
   * The named local sources this asset's latest run was given, as supplied
   * paths. Recording only: a binding never proves the script imported the
   * file or that the export looks a certain way. Absent on assets built
   * before named inputs existed, preserved when a later revision runs
   * without new inputs, and cleared when reset starts a fresh source.
   */
  inputs: Schema.optionalKey(Schema.Array(GameBlenderInputSource)),
  updatedAt: Schema.String,
});
export const GameTemplateId = Schema.Literals(["blank", "blank-three", "blank-unity"]);
export type GameTemplateId = typeof GameTemplateId.Type;
/**
 * The engine every game build runs on. Godot is the native lane; three.js is
 * the quick browser lane; Unity is the native lane on Unity 6.
 */
export const GameEngineId = Schema.Literals(["godot", "three", "unity"]);
export type GameEngineId = typeof GameEngineId.Type;
/** Game-relative directory holding a three.js game's static sources. */
export const THREE_PROJECT_DIRECTORY = "web";
/** Pinned three.js the browser lane vendors, so no install step is needed. */
export const THREE_PINNED_VERSION = "0.180.0";
/** Design resolution three.js games boot, explore and bot-play at. */
export const THREE_VIEWPORT = { width: 1280, height: 720 } as const;
/** Game-relative directory holding a Unity game's project. */
export const UNITY_PROJECT_DIRECTORY = "unity";
/**
 * The oldest Unity editor Kurambit accepts: the one `templates/blank-unity`
 * was authored with. Any newer Unity 6 (6000.x) editor works too.
 */
export const UNITY_MIN_VERSION = "6000.6.7f1";
/** Resolution Unity players boot, explore and screenshot at. */
export const UNITY_VIEWPORT = { width: 1280, height: 720 } as const;
export const GameTemplate = Schema.Struct({
  id: GameTemplateId,
  name: Schema.String,
  description: Schema.String,
  dimension: Schema.Literals(["2d", "3d"]),
  /**
   * The scene play starts in, which the check runs after the main scene so a
   * failure in gameplay initialization cannot hide behind the menu.
   */
  gameplayScene: Schema.optionalKey(Schema.String),
  /**
   * The template ships the read-only StudioProbe. Games built from such a
   * template owe a state probe: a playtest that cannot read one has proven
   * nothing about play, so it must not qualify the game.
   */
  probe: Schema.optionalKey(Schema.Boolean),
});
export type GameTemplate = typeof GameTemplate.Type;
/**
 * The starter templates the New game dialog offers. Template files live under
 * apps/server/templates/<id>/; a server test keeps this list and those folders in step.
 */
export const GAME_TEMPLATES: readonly GameTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description:
      "An empty Godot game inside a demo shell (title, pause, settings, end and credits screens), a game feel kit, a live state probe and Web, Windows and Linux export presets.",
    dimension: "3d",
    // The main scene is the shell's menu; the check also runs the gameplay scene it instances.
    gameplayScene: "res://scenes/game.tscn",
    probe: true,
  },
  {
    id: "blank-three",
    name: "Blank (browser)",
    description:
      "An empty three.js game inside a demo shell (title, pause, settings, end and credits screens), a game feel kit, a read-only studio probe and a single static web export. No install step; three.js is vendored.",
    dimension: "3d",
    // The page opens on the shell's title; "?play" boots straight into a run, so the check covers gameplay start.
    gameplayScene: "index.html?play",
    probe: true,
  },
  {
    id: "blank-unity",
    name: "Blank (Unity)",
    description:
      "An empty Unity 6 game inside a demo shell (title, pause, settings, controls, end and credits screens), HUD, feel, animation, camera and level kits, a live StudioProbe, Linux and Windows builds.",
    dimension: "3d",
    // Main.unity is the shell's entry; the check plays Game.unity, which boots straight into a run around it.
    gameplayScene: "Assets/Scenes/Game.unity",
    probe: true,
  },
];
export const DEFAULT_GAME_TEMPLATE: GameTemplateId = "blank";
/** The starter template a create request's engine maps to. */
export const gameTemplateForEngine = (engine: GameEngineId): GameTemplateId =>
  engine === "three" ? "blank-three" : engine === "unity" ? "blank-unity" : "blank";
export const GameManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  brief: Schema.String,
  artDirection: Schema.String,
  // Games created before starter templates existed have no template key.
  template: Schema.optionalKey(GameTemplateId),
  // Legacy and ignored: games no longer carry test suites; kept so older game.json files decode.
  testSuite: Schema.optionalKey(Schema.String),
  // Where the check runs the gameplay scene from; the blank template names it.
  gameplayScene: Schema.optionalKey(Schema.String),
  probe: Schema.optionalKey(Schema.Boolean),
  engine: Schema.Struct({ name: GameEngineId, version: Schema.String }),
  /** The engine project's folder in the game (godot/, web/, unity/). */
  project: Schema.optionalKey(Schema.String),
  /** The same folder under its legacy name: written beside `project` for one release so older installs open new games; read only through manifestProject. */
  godotProject: Schema.optionalKey(Schema.String),
  assets: Schema.Array(GameAsset),
  /**
   * Authored asset targets this game's inventory checks against. Each entry
   * names the files, scale/pivot conventions, animation and transition names,
   * collision and provenance promises one family owes. Absent on legacy games,
   * which inventory treats as having no authored requirements rather than as
   * missing everything. At most 16 families with at most 16 paths each.
   */
  families: Schema.optionalKey(Schema.Array(GameAssetFamily).check(Schema.isMaxLength(16))),
}).check(
  Schema.makeFilter((manifest) => (manifest.project ?? manifest.godotProject) !== undefined, {
    description: "a game.json that names its engine project folder (project)",
  }),
);
export type GameManifest = typeof GameManifest.Type;
/** The engine project's folder in the game: the one reader of the manifest's project key. */
export const manifestProject = (manifest: GameManifest): string =>
  manifest.project ?? manifest.godotProject ?? "";
/** The most files a game's sources may hold for a build: one bound for snapshots and Web builds. */
export const GAME_SOURCE_FILE_LIMIT = 50_000;
export const sourceLimitDetail = (project: string): string =>
  `The game's ${project}/ holds more than ${GAME_SOURCE_FILE_LIMIT.toLocaleString("en-US")} files a build reads; remove unused files (old exports, caches, copied packs) and retry.`;
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
      "low-memory",
      "unsupported-platform",
      "checksum",
      "download",
      "project-not-found",
      "thread-dispatch",
      "invalid-input",
      "license-missing",
      "source-changed",
      "unsafe-archive",
      "symlink",
      /** The operation was cancelled: a turn ended, a stop, a newer request. */
      "cancelled",
      /** A program Kurambit runs failed on its own; it says nothing about the game. */
      "tool-failed",
    ]),
    detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    /** A production run's own reason, when the failure was the run's. */
    runReason: Schema.optionalKey(GameRunErrorReason),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    const fixes = {
      "invalid-project": "Open a folder containing a valid game.json, or create a new game.",
      "invalid-path": "Use a relative path inside the game project.",
      symlink:
        "A symbolic link is on the way to this path. Game tools write only real files and folders inside the game and never follow a link; replace the link with a real folder or file and retry.",
      "tool-missing":
        "A program this needs is not installed, or its path is wrong. Ask the user to install it from the download page in the detail below (or fix its path in Settings > General > Game tools), then press Check again there.",
      "wrong-version":
        "The installed version is not one Kurambit can use: Godot 4.7.x, Blender 4.2 or later, Unity 6 (6000.x). Ask the user to install a supported version from the download page in the detail below, or point Settings > General > Game tools at one.",
      "templates-missing":
        "Godot's export templates for this exact Godot version are missing. Ask the user to open the Godot editor, choose Editor > Manage Export Templates and download them (or install the .tpz from https://godotengine.org/download), then press Check again in Settings > General > Game tools.",
      "unknown-template": "Pick a starter template from the New game dialog.",
      "starter-templates-missing":
        "Kurambit's starter template files are missing. Reinstall or update the app.",
      "command-failed":
        "The command failed. Read builds/logs for stdout and stderr, fix the reported error, and retry.",
      busy: "Another operation is running for this game, or another start on this machine (any game) is still taking its memory. Wait for it, or press Stop if it is your own work on this game.",
      "low-memory":
        "This machine has too little free memory to start this without risking it being killed mid-work. Close other apps, or wait a few minutes for other work to finish, then retry once. Retrying sooner gets the same answer.",
      checksum: "A helper Kurambit fetches failed its published checksum. Retry.",
      download:
        "A helper Kurambit fetches could not be downloaded. Check network access and retry.",
      io: "Check that the path exists and is writable. Read the server log for the underlying error.",
      "unsupported-platform":
        "This is not available on this operating system yet. Read the detail for what to install yourself.",
      "project-not-found":
        "Open this game as a project and start a thread before using game tools.",
      "thread-dispatch":
        "The turn that follows this game operation could not be sent. Retry the operation.",
      "invalid-input":
        "The request is outside the limits this operation accepts. Read the detail, shrink the request, and retry.",
      "license-missing":
        "Unity needs an active licence on this machine. Open Unity Hub, sign in, and add a Unity Personal licence under Preferences > Licenses, then retry. Kurambit never stores Unity credentials.",
      "source-changed":
        "The source changed: this library pack no longer matches the SHA-256 it was pinned with, so its bytes were not used. Pick another pack.",
      "unsafe-archive":
        "This library pack names an unsafe path or link, or unpacks past the size limits, so nothing from it was kept. Pick another pack.",
      cancelled:
        "The operation was cancelled before it finished (a turn ended, a stop, or a newer request). Retry it if it is still wanted.",
      "tool-failed":
        "A program Kurambit runs (the browser, the engine's editor or its CLI, an MCP server, the private display, ffmpeg) failed on its own. This says nothing about the game. Retry once; if it fails the same way, tell the user what the detail says.",
    };
    // A run holding the game is not cleared by Stop game, which stops only the caller's work.
    const fix =
      this.reason === "busy" && this.runReason === "run-live"
        ? "A production run is working on this game. Steer it from the game's chat, or stop the run; otherwise wait for it to end."
        : fixes[this.reason];
    return `${this.operation}: ${fix} Path: ${this.path}${this.detail ? `\n${this.detail}` : ""}`;
  }
}
// Tool failures are JSON objects, so include the computed recovery message explicitly.
export const GameOperationFailure = Schema.Struct({
  _tag: GameOperationError.fields._tag,
  operation: GameOperationError.fields.operation,
  path: GameOperationError.fields.path,
  reason: GameOperationError.fields.reason,
  detail: GameOperationError.fields.detail,
  runReason: GameOperationError.fields.runReason,
  message: Schema.String,
});
/**
 * Whose fault a failed game operation is: the build's (the game's own code or
 * content), a tool's (a program Kurambit runs, or a record it keeps), the
 * machine's (memory, or another operation holding the game), or the request's
 * (the caller asked for something invalid). The one place this is decided.
 */
export type GameOperationFault = "build" | "tool" | "machine" | "request";
type GameOperationReason = GameOperationError["reason"];
const FAULTS: Readonly<Record<GameOperationReason, GameOperationFault>> = {
  busy: "machine",
  "low-memory": "machine",
  cancelled: "machine",
  "command-failed": "build",
  "invalid-project": "build",
  symlink: "build",
  "invalid-input": "request",
  "invalid-path": "request",
  "unknown-template": "request",
  io: "tool",
  "tool-missing": "tool",
  "wrong-version": "tool",
  "templates-missing": "tool",
  "starter-templates-missing": "tool",
  "unsupported-platform": "tool",
  checksum: "tool",
  download: "tool",
  "project-not-found": "tool",
  "thread-dispatch": "tool",
  "license-missing": "tool",
  "source-changed": "tool",
  "unsafe-archive": "tool",
  "tool-failed": "tool",
};
export const gameOperationFault = (reason: GameOperationReason): GameOperationFault =>
  FAULTS[reason];
const STANDING: ReadonlySet<GameOperationReason> = new Set([
  "tool-missing",
  "wrong-version",
  "templates-missing",
  "starter-templates-missing",
  "unsupported-platform",
  "license-missing",
  "unsafe-archive",
  "source-changed",
]);
/** A fault that waiting cannot clear: it needs a person, so a run pauses at once. */
export const isStandingFault = (reason: GameOperationReason): boolean =>
  STANDING.has(reason) || FAULTS[reason] === "request";
/**
 * A failure's text as a person reads it: its first line, with machine paths
 * (the given roots, home) replaced by <path>, at most 300 characters.
 */
export const plainReason = (text: string, roots: ReadonlyArray<string> = []): string => {
  let line = (text.split("\n").find((each) => each.trim() !== "") ?? "").trim();
  for (const root of [...roots].filter((r) => r.length > 1).toSorted((a, b) => b.length - a.length))
    line = line.split(root).join("<path>");
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};
/** Where a game tool was found, in detection order. `kurambit` is a copy an earlier Kurambit installed. */
export const GameToolSource = Schema.Literals(["settings", "env", "unity-hub", "kurambit", "path"]);
export type GameToolSource = typeof GameToolSource.Type;
/**
 * One tool's health, shaped like a provider's: the user installs the tool,
 * Kurambit finds it. `warning` is usable with a gap the message names;
 * `error` is not usable.
 */
export const GameToolStatus = Schema.Struct({
  tool: Schema.Literals(["blender", "godot", "uv", "unity"]),
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  source: Schema.NullOr(GameToolSource),
  status: Schema.Literals(["ready", "warning", "error"]),
  message: Schema.String,
  /** The vendor's download page, for a tool that is missing or wrong. */
  downloadUrl: Schema.NullOr(Schema.String),
});
export type GameToolStatus = typeof GameToolStatus.Type;
export const GameToolchainStatus = Schema.Struct({
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
/** One primitive GameState value the StudioProbe reports. */
export const GamePlaytestStateValue = Schema.Union([Schema.Number, Schema.Boolean, Schema.String]);
export type GamePlaytestStateValue = typeof GamePlaytestStateValue.Type;
export const GamePlaytestProbe = Schema.Struct({
  /** Public GameState members, bounded by the probe to 40 keys and 80-character strings. */
  gameState: Schema.Record(Schema.String, GamePlaytestStateValue),
  /** World position of the first node in the `player` group, or null outside gameplay. */
  player: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number, z: Schema.Number })),
  /** Text of the visible Label, RichTextLabel, Button and Label3D nodes; older probes omit it. */
  hudText: Schema.optionalKey(Schema.String),
});
export type GamePlaytestProbe = typeof GamePlaytestProbe.Type;
export const GamePlaytestStateChange = Schema.Struct({
  key: Schema.String,
  before: GamePlaytestStateValue,
  after: GamePlaytestStateValue,
});
export type GamePlaytestStateChange = typeof GamePlaytestStateChange.Type;
/**
 * What the in-game probe saw during a playtest. `before` is the gameplay
 * baseline (the latest gameplay sample before the first player input, or the
 * first one after it when play starts from a menu), `after` the last gameplay
 * sample; `playerMoved` and `changes` are measured against the baseline, so
 * opening the game from its menu is not mistaken for movement. A typed
 * `GameState.state` marker that is not 0/false identifies play on its own, so
 * a no-player UI game still has a baseline and `player` may be null.
 */
export const GamePlaytestState = Schema.Struct({
  before: Schema.NullOr(GamePlaytestProbe),
  after: Schema.NullOr(GamePlaytestProbe),
  /** Net player displacement from the gameplay baseline to the last gameplay sample. */
  playerMoved: Schema.Number,
  /**
   * GameState values that moved away from their gameplay baseline (clocks ride
   * out of the baseline test because a value that only ever rises proves
   * nothing; no key names are needed).
   */
  changes: Schema.Array(GamePlaytestStateChange),
  /**
   * GameState keys whose last value never appears in the visible on-screen
   * text. Feedback for the agent, not a verdict; absent when the probe reports
   * no screen text.
   */
  notOnScreen: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GamePlaytestState = typeof GamePlaytestState.Type;
const GamePointerPosition = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export const GamePlaytestStep = Schema.Union([
  Schema.Struct({
    press: Schema.String.annotate({
      description:
        'Physical browser key to press, such as "Enter", "Space", "ArrowLeft", "w" or "F1" — not a Godot InputMap action name.',
    }),
  }),
  Schema.Struct({
    hold: Schema.String.annotate({
      description:
        'Physical browser key to hold, such as "Space" or "ArrowRight" — not a Godot InputMap action name.',
    }),
    holdMs: Schema.Number,
  }),
  Schema.Struct({
    drag: Schema.Struct({ from: GamePointerPosition, to: GamePointerPosition }),
    holdMs: Schema.Number,
  }),
  Schema.Struct({
    key: Schema.String.annotate({
      description:
        'Physical browser key to hold while playing, such as "ArrowUp", "w", "Space" or "F1" — not a Godot InputMap action name.',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold the key for this long." }),
  }),
  Schema.Struct({
    keys: Schema.Array(Schema.String).annotate({
      description:
        'Physical browser keys to hold at the same time, such as ["Shift", "w"] for a running jump or ["w", "Space"] — not Godot InputMap action names.',
    }),
    holdMs: Schema.Number.annotate({ description: "Hold every key for this long." }),
  }),
  Schema.Struct({ waitMs: Schema.Number.annotate({ description: "Wait before the next step." }) }),
  Schema.Struct({
    x: Schema.optionalKey(Schema.Number),
    y: Schema.optionalKey(Schema.Number),
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
/**
 * A game operation the server is running, or the last one it ran. Its events
 * replace polling: a stage opened while idle learns about a later agent build
 * from the push, not from a two-second status loop.
 */
export const GameOperationState = Schema.Literals(["running", "succeeded", "failed"]);
export type GameOperationState = typeof GameOperationState.Type;
export const GameStatus = Schema.Struct({
  root: Schema.String,
  manifest: GameManifest,
  toolchain: GameToolchainStatus,
  /**
   * The resolution from `godot/project.godot`, in which the web preview
   * is framed. Falls back to Godot's own default when the project does not set one.
   */
  viewport: GameViewport,
  /** A web build exists but game sources changed after it: play would be out of date. */
  webBuildStale: Schema.Boolean,
  /**
   * Whether the current source bytes are the ones the served build was
   * exported from. `"unknown"` is status's cheap answer: byte freshness costs
   * a full source read, so it is only computed on an explicit check (status
   * with `checkSources`). This says nothing about whether the served build
   * itself is usable.
   */
  sourcesDifferFromPlay: Schema.Union([Schema.Boolean, Schema.Literal("unknown")]),
  builds: Schema.Array(
    Schema.Struct({ target: Schema.String, path: Schema.String, updatedAt: Schema.String }),
  ),
  processes: Schema.Array(
    Schema.Struct({ pid: Schema.Number, operation: Schema.String, logPath: Schema.String }),
  ),
  previewUrl: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      state: GameOperationState,
      message: Schema.String,
      /** When the operation started, so clients can show elapsed time honestly. */
      at: Schema.String,
      /** The revision of the push that last changed it: later news has a higher one. */
      revision: Schema.Number,
    }),
  ),
});
export type GameStatus = typeof GameStatus.Type;
/**
 * One push about a game operation, for every client that might be showing that
 * game. `at` identifies the event itself (start and finish are separate events),
 * so a subscriber can tell a repeat from news.
 */
export const GameOperationEvent = Schema.Struct({
  revision: Schema.optionalKey(Schema.Number),
  root: Schema.String,
  name: Schema.String,
  state: Schema.Union([GameOperationState, Schema.Literal("cancelled")]),
  message: Schema.String,
  at: Schema.String,
  /** The thread whose work the operation is, when a thread owns it; absent for a run's or the system's own work. */
  ownerThreadId: Schema.optionalKey(ThreadId),
});
export type GameOperationEvent = typeof GameOperationEvent.Type;
export const GameCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  parentDirectory: Schema.String,
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Which lane to build in. Omitted means the Godot native lane. */
  engine: Schema.optionalKey(GameEngineId),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /** How the game's first run decides; omitted means Guided. */
  profile: Schema.optionalKey(GameRunProfile),
});
export type GameCreateInput = typeof GameCreateInput.Type;
export const GameOpenInput = Schema.Struct({ path: Schema.String, modelSelection: ModelSelection });
export const GameProjectResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  root: Schema.String,
});
/**
 * One row in the games library. It is a batched read: the sidebar must not ask
 * for a game's status once per project.
 */
export const GameSummary = Schema.Struct({
  projectId: ProjectId,
  root: Schema.String,
  name: Schema.String,
  template: Schema.NullOr(GameTemplateId),
  /** The operation running now, or the last one, for a building label. */
  operation: Schema.NullOr(Schema.Struct({ name: Schema.String, state: GameOperationState })),
  /** The production run working on this game now: its current step and when the run started. */
  run: Schema.NullOr(Schema.Struct({ step: Schema.String, startedAt: Schema.String })),
  /** The game's key art, relative to `root`, for the library card; null when none exists yet. */
  keyArt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type GameSummary = typeof GameSummary.Type;
export const GameListResult = Schema.Array(GameSummary);
export type GameListResult = typeof GameListResult.Type;
export const GameThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Ask the status read for the byte comparison it otherwise leaves
   * `unknown`; the read walks and hashes every source file when set.
   */
  checkSources: Schema.optionalKey(Schema.Boolean),
});
export const GameAction = Schema.Literals([
  "preview",
  "rebuild",
  "stop",
  "export-linux",
  "export-windows",
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
export const GameWindowsPackageFile = Schema.Struct({
  name: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
});
export type GameWindowsPackageFile = typeof GameWindowsPackageFile.Type;
/**
 * The downloadable Windows package. It describes files that were already
 * exported and validated; packaging never exports and never proves Windows
 * booted.
 */
export const GameWindowsPackage = Schema.Struct({
  /** Absolute path of the complete archive on the server. */
  archivePath: Schema.String,
  fileName: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  files: Schema.Array(GameWindowsPackageFile),
  embeddedPck: Schema.Boolean,
  executableBytes: Schema.Number,
  pckBytes: Schema.Number,
  pckFileCount: Schema.Number,
  notes: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameWindowsPackage = typeof GameWindowsPackage.Type;
/** The service package plus the capability URL the transports hand to a client. */
export const GameWindowsPackageResult = Schema.Struct({
  ...GameWindowsPackage.fields,
  /** Signed same-origin URL path; clients join it with their server origin. */
  downloadPath: Schema.String,
  expiresAt: Schema.String,
});
export type GameWindowsPackageResult = typeof GameWindowsPackageResult.Type;
export const GameWebPackageFile = Schema.Struct({
  /** Path inside the ZIP, with forward slashes. */
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
});
export type GameWebPackageFile = typeof GameWebPackageFile.Type;
/**
 * The downloadable Web build. It packages the immutable build Play currently
 * serves at that moment; it never exports and does not include later sources.
 */
export const GameWebPackage = Schema.Struct({
  /** Absolute path of the complete archive on the server. */
  archivePath: Schema.String,
  fileName: Schema.String,
  /** The selected build the archive was made from. */
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  bytes: Schema.Number,
  sha256: Schema.String,
  files: Schema.Array(GameWebPackageFile),
  /** The entry a static host serves at the ZIP root, normally index.html. */
  entry: Schema.String,
  /** The selected artifact's entry before any root mapping. */
  sourceEntry: Schema.String,
  notes: Schema.Array(Schema.String),
  message: Schema.String,
});
export type GameWebPackage = typeof GameWebPackage.Type;
export const GameWebPackageResult = Schema.Struct({
  ...GameWebPackage.fields,
  /** Signed same-origin URL path; clients join it with their server origin. */
  downloadPath: Schema.String,
  expiresAt: Schema.String,
});
export type GameWebPackageResult = typeof GameWebPackageResult.Type;
/** The GameOperationEvent name a change to a game's saved/ folder is pushed under. */
export const GAME_SAVED_MEDIA_EVENT = "saved";
/** A creator's copy of generated media in the game's saved/ folder, kept past the log cleanup. */
export const GameSavedMedia = Schema.Struct({
  name: Schema.String,
  /** Absolute path on the server. */
  path: Schema.String,
  bytes: Schema.Number,
  savedAt: Schema.String,
  /** The game-relative file it was saved from and the label it was saved with, when known. */
  source: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
});
export type GameSavedMedia = typeof GameSavedMedia.Type;
export const GameMediaSaveFields = {
  /** Game-relative (or absolute) path of a video or image Kurambit generated. */
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  /** Words for the saved name after its date ("round 2 bot run"). */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
};
export const GameMediaSaveInput = Schema.Struct({ threadId: ThreadId, ...GameMediaSaveFields });
export type GameMediaSaveInput = typeof GameMediaSaveInput.Type;
export const GameSavedListInput = Schema.Struct({ threadId: ThreadId });
export const GameSavedListResult = Schema.Array(GameSavedMedia);
export type GameSavedListResult = typeof GameSavedListResult.Type;
export const GameSavedDeleteFields = {
  /** A file directly in saved/, as the list names it. */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
};
export const GameSavedDeleteInput = Schema.Struct({ threadId: ThreadId, ...GameSavedDeleteFields });
export type GameSavedDeleteInput = typeof GameSavedDeleteInput.Type;
export const GameConsoleMessage = Schema.Struct({
  level: Schema.Literals(["log", "info", "warning", "error"]),
  text: Schema.String,
});
export type GameConsoleMessage = typeof GameConsoleMessage.Type;
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
  /** Which entry scenes the checker actually ran, in order: `main`, then `gameplay`. */
  entries: Schema.Array(Schema.String),
  durationMs: Schema.Number,
});
export type GameCheckResult = typeof GameCheckResult.Type;
