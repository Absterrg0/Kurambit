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

/**
 * The game engines this build runs. The manifest still names one, so a
 * project that declares anything else fails here — before any engine
 * lookup or process launch — instead of being silently routed elsewhere.
 */
export const SUPPORTED_GAME_ENGINE_IDS = ["godot", "three"] as const;
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

/**
 * One engine backend. It owns engine execution, configuration and parsing:
 * process arguments, runner scripts, project-settings formats and output
 * diagnostics. The core (GameService) owns everything else — stage order,
 * source binding, cancellation and operation ownership — and calls this
 * interface for the production import/check/export slice.
 */
export interface GameEngineBackend {
  readonly id: SupportedGameEngineId;
  /** Short human name for honest operation messages ("Godot", "three.js"). */
  readonly displayName: string;
  /** Which export targets this engine can release. Anything else is refused plainly. */
  readonly exportTargets: ReadonlyArray<"Web" | "Linux" | "Windows">;
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
  /** Run one export-release invocation and map the process outcome. */
  readonly runExportRelease: (
    ctx: GameEngineContext,
    input: {
      readonly preset: string;
      readonly outputPath: string;
      readonly operation: string;
    },
  ) => Effect.Effect<GameActionResult, GameOperationError>;
}

export interface ResolvedGameEngine {
  readonly backend: GameEngineBackend;
  readonly binary: GameEngineBinary;
  /** Absolute directory of the engine project. */
  readonly cwd: string;
  /** The manifest's project directory name (usually `godot`). */
  readonly project: string;
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
     * Resolve a game's engine: validate the manifest's engine first, then
     * resolve the executable. An unsupported engine never reaches the
     * toolchain lookup.
     */
    readonly resolve: (root: string) => Effect.Effect<ResolvedGameEngine, GameOperationError>;
  }
>()("kurambit/game/GameEngine") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const tools = yield* GameToolchain.GameToolchain;
  const processes = yield* GameProcesses.GameProcesses;
  const backends = new Map<string, GameEngineBackend>([
    ["godot", makeGodotBackend(processes, tools)],
    ["three", makeThreeBackend()],
  ]);
  const backendFor = (engineName: string): Effect.Effect<GameEngineBackend, GameOperationError> => {
    const backend = backends.get(engineName);
    return backend === undefined
      ? Effect.fail(unsupportedEngine(engineName))
      : Effect.succeed(backend);
  };
  const resolve = Effect.fn("GameEngine.resolve")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* backendFor(manifest.engine.name);
    const project = yield* backend.resolveProject(root, manifest);
    return {
      backend,
      binary: project.binary,
      cwd: project.projectDir,
      project: project.projectName,
    };
  });
  return GameEngine.of({ backendFor, resolve });
});

export const layer = Layer.effect(GameEngine, make);
