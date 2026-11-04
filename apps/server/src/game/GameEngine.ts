import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GameOperationError,
  type GameManifest,
  type GameActionResult,
  type GameCheckIssue,
  type GameProcessResult,
  type GameViewport,
} from "@kurambit/contracts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { makeGodotBackend } from "./GameGodotEngine.ts";
import { makeThreeBackend } from "./GameThreeEngine.ts";
import * as GameUnity from "./GameUnity.ts";
import { makeUnityBackend } from "./GameUnityEngine.ts";
import type { GameEngineProfile, GameExportTarget } from "./engineProfile.ts";

/**
 * The game engines this build runs. The manifest still names one, so a
 * project that declares anything else fails here — before any engine
 * lookup or process launch — instead of being silently routed elsewhere.
 */
export const SUPPORTED_GAME_ENGINE_IDS = ["godot", "three", "unity"] as const;
export type SupportedGameEngineId = (typeof SUPPORTED_GAME_ENGINE_IDS)[number];

export interface GameEngineBinary {
  readonly path: string;
  readonly version: string;
  readonly templates: string | null;
}

export interface GameEngineContext {
  readonly root: string;
  /** Absolute directory of the engine project. */
  readonly projectDir: string;
  /** Game-relative engine project directory. */
  readonly projectName: string;
  readonly binary: GameEngineBinary;
}

export interface GameEngineProjectSettings {
  readonly viewport: GameViewport;
}

export interface GameEngineCheckReport {
  readonly reported: {
    readonly entries: ReadonlyArray<string>;
    readonly errors: ReadonlyArray<GameCheckIssue>;
    readonly warnings: ReadonlyArray<GameCheckIssue>;
  } | null;
  /** Issues parsed from the check run's own stdout/stderr. */
  readonly issues: ReadonlyArray<GameCheckIssue>;
  readonly run: GameProcessResult;
}

/** A player build's outcome; `sourceId` names the sources it was built from, null when it failed. */
interface GamePlayerBuild {
  readonly result: GameActionResult;
  readonly sourceId: string | null;
}

/** What a play session's launch is given; the engine says how its runner starts from it. */
export interface PlayProcessInput {
  /** The engine project directory the sources play from. */
  readonly projectDir: string;
  /** The prepared player executable, for engines whose games play one; null otherwise. */
  readonly player: string | null;
  /** Where the runner reads its play-session request. */
  readonly requestPath: string;
  /** An ignored directory inside the game for runner files. */
  readonly scriptDir: string;
  /** Scratch outside the game for the process's own state and logs. */
  readonly traceDir: string;
  /** A kept session's stable save location (see gameKeptSaves); null starts with no saved data. */
  readonly saves: string | null;
  readonly viewport: GameViewport;
  /** Whether a private display exists; without one the runner must run headless or refuse. */
  readonly display: boolean;
}

/** One runner process: the caller puts it on a display, tracks it and ends it. */
export interface PlayProcess {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /** The whole environment, display variables stripped; the display host adds its own. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Engine fields of the request beside the port and token. */
  readonly request: { readonly expectedUserDataPrefix?: string };
  /** Directories that hold nothing worth keeping once the session ends. */
  readonly scratch: ReadonlyArray<string>;
  /** A line for the session message about how input reaches the game; empty when nothing to add. */
  readonly inputNote: string;
}

/**
 * One engine backend. It owns engine execution, configuration and parsing:
 * process arguments, runner scripts, project-settings formats and output
 * diagnostics. The core (GameService and its parts) owns everything else —
 * stage order, source binding, cancellation and operation ownership — and
 * asks this interface, never the engine's name, wherever engines differ.
 */
export interface GameEngineBackend {
  readonly profile: GameEngineProfile;
  readonly resolveProject: (
    root: string,
    manifest: GameManifest,
  ) => Effect.Effect<Omit<GameEngineContext, "root">, GameOperationError>;
  readonly projectSettingsFile: string;
  readonly projectDirectory: (manifest: GameManifest) => string;
  /** Parse the engine project-settings text (no I/O, no manifest). */
  readonly projectSettings: (projectFileText: string) => GameEngineProjectSettings;
  /** Parse engine diagnostics from combined process output. */
  readonly parseDiagnostics: (output: string) => ReadonlyArray<GameCheckIssue>;
  /** Headless editor import plus the diagnostics its output reported. */
  readonly importProject: (
    ctx: GameEngineContext,
  ) => Effect.Effect<
    { readonly result: GameActionResult; readonly issues: ReadonlyArray<GameCheckIssue> },
    GameOperationError
  >;
  /** Static + boot check: script execution and parsing. */
  readonly runCheck: (
    ctx: GameEngineContext,
    input: { readonly gameplayScene: string },
  ) => Effect.Effect<GameEngineCheckReport, GameOperationError>;
  /** Refuses an export the installed engine cannot make (missing export templates), before any import. */
  readonly exportReady: (
    binary: GameEngineBinary,
    target: GameExportTarget,
  ) => Effect.Effect<void, GameOperationError>;
  /**
   * The export preset a release uses, settled after the import and before the
   * source identity is taken, because the preset is part of the sources.
   */
  readonly exportPreset: (
    ctx: GameEngineContext,
    target: GameExportTarget,
  ) => Effect.Effect<{ readonly name: string; readonly added: boolean }, GameOperationError>;
  /** Run one export-release invocation and map the process outcome. */
  readonly runExportRelease: (
    ctx: GameEngineContext,
    input: {
      readonly preset: string;
      readonly outputPath: string;
      readonly operation: string;
    },
  ) => Effect.Effect<GameActionResult, GameOperationError>;
  /**
   * The game's one live editor, for engines that refuse a second editor on an
   * open project; null when every operation runs its own process.
   */
  readonly editor: {
    /** Runs work holding the editor, so another game cannot take it in between. */
    readonly hold: (
      root: string,
    ) => <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | GameOperationError, R>;
    readonly close: (root: string) => Effect.Effect<void>;
    /** Whether the project's first full import already ran. */
    readonly warm: (ctx: GameEngineContext) => Effect.Effect<boolean>;
    /** Opens the editor once (the project's first full import) and records it. */
    readonly open: (ctx: GameEngineContext) => Effect.Effect<void, GameOperationError>;
  } | null;
  /**
   * How a play session (exploration or a bot) starts this engine's runner, a
   * process speaking the play-session protocol over loopback. Null for
   * engines whose games play as a browser page, which the browser host opens.
   */
  readonly playProcess:
    | ((input: PlayProcessInput) => Effect.Effect<PlayProcess, GameOperationError>)
    | null;
  /**
   * For engines whose games ship and play as a built player folder rather
   * than one exported file; null otherwise.
   */
  readonly player: {
    /**
     * Builds a player of the current sources into `destination`, replacing
     * it only once the build's files check out and the sources did not
     * change meanwhile. The caller imports first.
     */
    readonly build: (
      ctx: GameEngineContext,
      input: {
        readonly target: "Linux" | "Windows";
        readonly destination: string;
        readonly operation: string;
      },
    ) => Effect.Effect<GamePlayerBuild, GameOperationError>;
    /** A release export: import and build into builds/linux or builds/windows. */
    readonly export: (
      ctx: GameEngineContext,
      target: "Linux" | "Windows",
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /** The Linux player's file inside a player folder. */
    readonly executable: string;
  } | null;
}

const unsupportedEngine = (engineName: string) =>
  new GameOperationError({
    operation: "resolve-engine",
    path: engineName === "" ? "(missing engine name)" : engineName,
    reason: "invalid-input",
    detail:
      `Unsupported game engine "${engineName === "" ? "(missing)" : engineName}". ` +
      `This build supports: ${SUPPORTED_GAME_ENGINE_IDS.join(", ")}. ` +
      `The project was not imported, checked or exported; no engine process started.`,
  });

export class GameEngine extends Context.Service<
  GameEngine,
  {
    /**
     * Return the backend for a manifest-declared engine name. Anything outside
     * the supported list fails before any executable lookup or process launch.
     */
    readonly backendFor: (
      engineName: string,
    ) => Effect.Effect<GameEngineBackend, GameOperationError>;
    /**
     * Resolve a game's engine and its project context: validate the
     * manifest's engine first, then resolve the executable. An unsupported
     * engine never reaches the toolchain lookup.
     */
    readonly context: (
      root: string,
    ) => Effect.Effect<
      { readonly backend: GameEngineBackend; readonly ctx: GameEngineContext },
      GameOperationError
    >;
    /** The engine's import of the game's project, as an action result. */
    readonly importProject: (root: string) => Effect.Effect<GameActionResult, GameOperationError>;
  }
>()("kurambit/game/GameEngine") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const tools = yield* GameToolchain.GameToolchain;
  const processes = yield* GameProcesses.GameProcesses;
  const unity = yield* GameUnity.GameUnity;
  const backends = new Map<string, GameEngineBackend>([
    ["godot", makeGodotBackend(processes, tools)],
    ["three", makeThreeBackend()],
    ["unity", makeUnityBackend(unity, tools)],
  ]);
  const backendFor = (engineName: string): Effect.Effect<GameEngineBackend, GameOperationError> => {
    const backend = backends.get(engineName);
    return backend === undefined
      ? Effect.fail(unsupportedEngine(engineName))
      : Effect.succeed(backend);
  };
  const context = Effect.fn("GameEngine.context")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* backendFor(manifest.engine.name);
    const project = yield* backend.resolveProject(root, manifest);
    return { backend, ctx: { root, ...project } };
  });
  const importProject = Effect.fn("GameEngine.importProject")(function* (root: string) {
    const { backend, ctx } = yield* context(root);
    return (yield* backend.importProject(ctx)).result;
  });
  return GameEngine.of({ backendFor, context, importProject });
});

export const layer = Layer.effect(GameEngine, make);
