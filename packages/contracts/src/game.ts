import * as Schema from "effect/Schema";
import { RuntimeMode } from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";
import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { GameAssetFamily } from "./gameAssets.ts";
import { GameBuildId } from "./gameBuildId.ts";
import { GameRunErrorReason } from "./gameRunReasons.ts";
import { GameCharacterRoute, GameStoredCharacterRoute } from "./gameStyle.ts";
import { GameSceneReport } from "./gameScene.ts";
import { GameQaReport, GameScreens } from "./gameQa.ts";
import { GamePlayerReport } from "./gamePlayer.ts";
import { GameSavedPlaysReading } from "./gamePlays.ts";

export const GameBlenderInputSource = Schema.Struct({
  /** Local handle the bpy script reads as `ASSET_INPUTS[name]`. */
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  /**
   * Where the source lives in this game: a game-relative path such as
   * `web/assets/library/models/crate/crate.gltf`. Never a URL.
   */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type GameBlenderInputSource = typeof GameBlenderInputSource.Type;

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
/** The starter templates a game.json may name: GAME_TEMPLATES' ids. */
export const GameTemplateId = Schema.Literals(["blank-three"]);
export type GameTemplateId = typeof GameTemplateId.Type;
/** The engines Kurambit builds and plays: GAME_ENGINES' keys. */
export const GameEngineId = Schema.Literals(["three"]);
export type GameEngineId = typeof GameEngineId.Type;
/** Game-relative directory holding a three.js game's static sources. */
export const THREE_PROJECT_DIRECTORY = "web";
/** Pinned three.js the browser lane vendors, so no install step is needed. */
export const THREE_PINNED_VERSION = "0.180.0";
/** Design resolution three.js games boot, explore and bot-play at. */
export const THREE_VIEWPORT = { width: 1280, height: 720 } as const;
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
  /** The Kurambit runtime major the template's files load (see GameRuntimes); absent when the template carries its own copy. */
  runtime: Schema.optionalKey(PositiveInt),
});
export type GameTemplate = typeof GameTemplate.Type;
/**
 * The starter templates the New game dialog offers. Template files live under
 * apps/server/templates/<id>/; a server test keeps this list and those folders in step.
 */
export const GAME_TEMPLATES: readonly GameTemplate[] = [
  {
    id: "blank-three",
    name: "Blank (browser)",
    description:
      "An empty three.js page the agent fills with the whole game, its title, HUD and look included, run by Kurambit's bridge for the Stage, the checks and replays, and a single static web export. No install step; three.js and the bridge load from Kurambit's runtime.",
    dimension: "3d",
    // The page opens on the shell's title; "?play" boots straight into a run, so the check covers gameplay start.
    gameplayScene: "index.html?play",
    probe: true,
    runtime: 1,
  },
];
/** How this game's engine shows the game on the Stage: its folder served live, a Web export, or its own window. */
export const GameStageKind = Schema.Literals(["live", "export", "window"]);
export type GameStageKind = typeof GameStageKind.Type;

/**
 * What a client says about each engine: keyed by every engine id, so a new
 * engine does not compile without its entry. An engine joins Kurambit with an
 * entry here, its profile and backend on the server (engineProfile.ts,
 * GameEngine.ts), its template and skill, and its tool's detection.
 */
export const GAME_ENGINES: Readonly<
  Record<
    GameEngineId,
    {
      /** Short human name ("three.js"). */
      readonly name: string;
      readonly template: GameTemplateId;
      /** The installed tool its games build and play with (a GameToolStatus tool); null when it needs none. */
      readonly tool: GameToolName | null;
      /**
       * When a chat turn changes the game, its build plays on the Stage and is
       * measured at once. Off for an engine whose builds are too slow to follow
       * every turn; its games build and play on request.
       */
      readonly turnLoop: boolean;
      /** How the Stage shows this engine's game. */
      readonly stage: GameStageKind;
      /** Its template's shell speaks the Stage bridge (gameStageBridge.ts): Freeze, select and live values. */
      readonly stageBridge: boolean;
      readonly picker: {
        readonly title: string;
        /** The engine's label where a form offers the engines side by side. */
        readonly short: string;
        readonly description: string;
      };
    }
  >
> = {
  three: {
    name: "three.js",
    template: "blank-three",
    tool: null,
    turnLoop: true,
    stage: "live",
    stageBridge: true,
    picker: {
      title: "three.js browser",
      short: "three.js · browser",
      description: "A quick static browser game, nothing to install. Web export only.",
    },
  },
};
/** The engine a create request without one builds for. */
export const DEFAULT_GAME_ENGINE: GameEngineId = GameEngineId.literals[0];
/**
 * What a three.js game made on the older demo shell says (its page carries that shell's screens):
 * this version opens it and plays nothing.
 */
export const OLD_SHELL_MESSAGE =
  "This game was made with an older Kurambit and is not supported in this version: its chat, builds and history still open, but nothing plays it.";
/** The starter template a create request's engine maps to. */
export const gameTemplateForEngine = (engine: GameEngineId): GameTemplateId =>
  GAME_ENGINES[engine].template;
/** The release targets an engine may export. */
/** The releases a game can make: each engine adds its own. */
export const GameExportTarget = Schema.Literals(["Web"]);
export type GameExportTarget = typeof GameExportTarget.Type;
/** Runtime majors by engine, as a manifest pins them. */
export const GameRuntimes = Schema.Struct({
  three: Schema.optionalKey(PositiveInt),
});
export type GameRuntimes = typeof GameRuntimes.Type;
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
  /** The engine project's folder in the game (web/ for three.js). */
  project: Schema.String,
  assets: Schema.Array(GameAsset),
  /**
   * Authored asset targets this game's inventory checks against. Each entry
   * names the files, scale/pivot conventions, animation and transition names,
   * collision and provenance promises one family owes. Absent on legacy games,
   * which inventory treats as having no authored requirements rather than as
   * missing everything. At most 16 families with at most 16 paths each.
   */
  families: Schema.optionalKey(Schema.Array(GameAssetFamily).check(Schema.isMaxLength(16))),
  /**
   * The person's choice of how models are made: in three.js code or in Blender.
   * Read through gameModelChoice: "library" is the old default (code with the library on).
   * Only the person changes it, or the agent when they ask.
   */
  characters: Schema.optionalKey(GameStoredCharacterRoute),
  /** Whether models may come from the free library. Absent on games made before it was opt-in: on. */
  library: Schema.optionalKey(Schema.Boolean),
  /**
   * The Kurambit runtime major the game loads, by engine ({ three: 1 }): Kurambit serves it
   * at _kurambit/runtime/<engine>/<major>/ and copies it into exports, and every minor and
   * patch of that major reaches the game. Absent on a game that carries its own copy.
   */
  runtime: Schema.optionalKey(GameRuntimes),
});
export type GameManifest = typeof GameManifest.Type;
/** The runtime major the game loads for its engine, or null when it carries its own copy. */
export const manifestRuntime = (manifest: GameManifest): number | null => {
  const majors: { readonly [Engine in GameEngineId]?: number } = manifest.runtime ?? {};
  return majors[manifest.engine.name] ?? null;
};
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
      /** Something only the person sets up (an art provider's key, a sign-in, a raised limit). */
      "setup-missing",
      "source-changed",
      "unsafe-archive",
      "symlink",
      /** The operation was cancelled: a turn ended, a stop, a newer request. */
      "cancelled",
      /** A program Kurambit runs failed on its own; it says nothing about the game. */
      "tool-failed",
      /** This version plays nothing of the game (OLD_SHELL_MESSAGE): its page predates the runtime. */
      "unsupported",
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
        "A program or add-on this needs is not installed, or its path is wrong. Do what the detail below says: an add-on is added by the op it names once the person agrees; a program the person installs from the download page it names (or fixes its path in Settings > Game tools), then presses Check again there.",
      "wrong-version":
        "The installed version is not one Kurambit can use: Blender 4.2 or later. Ask the user to install a supported version from the download page in the detail below, or point Settings > Game tools at one.",
      "templates-missing":
        "The engine's export templates for this exact version are missing. Ask the user to install them, then press Check again in Settings > Game tools.",
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
        "A helper Kurambit fetches could not be downloaded. Check network access and retry, unless the detail says retrying will not help.",
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
        "The engine needs an active licence on this machine. Ask the user to add one, then retry. Kurambit never stores engine credentials.",
      "setup-missing":
        "This needs something only the person sets up in Settings. Tell them what the detail names; do not make it another way instead.",
      "source-changed":
        "The source changed: this library pack no longer matches the SHA-256 it was pinned with, so its bytes were not used. Pick another pack.",
      "unsafe-archive":
        "This library pack names an unsafe path or link, or unpacks past the size limits, so nothing from it was kept. Pick another pack.",
      cancelled:
        "The operation was cancelled before it finished (a turn ended, a stop, or a newer request). Retry it if it is still wanted.",
      "tool-failed":
        "A program Kurambit runs (the browser, the engine's editor or its CLI, an MCP server, the private display, ffmpeg) failed on its own. This says nothing about the game. Retry once; if it fails the same way, tell the user what the detail says.",
      unsupported:
        "This version of Kurambit does not play this game; its chat, builds and history still work. Tell the person what the detail says; do not build or run the game another way.",
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
  unsupported: "request",
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
  "setup-missing": "tool",
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
  "setup-missing",
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
export const GameToolSource = Schema.Literals(["settings", "env", "kurambit", "path"]);
export type GameToolSource = typeof GameToolSource.Type;
/**
 * One tool's health, shaped like a provider's: the user installs the tool,
 * Kurambit finds it. `warning` is usable with a gap the message names;
 * `error` is not usable.
 */
export const GameToolName = Schema.Literals(["blender", "uv", "addon", "ffmpeg"]);
export type GameToolName = typeof GameToolName.Type;
/** An add-on's id in Kurambit's add-ons list ("mpfb"). */
export const GameAddonId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/));
export type GameAddonId = typeof GameAddonId.Type;
/**
 * An entry of the add-ons list: a tool that makes something, fetched pinned and checked into
 * Kurambit's own Blender folder. A pack of finished assets is no add-on: those are the library's.
 */
export const GameAddon = Schema.Struct({
  id: GameAddonId,
  /** The add-on's own name ("MPFB2"). */
  name: Schema.String,
  /** What it lets a game make, as a row's title ("Human bodies"). */
  makes: Schema.String,
  /** The same in a sentence. */
  purpose: Schema.String,
  /** The host it is fetched from ("extensions.blender.org"). */
  source: Schema.String,
  /** From Blender's own extensions platform. */
  official: Schema.Boolean,
  licence: Schema.String,
  version: Schema.String,
  bytes: Schema.Number,
  /** The person is asked before it is fetched: a large download, or one not from Blender's platform. */
  asksFirst: Schema.Boolean,
  /** What a game does without it. */
  without: Schema.String,
});
export type GameAddon = typeof GameAddon.Type;
export const GameToolStatus = Schema.Struct({
  tool: GameToolName,
  /** The add-ons list's entry, on an "addon" row. */
  addon: Schema.optionalKey(GameAddon),
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
    // Its description stands for every key field here (hold, key, keys): the tools' text is budgeted.
    press: Schema.String.annotate({
      description: 'A browser key name ("Enter", "w", "ArrowLeft").',
    }),
  }),
  Schema.Struct({
    hold: Schema.String,
    holdMs: Schema.Number,
  }),
  Schema.Struct({
    drag: Schema.Struct({ from: GamePointerPosition, to: GamePointerPosition }),
    holdMs: Schema.Number,
  }),
  Schema.Struct({
    key: Schema.String,
    holdMs: Schema.Number,
  }),
  Schema.Struct({
    keys: Schema.Array(Schema.String).annotate({
      description: "Browser key names, held together.",
    }),
    holdMs: Schema.Number,
  }),
  Schema.Struct({ waitMs: Schema.Number }),
  Schema.Struct({
    x: Schema.optionalKey(Schema.Number),
    y: Schema.optionalKey(Schema.Number),
    click: Schema.Literals(["left", "middle", "right"]).annotate({
      description: "A mouse button, clicked at x, y or the centre.",
    }),
  }),
  Schema.Struct({
    mouseMove: Schema.Struct({ dx: Schema.Number, dy: Schema.Number }).annotate({
      description: "A pointer move, in pixels.",
    }),
  }),
  Schema.Struct({
    screenshot: Schema.String.check(Schema.isMaxLength(80)).annotate({
      description: "A frame taken here, answered as an image with this label.",
    }),
  }),
]);
export type GamePlaytestStep = typeof GamePlaytestStep.Type;
/**
 * A game operation the server is running, or the last one it ran. Its events
 * replace polling: a stage opened while idle learns about a later agent build
 * from the push, not from a two-second status loop.
 */
/** A cancelled operation was stopped, by its owner or the creator: not a failure of the game. */
export const GameOperationState = Schema.Literals(["running", "succeeded", "failed", "cancelled"]);
export type GameOperationState = typeof GameOperationState.Type;
export const GameStatus = Schema.Struct({
  root: Schema.String,
  manifest: GameManifest,
  /** The one tool this game's engine needs, for this project; null when it needs none. */
  engineTool: Schema.NullOr(GameToolStatus),
  /** The release targets this game's engine exports; anything else is refused. */
  exportTargets: Schema.Array(GameExportTarget),
  /** The resolution the game boots at, in which the Stage frames it. */
  viewport: GameViewport,
  /**
   * Whether the game can be lost, from its own code (it calls `lose()` or reads `cannotLose`):
   * the Stage offers Can't lose only then. Absent from an older server: offered as before.
   */
  canLose: Schema.optionalKey(Schema.Boolean),
  /**
   * Why this version plays nothing of a game in an engine it has (OLD_SHELL_MESSAGE); absent when
   * it plays the game.
   */
  unsupported: Schema.optionalKey(Schema.String),
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
    Schema.Struct({
      target: Schema.String,
      path: Schema.String,
      updatedAt: Schema.String,
      /** Whether Kurambit can package this release as a download. */
      packageable: Schema.Boolean,
      /** A release that is one file, or a whole folder to ship together. */
      ships: Schema.Literals(["file", "folder"]),
    }),
  ),
  processes: Schema.Array(
    Schema.Struct({ pid: Schema.Number, operation: Schema.String, logPath: Schema.String }),
  ),
  previewUrl: Schema.NullOr(Schema.String),
  /**
   * A live-staged game's serve, as the server holds it for every client:
   * "serving"; "stopped" (someone stopped it: the Stage waits for Play); or
   * "off" (not asked since the server started: a shown Stage opens it).
   * Always "off" for engines not staged live.
   */
  live: Schema.Literals(["off", "serving", "stopped"]),
  /** How the person chose to make this game's models (gameModelChoice). */
  characters: GameCharacterRoute,
  /** Whether the person let this game take models from the free library. */
  library: Schema.Boolean,
  /** The builds being played from copies of their own (Play of a build), with their URLs. */
  buildPlays: Schema.Array(
    Schema.Struct({ build: GameBuildId, url: Schema.NullOr(Schema.String) }),
  ),
  operation: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      state: GameOperationState,
      message: Schema.String,
      /** When the operation started, so clients can show elapsed time honestly. */
      at: Schema.String,
      /** The revision of the push that last changed it: later news has a higher one. */
      revision: Schema.Number,
      /** The thread whose work it is, when a thread owns it; absent for a run's or the system's own work. */
      ownerThreadId: Schema.optionalKey(ThreadId),
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
  state: GameOperationState,
  message: Schema.String,
  at: Schema.String,
  /** The thread whose work the operation is, when a thread owns it; absent for a run's or the system's own work. */
  ownerThreadId: Schema.optionalKey(ThreadId),
});
export type GameOperationEvent = typeof GameOperationEvent.Type;
/** A reference picture's data URL at most: a 1568 px PNG, with room. */
export const GAME_REFERENCE_MAX_DATA_URL_CHARS = 12_000_000;
export const GameCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  /** A model names the game from its brief before the game is made; `name` is the fallback. */
  nameFromBrief: Schema.optionalKey(Schema.Boolean),
  parentDirectory: Schema.String,
  brief: Schema.String.check(Schema.isMinLength(1)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Which engine to build in. Omitted means DEFAULT_GAME_ENGINE. */
  engine: Schema.optionalKey(GameEngineId),
  /** How the person chose to make its models, before the first turn builds them. Omitted: code. */
  characters: Schema.optionalKey(GameCharacterRoute),
  /** Whether it may take models from the free library. Omitted: off. */
  library: Schema.optionalKey(Schema.Boolean),
  /**
   * A picture the person attached to aim for, as a PNG data URL (the client re-encodes any image
   * it reads), saved as art/reference.png and attached to the first message.
   */
  reference: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
      dataUrl: Schema.String.check(
        Schema.isMaxLength(GAME_REFERENCE_MAX_DATA_URL_CHARS),
        Schema.isPattern(/^data:image\/png;base64,/),
      ),
    }),
  ),
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type GameCreateInput = typeof GameCreateInput.Type;
export const GameOpenInput = Schema.Struct({
  path: Schema.String,
  modelSelection: ModelSelection,
  /**
   * A new chat on the game, empty, instead of its newest one. The game's empty chat is reused when
   * it has one, so asking twice opens the same chat.
   */
  newChat: Schema.optionalKey(Schema.Boolean),
});
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
  /** How many numbered builds the game has had, its copies' included. */
  buildCount: NonNegativeInt,
  /** When its newest build landed; null before the first. */
  latestBuildAt: Schema.NullOr(Schema.String),
  /** Where it is published on kurambit.com; null when it is not. */
  published: Schema.NullOr(Schema.Struct({ slug: Schema.String, url: Schema.String })),
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
/** The person's choice of how this game's models are made, written into its game.json; omitted parts stay. */
export const GameSetCharacterRouteInput = Schema.Struct({
  threadId: ThreadId,
  route: Schema.optionalKey(GameCharacterRoute),
  library: Schema.optionalKey(Schema.Boolean),
});
export type GameSetCharacterRouteInput = typeof GameSetCharacterRouteInput.Type;
export const GameSetCharacterRouteResult = Schema.Struct({
  route: GameCharacterRoute,
  library: Schema.Boolean,
});
export type GameSetCharacterRouteResult = typeof GameSetCharacterRouteResult.Type;
/** game_play op model_sheet: the things to draw alone, by the names the game gave them (ctx.thing, ASSETS keys). */
export const GameModelSheetInput = Schema.Struct({
  /** A game-relative PNG to show beside the sheets; omitted, STYLE.json's anchor or art/reference.png. */
  reference: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  ),
  things: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
  ),
  /**
   * With a reference: where the reference's camera sees the model from, in degrees. `around`
   * turns from the model's front (+z) toward its right side (90 is the right side's profile);
   * `up` is above the horizon. Omitted: a low front three-quarter.
   */
  view: Schema.optionalKey(
    Schema.Struct({
      around: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 360 })),
      up: Schema.Finite.check(Schema.isBetween({ minimum: -89, maximum: 89 })),
    }),
  ),
});
export type GameModelSheetInput = typeof GameModelSheetInput.Type;
/** One thing's sheet, as the game's shell measured it in the pose it held. */
export const GameModelSheet = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  /** Metres: wide (x), tall (y), long (z). */
  size: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  triangles: Schema.Number,
  drawCalls: Schema.Number,
  /** The sheet picture, game-relative. */
  image: Schema.String,
});
export type GameModelSheet = typeof GameModelSheet.Type;
export const GameModelSheetResult = Schema.Struct({
  sheets: Schema.Array(GameModelSheet),
  /** Names asked for that the game has no thing with a body by. */
  missing: Schema.Array(Schema.String),
  /** The things the game named, with a body, that a sheet can draw (at most 60). */
  things: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.String })),
  /** The reference picture attached after the sheets, game-relative; absent when the game has none. */
  reference: Schema.optionalKey(Schema.String),
  /** How to judge the sheets before changing the model. */
  review: Schema.optionalKey(Schema.String),
  /** Why nothing could be drawn, when the game did not answer. */
  note: Schema.optionalKey(Schema.String),
});
export type GameModelSheetResult = typeof GameModelSheetResult.Type;
export const GameAction = Schema.Literals(["preview", "rebuild", "stop"]);
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
const GameMediaSaveFields = {
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
const GameSavedDeleteFields = {
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
/**
 * What a person would see is wrong, from a short random-input play of the gameplay entry
 * (three.js): each line worded, with the frame that shows it. Not part of `ok`, which is the
 * boot check's; a check that made no play says why.
 */
export const GameCheckScene = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("measured"),
    /** One line per problem, its frame path appended; empty when the play showed none. */
    lines: Schema.Array(Schema.String),
    report: GameSceneReport,
    /** Milliseconds the play and its reading took. */
    ms: Schema.Number,
    /** How the play was drawn, when that matters for reading it. */
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("not-measured"), why: Schema.String }),
]);
export type GameCheckScene = typeof GameCheckScene.Type;
/** A picture of the game as the check left it: the title as it boots, or play after its input. */
export const GameCheckView = Schema.Struct({
  entry: Schema.Literals(["boot", "gameplay"]),
  /** Game-relative PNG beside the check's log. */
  path: Schema.String,
});
export type GameCheckView = typeof GameCheckView.Type;
export const GameCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(GameCheckIssue),
  warnings: Schema.Array(GameCheckIssue),
  /** Which entry scenes the checker actually ran, in order: `main`, then `gameplay`. */
  entries: Schema.Array(Schema.String),
  durationMs: Schema.Number,
  scene: Schema.optionalKey(GameCheckScene),
  /** What the game looked like, for engines that can show it (three.js). */
  views: Schema.optionalKey(Schema.Array(GameCheckView)),
  /**
   * How the gameplay entry's play ran on this machine's GPU, in one line ("58 fps · 1% low 41 ·
   * GPU 14.2 ms at 1× of 1280×720 · 420 draw calls · 2.3M triangles"), or why it was not read.
   */
  performance: Schema.optionalKey(Schema.String),
  /**
   * The QA play (three.js): every declared control answers, Retry starts clean, the HUD stays
   * on screen. `problems` are what to fix, in words; not part of `ok`, which is the boot check's.
   */
  qa: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal("measured"),
        problems: Schema.Array(Schema.String),
        report: GameQaReport,
        ms: Schema.Number,
      }),
      Schema.Struct({
        status: Schema.Literal("not-measured"),
        why: Schema.String,
        /**
         * old-shell: the game's copy of the shell predates the QA play; a new build adds it.
         * checker: the QA play's own page did not open (GameFactNotMeasuredCause).
         */
        cause: Schema.optionalKey(Schema.Literals(["old-shell", "checker"])),
      }),
    ]),
  ),
  /**
   * After the QA play (three.js): its page resized to phone portrait, then to widescreen, and
   * played a moment at each. `problems` say what broke at which size, each with its frame in
   * `report`; not part of `ok`. `report.bytes` is what that page downloaded to start and play.
   */
  screens: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal("measured"),
        problems: Schema.Array(Schema.String),
        report: GameScreens,
        ms: Schema.Number,
      }),
      Schema.Struct({ status: Schema.Literal("not-measured"), why: Schema.String }),
    ]),
  ),
  /**
   * On the boot page once it is checked (three.js): the page as a player opens it, its first
   * minute measured as a player meets it (gamePlayer.ts). `lines` say each reading against its
   * line; not part of `ok`.
   */
  player: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal("measured"),
        lines: Schema.Array(Schema.String),
        report: GamePlayerReport,
        ms: Schema.Number,
      }),
      Schema.Struct({
        status: Schema.Literal("not-measured"),
        why: Schema.String,
        /** The first minute's own page did not open (GameFactNotMeasuredCause). */
        cause: Schema.optionalKey(Schema.Literal("checker")),
      }),
    ]),
  ),
  /**
   * A final check of a game with saved plays: each replayed on the folder as it is now, read
   * against how it ended when saved ("2 of 3 end the same; first boss win now loses at 30 s").
   * One that ends differently is a regression or the change you meant: say which.
   */
  savedPlays: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal("measured"),
        text: Schema.String,
        reading: GameSavedPlaysReading,
      }),
      Schema.Struct({ status: Schema.Literal("not-measured"), why: Schema.String }),
    ]),
  ),
});
export type GameCheckResult = typeof GameCheckResult.Type;
export type GameCheckQa = NonNullable<GameCheckResult["qa"]>;
export type GameCheckScreens = NonNullable<GameCheckResult["screens"]>;
