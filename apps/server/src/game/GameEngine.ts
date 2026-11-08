// @effect-diagnostics nodeBuiltinImport:off -- The check reads the source tree around the engine's run.
import * as NodePath from "node:path";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GameOperationError,
  gameOperationFault,
  isGameEngineActive,
  parkedEngineMessage,
  type GameEngineId,
  manifestProject,
  manifestRuntime,
  type GameManifest,
  type GameActionResult,
  type GameCheckIssue,
  type GameCheckResult,
  type GameCheckScene,
  type GameProcessResult,
  type GameToolStatus,
  type GameViewport,
  type GameUnityRecompileResult,
  type ThreadId,
} from "@kurambit/contracts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { makeGodotBackend } from "./GameGodotEngine.ts";
import { makeThreeBackend } from "./GameThreeEngine.ts";
import { runtimesDirectory } from "./gameRuntime.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import * as GameUnity from "./GameUnity.ts";
import { makeUnityBackend } from "./GameUnityEngine.ts";
import { engineProfile, type GameEngineProfile, type GameExportTarget } from "./engineProfile.ts";
import * as GameOperations from "./GameOperations.ts";
import { limitIssues, mergeCheckIssues } from "./godotCheckOutput.ts";
import { makeAtomicWriter } from "./gameFiles.ts";
import {
  comparedSource,
  hashFile,
  snapshotBuildSource,
  sourceIdentityError,
} from "./sourceSnapshot.ts";
import type { WindowHost } from "./windowHost.ts";

/**
 * The game engines this build runs. The manifest still names one, so a
 * project that declares anything else fails here — before any engine
 * lookup or process launch — instead of being silently routed elsewhere.
 */
const SUPPORTED_GAME_ENGINE_IDS = ["godot", "three", "unity"] as const;
/** Clean checks kept for builds' facts: a turn's last few checks are the ones its build may match. */
const CLEAN_CHECKS = 32;
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
  /** The Kurambit runtime major the game loads (game.json `runtime`); null when it carries its own copy. */
  readonly runtime: number | null;
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
  /** The scene report of a check that asked for one, from an engine that measures it. */
  readonly scene?: GameCheckScene;
}

/** One release the engine wrote into a staging folder. */
export interface GameEngineRelease {
  /** success ⇒ `artifact` names the release's file inside the staging folder. */
  readonly result: GameActionResult;
  readonly artifact: string | null;
  /** Lines the export's message carries (a preset added, how the release ships). */
  readonly notes: ReadonlyArray<string>;
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
  /** The window the runner gets (see windowHost); without one it must run headless or refuse. */
  readonly window: WindowHost["kind"] | null;
}

/** One runner process: the caller puts it in a window host's window, tracks it and ends it. */
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
 * One engine's driver. It owns everything engine-specific: the project and its
 * binary, its tool's status, import, check, the releases it makes and their
 * files, play, and its live editor's lifetime. The core (GameEngine,
 * GameExport, GameStage) owns stage order, source identity, staging,
 * publication and operation ownership, and asks this interface (or the
 * profile), never the engine's name, wherever engines differ.
 */
export interface GameEngineBackend {
  readonly profile: GameEngineProfile;
  readonly resolveProject: (
    root: string,
    manifest: GameManifest,
  ) => Effect.Effect<Omit<GameEngineContext, "root" | "runtime">, GameOperationError>;
  /** The one tool this game's engine needs, for this project (Unity's editor by its version); null when it needs none. */
  readonly toolStatus: (
    root: string,
    manifest: GameManifest,
  ) => Effect.Effect<GameToolStatus | null>;
  /** The resolution the game boots, explores and bot-plays at, from the project folder alone. */
  readonly viewport: (projectDir: string) => Effect.Effect<GameViewport, GameOperationError>;
  /** The project's settings file, relative to the project: where a check names project-wide errors. */
  readonly projectSettingsFile: string;
  /**
   * The editor import, read by the engine's one error reading: success
   * exactly when the run ended cleanly and `issues` is empty.
   */
  readonly importProject: (
    ctx: GameEngineContext,
  ) => Effect.Effect<
    { readonly result: GameActionResult; readonly issues: ReadonlyArray<GameCheckIssue> },
    GameOperationError
  >;
  /**
   * Boot check of the entries the engine boots: what the player opens first, then the
   * gameplay entry. With `scene`, an engine that has a scene report plays the gameplay entry
   * briefly with random input and returns it.
   */
  readonly runCheck: (
    ctx: GameEngineContext,
    input: { readonly gameplayScene: string; readonly scene: boolean },
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
  /**
   * Writes one release of the current sources into `staging`, an empty folder
   * the core made beside the destination, and checks its own files. The core
   * compares the sources around it and publishes the folder.
   */
  readonly release: (
    ctx: GameEngineContext,
    input: {
      readonly target: GameExportTarget;
      readonly preset: string;
      readonly staging: string;
      readonly operation: string;
    },
  ) => Effect.Effect<GameEngineRelease, GameOperationError>;
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
   * For engines whose games play as a built player folder: the release target
   * sessions on this machine play, and where a game keeps players by source
   * identity. Players are built through `release`; null otherwise.
   */
  readonly player: {
    readonly playTarget: "Linux" | "Windows";
    /** The player's executable inside a player folder. */
    readonly executable: string;
    /** The folder a game keeps the player of these sources in. */
    readonly cacheDir: (root: string, sourceId: string) => string;
    /** Whether a builds/logs entry is a kept player folder. */
    readonly isCacheDir: (name: string) => boolean;
    /** Whether a player folder holds everything the player needs. */
    readonly complete: (directory: string) => Effect.Effect<boolean>;
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

/** Engine work (import, check, export, play) never starts on a parked engine's game. */
export const parkedEngine = (engine: GameEngineId) =>
  new GameOperationError({
    operation: "resolve-engine",
    path: engine,
    reason: "engine-parked",
    detail: parkedEngineMessage(engine),
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
    /** `game_import`: the engine's import of the thread's game, as the game's operation. */
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * The game's boot check, as the thread's game's operation (`owner` names
     * whose work it is, the thread by default), holding the live editor itself.
     * Everything the game did is in the result (a failed import, an entry that
     * does not load, a freeze, compile errors); it fails only when the check
     * could not be made: a tool or the machine. The agent's and the person's
     * check also plays the gameplay entry briefly for the scene report (see
     * GameEngineBackend.runCheck).
     */
    readonly check: (
      threadId: ThreadId,
      owner?: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
    /**
     * The boot check of a checkout no thread owns (a build's copy), as its own
     * operation; a build's facts read the scene from their own random-input play instead.
     */
    readonly checkIn: (
      root: string,
      owner: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
    /**
     * A clean `check` this server made of the very files `root` holds (its
     * engine project and game.json, byte for byte), or null. That check booted
     * the same entries and played the gameplay entry longer, so it stands for
     * the copy's boot check.
     */
    readonly cleanCheckOf: (root: string) => Effect.Effect<GameCheckResult | null>;
    /** `game_unity_recompile`: the live editor imports changed files and compiles, with C# errors at file:line. */
    readonly recompile: (
      threadId: ThreadId,
    ) => Effect.Effect<GameUnityRecompileResult, GameOperationError>;
    /**
     * The one tool this game's engine needs, as the toolchain sees it for this
     * project. Asked on every status read, so an answer is kept briefly per game.
     */
    readonly toolStatus: (root: string) => Effect.Effect<GameToolStatus | null, GameOperationError>;
    /** The resolution the game boots, explores and bot-plays at. */
    readonly viewport: (root: string) => Effect.Effect<GameViewport, GameOperationError>;
  }
>()("kurambit/game/GameEngine") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  const tools = yield* GameToolchain.GameToolchain;
  const processes = yield* GameProcesses.GameProcesses;
  const unity = yield* GameUnity.GameUnity;
  const gameBrowser = yield* makeGameBrowser;
  const templates = yield* GameTemplates.GameTemplates;
  const writeAtomic = yield* makeAtomicWriter;
  const backends = new Map<string, GameEngineBackend>([
    ["godot", makeGodotBackend(processes, tools, writeAtomic)],
    ["three", makeThreeBackend(gameBrowser, Effect.map(templates.directory, runtimesDirectory))],
    ["unity", makeUnityBackend(unity, tools)],
  ]);
  const backendFor = (engineName: string): Effect.Effect<GameEngineBackend, GameOperationError> => {
    const backend = backends.get(engineName);
    return backend === undefined
      ? Effect.fail(unsupportedEngine(engineName))
      : Effect.succeed(backend);
  };
  /** The backend that runs a game's engine work; a parked engine's is refused. */
  const runner = (manifest: GameManifest) =>
    isGameEngineActive(manifest.engine.name)
      ? backendFor(manifest.engine.name)
      : Effect.fail(parkedEngine(manifest.engine.name));
  const context = Effect.fn("GameEngine.context")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* runner(manifest);
    const project = yield* backend.resolveProject(root, manifest);
    return { backend, ctx: { root, ...project, runtime: manifestRuntime(manifest) } };
  });
  const importProject = Effect.fn("GameEngine.importProject")(function* (root: string) {
    const { backend, ctx } = yield* context(root);
    return (yield* backend.importProject(ctx)).result;
  });

  const snapshot = (root: string, project: string, backend: GameEngineBackend) =>
    Effect.promise((signal) =>
      snapshotBuildSource(root, project, { signal, rules: backend.profile.buildInputs }),
    );

  /**
   * Imports first: a fresh game has no .godot cache, so .tres files and
   * class_names can resolve. Import is cache preparation, not the check
   * itself: Godot's import can write sidecar files inside the project, so the
   * inputs are read after it and before the checking script runs.
   */
  const checkSources = (
    root: string,
    backend: GameEngineBackend,
    ctx: GameEngineContext,
    manifest: GameManifest,
    startedAt: number,
    scene: boolean,
  ) =>
    Effect.gen(function* () {
      const { profile } = backend;
      const project = ctx.projectName;
      const imported = yield* backend.importProject(ctx);
      const before = yield* snapshot(root, project, backend);
      // Sources that cannot be identified: a link or too many files is the
      // game's (a check error, through asResult), an unreadable tree ours.
      if (before.kind === "unknown")
        return yield* sourceIdentityError(`${profile.displayName} check`, root, project, before);
      const executed = yield* backend.runCheck(ctx, {
        gameplayScene: manifest.gameplayScene ?? "",
        scene,
      });
      const { run, reported } = executed;
      const errors = mergeCheckIssues(reported?.errors ?? [], [
        ...imported.issues,
        ...executed.issues,
      ]);
      // File labels name the engine project, whichever engine it is.
      const projectFile = `${project}/${backend.projectSettingsFile}`;
      if (!imported.result.success && imported.issues.length === 0)
        errors.unshift({
          file: projectFile,
          message: `Import failed with exit code ${imported.result.process?.exitCode ?? -1}. ${imported.result.message}`,
        });
      if (reported === null)
        errors.unshift({
          file: projectFile,
          message: `The ${profile.displayName} check script did not report a result. The project may have crashed during startup.`,
        });
      if (run.timedOut) errors.unshift({ file: projectFile, message: profile.check.timedOut });
      if (run.exitCode !== 0 && errors.length === 0)
        errors.unshift({
          file: projectFile,
          message: `${profile.displayName} exited with code ${run.exitCode}. ${commandDetail(run)}`,
        });
      // A game created before gameplay entries is checked as it always was, but
      // the warning says what the check did not cover rather than implying it did.
      const warnings = [
        ...(reported?.warnings ?? []),
        ...(manifest.gameplayScene == null && profile.check.withoutGameplayScene !== null
          ? [{ file: "game.json", message: profile.check.withoutGameplayScene }]
          : []),
      ];
      const after = yield* snapshot(root, project, backend);
      if (after.kind === "unknown")
        return yield* sourceIdentityError(`${profile.displayName} check`, root, project, after);
      // Sources that moved during the check (the game may write its own
      // folder as it runs) leave the verdict standing, with a warning.
      const comparison = comparedSource(before, after, "check");
      if (comparison.kind !== "current")
        warnings.unshift({ file: `${project}/`, message: comparison.detail });
      return {
        ok: errors.length === 0 && reported !== null && !run.timedOut,
        errors: limitIssues(errors),
        warnings: limitIssues(warnings),
        entries: reported?.entries ?? [],
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        ...(scene
          ? {
              scene: executed.scene ?? {
                status: "not-measured" as const,
                why: `${profile.displayName} games have no scene report yet; it is measured for three.js games`,
              },
            }
          : {}),
      } satisfies GameCheckResult;
    });

  const check = Effect.fn("GameEngine.check")(function* (
    root: string,
    options?: { readonly scene?: boolean },
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    // A failure the game's own files cause (an unreadable game.json, an editor
    // that will not open the project for its compile errors) is a check
    // result, so the check fails only when a tool or the machine kept it from
    // being made.
    const asResult = (error: GameOperationError) =>
      gameOperationFault(error.reason) !== "build"
        ? Effect.fail(error)
        : Effect.map(Clock.currentTimeMillis, (now) => ({
            ok: false,
            errors: limitIssues([
              { file: error.path, message: `${error.operation}: ${error.detail ?? error.reason}` },
            ]),
            warnings: [],
            entries: [],
            durationMs: now - startedAt,
          }));
    return yield* Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const backend = yield* runner(manifest);
      const project = yield* backend.resolveProject(root, manifest);
      const ctx = { root, ...project, runtime: manifestRuntime(manifest) };
      const work = checkSources(root, backend, ctx, manifest, startedAt, options?.scene === true);
      // With a live editor, import and check share one hold, as export does:
      // another game cannot take the editor between them.
      return yield* backend.editor === null ? work : backend.editor.hold(root)(work);
    }).pipe(Effect.catchTags({ GameOperationError: asResult }));
  });

  const toolAnswers = yield* Cache.make({
    lookup: (root: string) =>
      Effect.gen(function* () {
        const manifest = yield* projects.read(root);
        // A parked engine's tool is not looked for, not even for its own games.
        if (!isGameEngineActive(manifest.engine.name)) return null;
        const backend = yield* backendFor(manifest.engine.name);
        return yield* backend.toolStatus(root, manifest);
      }),
    capacity: 256,
    timeToLive: "30 seconds",
  });
  const toolStatus = (root: string) => Cache.get(toolAnswers, root);

  const viewport = Effect.fn("GameEngine.viewport")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* backendFor(manifest.engine.name);
    // The project folder alone answers this; no binary is resolved.
    return yield* backend.viewport(GameProjectService.insideGame(root, manifestProject(manifest)));
  });

  // Clean checks by the identity of what they checked. Memory only: one lost costs a boot check.
  const cleanChecks = new Map<string, GameCheckResult>();
  /** The engine project's files and game.json, by content; null when they cannot be read whole. */
  const checkedIdentity = (root: string) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const snapshot = yield* Effect.promise((signal) =>
        snapshotBuildSource(root, manifestProject(manifest), {
          signal,
          rules: engineProfile(manifest.engine.name).buildInputs,
        }),
      );
      if (snapshot.kind !== "known") return null;
      const manifestHash = yield* Effect.promise(() =>
        hashFile(NodePath.join(root, "game.json"), { noFollow: true }),
      );
      return `${manifest.engine.name}:${snapshot.sourceId}:${manifestHash.sha256}`;
    }).pipe(Effect.orElseSucceed(() => null));
  /** The thread's check, remembered when it is clean and its files held still throughout. */
  const checkRemembered = (root: string) =>
    Effect.gen(function* () {
      const before = yield* checkedIdentity(root);
      const result = yield* check(root, { scene: true });
      if (result.ok && before !== null && before === (yield* checkedIdentity(root))) {
        cleanChecks.delete(before);
        cleanChecks.set(before, result);
        if (cleanChecks.size > CLEAN_CHECKS) {
          const oldest = cleanChecks.keys().next().value;
          if (oldest !== undefined) cleanChecks.delete(oldest);
        }
      }
      return result;
    });
  const checkLabel = (root: string) =>
    Effect.map(
      projects.read(root),
      (manifest) => `${engineProfile(manifest.engine.name).displayName} check`,
    );
  return GameEngine.of({
    backendFor,
    context,
    importProject,
    import: (threadId) => projects.exclusive(threadId, "Import", importProject),
    check: (threadId, owner) =>
      Effect.gen(function* () {
        const label = yield* checkLabel(yield* projects.resolve(threadId));
        return yield* projects.exclusive(threadId, label, checkRemembered, { owner });
      }),
    checkIn: (root, owner) =>
      Effect.flatMap(checkLabel(root), (label) =>
        operations.exclusive(root, label, check(root), owner),
      ),
    cleanCheckOf: (root) =>
      Effect.map(checkedIdentity(root), (identity) =>
        identity === null ? null : (cleanChecks.get(identity) ?? null),
      ),
    recompile: (threadId) =>
      projects.exclusive(threadId, "Unity recompile", (root) =>
        Effect.gen(function* () {
          const { backend, ctx } = yield* context(root);
          if (backend.editor === null)
            return yield* new GameOperationError({
              operation: "Unity recompile",
              path: root,
              reason: "invalid-input",
              detail: "The game_unity_* tools work on Unity games; this game runs another engine.",
            });
          const imported = yield* backend.importProject(ctx);
          return {
            ok: imported.result.success,
            errors: imported.issues,
            warnings: [],
            text: imported.result.message.slice(0, 4000),
          };
        }),
      ),
    toolStatus,
    viewport,
  });
});

export const layer = Layer.effect(GameEngine, make);
