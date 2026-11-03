// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  GameOperationError,
  type GameCheckResult,
  type GameStatus,
  type GameAction,
  type GameActionResult,
  type GameOperationEvent,
  type GameWebPackage,
  type GameWindowsPackage,
  type ThreadId,
  GAME_EXPLORE_BOUNDS,
  EXPLORE_CAPTURE_BOUNDS,
  THREE_VIEWPORT,
  UNITY_VIEWPORT,
  exploreCaptureIssues,
  exploreStepIssues,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  type GameExploreStep,
  type GameConsoleMessage,
  type GamePlaytestProbe,
  type GameViewport,
  type GameBlenderCodeInput,
  type GameBlenderCodeResult,
  type GameBlenderExportInput,
  type GameBlenderExportResult,
  type GameBlenderLookInput,
  type GameBlenderLookResult,
  type GameBlenderSceneInput,
  type GameBlenderSceneResult,
  type GameBlenderAssetsSearchInput,
  type GameBlenderAssetsSearchResult,
  type GameBlenderAssetsImportInput,
  type GameBlenderAssetsImportResult,
  type GameAssetsAddInput,
  type GameAssetsAddResult,
  type GameAssetsSearchInput,
  type GameAssetsSearchResult,
  type GameUnityConsoleInput,
  type GameUnityEditInput,
  type GameUnityEvalInput,
  type GameUnityPlayInput,
  type GameUnityRecompileResult,
  type GameUnityScreenshotInput,
  type GameUnityScreenshotResult,
  type GameUnityTextResult,
  type GameUnityToolsResult,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotReportResult,
  type GameBotViewInput,
  type GameBotViewResult,
  type GameSecretName,
  type GameSetSecretInput,
  type GameSetSecretResult,
  type GameSecretsStatusResult,
} from "@kurambit/contracts";
import * as GameExploreNative from "./gameExploreNative.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as ExploreSheet from "./exploreSheet.ts";
import * as ExploreEvidence from "./exploreEvidence.ts";
import * as GameBlender from "./GameBlender.ts";
import * as GameBot from "./GameBot.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameUnity from "./GameUnity.ts";
import { unityPlayerDirectory } from "./GameUnityEngine.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { openMediaFile, type OpenMediaFile } from "../assets/MediaFile.ts";
import { commandDetail } from "./commandDetail.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  describeWebArtifacts,
  hashWebBuild,
  hashWebBuildDirectory,
} from "./webBuild.ts";
import {
  comparedSource,
  headCommit,
  restoredToCommit,
  snapshotBuildSource,
} from "./sourceSnapshot.ts";
import * as GameOperations from "./GameOperations.ts";
import { userDirConfigIssues } from "./gameNativeUserDir.ts";
import { mergeCheckIssues, limitIssues } from "./godotCheckOutput.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import { openExploreWeb, webStepIssues, type ExploreWebHandle } from "./gameExploreWeb.ts";
import { requireChromium } from "./gameChromium.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import { planWindowsPreset } from "./windowsPreset.ts";
import { inspectWindowsBuild, type WindowsBuildInspection } from "./windowsExport.ts";
import { publishWindowsBuild } from "./windowsPublication.ts";
import {
  WEB_PACKAGE_FILE,
  packageWebRelease,
  WebPackageError,
  webPackageArchivePath,
} from "./webPackage.ts";
import {
  packageWindowsRelease,
  retireWindowsArchive,
  WindowsPackageError,
  WINDOWS_PACKAGE_FILE,
  windowsPackageArchivePath,
} from "./windowsPackage.ts";

/** Short confirmation the creator reads after an export lands. */
const WEB_READY_MESSAGE = "Web game is ready to play. Open it with Play.";

/**
 * Hashes an already opened, identity-checked archive. A download names the
 * archive it was minted for, so the bytes served must still be those bytes.
 */
const hashOpenFile = async (file: OpenMediaFile) => {
  const hash = NodeCrypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  for (;;) {
    const result = await file.handle.read(buffer, 0, buffer.byteLength, offset);
    if (result.bytesRead === 0) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return { bytes: offset, sha256: hash.digest("hex") };
};

export class GameService extends Context.Service<
  GameService,
  {
    readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void, GameOperationError>;
    readonly finishExploration: (threadId: ThreadId) => Effect.Effect<
      {
        sessions: number;
        actions: number;
        executedInputSteps: number;
        nominalMs: number;
        images: number;
      },
      GameOperationError
    >;
    /**
     * Caps the explore input this thread may use across all its sessions;
     * starts and acts past it are refused with the reason.
     */
    readonly limitExploreInput: (threadId: ThreadId, totalMs: number) => Effect.Effect<void>;
    /**
     * Tiles an even selection of the frames this thread's explore sessions kept
     * into one JPEG at `output` (absolute). Returns how many frames it drew; 0
     * draws nothing.
     */
    readonly exploreSheet: (
      threadId: ThreadId,
      output: string,
    ) => Effect.Effect<number, GameOperationError>;
    readonly status: (
      threadId: ThreadId,
      options?: { readonly checkSources?: boolean | undefined },
    ) => Effect.Effect<GameStatus, GameOperationError>;
    /** Operation pushes for every game this server runs. */
    readonly events: Stream.Stream<GameOperationEvent>;
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Close the live Blender and Unity editors without saving, so a scene held
     * in memory cannot save over files restored on disk; the next call reopens them.
     */
    readonly closeLiveEditors: (root: string) => Effect.Effect<void>;
    /** Live Blender scene: run bpy code, auto-saving the .blend source. */
    readonly blenderCode: (
      threadId: ThreadId,
      input: GameBlenderCodeInput,
    ) => Effect.Effect<GameBlenderCodeResult, GameOperationError>;
    /** Live Blender scene: see it as one image (viewport, camera, angles, frames). */
    readonly blenderLook: (
      threadId: ThreadId,
      input: GameBlenderLookInput,
    ) => Effect.Effect<GameBlenderLookResult, GameOperationError>;
    /** Live Blender scene: facts as text (objects, sizes, health). */
    readonly blenderScene: (
      threadId: ThreadId,
      input: GameBlenderSceneInput,
    ) => Effect.Effect<GameBlenderSceneResult, GameOperationError>;
    /** Live Blender scene: search a library of existing assets. */
    readonly blenderAssetsSearch: (
      threadId: ThreadId,
      input: GameBlenderAssetsSearchInput,
    ) => Effect.Effect<GameBlenderAssetsSearchResult, GameOperationError>;
    /**
     * Live Blender scene: import a library asset, save the .blend source in
     * the game and export a GLB under godot/ the game can load. Run
     * game_import after so Godot sees it.
     */
    readonly blenderAssetsImport: (
      threadId: ThreadId,
      input: GameBlenderAssetsImportInput,
    ) => Effect.Effect<GameBlenderAssetsImportResult, GameOperationError>;
    /**
     * Live Blender scene: export the named objects (or every mesh) as a GLB
     * under the engine directory, saving the .blend source. Run game_import
     * after.
     */
    readonly blenderExport: (
      threadId: ThreadId,
      input: GameBlenderExportInput,
    ) => Effect.Effect<GameBlenderExportResult, GameOperationError>;
    /** The pinned CC0 library: packs, or files inside one pack with a contact sheet. */
    readonly assetsSearch: (
      threadId: ThreadId,
      input: GameAssetsSearchInput,
    ) => Effect.Effect<GameAssetsSearchResult, GameOperationError>;
    /** Copy library files into the engine's asset dir and credit them in ASSETS.md. */
    readonly assetsAdd: (
      threadId: ThreadId,
      input: GameAssetsAddInput,
    ) => Effect.Effect<GameAssetsAddResult, GameOperationError>;
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux" | "Windows",
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Which export targets the game's engine backend declares, with its display
     * name. Internal loop fact resolved through the existing engine path; not
     * an MCP tool. Runs no processes.
     */
    readonly exportTargets: (threadId: ThreadId) => Effect.Effect<
      {
        targets: ReadonlyArray<"Web" | "Linux" | "Windows">;
        displayName: string;
      },
      GameOperationError
    >;
    /**
     * Packages the already exported Windows release as a ZIP. It never exports;
     * a missing or unusable release is an error and leaves earlier files alone.
     */
    readonly packageWindows: (
      threadId: ThreadId,
    ) => Effect.Effect<GameWindowsPackage, GameOperationError>;
    /**
     * Packages the exact immutable Web build Play currently serves as a
     * static-host ZIP. It never exports and never chooses another build.
     */
    readonly packageWeb: (threadId: ThreadId) => Effect.Effect<GameWebPackage, GameOperationError>;
    /** The complete archive a signed download URL serves; never creates one. */
    readonly webPackageFile: (
      threadId: ThreadId,
      buildId: string,
      packageSha256: string,
    ) => Effect.Effect<
      {
        readonly path: string;
        readonly fileName: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly identity: { readonly device: string; readonly inode: string };
      },
      GameOperationError
    >;
    /** The complete archive a signed download URL serves; never creates one. */
    readonly windowsPackageFile: (
      threadId: ThreadId,
      packageSha256: string,
    ) => Effect.Effect<
      {
        readonly path: string;
        readonly fileName: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly identity: { readonly device: string; readonly inode: string };
      },
      GameOperationError
    >;
    /**
     * Opens a bounded persistent exploration session on the current game
     * sources. Short act/observe cycles keep one paused runner; closing
     * releases it. Descriptive only: it never qualifies or passes quality.
     */
    readonly exploreStart: (
      threadId: ThreadId,
      input: typeof GameExploreStartInput.Type,
    ) => Effect.Effect<typeof GameExploreStartResult.Type, GameOperationError>;
    /** Runs one short input step batch in an exploration session. */
    readonly exploreAct: (
      threadId: ThreadId,
      input: typeof GameExploreActInput.Type,
    ) => Effect.Effect<typeof GameExploreActResult.Type, GameOperationError>;
    /** Closes a session, releasing its runner and profile. */
    readonly exploreClose: (
      threadId: ThreadId,
      input: typeof GameExploreCloseInput.Type,
    ) => Effect.Effect<typeof GameExploreCloseResult.Type, GameOperationError>;
    /**
     * Runs a model-written bot file against the real game in real time at
     * normal speed on a private display. Holds and releases go out at 10 Hz,
     * one continuous video is recorded, and detectors findings carry time
     * and position. Never blocked by another operation: one bot run per game
     * at a time, refused as busy otherwise.
     */
    readonly botRun: (
      threadId: ThreadId,
      input: GameBotRunInput,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /**
     * The same bot run in a checkout of the game no thread owns, such as the
     * production run's checkout of one build for its blind comparison.
     */
    readonly botRunIn: (
      root: string,
      input: GameBotRunInput,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /** Rebuild the facts-only player report across this game's bot runs. */
    readonly botReport: (
      threadId: ThreadId,
    ) => Effect.Effect<GameBotReportResult, GameOperationError>;
    /**
     * Which Game Tools keys are set. Presence alone, never values: the UI
     * shows "set" or "not set" from this.
     */
    readonly secretsStatus: () => Effect.Effect<
      { readonly jev: boolean; readonly sketchfab: boolean; readonly polypizza: boolean },
      GameOperationError
    >;
    /** Store a Game Tools key, or clear it with an empty value. */
    readonly setSecret: (
      input: typeof GameSetSecretInput.Type,
    ) => Effect.Effect<typeof GameSetSecretResult.Type, GameOperationError>;
    /** A quick look at a finished bot run: summary, findings and evidence paths. */
    readonly botView: (
      threadId: ThreadId,
      input: GameBotViewInput,
    ) => Effect.Effect<GameBotViewResult, GameOperationError>;
    readonly check: (threadId: ThreadId) => Effect.Effect<GameCheckResult, GameOperationError>;
    /** Live Unity editor: the editing tools game_unity_edit may call, with input schemas. */
    readonly unityTools: (
      threadId: ThreadId,
    ) => Effect.Effect<GameUnityToolsResult, GameOperationError>;
    /** Live Unity editor: call one editing tool, then save the open scenes. */
    readonly unityEdit: (
      threadId: ThreadId,
      input: GameUnityEditInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    /** Live Unity editor: evaluate C# on the editor's main thread. */
    readonly unityEval: (
      threadId: ThreadId,
      input: GameUnityEvalInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    /** Live Unity editor: import changed files and compile, with C# errors at file:line. */
    readonly unityRecompile: (
      threadId: ThreadId,
    ) => Effect.Effect<GameUnityRecompileResult, GameOperationError>;
    /** Live Unity editor: enter or leave play mode. */
    readonly unityPlay: (
      threadId: ThreadId,
      input: GameUnityPlayInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
    /** Live Unity editor: the Game view through the main camera, as one image. */
    readonly unityScreenshot: (
      threadId: ThreadId,
      input: GameUnityScreenshotInput,
    ) => Effect.Effect<GameUnityScreenshotResult, GameOperationError>;
    /** Live Unity editor: recent console entries. */
    readonly unityConsole: (
      threadId: ThreadId,
      input: GameUnityConsoleInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
  }
>()("kurambit/game/GameService") {}
const isGameOperationError = Schema.is(GameOperationError);

/** The build Play serves, written at each Web export. */
const SelectedWebBuild = Schema.Struct({
  buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  directory: Schema.String.check(Schema.isMinLength(1)),
  sourceId: Schema.NullOr(Schema.String),
  entry: Schema.String.check(Schema.isMinLength(1)),
});
interface SelectedWebBuild extends Schema.Schema.Type<typeof SelectedWebBuild> {}
const decodeSelectedBuild = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(SelectedWebBuild)),
);
const encodeSelectedBuild = Schema.encodeSync(Schema.fromJsonString(SelectedWebBuild));

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const gameEngine = yield* GameEngine.GameEngine;
  const liveUnity = yield* GameUnity.GameUnity;
  const preview = yield* GamePreview.GamePreview;
  const liveBlender = yield* GameBlender.GameBlender;
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const gameBot = yield* GameBot.GameBot;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const operations = yield* GameOperations.GameOperations;
  const evidenceDir = NodePath.join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "explore-evidence",
  );
  const startedMs = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, startedMs)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Pruning explore evidence failed.", { cause })),
  );
  // `owner` is the thread whose call started the operation. A turn that ends
  // cancels only its own work: the production loop runs boot checks on the
  // same game while role turns are being interrupted at their caps.
  const active = new Map<
    string,
    { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void>; owner: string }
  >();
  /** Cancels the game's running operation; with `owner`, only that thread's. */
  const cancel = Effect.fnUntraced(function* (root: string, owner?: string) {
    const operation = active.get(root);
    if (operation === undefined) return;
    if (owner !== undefined && operation.owner !== owner) return;
    yield* Deferred.succeed(operation.cancelled, undefined);
    // The race interrupts work and awaits its finalizers, including native child exit.
    yield* Deferred.await(operation.done);
  });
  /**
   * Operations report failure in more than one shape: action results use
   * `success` and the Godot check uses `ok`. The shared operation state has
   * to see both, or a failed build announces success to the stage.
   */
  const operationFailed = (result: unknown): boolean => {
    if (typeof result !== "object" || result === null) return false;
    if ("success" in result && result.success === false) return true;
    if ("ok" in result && result.ok === false) return true;
    return false;
  };
  /** The honest message for a finished operation. */
  const operationMessage = (result: unknown, name: string): string => {
    if (typeof result !== "object" || result === null) return `${name} completed.`;
    return "message" in result ? String(result.message) : `${name} completed.`;
  };
  const exclusive = <A>(
    root: string,
    name: string,
    work: Effect.Effect<A, GameOperationError>,
    owner: string,
  ) =>
    Effect.gen(function* () {
      if (active.has(root))
        return yield* new GameOperationError({ operation: name, path: root, reason: "busy" });
      const cancelled = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const at = DateTime.formatIso(yield* DateTime.now);
      active.set(root, { cancelled, done, owner });
      yield* operations.record(
        root,
        { name, state: "running", message: `${name} is running.`, at },
        "running",
      );
      const stopped = Deferred.isDone(cancelled);
      return yield* work.pipe(
        Effect.raceFirst(
          Deferred.await(cancelled).pipe(
            Effect.andThen(
              Effect.fail(
                new GameOperationError({
                  operation: name,
                  path: root,
                  reason: "command-failed",
                  detail: "Operation cancelled.",
                }),
              ),
            ),
          ),
        ),
        Effect.tap((result) =>
          Effect.gen(function* () {
            const failed = operationFailed(result);
            yield* operations.record(
              root,
              {
                name,
                state: failed ? "failed" : "succeeded",
                message: operationMessage(result, name),
                at,
              },
              failed ? "failed" : "succeeded",
            );
          }),
        ),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const wasCancelled = yield* stopped;
            yield* operations.record(
              root,
              {
                name,
                // The status field has no cancelled state; Stop reads as a
                // failed run with an honest message.
                state: "failed",
                message: error.message,
                at,
              },
              wasCancelled ? "cancelled" : "failed",
            );
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* operations.record(
              root,
              { name, state: "failed", message: `${name} was cancelled.`, at },
              "cancelled",
            );
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(root);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        ),
      );
    });
  /**
   * Resolve the game's engine through the registry: an unsupported engine
   * fails here, before any executable lookup or process launch. The returned
   * backend owns engine execution and parsing; the core keeps orchestration.
   */
  const engine = Effect.fnUntraced(function* (root: string) {
    const resolved = yield* gameEngine.resolve(root);
    return {
      backend: resolved.backend,
      godot: resolved.binary,
      cwd: resolved.cwd,
      godotProject: resolved.project,
    };
  });
  const snapshot = (root: string, godotProject: string) =>
    Effect.promise((signal) => snapshotBuildSource(root, godotProject, { signal }));
  // No exclusive() here: a real-time run takes minutes and must not hold the
  // game's operation lock. The bot service refuses a second concurrent run
  // per checkout as busy.
  const botRunIn = Effect.fnUntraced(function* (root: string, input: GameBotRunInput) {
    const manifest = yield* projects.read(root);
    if (manifest.engine.name === "unity")
      return yield* new GameOperationError({
        operation: "Bot run",
        path: root,
        reason: "invalid-input",
        detail:
          "Bot runs do not play Unity games yet. Play a Unity game with game_explore_start/act/close, which runs a real Linux build with real input.",
      });
    // Static sources need no editor import; the bot plays the folder.
    if (manifest.engine.name !== "three") {
      const imported = yield* importGame(root);
      if (!imported.success)
        return yield* new GameOperationError({
          operation: "Bot run",
          path: imported.path ?? root,
          reason: "command-failed",
          detail: `The Godot import failed before the bot run started.\n${imported.message}`.slice(
            -2000,
          ),
        });
    }
    return yield* gameBot.run(root, input);
  });
  const importGame = Effect.fnUntraced(function* (root: string, projectDir?: string) {
    const { backend, godot, cwd, godotProject } = yield* engine(root);
    const executed = yield* backend.importProject({
      root,
      projectDir: projectDir ?? cwd,
      projectName: godotProject,
      binary: godot,
    });
    return executed.result;
  });
  /**
   * Ensures the project has a usable Windows Desktop preset. Its text is
   * written atomically because a half-written preset would break every later
   * export; a preset the creator already wrote is never rewritten.
   */
  const ensureWindowsPreset = (presetsPath: string) =>
    Effect.gen(function* () {
      const existing = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.readFile(presetsPath, "utf8");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-windows",
            path: presetsPath,
            reason: "io",
            cause,
          }),
      });
      const plan = planWindowsPreset(existing);
      if (!plan.ok)
        return yield* new GameOperationError({
          operation: "export-windows",
          path: presetsPath,
          reason: "invalid-input",
          detail: plan.detail,
        });
      if (plan.text !== null) {
        const text = plan.text;
        const temporary = `${presetsPath}.${NodeCrypto.randomUUID()}.tmp`;
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.writeFile(temporary, text, "utf8");
            await NodeFSP.rename(temporary, presetsPath);
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "export-windows",
              path: presetsPath,
              reason: "io",
              detail:
                "The Windows export preset could not be added; existing presets were left as they were.",
              cause,
            }),
        }).pipe(Effect.ensuring(Effect.promise(() => NodeFSP.rm(temporary, { force: true }))));
      }
      return plan;
    });
  const SELECTED_BUILD_FILE = "builds/web-selected.json";
  const readSelectedBuild = (root: string): Effect.Effect<SelectedWebBuild | null> =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(root, SELECTED_BUILD_FILE), "utf8")
        .then((text) => decodeSelectedBuild(text))
        .catch(() => null),
    );
  const writeSelectedBuild = (
    root: string,
    selected: SelectedWebBuild,
  ): Effect.Effect<void, GameOperationError> =>
    Effect.tryPromise({
      try: () =>
        NodeFSP.writeFile(
          NodePath.join(root, SELECTED_BUILD_FILE),
          `${encodeSelectedBuild(selected)}\n`,
        ),
      catch: (cause) =>
        new GameOperationError({
          operation: "export",
          path: NodePath.join(root, SELECTED_BUILD_FILE),
          reason: "io",
          cause,
        }),
    });
  /**
   * A Unity player is a folder (the executable, its `game_Data/` and the
   * engine runtime library), so it builds into a staging folder and replaces
   * builds/linux or builds/windows only once its files check out and the
   * sources did not change during the build. The caller imports first.
   */
  const buildUnityPlayer = Effect.fnUntraced(function* (
    root: string,
    target: "Linux" | "Windows",
    destination: string,
    operation: string,
  ) {
    const { backend, godot, cwd, godotProject } = yield* engine(root);
    const executable = target === "Windows" ? "game.exe" : "game.x86_64";
    const staging = NodePath.join(
      NodePath.dirname(destination),
      `.${NodePath.basename(destination)}-${NodeCrypto.randomUUID()}`,
    );
    return yield* Effect.gen(function* () {
      const before = yield* snapshot(root, godotProject);
      const headBefore = yield* Effect.promise(() => headCommit(root));
      // An interrupted build leaves its staging folder; only this build's own name prefix is cleared.
      yield* Effect.promise(async () => {
        const parent = NodePath.dirname(destination);
        const prefix = `.${NodePath.basename(destination)}-`;
        for (const name of await NodeFSP.readdir(parent).catch(() => [] as string[]))
          if (name.startsWith(prefix))
            await NodeFSP.rm(NodePath.join(parent, name), { recursive: true, force: true });
      });
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(staging, { recursive: true }),
        catch: (cause) => new GameOperationError({ operation, path: staging, reason: "io", cause }),
      });
      const result = yield* backend.runExportRelease(
        { root, projectDir: cwd, projectName: godotProject, binary: godot },
        { preset: target, outputPath: NodePath.join(staging, executable), operation },
      );
      if (!result.success) return { result, sourceId: null };
      // Unity names this debug-symbol folder itself: it is never shipped.
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(staging, "game_BackUpThisFolder_ButDontShipItWithYourGame"), {
          recursive: true,
          force: true,
        }),
      );
      const runtime = target === "Windows" ? "UnityPlayer.dll" : "UnityPlayer.so";
      const missing = yield* Effect.promise(async () => {
        const absent: string[] = [];
        for (const [name, kind] of [
          [executable, "file"],
          ["game_Data", "directory"],
          [runtime, "file"],
        ] as const) {
          const stat = await NodeFSP.stat(NodePath.join(staging, name)).catch(() => null);
          if (
            stat === null ||
            (kind === "file" ? !stat.isFile() || stat.size === 0 : !stat.isDirectory())
          )
            absent.push(name);
        }
        return absent;
      });
      if (missing.length > 0)
        return {
          result: {
            ...result,
            success: false,
            message:
              `The Unity ${target} build is missing ${missing.join(", ")}; nothing was replaced.\n${result.message}`.slice(
                -4096,
              ),
          },
          sourceId: null,
        };
      const after = yield* snapshot(root, godotProject);
      let comparison = comparedSource(before, after, "export");
      // URP's re-save of its pipeline assets is the one mid-build change that
      // still built these sources (restoredToCommit says exactly when).
      if (
        comparison.kind === "changed" &&
        before.kind === "known" &&
        after.kind === "known" &&
        (yield* Effect.promise(() =>
          restoredToCommit(root, godotProject, before, after, headBefore),
        ))
      )
        comparison = { kind: "current", sourceId: after.sourceId };
      if (comparison.kind !== "current")
        return {
          result: { ...result, success: false, message: comparison.detail },
          sourceId: null,
        };
      yield* Effect.tryPromise({
        try: async () => {
          const old = `${destination}.old-${NodeCrypto.randomUUID()}`;
          const existing = await NodeFSP.stat(destination).catch(() => null);
          if (existing !== null) await NodeFSP.rename(destination, old);
          try {
            await NodeFSP.rename(staging, destination);
          } catch (cause) {
            // The previous build goes back rather than leaving no build at all.
            if (existing !== null) await NodeFSP.rename(old, destination).catch(() => undefined);
            throw cause;
          }
          await NodeFSP.rm(old, { recursive: true, force: true });
        },
        catch: (cause) =>
          new GameOperationError({
            operation,
            path: destination,
            reason: "io",
            detail: "The checked Unity build could not be moved into place.",
            cause,
          }),
      });
      return {
        result: { ...result, path: NodePath.join(destination, executable) },
        sourceId: comparison.sourceId,
      };
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true }))),
    );
  });
  const runUnityExport = Effect.fnUntraced(function* (
    root: string,
    target: "Web" | "Linux" | "Windows",
  ) {
    if (target === "Web")
      return yield* new GameOperationError({
        operation: "Unity export",
        path: root,
        reason: "invalid-input",
        detail: "Unity games export Linux and Windows only; Web (WebGL) is refused for now.",
      });
    const directory = target === "Windows" ? "builds/windows" : "builds/linux";
    // One hold for import and build: another game cannot take the editor between them.
    const built = yield* liveUnity.hold(root)(
      Effect.gen(function* () {
        const imported = yield* importGame(root);
        if (!imported.success) return { result: imported, sourceId: null };
        return yield* buildUnityPlayer(
          root,
          target,
          NodePath.join(root, directory),
          `export-${target.toLowerCase()}`,
        );
      }),
    );
    if (!built.result.success) return built.result;
    return {
      ...built.result,
      message:
        target === "Windows"
          ? "Unity Windows x86_64 build ready at builds/windows/game.exe with game_Data/, UnityPlayer.dll and MonoBleedingEdge/ beside it; ship the whole folder. This machine did not run it on Windows."
          : "Unity Linux x86_64 build ready at builds/linux/game.x86_64 with game_Data/ and UnityPlayer.so beside it; ship the whole folder.",
    };
  });
  const runExport = Effect.fnUntraced(function* (
    root: string,
    target: "Web" | "Linux" | "Windows",
  ) {
    const { backend, godot, cwd, godotProject } = yield* engine(root);
    if (!backend.exportTargets.includes(target))
      return yield* new GameOperationError({
        operation: `${backend.displayName} export`,
        path: root,
        reason: "invalid-input",
        detail: `${backend.displayName} games export ${backend.exportTargets.join(", ")} only; ${target} is refused for this engine.`,
      });
    if (backend.id === "unity") return yield* runUnityExport(root, target);
    const toolStatus = yield* tools.status;
    const engineStatus =
      backend.id === "godot"
        ? toolStatus.tools.find((tool) => tool.tool === "godot")
        : { ready: true };
    if (!engineStatus?.ready)
      return yield* new GameOperationError({
        operation: `${backend.displayName} export`,
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Godot executable: ${godot.path} (${godot.version}).`,
      });
    const windowsTemplates = godot.templates;
    if (
      target === "Windows" &&
      (windowsTemplates === null ||
        !(yield* Effect.promise(() => GameToolchain.hasWindowsExportTemplates(windowsTemplates))))
    )
      return yield* new GameOperationError({
        operation: `${backend.displayName} Windows export`,
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Windows x86_64 export templates for Godot ${godot.version} are missing from ${godot.templates ?? "the template directory"}. Ask the user to run Install tools in Settings > General > Game tools to add them; the Godot binary and the Web/Linux templates are reused as they are. Godot executable: ${godot.path}.`,
      });
    // Import first: Godot's import writes engine-generated sidecars (*.import,
    // *.uid and .godot/) inside the project. The source identity is taken after
    // that import and never counts those files, so a fresh tree imports
    // cleanly and a snapshot never carries engine output.
    const imported = yield* importGame(root);
    if (!imported.success) return imported;
    // The preset is part of the exported sources, so it is settled before the
    // source identity is taken. Only a Windows export touches it.
    const windowsPreset =
      target === "Windows"
        ? yield* ensureWindowsPreset(NodePath.join(cwd, "export_presets.cfg"))
        : null;
    // Web exports stage in a hidden directory under the candidate root, never in
    // the served tree. A partial or failed export therefore cannot change what
    // Play loads; only a complete, hashed artifact is moved into place.
    const staging =
      target === "Web"
        ? NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY, `.staging-${NodeCrypto.randomUUID()}`)
        : null;
    const windowsOutput =
      target === "Windows" ? NodePath.join(root, "builds/windows/game.exe") : null;
    // A failed Windows export must leave the previous game.exe usable, so the
    // engine writes beside it and the artifact is moved into place only after
    // its PE and pack check out.
    const windowsStaging =
      windowsOutput === null
        ? null
        : NodePath.join(NodePath.dirname(windowsOutput), `.game-${NodeCrypto.randomUUID()}.exe`);
    const output =
      staging !== null
        ? NodePath.join(staging, "index.html")
        : (windowsOutput ?? NodePath.join(root, "builds/linux/game.x86_64"));
    const exportOutput = windowsStaging ?? output;
    const cleanedUp = Effect.ensuring(
      Effect.promise(async () => {
        if (staging !== null) await NodeFSP.rm(staging, { recursive: true, force: true });
        if (windowsStaging !== null) {
          await NodeFSP.rm(windowsStaging, { force: true });
          await NodeFSP.rm(windowsStaging.replace(/\.exe$/, ".pck"), { force: true });
        }
      }),
    );
    return yield* Effect.gen(function* () {
      const before = yield* snapshot(root, godotProject);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(exportOutput), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "export", path: exportOutput, reason: "io", cause }),
      });
      const exportPresetName = windowsPreset?.name ?? target;
      const exportResult = yield* backend.runExportRelease(
        {
          root,
          projectDir: cwd,
          projectName: godotProject,
          binary: godot,
        },
        {
          preset: exportPresetName,
          outputPath: exportOutput,
          operation: `export-${target.toLowerCase()}`,
        },
      );
      // The engine writes beside the previous build; the reported path is the
      // published artifact the inspection below moves into place.
      const result =
        windowsOutput !== null ? { ...exportResult, path: windowsOutput } : exportResult;
      if (!result.success) return result;
      // A Godot web release is its entry plus the engine files beside it; a
      // three.js release is the static copy, whose entry proves the staging.
      const expectedFiles =
        target === "Web"
          ? backend.id === "three"
            ? [output]
            : [
                output,
                output.replace(/\.html$/, ".wasm"),
                output.replace(/\.html$/, ".js"),
                output.replace(/\.html$/, ".pck"),
              ]
          : [exportOutput];
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of expectedFiles) {
            const stat = await NodeFSP.stat(file);
            if (!stat.isFile() || stat.size === 0) throw new Error(`Empty export: ${file}`);
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "export-output",
            path: exportOutput,
            reason: "command-failed",
            detail:
              `Expected nonempty export files were missing.\n${commandDetail(result.process!)}`.slice(
                -4096,
              ),
            cause,
          }),
      });
      let windowsMessage: string | null = null;
      let checkedWindows: {
        readonly inspection: WindowsBuildInspection;
        readonly stagedPck: string;
      } | null = null;
      if (windowsOutput !== null && windowsStaging !== null) {
        const stagedPck = windowsStaging.replace(/\.exe$/, ".pck");
        const inspection = yield* Effect.tryPromise({
          try: async () => {
            const executable = await NodeFSP.readFile(windowsStaging);
            const pck = await NodeFSP.readFile(stagedPck).catch(() => null);
            return await inspectWindowsBuild({ executable, pck });
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "export-windows",
              path: windowsStaging,
              reason: "command-failed",
              detail: "The exported Windows executable could not be read back.",
              cause,
            }),
        });
        if (inspection.issues.length > 0)
          return {
            ...result,
            success: false,
            message:
              `The Windows export did not produce a usable x86_64 executable with the game's pack: ${inspection.issues.join(" ")}\n${commandDetail(result.process!)}`.slice(
                -4096,
              ),
          };
        checkedWindows = { inspection, stagedPck };
      }
      // Hash the staged artifact before it becomes visible. The hash is the
      // directory name, so an immutable build can never be overwritten later
      // with different bytes under the same identity.
      const hashed =
        staging === null ? null : yield* Effect.promise(() => hashWebBuildDirectory(staging));
      if (target === "Web" && hashed === null)
        return {
          ...result,
          success: false,
          message: "The exported web build directory could not be read back.",
        };
      // Prove the game folder did not change while the export ran: an edit
      // during the export means the build no longer describes the sources.
      const comparison = comparedSource(before, yield* snapshot(root, godotProject), "export");
      if (comparison.kind !== "current") {
        const detail = comparison.detail;
        return {
          ...result,
          success: false,
          message: `${detail}\n${commandDetail(result.process!)}`.slice(-4096),
        };
      }
      // The checked artifact stays staged until the source comparison accepts
      // it. Only then may it replace a build the creator already had.
      if (windowsOutput !== null && windowsStaging !== null && checkedWindows !== null) {
        const { inspection, stagedPck } = checkedWindows;
        const publication = yield* Effect.tryPromise({
          try: async () => {
            const retirement = await retireWindowsArchive({
              archive: windowsPackageArchivePath(root),
            });
            try {
              const published = await publishWindowsBuild({
                stagedExecutable: windowsStaging,
                stagedPck: inspection.embeddedPck ? null : stagedPck,
                executable: windowsOutput,
                pck: windowsOutput.replace(/\.exe$/, ".pck"),
              });
              const retirementNotes = retirement === null ? [] : await retirement.discard();
              return { ...published, notes: [...published.notes, ...retirementNotes] };
            } catch (cause) {
              if (retirement !== null) await retirement.restore();
              throw cause;
            }
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "export-windows",
              path: windowsOutput,
              reason: "io",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "The checked Windows build could not be moved into builds/windows.",
              cause,
            }),
        });
        windowsMessage =
          (inspection.embeddedPck
            ? `Windows x86_64 build ready at builds/windows/game.exe with its game data embedded (${Math.round(inspection.executableBytes / (1024 * 1024))} MB).`
            : `Windows x86_64 build ready at builds/windows/game.exe with builds/windows/game.pck beside it (${Math.round(inspection.executableBytes / (1024 * 1024))} MB). Keep both files together.`) +
          (windowsPreset === null || windowsPreset.text === null
            ? ""
            : " A standard Windows export preset was added.") +
          (publication.notes.length === 0 ? "" : ` ${publication.notes.join(" ")}`) +
          " This machine did not run it on Windows.";
      }
      const directory = hashed === null ? null : candidateBuildDirectory(hashed.buildId);
      if (hashed !== null && directory !== null) {
        const final = NodePath.join(root, directory);
        const existing = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(final, "index.html")).then(
            () => true,
            () => false,
          ),
        );
        const staged = staging!;
        const same =
          existing &&
          (yield* Effect.promise(() => hashWebBuildDirectory(final)))?.buildId === hashed.buildId;
        if (same) yield* Effect.promise(() => NodeFSP.rm(staged, { recursive: true, force: true }));
        else {
          // A directory under our own hash that does not hash to it is
          // corruption; replace it rather than serve bytes the id did not name.
          if (existing)
            yield* Effect.promise(() => NodeFSP.rm(final, { recursive: true, force: true }));
          yield* Effect.promise(() => NodeFSP.rename(staged, final));
        }
      }
      // The record names every served file, not just index.html: a deleted or
      // replaced .pck must force a rebuild before anyone plays it.
      const artifacts =
        directory === null
          ? null
          : yield* Effect.promise(() => describeWebArtifacts(root, directory));
      if (target === "Web" && (artifacts === null || hashed === null || directory === null))
        return {
          ...result,
          success: false,
          message: "The exported web build directory could not be read back.",
        };
      if (hashed !== null && directory !== null) {
        const after = yield* snapshot(root, godotProject);
        const selected: SelectedWebBuild = {
          buildId: hashed.buildId,
          directory,
          sourceId: after !== null && after.kind === "known" ? after.sourceId : null,
          entry: "index.html",
        };
        yield* writeSelectedBuild(root, selected);
        return {
          ...result,
          path: NodePath.join(root, directory, "index.html"),
          message: WEB_READY_MESSAGE,
        };
      }
      return windowsMessage === null
        ? result
        : { ...result, path: windowsOutput ?? result.path, message: windowsMessage };
    }).pipe(cleanedUp);
  });
  /**
   * The build Play should show: the selected one while its immutable directory
   * still hashes to its recorded id, otherwise a pre-change builds/web game, or
   * null when the game has never been built.
   */
  const selectedPreview = (root: string) =>
    Effect.gen(function* () {
      const selected = yield* readSelectedBuild(root);
      if (selected !== null) {
        const hashed = yield* Effect.promise(() => hashWebBuild(root, selected.directory));
        if (hashed !== null && hashed.buildId === selected.buildId)
          return {
            directory: selected.directory,
            selected,
            url: yield* preview.select(root, selected.directory),
          };
      }
      // Only a game with no selection may fall back to a pre-change build; a
      // broken selected record must rebuild, not silently serve something else.
      if (selected !== null) return null;
      const legacy = yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, WEB_BUILD_DIRECTORY, "index.html")).then(
          () => true,
          () => false,
        ),
      );
      if (legacy)
        return {
          directory: WEB_BUILD_DIRECTORY,
          selected: null,
          url: yield* preview.select(root, WEB_BUILD_DIRECTORY),
        };
      return null;
    });
  /** Builds and publishes the current sources, then serves that build. */
  const publishWeb = (root: string) =>
    Effect.gen(function* () {
      const exported = yield* runExport(root, "Web");
      if (!exported.success) return exported;
      const served = yield* selectedPreview(root);
      return served === null
        ? exported
        : {
            ...exported,
            message: WEB_READY_MESSAGE,
            url: served.url,
          };
    });
  interface ExploreNativeConn {
    socket: NodeNet.Socket;
    lineState: GameExploreNative.NativeLineState;
    token: string;
    hasDisplay: boolean;
    pid: number;
    server: NodeNet.Server;
    nextId: number;
  }
  interface ExploreWebConn {
    handle: ExploreWebHandle;
    server: { url: string; close: () => Promise<void> };
  }
  interface ExploreSession {
    readonly id: string;
    readonly root: string;
    readonly threadId: ThreadId;
    readonly buildId: string;
    readonly sourceId: string | null;
    readonly viewport: GameViewport;
    /** Honest boot timing, frozen with the session. */
    readonly bootMs: number | null;
    readonly profileDir: string;
    readonly traceDir: string;
    readonly native: ExploreNativeConn | null;
    readonly web: ExploreWebConn | null;
    readonly lock: Semaphore.Semaphore;
    lastActiveMs: number;
    readonly wallDeadlineMs: number;
    calls: number;
    totalSteps: number;
    totalNominalMs: number;
    images: number;
    readonly actions: ExploreActAction[];
    closed: boolean;
    closeReason: string | null;
    closedAt: string | null;
  }
  interface ExploreActAction {
    readonly index: number;
    readonly steps: readonly GameExploreStep[];
    readonly executedInputSteps: number;
    readonly nominalMs: number;
    readonly probe: GamePlaytestProbe | null;
    readonly screenshot: string;
    readonly consoleMessages: readonly GameConsoleMessage[];
    readonly consoleTruncated: number;
    readonly failure?: string;
    readonly execution?: "unknown";
    readonly screenText?: Record<string, string>;
    readonly ui?: ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly rect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }>;
    readonly errors?: ReadonlyArray<{ readonly message: string; readonly where: string }>;
    readonly uiResults?: ReadonlyArray<{
      readonly id: string;
      readonly action: string;
      readonly received: boolean;
      readonly detail: string;
    }>;
    readonly inspections?: ReadonlyArray<{
      readonly path: string;
      readonly values: Record<string, string | number | boolean | Array<number> | null>;
      readonly error?: string;
    }>;
    readonly screenshotReason?: string;
  }
  const exploreScratchBase = () => NodePath.join(NodeOS.tmpdir(), "game-explore");
  const exploreInvalid = (path: string, detail: string) =>
    new GameOperationError({ operation: "Explore session", path, reason: "invalid-input", detail });
  const exploreNativeStepIssues = (steps: readonly GameExploreStep[]): readonly string[] => {
    const issues: string[] = [];
    for (const [index, step] of steps.entries()) {
      if ("ui" in step) {
        if (step.ui.id.length === 0 || step.ui.id.length > 200)
          issues.push(`Step ${index + 1} ui id must contain 1–200 characters.`);
        if (step.ui.action !== "click" && step.ui.action !== "drag")
          issues.push(`Step ${index + 1} ui action must be click or drag.`);
        if (step.ui.action === "drag" && (step.ui.to === undefined || step.ui.to.length === 0))
          issues.push(`Step ${index + 1} ui drag needs a to id.`);
      } else if ("inspect" in step) {
        if (step.inspect.path.length === 0 || step.inspect.path.length > 500)
          issues.push(`Step ${index + 1} inspect path must contain 1–500 characters.`);
        const properties = step.inspect.properties ?? [];
        if (properties.length > GAME_EXPLORE_BOUNDS.maxInspectValues)
          issues.push(
            `Step ${index + 1} inspect lists ${properties.length} properties; at most ${GAME_EXPLORE_BOUNDS.maxInspectValues} may be read.`,
          );
        for (const name of properties)
          if (name.length === 0 || name.length > 64)
            issues.push(`Step ${index + 1} inspect property names must contain 1–64 characters.`);
      }
    }
    return issues;
  };
  /**
   * Ends a native session's tracked process tree by PID only. The quit line
   * asks the runner to exit itself; the tracked stop ends the whole owned
   * group (xvfb-run plus its display server and Godot child) when it lingers.
   * Never matches processes by name.
   */
  const closeNativeConn = (session: ExploreSession) =>
    Effect.gen(function* () {
      const conn = session.native;
      if (conn === null) return;
      yield* Effect.promise(async () => {
        // Ask the runner to exit itself, then end the tracked tree by PID.
        // The quit line is flushed with end(); the tracked stop below ends
        // the whole owned group if the runner lingers. Never match by name.
        try {
          const sock = conn.socket;
          if (!sock.destroyed) {
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              sock.end(JSON.stringify({ op: "quit", id: conn.nextId++ }) + "\n", done);
              // @effect-diagnostics-next-line globalTimers:off -- Best-effort quit flush on a raw socket; the tracked stop below still ends the tree.
              setTimeout(done, 2_000);
            });
          }
        } catch {
          // Best effort; the tracked stop below still ends the tree.
        }
        try {
          conn.socket.destroy();
        } catch {
          // Already gone.
        }
        await new Promise<void>((resolve) => conn.server.close(() => resolve()));
      });
      yield* processes.stop(session.root).pipe(Effect.ignore);
    });
  // Worktree judges own different roots; a session in one game must not
  // consume another game's play budget. The thread lease still owns input.
  const exploreStartLock = Semaphore.makeUnsafe(1);
  const exploreLive = new Map<string, ExploreSession>();
  // A write-through cache of the records under `evidenceDir`; a restart
  // reloads them, so a sample's earlier play still counts.
  const exploreEvidence = new Map<string, ExploreEvidence.ThreadEvidence>();
  const evidenceLock = Semaphore.makeUnsafe(1);
  const rememberEvidence = (record: ExploreEvidence.ThreadEvidence) => {
    exploreEvidence.delete(record.threadId);
    exploreEvidence.set(record.threadId, record);
    if (exploreEvidence.size > 128) {
      const oldest = exploreEvidence.keys().next().value;
      if (oldest !== undefined) exploreEvidence.delete(oldest);
    }
  };
  const writeEvidence = (record: ExploreEvidence.ThreadEvidence) =>
    Effect.tryPromise(() => ExploreEvidence.write(evidenceDir, record)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Persisting explore evidence failed.", {
          threadId: record.threadId,
          cause,
        }),
      ),
    );
  /** The caller holds `evidenceLock`. */
  const loadEvidence = (threadId: string, root: string) =>
    Effect.gen(function* () {
      const cached = exploreEvidence.get(threadId);
      if (cached !== undefined) return cached;
      const disk = yield* Effect.promise(() => ExploreEvidence.read(evidenceDir, threadId));
      if (disk === null) return ExploreEvidence.empty(threadId, root);
      const record = ExploreEvidence.closeOrphans(
        disk,
        new Set([...exploreLive.values()].map((live) => live.id)),
      );
      rememberEvidence(record);
      if (record.sessions.some((s, i) => s !== disk.sessions[i])) yield* writeEvidence(record);
      return record;
    });
  const threadEvidence = (threadId: ThreadId, root: string) =>
    evidenceLock.withPermits(1)(loadEvidence(String(threadId), root));
  /** Records the session's play so far; called after its start, every act and its close. */
  const persistSession = (session: ExploreSession) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const owner = String(session.threadId);
        const record = yield* loadEvidence(owner, session.root);
        const frames = [...(record.sessions.find((s) => s.id === session.id)?.frames ?? [])];
        for (const action of session.actions)
          if (action.screenshot !== "" && !frames.some((frame) => frame.step === action.index))
            frames.push({
              step: action.index,
              // Only a capped thread (a blind sample) draws a sheet, so only its
              // frames are kept past a reboot; others record the scratch path.
              path: exploreInputCaps.has(owner)
                ? yield* Effect.promise(() =>
                    ExploreEvidence.keepFrame(
                      evidenceDir,
                      owner,
                      session.id,
                      NodePath.join(session.traceDir, action.screenshot),
                    ),
                  )
                : NodePath.join(session.traceDir, action.screenshot),
            });
        const next = ExploreEvidence.upsert(record, {
          id: session.id,
          actions: session.actions.length,
          executedInputSteps: session.actions.reduce(
            (sum, action) => sum + action.executedInputSteps,
            0,
          ),
          nominalMs: session.totalNominalMs,
          images: session.images,
          frames,
          closed: session.closed,
          closeReason: session.closeReason,
        });
        rememberEvidence(next);
        yield* writeEvidence(next);
      }),
    );
  const exploreBudget =
    `This session holds ${GAME_EXPLORE_BOUNDS.maxCalls} acts and ` +
    `${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s of input, about ` +
    `${(GAME_EXPLORE_BOUNDS.maxTotalNominalMs / GAME_EXPLORE_BOUNDS.maxCalls / 1000).toFixed(1)} s per act.`;
  // Weak players held ~0.8 s per step and ran out of acts at 13-30 s of a
  // 60 s session even with acts-left shown; the seconds per remaining act
  // that would spend the rest is the number they can act on.
  // Per-thread input budgets across sessions (a blind sample's), set by the run.
  const exploreInputCaps = new Map<string, number>();
  const inputUsedBefore = (threadId: ThreadId, sessionId: string | null) => {
    const record = exploreEvidence.get(String(threadId));
    return record === undefined ? 0 : ExploreEvidence.totals(record, sessionId ?? "").nominalMs;
  };
  const explorePace = (session: ExploreSession) => {
    const s = (ms: number) => (ms / 1000).toFixed(1);
    const actsLeft = GAME_EXPLORE_BOUNDS.maxCalls - session.calls;
    const stepsLeft = GAME_EXPLORE_BOUNDS.maxTotalSteps - session.totalSteps;
    const earlierMs = inputUsedBefore(session.threadId, session.id);
    const cap = exploreInputCaps.get(String(session.threadId));
    const leftMs = Math.min(
      GAME_EXPLORE_BOUNDS.maxTotalNominalMs - session.totalNominalMs,
      cap === undefined ? Number.POSITIVE_INFINITY : cap - earlierMs - session.totalNominalMs,
    );
    const used =
      `input used: ${s(session.totalNominalMs)} s of this session's ` +
      `${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s` +
      (cap !== undefined
        ? ` (${s(earlierMs + session.totalNominalMs)} s of your ${s(cap)} s across sessions)`
        : earlierMs > 0
          ? ` (${s(earlierMs + session.totalNominalMs)} s across your sessions)`
          : "");
    if (actsLeft <= 0 || leftMs <= 0 || stepsLeft <= 0) return `${used}; this session is spent.`;
    const perAct = Math.min(leftMs / actsLeft, GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall);
    return `${used}, ${s(leftMs)} s left over ${actsLeft} act(s) and ${stepsLeft} step(s): about ${s(perAct)} s of input per act spends it.`;
  };
  /**
   * Releases a session's player and scratch. The caller holds the session
   * lock; the transition is uninterruptible once it starts so a cancelled
   * close cannot leave a half-removed profile behind.
   */
  const exploreFinalize = (session: ExploreSession, reason: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (session.closed) return null;
        session.closed = true;
        session.closeReason = reason;
        session.closedAt = DateTime.formatIso(yield* DateTime.now);
        if (session.native !== null)
          yield* closeNativeConn(session).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing a native exploration session failed.", {
                sessionId: session.id,
                cause,
              }),
            ),
          );
        if (session.web !== null)
          yield* Effect.promise(() =>
            (async () => {
              try {
                await session.web!.handle.close();
              } finally {
                await session.web!.server.close();
              }
            })(),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing a web exploration session failed.", {
                sessionId: session.id,
                cause,
              }),
            ),
          );
        yield* Effect.promise(() =>
          NodeFSP.rm(session.profileDir, { recursive: true, force: true }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Removing an exploration profile failed.", {
              sessionId: session.id,
              cause,
            }),
          ),
        );
        if (exploreLive.get(session.root) === session) exploreLive.delete(session.root);
        yield* persistSession(session);
        const result = {
          sessionId: session.id,
          reason,
          actions: session.actions.length,
          executedInputSteps: session.actions.reduce(
            (sum, action) => sum + action.executedInputSteps,
            0,
          ),
          totalNominalMs: session.totalNominalMs,
          images: session.images,
          message:
            `Exploration ${reason}: ${session.actions.length} act(s), ` +
            `${session.totalNominalMs}ms nominal. ` +
            `This session never qualified the build.`,
        } satisfies typeof GameExploreCloseResult.Type;
        return result;
      }),
    );
  const exploreReap = Effect.gen(function* () {
    for (const live of exploreLive.values()) {
      if (live.closed) continue;
      yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.closed || exploreLive.get(live.root) !== live) return;
          const now = yield* Clock.currentTimeMillis;
          if (now < live.wallDeadlineMs && now < live.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs)
            return;
          const reason = now >= live.wallDeadlineMs ? "wall-expired" : "idle-expired";
          yield* exploreFinalize(live, reason).pipe(Effect.ignore);
        }),
      );
    }
  });
  /** Idle and wall-clock expiry sweep. One scoped fiber owns it; sessions never sleep in a caller. */
  const exploreLease = (session: ExploreSession, root: string, threadId: ThreadId) => {
    if (session.root !== root)
      return exploreInvalid(session.id, "That exploration session belongs to another game.");
    if (String(session.threadId) !== String(threadId))
      return exploreInvalid(
        session.id,
        "That exploration session belongs to another thread; only its own thread may act on it or close it.",
      );
    return null;
  };
  /**
   * Opens a native exploration session on the current game sources. No
   * export is built or served: Godot runs the real main scene under a
   * server-owned runner script (ignored builds/logs only) and talks back
   * over loopback TCP. The game tree stays paused between acts.
   */
  const exploreStartNative = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      yield* projects.read(root);
      const resolved = yield* engine(root);
      const imported = yield* importGame(root);
      if (!imported.success)
        return yield* new GameOperationError({
          operation: "Explore session",
          path: root,
          reason: "command-failed",
          detail:
            `The Godot import failed before the native session started.\n${imported.message}`.slice(
              -2000,
            ),
        });
      const before = yield* snapshot(root, resolved.godotProject);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the native session ran; the result would not be current.",
        );
      const projectText = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(resolved.cwd, "project.godot"), "utf8").catch(() => ""),
      );
      const dirIssues = userDirConfigIssues(projectText);
      if (dirIssues.length > 0) return yield* exploreInvalid(root, dirIssues.join(" "));
      const baseViewport = parseGodotViewport(projectText);
      if (
        baseViewport.width > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        baseViewport.height > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        baseViewport.width < EXPLORE_CAPTURE_BOUNDS.minDimension ||
        baseViewport.height < EXPLORE_CAPTURE_BOUNDS.minDimension
      )
        return yield* exploreInvalid(
          root,
          `The game's base viewport (${baseViewport.width}x${baseViewport.height}) does not fit the capture bounds. Change display/window/size in project.godot first.`,
        );
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const staged = yield* Effect.tryPromise({
        try: () => GameExploreNative.stageNativeScript(root, id, traceDir),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      // profileDir reuses the finalize removal: the runner script and request
      // live under ignored builds/logs and are removed again on close.
      const profileDir = staged.scriptDir;
      const token = GameExploreNative.nativeSessionToken();
      const now = yield* Clock.currentTimeMillis;
      const dropScratch = Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(traceDir, { recursive: true, force: true }),
          NodeFSP.rm(staged.scriptDir, { recursive: true, force: true }),
        ]),
      ).pipe(Effect.ignore);
      const cleanupChild = processes.stop(root).pipe(Effect.ignore);
      // The TCP server owns the boot handshake; the tracked child is stopped
      // on any exit before the session registers, by PID only.
      const dropAll = Effect.gen(function* () {
        yield* cleanupChild;
        yield* dropScratch;
      });
      const server: NodeNet.Server = yield* Effect.tryPromise({
        try: async () => {
          const listener = NodeNet.createServer();
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
              listener.off("error", reject);
              resolve();
            });
          });
          return listener;
        },
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const lineState: GameExploreNative.NativeLineState = {
        buffer: "",
        notify: null,
        closed: false,
      };
      let runnerSocket: NodeNet.Socket | null = null;
      server.on("connection", (sock) => {
        if (runnerSocket !== null) {
          sock.destroy();
          return;
        }
        runnerSocket = sock;
        GameExploreNative.attachLineState(sock, lineState);
      });
      const port = (server.address() as NodeNet.AddressInfo).port;
      yield* Effect.tryPromise({
        try: () =>
          GameExploreNative.writeNativeRequest(staged.requestPath, {
            port,
            token,
            expectedUserDataPrefix: staged.isolation.dataDir,
          }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      }).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const xvfb = yield* Effect.promise(() => GameExploreNative.findXvfb()).pipe(
        Effect.orElseSucceed(() => null),
      );
      const hasDisplay = xvfb !== null;
      const godotArgs = GameExploreNative.nativeGodotArgs({
        projectDir: resolved.cwd,
        scriptPath: staged.scriptPath,
        requestPath: staged.requestPath,
        width: baseViewport.width,
        height: baseViewport.height,
        hasDisplay,
      });
      const launched = yield* (
        hasDisplay
          ? processes.start({
              root,
              executable: xvfb!,
              args: [
                "-a",
                "-s",
                // Xvfb rejects a screen without depth ("Invalid screen
                // configuration"), and xvfb-run still runs Godot against the
                // dead display, so every native boot times out with no
                // picture. Keep the x24 depth the helper uses.
                `-screen 0 ${baseViewport.width}x${baseViewport.height}x24`,
                resolved.godot.path,
                ...godotArgs,
              ],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              envMode: "replace",
              ownedProcessGroup: true,
            })
          : processes.start({
              root,
              executable: resolved.godot.path,
              args: [...godotArgs],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              envMode: "replace",
              ownedProcessGroup: true,
            })
      ).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs; the run's game time uses the controlled clock.
      const bootWallStart = Date.now();
      let everConnected = false;
      const markConnected = () => {
        everConnected = true;
      };
      server.on("connection", markConnected);
      const hello = yield* Effect.tryPromise({
        try: (signal) =>
          (async () => {
            const timeout = AbortSignal.timeout(bootTimeoutMs);
            const combined =
              signal === undefined || signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
            for (;;) {
              let line: string | null;
              try {
                line = await GameExploreNative.nextRunnerLine(lineState, combined);
              } catch (cause) {
                if (signal?.aborted) throw new Error("aborted", { cause });
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: `The native game did not boot within ${bootTimeoutMs}ms; no exploration session was opened. ${cause instanceof Error ? cause.message : String(cause)}`,
                  ...(cause === undefined ? {} : { cause }),
                });
              }
              if (line === null) {
                // The runner connected and went away without a hello.
                if (everConnected)
                  throw new GameOperationError({
                    operation: "Explore session",
                    path: root,
                    reason: "command-failed",
                    detail:
                      "The native runner exited before booting; no exploration session was opened.",
                  });
                continue;
              }
              const text = String(line).trim();
              if (text === "") continue;
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(text);
              } catch {
                continue;
              }
              if (typeof parsed !== "object" || parsed === null) continue;
              const record = parsed as Record<string, unknown>;
              if (typeof record["error"] === "string")
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: record["error"] as string,
                });
              if (record["token"] !== token)
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: "The native runner presented a wrong session token.",
                });
              return record;
            }
          })(),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const clean = GameExploreNative.sanitizeNativeObservation(hello);
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs; the run's game time uses the controlled clock.
      const bootMs = Date.now() - bootWallStart;
      if (runnerSocket === null)
        return yield* exploreInvalid(
          root,
          "The native runner never connected; no session was opened.",
        );
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        bootMs,
        profileDir,
        traceDir,
        native: {
          socket: runnerSocket!,
          lineState,
          token,
          hasDisplay,
          pid: launched.pid,
          server,
          nextId: 1,
        },
        web: null,
        lock: Semaphore.makeUnsafe(1),
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalSteps: 0,
        totalNominalMs: 0,
        images: 0,
        actions: [],
        closed: false,
        closeReason: null,
        closedAt: null,
      };
      if (clean.probe !== null) {
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...clean.probe.gameState },
            player: clean.probe.player === null ? null : { ...clean.probe.player },
          },
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          screenText: { ...clean.screenText },
          ui: clean.ui.map((control) => ({
            ...control,
            rect: { ...control.rect },
          })),
          errors: clean.errors.map((error) => ({ ...error })),
        });
      }
      exploreLive.set(root, live);
      const noPicture =
        " Runs headless without a picture (xvfb-run was not found on PATH): state, text, ui and errors stay available.";
      return {
        sessionId: id,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        booted: true,
        bootMs,
        message:
          `Native exploration session ${id.slice(0, 8)} opened on the current sources ${before.sourceId.slice(0, 12)} ` +
          `at ${baseViewport.width}x${baseViewport.height} (paused between calls). ` +
          `${exploreBudget} Act with input steps plus ui and inspect steps, then game_explore_close. ` +
          (hasDisplay ? "" : noPicture + " ") +
          `This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  /**
   * Opens a Unity exploration session: a real Linux player of the current
   * sources, built once per source identity under ignored builds/logs, runs
   * on a private display. The template's StudioProbe speaks the native
   * runner's protocol over loopback TCP, so acts, pictures, probe reads and
   * closing share the Godot native path. The game is paused between acts.
   */
  /**
   * The Linux player a Unity session plays: built once per source identity
   * under ignored builds/logs. Runs as the game's exclusive operation, so it
   * never races game_export or game_check for the editor, and outside the
   * start lock every game's explore shares.
   */
  const unityPlayerFor = (threadId: ThreadId, root: string) =>
    Effect.gen(function* () {
      const { godotProject } = yield* engine(root);
      const known = (detail: string) =>
        Effect.flatMap(snapshot(root, godotProject), (source) =>
          source.kind === "known"
            ? Effect.succeed(source.sourceId)
            : Effect.fail(exploreInvalid(root, detail)),
        );
      const playerOf = (sourceId: string) =>
        NodePath.join(unityPlayerDirectory(root, sourceId), "game.x86_64");
      const cached = (sourceId: string) =>
        Effect.promise(() =>
          NodeFSP.stat(playerOf(sourceId)).then(
            (stat) => stat.isFile(),
            () => false,
          ),
        );
      const before = yield* known(
        "The game sources could not be identified before the Unity session ran; the result would not be current.",
      );
      if (yield* cached(before)) return { player: playerOf(before), sourceId: before };
      return yield* exclusive(
        root,
        "Unity play build",
        liveUnity.hold(root)(
          Effect.gen(function* () {
            // The refresh writes .meta files for new assets, so the identity
            // the player is built and cached under is taken after it.
            const imported = yield* importGame(root);
            if (!imported.success)
              return yield* new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: `The Unity import failed, so no session was opened.
${imported.message}`.slice(-3000),
              });
            const sourceId = yield* known(
              "The game sources could not be identified after the Unity import; the result would not be current.",
            );
            if (yield* cached(sourceId)) return { player: playerOf(sourceId), sourceId };
            // One play build is kept: older ones are the previous sources' players.
            yield* Effect.promise(async () => {
              const logs = NodePath.join(root, "builds/logs");
              for (const name of await NodeFSP.readdir(logs).catch(() => [] as string[]))
                if (name.startsWith("unity-play-"))
                  await NodeFSP.rm(NodePath.join(logs, name), { recursive: true, force: true });
            });
            const built = yield* buildUnityPlayer(
              root,
              "Linux",
              unityPlayerDirectory(root, sourceId),
              "unity-play-build",
            );
            if (!built.result.success)
              return yield* new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: `The Unity play build failed, so no session was opened.
${built.result.message}`.slice(-3000),
              });
            if (built.sourceId === null)
              return yield* exploreInvalid(
                root,
                "The game sources changed while the Unity play build ran; start the session again.",
              );
            // The build settled files back to their committed content: the
            // player is cached under the sources as they now stand.
            if (built.sourceId !== sourceId) {
              const settled = built.sourceId;
              yield* Effect.tryPromise({
                try: () =>
                  NodeFSP.rename(
                    unityPlayerDirectory(root, sourceId),
                    unityPlayerDirectory(root, settled),
                  ),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "Explore session",
                    path: unityPlayerDirectory(root, settled),
                    reason: "io",
                    cause,
                  }),
              });
            }
            return { player: playerOf(built.sourceId), sourceId: built.sourceId };
          }),
        ),
        String(threadId),
      );
    });
  const exploreStartUnity = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
    prepared: { readonly player: string; readonly sourceId: string },
  ) =>
    Effect.gen(function* () {
      const { player, sourceId } = prepared;
      const xvfb = yield* Effect.promise(() => GameExploreNative.findXvfb()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (xvfb === null)
        return yield* exploreInvalid(
          root,
          "Unity exploration needs xvfb-run for the player's private display; install the system Xvfb package.",
        );
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const token = GameExploreNative.nativeSessionToken();
      const requestPath = NodePath.join(traceDir, "request.json");
      const playerHome = NodePath.join(traceDir, "home");
      const dropScratch = Effect.promise(() =>
        NodeFSP.rm(traceDir, { recursive: true, force: true }),
      ).pipe(Effect.ignore);
      const server: NodeNet.Server = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(playerHome, { recursive: true });
          const listener = NodeNet.createServer();
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
              listener.off("error", reject);
              resolve();
            });
          });
          return listener;
        },
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const lineState: GameExploreNative.NativeLineState = {
        buffer: "",
        notify: null,
        closed: false,
      };
      let runnerSocket: NodeNet.Socket | null = null;
      server.on("connection", (sock) => {
        if (runnerSocket !== null) {
          sock.destroy();
          return;
        }
        runnerSocket = sock;
        GameExploreNative.attachLineState(sock, lineState);
      });
      const port = (server.address() as NodeNet.AddressInfo).port;
      const dropAll = Effect.gen(function* () {
        yield* processes.stop(root).pipe(Effect.ignore);
        yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
        yield* dropScratch;
      });
      yield* Effect.tryPromise({
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- The player's request file is the runner protocol's fixed two-field JSON.
        try: () => NodeFSP.writeFile(requestPath, JSON.stringify({ port, token })),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      }).pipe(Effect.tapError(() => dropAll));
      const viewport = { ...UNITY_VIEWPORT };
      // The player keeps its prefs and log under the session's scratch HOME,
      // never the user's ~/.config/unity3d.
      const env: NodeJS.ProcessEnv = {
        ...GameProcesses.engineChildEnv(),
        HOME: playerHome,
        XDG_CONFIG_HOME: NodePath.join(playerHome, ".config"),
        LIBGL_ALWAYS_SOFTWARE: "1",
        LP_NUM_THREADS: "2",
      };
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootWallStart = Date.now();
      const launched = yield* processes
        .start({
          root,
          executable: xvfb,
          args: [
            "-a",
            "-s",
            `-screen 0 ${viewport.width}x${viewport.height}x24`,
            player,
            "-kurambitExplore",
            requestPath,
            "-screen-fullscreen",
            "0",
            "-screen-width",
            String(viewport.width),
            "-screen-height",
            String(viewport.height),
            "-force-glcore",
            "-logFile",
            NodePath.join(traceDir, "player.log"),
          ],
          operation: "explore-unity",
          timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
          env,
          envMode: "replace",
          ownedProcessGroup: true,
        })
        .pipe(Effect.tapError(() => dropAll));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const hello = yield* Effect.tryPromise({
        try: async (signal) => {
          const timeout = AbortSignal.timeout(bootTimeoutMs);
          const combined = signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
          for (;;) {
            const line = await GameExploreNative.nextRunnerLine(lineState, combined).catch(
              (cause: unknown) => {
                throw new Error(
                  `The Unity player did not report in within ${bootTimeoutMs}ms; no exploration session was opened. Player log: ${NodePath.join(traceDir, "player.log")}`,
                  { cause },
                );
              },
            );
            if (line === null) {
              if (runnerSocket !== null) throw new Error("The Unity player exited before booting.");
              continue;
            }
            let parsed: unknown = null;
            try {
              // @effect-diagnostics-next-line preferSchemaOverJson:off -- Runner protocol lines are sanitized field by field below.
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null) continue;
            const record = parsed as Record<string, unknown>;
            if (record["token"] !== token)
              throw new Error("The Unity player presented a wrong session token.");
            return record;
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: root,
            reason: "command-failed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(Effect.tapError(() => dropAll));
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootMs = Date.now() - bootWallStart;
      const clean = GameExploreNative.sanitizeNativeObservation(hello);
      const now = yield* Clock.currentTimeMillis;
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: sourceId,
        sourceId: sourceId,
        viewport,
        bootMs,
        // Close removes the player's scratch HOME; pictures and player.log stay as evidence.
        profileDir: playerHome,
        traceDir,
        native: {
          socket: runnerSocket!,
          lineState,
          token,
          hasDisplay: true,
          pid: launched.pid,
          server,
          nextId: 1,
        },
        web: null,
        lock: Semaphore.makeUnsafe(1),
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalSteps: 0,
        totalNominalMs: 0,
        images: 0,
        actions: [],
        closed: false,
        closeReason: null,
        closedAt: null,
      };
      if (clean.probe !== null)
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...clean.probe.gameState },
            player: clean.probe.player === null ? null : { ...clean.probe.player },
          },
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          screenText: { ...clean.screenText },
          ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
          errors: clean.errors.map((error) => ({ ...error })),
        });
      exploreLive.set(root, live);
      return {
        sessionId: id,
        buildId: sourceId,
        sourceId: sourceId,
        viewport,
        booted: true,
        bootMs,
        message:
          `Unity exploration session ${id.slice(0, 8)} opened on a Linux player of the current sources ${sourceId.slice(0, 12)} ` +
          `at ${viewport.width}x${viewport.height} (paused between calls). Keys and mouse go in through the Input System. ` +
          `${exploreBudget} Act with input steps plus ui and inspect steps, then game_explore_close. This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  /**
   * Opens a web exploration session on the current game sources. The static
   * folder is served over loopback and headless Chromium plays it in real
   * time: real keyboard and mouse input, screenshots, console errors and the
   * game's read-only `window.__studio` probe. There is no pause between
   * calls; waits and holds advance game time as they run.
   */
  const exploreStartWeb = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      yield* projects.read(root);
      const resolved = yield* engine(root);
      if (resolved.backend.id !== "three")
        return yield* exploreInvalid(
          root,
          "Web exploration plays three.js browser games; this game runs on another engine.",
        );
      const before = yield* snapshot(root, resolved.godotProject);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the web session ran; the result would not be current.",
        );
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const executable = yield* requireChromium("Explore session", root);
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(traceDir, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const profileDir = NodePath.join(traceDir, "chrome-profile");
      const server = yield* Effect.tryPromise({
        try: () => serveGameDirectory(root, resolved.godotProject),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: root,
            reason: "io",
            detail: "The static project could not be served.",
            cause,
          }),
      });
      const now = yield* Clock.currentTimeMillis;
      const dropServer = Effect.promise(() => server.close()).pipe(Effect.ignore);
      const handle = yield* Effect.tryPromise({
        try: (signal) =>
          openExploreWeb({
            executable,
            url: server.url,
            profileDirectory: profileDir,
            width: THREE_VIEWPORT.width,
            height: THREE_VIEWPORT.height,
            bootTimeoutMs,
            signal,
          }),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.tapError(() => dropServer),
        Effect.onInterrupt(() => dropServer),
      );
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { ...handle.viewport },
        bootMs: handle.bootMs,
        profileDir,
        traceDir,
        native: null,
        web: { handle, server },
        lock: Semaphore.makeUnsafe(1),
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalSteps: 0,
        totalNominalMs: 0,
        images: 0,
        actions: [],
        closed: false,
        closeReason: null,
        closedAt: null,
      };
      if (handle.bootProbe !== null) {
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...handle.bootProbe.gameState },
            player: handle.bootProbe.player === null ? null : { ...handle.bootProbe.player },
          },
          screenshot: "",
          consoleMessages: [...handle.bootConsole],
          consoleTruncated: 0,
        });
      }
      exploreLive.set(root, live);
      return {
        sessionId: id,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { ...handle.viewport },
        booted: true,
        bootMs: handle.bootMs,
        message:
          `Web exploration session ${id.slice(0, 8)} opened on the current sources ${before.sourceId.slice(0, 12)} ` +
          `at ${handle.viewport.width}x${handle.viewport.height} (real time: the game keeps running between calls). ` +
          `${exploreBudget} Act with input steps, then game_explore_close. ` +
          `This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const threadCap = exploreInputCaps.get(String(threadId));
      // The cache, else disk: right after a restart the cache is cold.
      const usedBefore =
        threadCap === undefined
          ? 0
          : ExploreEvidence.totals(
              yield* evidenceLock.withPermits(1)(loadEvidence(String(threadId), root)),
            ).nominalMs;
      if (threadCap !== undefined && usedBefore >= threadCap - 500)
        return yield* exploreInvalid(
          root,
          `Your ${threadCap / 1000} s input budget across sessions is spent; do not start another session. Write your notes now.`,
        );
      const unity = (yield* projects.read(root)).engine.name === "unity" && input.target !== "web";
      if (unity) {
        const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
        if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      }
      // The player build takes minutes and is the game's own exclusive
      // operation; the start lock is held only to launch and register.
      const unityPlayer =
        unity && !exploreLive.has(root) ? yield* unityPlayerFor(threadId, root) : null;
      return yield* exploreStartLock
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = exploreLive.get(root);
            if (existing !== undefined)
              return yield* exploreInvalid(
                existing.id,
                "Another exploration session is open for this game; its owning thread must close it before this game can start another.",
              );
            const manifest = yield* projects.read(root);
            const target = input.target ?? (manifest.engine.name === "three" ? "web" : "native");
            if (target === "web") {
              if (manifest.engine.name !== "three")
                return yield* exploreInvalid(
                  root,
                  `${manifest.engine.name === "unity" ? "Unity" : "Godot"} web play is not in this build; start the session without a target (or with target native).`,
                );
              return yield* exploreStartWeb(threadId, root, input);
            }
            if (manifest.engine.name === "three")
              return yield* exploreInvalid(
                root,
                "This is a three.js browser game; start the session with target web.",
              );
            if (manifest.engine.name === "unity")
              return unityPlayer === null
                ? yield* exploreInvalid(
                    root,
                    "An exploration session for this game closed while this one was starting; start the session again.",
                  )
                : yield* exploreStartUnity(threadId, root, input, unityPlayer);
            return yield* exploreStartNative(threadId, root, input);
          }),
        )
        .pipe(
          Effect.tap((started) => {
            const live = exploreLive.get(root);
            return live?.id === started.sessionId ? persistSession(live) : Effect.void;
          }),
        );
    });
  /**
   * Runs one native act through the runner's TCP connection and persists the
   * returned picture where one exists. Headless runs keep no picture; the
   * session stays usable for state, text, ui and errors.
   */
  const exploreActNative = (
    session: ExploreSession,
    input: typeof GameExploreActInput.Type,
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const conn = session.native!;
      const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
      const screenshotPath = conn.hasDisplay ? NodePath.join(session.traceDir, file) : null;
      const failAct = Effect.gen(function* () {
        session.actions.push({
          index: callIndex,
          steps: [...input.steps],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: null,
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          execution: "unknown",
          failure:
            "Act failed or was interrupted after possible partial execution. Exact input progress is unknown.",
        });
        yield* exploreFinalize(session, "act-failed");
      });
      const reply = yield* Effect.tryPromise({
        try: (signal) =>
          (async () => {
            const id = conn.nextId++;
            conn.socket.write(
              JSON.stringify({ id, op: "act", steps: [...input.steps], screenshotPath }) + "\n",
            );
            const timeout = AbortSignal.timeout(120_000);
            const combined =
              signal === undefined || signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
            for (;;) {
              let line: string | null;
              try {
                line = await GameExploreNative.nextRunnerLine(conn.lineState, combined);
              } catch (cause) {
                if (signal?.aborted) throw new Error("aborted");
                if (cause === undefined) throw new Error("The native act timed out after 120s.");
                throw new Error("The native act timed out after 120s.", { cause });
              }
              if (line === null) throw new Error("The native session closed.");
              const text = String(line).trim();
              if (text === "") continue;
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(text);
              } catch {
                continue;
              }
              if (typeof parsed !== "object" || parsed === null) continue;
              const record = parsed as Record<string, unknown>;
              if (record["id"] !== id) continue;
              if (record["ok"] !== true)
                throw new Error(
                  typeof record["error"] === "string"
                    ? (record["error"] as string)
                    : "The native act failed.",
                );
              return record;
            }
          })(),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: session.id,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? failAct : Effect.void)));
      const clean = GameExploreNative.sanitizeNativeObservation(reply);
      const executedInputSteps =
        typeof reply["executedInputSteps"] === "number"
          ? (reply["executedInputSteps"] as number)
          : 0;
      // The runner writes the picture directly to the trace dir; the act only
      // keeps it when the file is really there.
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (screenshotPath !== null && reply["screenshot"] === true) {
        const present = yield* Effect.promise(() =>
          NodeFSP.stat(screenshotPath)
            .then((stat) => stat.isFile() && stat.size > 0)
            .catch(() => false),
        );
        if (present) keptScreenshot = file;
        else
          screenshotReason =
            "The native picture was unavailable even though a display was expected; state, text, ui and errors stay available.";
      } else if (screenshotPath === null) {
        screenshotReason =
          "xvfb-run was not found on PATH, so the native session runs headless without a picture. State, text, ui and errors stay available.";
      }
      const probe =
        clean.probe === null
          ? null
          : {
              gameState: { ...clean.probe.gameState },
              player: clean.probe.player === null ? null : { ...clean.probe.player },
            };
      session.actions.push({
        index: callIndex,
        steps: [...input.steps],
        executedInputSteps,
        nominalMs,
        probe,
        screenshot: keptScreenshot,
        consoleMessages: [],
        consoleTruncated: 0,
        screenText: { ...clean.screenText },
        ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
        errors: clean.errors.map((error) => ({ ...error })),
        uiResults: clean.uiResults.map((result) => ({ ...result })),
        inspections: clean.inspections.map((entry) => ({ ...entry, values: { ...entry.values } })),
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
      });
      session.totalNominalMs += nominalMs;
      if (keptScreenshot !== "") session.images += 1;
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      const received = clean.uiResults.filter((result) => result.received).length;
      return {
        sessionId: session.id,
        callIndex,
        executedInputSteps,
        nominalMs,
        probe,
        screenshotPath:
          keptScreenshot === "" ? null : NodePath.join(session.traceDir, keptScreenshot),
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
        screenText: { ...clean.screenText },
        ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
        errors: clean.errors.map((error) => ({ ...error })),
        uiResults: clean.uiResults.map((result) => ({ ...result })),
        inspections: clean.inspections.map((entry) => ({ ...entry, values: { ...entry.values } })),
        consoleMessages: [],
        consoleTruncated: 0,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${executedInputSteps} input, +${nominalMs}ms nominal); ` +
          (clean.uiResults.length > 0
            ? `${received}/${clean.uiResults.length} ui action(s) received; `
            : "") +
          `${explorePace(session)} ` +
          `This observation is descriptive only, never a verdict.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
        totalNominalMs: session.totalNominalMs,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? Effect.gen(function* () {
              if (!session.actions.some((action) => action.index === callIndex))
                yield* Effect.gen(function* () {
                  session.actions.push({
                    index: callIndex,
                    steps: [...input.steps],
                    executedInputSteps: 0,
                    nominalMs: 0,
                    probe: null,
                    screenshot: "",
                    consoleMessages: [],
                    consoleTruncated: 0,
                    execution: "unknown",
                    failure:
                      "Observation failed after possible partial execution. Exact input progress is unknown.",
                  });
                  yield* exploreFinalize(session, "act-failed");
                });
            })
          : Effect.void,
      ),
    );
  /**
   * Runs one web act through headless Chromium and persists the returned
   * picture. The game runs in real time, so waits and holds in the steps
   * already advanced it; captures cost nothing extra.
   */
  const exploreActWeb = (
    session: ExploreSession,
    input: typeof GameExploreActInput.Type,
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const conn = session.web!;
      const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
      const screenshotPath = NodePath.join(session.traceDir, file);
      const failAct = Effect.gen(function* () {
        session.actions.push({
          index: callIndex,
          steps: [...input.steps],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: null,
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          execution: "unknown",
          failure:
            "Act failed or was interrupted after possible partial execution. Exact input progress is unknown.",
        });
        yield* exploreFinalize(session, "act-failed");
      });
      const observed = yield* Effect.tryPromise({
        try: (signal) => conn.handle.act([...input.steps], callIndex, signal),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: session.id,
            reason: "command-failed",
            detail:
              cause instanceof Error && cause.message !== "aborted"
                ? cause.message.slice(0, 500)
                : "The web act failed.",
            cause,
          }),
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? failAct : Effect.void)));
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (observed.screenshotData !== "") {
        const written = yield* Effect.promise(() =>
          NodeFSP.writeFile(screenshotPath, Buffer.from(observed.screenshotData, "base64"))
            .then(() =>
              NodeFSP.stat(screenshotPath).then(
                (stat) => stat.isFile() && stat.size > 0,
                () => false,
              ),
            )
            .catch(() => false),
        );
        if (written) keptScreenshot = file;
        else
          screenshotReason =
            "The browser picture could not be saved; state and console messages stay available.";
      } else {
        screenshotReason =
          "The browser returned no picture for this act; state and console messages stay available.";
      }
      const probe =
        observed.probe === null
          ? null
          : {
              gameState: { ...observed.probe.gameState },
              player: observed.probe.player === null ? null : { ...observed.probe.player },
            };
      session.actions.push({
        index: callIndex,
        steps: [...input.steps],
        executedInputSteps: observed.executedInputSteps,
        nominalMs,
        probe,
        screenshot: keptScreenshot,
        consoleMessages: [...observed.consoleMessages],
        consoleTruncated: observed.consoleTruncated,
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
      });
      session.totalNominalMs += nominalMs;
      if (keptScreenshot !== "") session.images += 1;
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      return {
        sessionId: session.id,
        callIndex,
        executedInputSteps: observed.executedInputSteps,
        nominalMs,
        probe,
        screenshotPath: keptScreenshot === "" ? null : screenshotPath,
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
        consoleMessages: [...observed.consoleMessages],
        consoleTruncated: observed.consoleTruncated,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${observed.executedInputSteps} input, +${nominalMs}ms nominal); ` +
          `${explorePace(session)} ` +
          `This observation is descriptive only, never a verdict.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
        totalNominalMs: session.totalNominalMs,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? Effect.gen(function* () {
              if (!session.actions.some((action) => action.index === callIndex))
                yield* Effect.gen(function* () {
                  session.actions.push({
                    index: callIndex,
                    steps: [...input.steps],
                    executedInputSteps: 0,
                    nominalMs: 0,
                    probe: null,
                    screenshot: "",
                    consoleMessages: [],
                    consoleTruncated: 0,
                    execution: "unknown",
                    failure:
                      "Observation failed after possible partial execution. Exact input progress is unknown.",
                  });
                  yield* exploreFinalize(session, "act-failed");
                });
            })
          : Effect.void,
      ),
    );
  const exploreAct = (threadId: ThreadId, input: typeof GameExploreActInput.Type) =>
    Effect.gen(function* () {
      const session = [...exploreLive.values()].find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; start a new one with game_explore_start.",
        );
      const root = yield* projects.resolve(threadId);
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      // Direct service callers bypass the tool schema, so the per-call shape
      // is enforced here too, before any budget or browser work.
      if (input.steps.length === 0 || input.steps.length > GAME_EXPLORE_BOUNDS.maxStepsPerCall)
        return yield* exploreInvalid(
          session.id,
          `Use 1–${GAME_EXPLORE_BOUNDS.maxStepsPerCall} steps per act; this act has ${input.steps.length}.`,
        );
      if (session.calls >= GAME_EXPLORE_BOUNDS.maxCalls)
        return yield* exploreInvalid(
          session.id,
          `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and start a new exploration.`,
        );
      const nominalMs = GameExploreNative.exploreStepsNominalMs(
        input.steps,
        session.web === null ? "native" : "web",
      );
      if (!Number.isFinite(nominalMs) || nominalMs < 0)
        return yield* exploreInvalid(session.id, "The act has an invalid duration.");
      if (nominalMs > GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall)
        return yield* exploreInvalid(
          session.id,
          `The act lasts ${nominalMs}ms; one act may last at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall}ms.`,
        );
      const stepIssues = exploreStepIssues(input.steps);
      if (stepIssues.length > 0) return yield* exploreInvalid(session.id, stepIssues.join("\n"));
      if (session.web !== null) {
        const webIssues = webStepIssues(input.steps);
        if (webIssues.length > 0) return yield* exploreInvalid(session.id, webIssues.join("\n"));
      } else {
        const nativeIssues = exploreNativeStepIssues(input.steps);
        if (nativeIssues.length > 0)
          return yield* exploreInvalid(session.id, nativeIssues.join("\n"));
      }
      return yield* session.lock.withPermits(1)(
        Effect.gen(function* () {
          if (session.closed || exploreLive.get(session.root) !== session)
            return yield* exploreInvalid(
              session.id,
              "That exploration session is closed or expired; start a new one with game_explore_start.",
            );
          const now = yield* Clock.currentTimeMillis;
          if (
            now >= session.wallDeadlineMs ||
            now >= session.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs
          ) {
            const reason = now >= session.wallDeadlineMs ? "wall-expired" : "idle-expired";
            yield* exploreFinalize(session, reason);
            return yield* exploreInvalid(
              session.id,
              `That exploration session ${reason}. Start a new exploration with game_explore_start.`,
            );
          }
          // Budgets are checked under the session lock so concurrent acts
          // cannot each pass before either one accounts for itself.
          if (session.calls >= GAME_EXPLORE_BOUNDS.maxCalls)
            return yield* exploreInvalid(
              session.id,
              `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and start a new exploration.`,
            );
          if (session.totalSteps + input.steps.length > GAME_EXPLORE_BOUNDS.maxTotalSteps)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalSteps} total steps; close it and start a new exploration.`,
            );
          if (session.totalNominalMs + nominalMs > GAME_EXPLORE_BOUNDS.maxTotalNominalMs)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalNominalMs}ms total nominal time; close it and start a new exploration.`,
            );
          const threadCap = exploreInputCaps.get(String(session.threadId));
          if (threadCap !== undefined) {
            const record = yield* evidenceLock.withPermits(1)(
              loadEvidence(String(session.threadId), session.root),
            );
            const usedMs =
              ExploreEvidence.totals(record, session.id).nominalMs + session.totalNominalMs;
            if (usedMs + nominalMs > threadCap)
              return yield* exploreInvalid(
                session.id,
                `This act would pass your ${threadCap / 1000} s input budget across sessions (${(usedMs / 1000).toFixed(1)} s used, ${((threadCap - usedMs) / 1000).toFixed(1)} s left); use a shorter act, or close the session and write your notes.`,
              );
          }
          // Headless native acts persist no picture, so the image bound only
          // covers acts that actually keep one. Web acts always keep one.
          const keepsImage =
            session.web !== null || (session.native !== null && session.native.hasDisplay);
          if (keepsImage && session.images + 1 > GAME_EXPLORE_BOUNDS.maxImages)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxImages} persisted images; close it and start a new exploration.`,
            );
          const callIndex = session.calls + 1;
          session.calls = callIndex;
          session.totalSteps += input.steps.length;
          return yield* (
            session.web !== null
              ? exploreActWeb(session, input, callIndex, nominalMs)
              : exploreActNative(session, input, callIndex, nominalMs)
          ).pipe(Effect.ensuring(persistSession(session)));
        }),
      );
    });
  const exploreClose = (threadId: ThreadId, input: typeof GameExploreCloseInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const session = [...exploreLive.values()].find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; start a new one with game_explore_start.",
        );
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      return yield* session.lock.withPermits(1)(
        Effect.gen(function* () {
          // A close that arrives after the deadlines reports the expiry the
          // reaper would have saved, instead of claiming a clean close.
          if (!session.closed) {
            const now = yield* Clock.currentTimeMillis;
            if (
              now >= session.wallDeadlineMs ||
              now >= session.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs
            ) {
              const reason = now >= session.wallDeadlineMs ? "wall-expired" : "idle-expired";
              yield* exploreFinalize(session, reason);
            }
          }
          const result = yield* exploreFinalize(session, "closed");
          if (result !== null) return result;
          return yield* exploreInvalid(
            input.sessionId,
            "That exploration session is closed or expired; start a new one with game_explore_start.",
          );
        }),
      );
    });
  /**
   * Imports first: a fresh game has no .godot cache, so .tres files and
   * class_names can resolve. A Unity import and check share one hold, as
   * export does: another game cannot take the editor between them.
   */
  const checkGame = (root: string) =>
    Effect.flatMap(engine(root), ({ backend }) =>
      backend.id === "unity" ? liveUnity.hold(root)(checkSources(root)) : checkSources(root),
    );
  const checkSources = (root: string) =>
    Effect.gen(function* () {
      {
        const startedAt = yield* Clock.currentTimeMillis;
        const { backend, godot, cwd, godotProject } = yield* engine(root);
        const manifest = yield* projects.read(root);
        const gameplayScene = manifest.gameplayScene ?? "";
        // Import is cache preparation, not the check itself: Godot's import can
        // write sidecar files inside the project, so the inputs are read after it
        // and before the checking script runs.
        const imported = yield* importGame(root);
        const before = yield* snapshot(root, godotProject);
        {
          const executed = yield* backend.runCheck(
            { root, projectDir: cwd, projectName: godotProject, binary: godot },
            { gameplayScene },
          );
          const run = executed.run;
          const reported = executed.reported;
          const importedOutput =
            imported.process === null
              ? ""
              : `${imported.process.stdout}\n${imported.process.stderr}`;
          const importedIssues = backend.parseDiagnostics(importedOutput);
          const parsed = [...importedIssues, ...executed.issues];
          const errors = mergeCheckIssues(reported?.errors ?? [], parsed);
          // File labels name the engine project, whichever engine it is.
          const projectFile = `${godotProject}/${backend.projectSettingsFile}`;
          if (!imported.success && importedIssues.length === 0)
            errors.unshift({
              file: projectFile,
              message: `Import failed with exit code ${imported.process?.exitCode ?? -1}. ${imported.message}`,
            });
          if (reported === null)
            errors.unshift({
              file: projectFile,
              message: `The ${backend.displayName} check script did not report a result. The project may have crashed during startup.`,
            });
          if (run.timedOut)
            errors.unshift({
              file: projectFile,
              message:
                backend.id === "three"
                  ? "The three.js check timed out: the page never reported ready within 60 s."
                  : `The ${backend.displayName} check timed out before finishing its physics frames.`,
            });
          if (run.exitCode !== 0 && errors.length === 0)
            errors.unshift({
              file: projectFile,
              message: `${backend.displayName} exited with code ${run.exitCode}. ${commandDetail(run)}`,
            });
          // A game created before gameplay entries is checked as it always was, but
          // the warning says what the check did not cover rather than implying it did.
          // A three.js game's gameplay entry is a page URL (the starter's is
          // index.html?play) that the check loads after the page itself.
          const warnings = [
            ...(reported?.warnings ?? []),
            ...(manifest.gameplayScene == null && backend.id === "godot"
              ? [
                  {
                    file: "game.json",
                    message:
                      "The manifest declares no gameplay scene, so the check ran only the main scene (the menu); gameplay initialization was not exercised.",
                  },
                ]
              : []),
          ];
          const after = yield* snapshot(root, godotProject);
          const comparison = comparedSource(before, after, "check");
          if (comparison.kind !== "current")
            warnings.unshift({ file: `${godotProject}/`, message: comparison.detail });
          const result = {
            ok: errors.length === 0 && reported !== null && !run.timedOut,
            errors: limitIssues(errors),
            warnings: limitIssues(warnings),
            entries: reported?.entries ?? [],
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          };
          return result;
        }
      }
    });
  const unityRoot = (root: string) =>
    projects.read(root).pipe(
      Effect.flatMap((manifest) =>
        manifest.engine.name === "unity"
          ? Effect.void
          : Effect.fail(
              new GameOperationError({
                operation: "Unity editor",
                path: root,
                reason: "invalid-input",
                detail:
                  "The game_unity_* tools work on Unity games; this game runs another engine.",
              }),
            ),
      ),
    );
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* exclusive(root, name, work(root), String(threadId));
  });
  // Idle and wall-clock expiry without a caller: one scoped fiber sweeps the
  // live sessions. Production timers own it; every act/close also
  // checks the same deadlines lazily.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (let sweep = 1; ; sweep += 1) {
        yield* Effect.sleep(Duration.seconds(30));
        yield* exploreReap;
        // A server that runs for weeks never restarts to prune; once an hour.
        if (sweep % 120 === 0) {
          const now = yield* Clock.currentTimeMillis;
          // Locked: a thread resuming mid-prune must not lose its fresh write.
          yield* evidenceLock
            .withPermits(1)(Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, now)))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Pruning explore evidence failed.", { cause }),
              ),
            );
        }
      }
    }),
  );
  /** Serves a minted package download after proving the bytes are still the minted ones. */
  const verifyPackageFile = (
    operation: string,
    path: string,
    packageSha256: string,
    fileName: string,
    missingDetail: string,
  ) =>
    Effect.gen(function* () {
      const opened = yield* openMediaFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({
              operation,
              path,
              reason: "io",
              detail: "The package could not be opened.",
              cause,
            }),
        ),
      );
      if (opened === null)
        return yield* new GameOperationError({
          operation,
          path,
          reason: "download",
          detail: missingDetail,
        });
      const verified = yield* Effect.tryPromise({
        try: () => hashOpenFile(opened),
        catch: (cause) =>
          new GameOperationError({
            operation,
            path,
            reason: "io",
            detail: "The package could not be read.",
            cause,
          }),
      });
      const after = yield* Effect.tryPromise({
        try: () => opened.handle.stat({ bigint: true }),
        catch: (cause) =>
          new GameOperationError({
            operation,
            path,
            reason: "io",
            detail: "The package could not be checked.",
            cause,
          }),
      });
      if (BigInt(verified.bytes) !== after.size || verified.sha256 !== packageSha256)
        return yield* new GameOperationError({
          operation,
          path,
          reason: "checksum",
          detail:
            "The package changed after this download link was created. Open Builds, then choose Download package again.",
        });
      return {
        path,
        fileName,
        bytes: verified.bytes,
        sha256: verified.sha256,
        identity: { device: after.dev.toString(), inode: after.ino.toString() },
      };
    });
  return GameService.of({
    events: operations.events,
    finishExploration: Effect.fn("GameService.finishExploration")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      const live = exploreLive.get(root);
      if (live !== undefined && String(live.threadId) === String(threadId))
        yield* live.lock.withPermits(1)(exploreFinalize(live, "role-finished"));
      return ExploreEvidence.totals(yield* threadEvidence(threadId, root));
    }),
    limitExploreInput: (threadId, totalMs) =>
      Effect.sync(() => {
        exploreInputCaps.set(String(threadId), totalMs);
      }),
    exploreSheet: Effect.fn("GameService.exploreSheet")(function* (threadId, output) {
      const root = yield* projects.resolve(threadId);
      const kept = ExploreEvidence.frames(yield* threadEvidence(threadId, root));
      // A frame whose copy failed stays in temp scratch, which can be cleaned,
      // and a capture can be cut off mid-write; only complete PNGs are drawn.
      const present = yield* Effect.promise(() =>
        Promise.all(
          kept.map((frame) => ExploreSheet.pngSize(frame.path).then((size) => size !== null)),
        ),
      );
      const onDisk = kept.filter((_, i) => present[i]);
      if (onDisk.length < kept.length)
        yield* Effect.logWarning(
          "Some kept explore frames are gone or incomplete; the sheet draws the rest.",
          {
            threadId,
            kept: kept.length,
            lost: kept.length - onDisk.length,
          },
        );
      const frames = ExploreSheet.pickFrames(onDisk);
      const size =
        frames.length === 0
          ? null
          : yield* Effect.promise(() => ExploreSheet.pngSize(frames[0]!.path));
      if (size === null || size.w === 0) return 0;
      const ffmpeg = yield* Effect.promise(() =>
        GameProcesses.findExecutable("ffmpeg", {
          pathEnv: process.env.PATH,
          override: process.env.KURAMBIT_FFMPEG,
        }),
      );
      if (ffmpeg === null)
        return yield* new GameOperationError({
          operation: "Explore sheet",
          path: "ffmpeg",
          reason: "tool-missing",
          detail: "ffmpeg draws the frame sheet.",
        });
      const fontDirectory = yield* GameAssetLibrary.labelFontDirectory();
      // ffmpeg writes a fresh name, then the rename replaces whatever sits at
      // `output` without following a link planted there.
      const temporary = NodePath.join(
        NodePath.dirname(output),
        `.sheet-${NodeCrypto.randomUUID()}.jpg`,
      );
      const removeTemporary = Effect.promise(() =>
        NodeFSP.rm(temporary, { force: true }).catch(() => undefined),
      );
      const result = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(output), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore sheet",
            path: output,
            reason: "io",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(
        Effect.andThen(
          processes.run({
            root,
            ...(fontDirectory === undefined ? {} : { cwd: fontDirectory }),
            executable: ffmpeg,
            args: ExploreSheet.sheetArgs(
              frames,
              size.h / size.w,
              fontDirectory === undefined ? null : GameAssetLibrary.LABEL_FONT,
              temporary,
            ),
            operation: "explore-sheet",
            timeoutMs: 60_000,
            envMode: "replace",
            env: GameProcesses.engineChildEnv(),
          }),
        ),
      );
      if (result.exitCode !== 0) {
        yield* removeTemporary;
        return yield* new GameOperationError({
          operation: "Explore sheet",
          path: output,
          reason: "command-failed",
          detail: result.stderr.slice(0, 1000),
        });
      }
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(temporary, output),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore sheet",
            path: output,
            reason: "command-failed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(Effect.onError(() => removeTemporary));
      return frames.length;
    }),
    cancelThread: Effect.fn("GameService.cancelThread")(function* (threadId) {
      const root = yield* projects.resolve(threadId).pipe(
        Effect.catchTags({
          GameOperationError: (error) =>
            error.reason === "project-not-found" || error.reason === "invalid-project"
              ? Effect.succeed(null)
              : Effect.fail(error),
        }),
      );
      if (root !== null) {
        yield* cancel(root, String(threadId));
        // A cancelled turn also releases the game's exploration session: the
        // browser belongs to the user, not to a turn that is going away.
        const live = exploreLive.get(root);
        if (live !== undefined && String(live.threadId) === String(threadId))
          yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
      }
    }),
    status: Effect.fn("GameService.status")(function* (threadId, statusOptions) {
      const root = yield* projects.resolve(threadId);
      const manifest = yield* projects.read(root);
      const inventory = yield* projects.inventory(root);
      const selected = yield* readSelectedBuild(root);
      const selectedPresent =
        selected === null
          ? null
          : yield* Effect.promise(async () => {
              // Cheap structural check for status polling: a missing or empty
              // artifact file must read as stale. Byte identity is checked when
              // Play actually opens the build, not on every poll. three.js
              // builds are static copies (no wasm/pck), so only their entry
              // and script must be present.
              const names =
                manifest.engine.name === "three"
                  ? ["index.html", "main.js"]
                  : ["index.html", "index.js", "index.wasm", "index.pck"];
              for (const name of names) {
                const stat = await NodeFSP.stat(
                  NodePath.join(root, selected.directory, name),
                ).catch(() => null);
                if (stat === null || !stat.isFile() || stat.size === 0) return false;
              }
              return true;
            });
      // The inventory reports what exists under builds/, but Play follows the
      // selected record. With nothing selected, only the legacy mutable build
      // can be played.
      const builds =
        selected === null
          ? inventory.builds.filter(
              (build) => build.target !== "Web" || build.path.startsWith(`${WEB_BUILD_DIRECTORY}/`),
            )
          : [
              ...inventory.builds.filter((build) => build.target !== "Web"),
              {
                target: "Web",
                path: `${selected.directory}/${selected.entry}`,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            ];
      // Freshness is a byte question against the snapshot the export recorded.
      // An unreadable tree cannot be shown to match, but it is also not proven
      // to differ.
      const current = yield* snapshot(root, manifest.godotProject).pipe(Effect.option);
      const currentId =
        current._tag === "Some" && current.value.kind === "known" ? current.value.sourceId : null;
      const matchesSelected =
        selected === null || selected.sourceId === null || currentId === null
          ? null
          : currentId === selected.sourceId;
      // What Play would show: a good export does not make the selected build
      // fresh, and a source edit does not make the selected artifact unplayable.
      const webBuildStale =
        selected === null ? false : selectedPresent !== true || matchesSelected === false;
      const sourcesDifferFromPlay: boolean | "unknown" =
        selected === null
          ? false
          : statusOptions?.checkSources !== true
            ? "unknown"
            : (matchesSelected ?? "unknown");
      // Status observes the preview; it never switches it. A stopped preview
      // stays stopped.
      const previewUrl = preview.url(root);
      return {
        root,
        ...inventory,
        builds,
        // Usability and source freshness are separate answers: the selected
        // build can be perfectly playable while the editable sources have moved
        // on, which is the normal state after an export.
        webBuildStale,
        sourcesDifferFromPlay,
        toolchain: yield* tools.status,
        processes: processes.list(root),
        previewUrl,
        operation: operations.current(root),
      };
    }),
    import: (threadId) => withRoot(threadId, "Import", importGame),
    export: (threadId, target) =>
      withRoot(threadId, `Export ${target}`, (root) => runExport(root, target)),
    exportTargets: (threadId) =>
      withRoot(threadId, "Export targets", (root) =>
        Effect.gen(function* () {
          const { backend } = yield* engine(root);
          return { targets: backend.exportTargets, displayName: backend.displayName };
        }),
      ),
    packageWindows: (threadId) =>
      withRoot(threadId, "Package Windows build", (root) =>
        Effect.gen(function* () {
          if ((yield* projects.read(root)).engine.name === "unity")
            return yield* new GameOperationError({
              operation: "Package Windows build",
              path: NodePath.join(root, "builds/windows"),
              reason: "invalid-input",
              detail:
                "Windows packaging reads a Godot executable and pack. A Unity Windows build is the whole builds/windows folder; zip that folder to ship it.",
            });
          const packaged = yield* Effect.tryPromise({
            try: (signal) => packageWindowsRelease({ root, signal }),
            catch: (cause) =>
              cause instanceof WindowsPackageError
                ? new GameOperationError({
                    operation: "Package Windows build",
                    path: cause.path,
                    reason:
                      cause.kind === "missing" ||
                      cause.kind === "invalid" ||
                      cause.kind === "changed"
                        ? "invalid-input"
                        : "io",
                    detail: cause.message,
                    cause,
                  })
                : new GameOperationError({
                    operation: "Package Windows build",
                    path: NodePath.join(root, "builds/windows/game.exe"),
                    reason: "io",
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "The Windows package could not be created.",
                    cause,
                  }),
          });
          const relative = NodePath.relative(root, packaged.archivePath)
            .split(NodePath.sep)
            .join("/");
          return {
            archivePath: packaged.archivePath,
            fileName: packaged.fileName,
            bytes: packaged.bytes,
            sha256: packaged.sha256,
            files: packaged.files.map((file) => ({
              name: file.name,
              bytes: file.bytes,
              sha256: file.sha256,
            })),
            embeddedPck: packaged.embeddedPck,
            executableBytes: packaged.executableBytes,
            pckBytes: packaged.pckBytes,
            pckFileCount: packaged.pckFileCount,
            notes: [
              ...packaged.notes,
              `The ZIP contains the existing checked release files (${packaged.files.map((file) => file.name).join(" and ")}), not a new export. This machine did not run it on Windows.`,
            ],
            message: `Windows package ready at ${relative} (${Math.round(packaged.bytes / (1024 * 1024))} MB).`,
          };
        }),
      ),
    packageWeb: (threadId) =>
      withRoot(threadId, "Package Web build", (root) =>
        Effect.gen(function* () {
          const selected = yield* readSelectedBuild(root);
          if (selected === null)
            return yield* new GameOperationError({
              operation: "Package Web build",
              path: NodePath.join(root, WEB_BUILD_DIRECTORY),
              reason: "invalid-input",
              detail:
                "No Web build is selected for Play, so there is no build to package. Build & play the game first; packaging never exports and never packages a draft, legacy or unselected build.",
            });
          // Packaging is a byte operation on the selected artifact. Comparing
          // editable sources would walk and hash up to a gigabyte of art for a
          // note, and a download must not pay that cost, so the wording below
          // never claims the sources are current.
          const packaged = yield* Effect.tryPromise({
            try: (signal) => packageWebRelease({ root, selected, signal }),
            catch: (cause) =>
              cause instanceof WebPackageError
                ? new GameOperationError({
                    operation: "Package Web build",
                    path: cause.path,
                    reason:
                      cause.kind === "missing" ||
                      cause.kind === "invalid" ||
                      cause.kind === "changed"
                        ? "invalid-input"
                        : "io",
                    detail: cause.message,
                    cause,
                  })
                : new GameOperationError({
                    operation: "Package Web build",
                    path: NodePath.join(root, "builds/web-packages"),
                    reason: "io",
                    detail:
                      cause instanceof Error
                        ? cause.message
                        : "The Web package could not be created.",
                    cause,
                  }),
          });
          const relative = NodePath.relative(root, packaged.archivePath)
            .split(NodePath.sep)
            .join("/");
          const build = selected.buildId.slice(0, 12);
          const sourceNote = `The ZIP is the selected Web build Play serves (${build}); it contains those fixed bytes only, and later source edits are not included. Packaging does not compare them.`;
          return {
            archivePath: packaged.archivePath,
            fileName: packaged.fileName,
            buildId: packaged.buildId,
            bytes: packaged.bytes,
            sha256: packaged.sha256,
            files: packaged.files,
            entry: packaged.entry,
            sourceEntry: packaged.sourceEntry,
            notes: [
              ...packaged.notes,
              sourceNote,
              "Serve the extracted files from an ordinary static HTTP host; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP.",
            ],
            message: `Web package ready at ${relative} (${Math.round(packaged.bytes / (1024 * 1024))} MB) for selected build ${build}.`,
          };
        }),
      ),
    webPackageFile: (threadId, buildId, packageSha256) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        if (!/^[0-9a-f]{64}$/.test(buildId))
          return yield* new GameOperationError({
            operation: "Download Web package",
            path: NodePath.join(root, "builds/web-packages"),
            reason: "download",
            detail:
              "This Web package link does not name a build. Open Builds and download the selected build again.",
          });
        const selected = yield* readSelectedBuild(root);
        const path = webPackageArchivePath(root, buildId);
        if (selected === null || selected.buildId !== buildId)
          return yield* new GameOperationError({
            operation: "Download Web package",
            path,
            reason: "download",
            detail:
              "The selected Web build changed after this download link was created. Open Builds and download the package for the selected build.",
          });
        return yield* verifyPackageFile(
          "Download Web package",
          path,
          packageSha256,
          WEB_PACKAGE_FILE,
          "No complete Web package is ready for the selected build. Open Builds, then choose Download package on the selected Web build.",
        );
      }).pipe(Effect.scoped),
    windowsPackageFile: (threadId, packageSha256) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const path = windowsPackageArchivePath(root);
        return yield* verifyPackageFile(
          "Download Windows package",
          path,
          packageSha256,
          WINDOWS_PACKAGE_FILE,
          "No Windows package is ready. Open Builds, then choose Download package on the Windows build.",
        );
      }).pipe(Effect.scoped),
    exploreStart: (threadId, input) => exploreStart(threadId, input),
    exploreAct: (threadId, input) => exploreAct(threadId, input),
    exploreClose: (threadId, input) => exploreClose(threadId, input),
    botRun: (threadId, input) =>
      Effect.flatMap(projects.resolve(threadId), (root) => botRunIn(root, input)),
    botRunIn: (root, input) => botRunIn(root, input),
    botView: (threadId, input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* gameBot.view(root, input);
      }),
    botReport: (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* gameBot.report(root);
      }),
    secretsStatus: () =>
      Effect.gen(function* () {
        const present = (name: string): Effect.Effect<boolean> =>
          secrets.get(name).pipe(
            Effect.map((found) => {
              if (Option.isNone(found)) return false;
              return Buffer.from(found.value).toString("utf8").trim().length > 0;
            }),
            Effect.orElseSucceed(() => false),
          );
        const [jev, sketchfab, polypizza] = yield* Effect.all([
          present(GameBot.GAME_BOT_JEV_SECRET),
          present(GameBlender.GAME_BLENDER_SKETCHFAB_SECRET),
          present(GameBlender.GAME_BLENDER_POLYPIZZA_SECRET),
        ]);
        return { jev, sketchfab, polypizza } satisfies GameSecretsStatusResult;
      }),
    setSecret: (input) =>
      Effect.gen(function* () {
        const name =
          input.name === "jev"
            ? GameBot.GAME_BOT_JEV_SECRET
            : input.name === "sketchfab"
              ? GameBlender.GAME_BLENDER_SKETCHFAB_SECRET
              : GameBlender.GAME_BLENDER_POLYPIZZA_SECRET;
        const value = input.secret.trim();
        if (value === "") {
          yield* secrets.remove(name).pipe(Effect.orElseSucceed(() => undefined));
          return { name: input.name, set: false } satisfies GameSetSecretResult;
        }
        yield* secrets.set(name, Buffer.from(value)).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "game secret",
                path: input.name,
                reason: "io",
                detail: "The key could not be stored.",
                cause,
              }),
          ),
        );
        return { name: input.name, set: true } satisfies GameSetSecretResult;
      }),
    check: (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const manifest = yield* projects.read(root);
        const label =
          manifest.engine.name === "three"
            ? "three.js check"
            : manifest.engine.name === "unity"
              ? "Unity check"
              : "Godot check";
        return yield* withRoot(threadId, label, checkGame);
      }),
    unityTools: (threadId) =>
      withRoot(threadId, "Unity tools", (root) =>
        unityRoot(root).pipe(
          Effect.andThen(liveUnity.tools(root)),
          Effect.map((tools) => ({ tools })),
        ),
      ),
    unityEdit: (threadId, input) =>
      withRoot(threadId, "Unity edit", (root) =>
        Effect.gen(function* () {
          yield* unityRoot(root);
          if (!GameUnity.UNITY_EDIT_TOOL.test(input.tool))
            return yield* new GameOperationError({
              operation: "Unity edit",
              path: input.tool,
              reason: "invalid-input",
              detail:
                "That tool is not an editing tool here. List the editing tools with game_unity_tools; use game_unity_eval, game_unity_play, game_unity_screenshot or game_unity_console for the rest.",
            });
          // Edits live in the open scene until saved, so the edit and its save hold one editor.
          return yield* liveUnity.hold(root)(
            Effect.gen(function* () {
              const result = yield* liveUnity.call(root, input.tool, { ...input.arguments });
              const saved = yield* liveUnity.call(root, "editor_save_all", {}).pipe(
                Effect.map(GameUnity.textOf),
                Effect.orElseSucceed(() => "Saving the scene failed."),
              );
              return { text: `${GameUnity.textOf(result).slice(0, 8000)}\n${saved}` };
            }),
          );
        }),
      ),
    unityEval: (threadId, input) =>
      withRoot(threadId, "Unity eval", (root) =>
        unityRoot(root).pipe(
          Effect.andThen(
            liveUnity.call(root, "script_eval", { code: input.code, timeout: 60 }, 90_000),
          ),
          Effect.map((result) => ({ text: GameUnity.textOf(result).slice(0, 8000) })),
        ),
      ),
    unityRecompile: (threadId) =>
      withRoot(threadId, "Unity recompile", (root) =>
        Effect.gen(function* () {
          yield* unityRoot(root);
          const { backend, godot, cwd, godotProject } = yield* engine(root);
          const imported = yield* backend.importProject({
            root,
            projectDir: cwd,
            projectName: godotProject,
            binary: godot,
          });
          return {
            ok: imported.result.success,
            errors: imported.issues,
            warnings: [],
            text: imported.result.success
              ? imported.result.message
              : imported.result.message.slice(0, 4000),
          };
        }),
      ),
    unityPlay: (threadId, input) =>
      withRoot(threadId, "Unity play", (root) =>
        Effect.gen(function* () {
          yield* unityRoot(root);
          // An unfocused editor freezes play mode at frame 1 without auto-tick.
          if (input.action === "start") yield* liveUnity.call(root, "editor_set_auto_tick", {});
          const result = yield* liveUnity.call(
            root,
            input.action === "start" ? "editor_playmode_start" : "editor_playmode_stop",
            {},
            120_000,
          );
          return { text: GameUnity.textOf(result) };
        }),
      ),
    unityScreenshot: (threadId, input) =>
      withRoot(threadId, "Unity screenshot", (root) =>
        Effect.gen(function* () {
          yield* unityRoot(root);
          const result = yield* liveUnity.call(root, "capture_game_view", {
            source: "camera",
            max_resolution: input.maxSize ?? 960,
          });
          return GameUnity.screenshotOf(result);
        }),
      ),
    unityConsole: (threadId, input) =>
      withRoot(threadId, "Unity console", (root) =>
        unityRoot(root).pipe(
          Effect.andThen(
            liveUnity.call(root, "console_get", {
              level: input.level ?? "log",
              tail: input.tail ?? 50,
            }),
          ),
          Effect.map((result) => ({ text: GameUnity.textOf(result).slice(0, 12000) })),
        ),
      ),
    blenderCode: (threadId, input) =>
      withRoot(threadId, "Blender code", (root) => liveBlender.code(root, input)),
    blenderLook: (threadId, input) =>
      withRoot(threadId, "Blender look", (root) => liveBlender.look(root, input)),
    blenderScene: (threadId, input) =>
      withRoot(threadId, "Blender scene", (root) => liveBlender.scene(root, input)),
    blenderAssetsSearch: (threadId, input) =>
      withRoot(threadId, "Blender assets search", (root) => liveBlender.assetsSearch(root, input)),
    blenderAssetsImport: (threadId, input) =>
      withRoot(threadId, "Blender assets import", (root) => liveBlender.assetsImport(root, input)),
    blenderExport: (threadId, input) =>
      withRoot(threadId, "Blender export", (root) => liveBlender.exportGlb(root, input)),
    // Search only reads the game and writes its contact sheet under builds/, so it never waits on the game's lock.
    assetsSearch: (threadId, input) =>
      projects.resolve(threadId).pipe(Effect.flatMap((root) => library.search(root, input))),
    assetsAdd: (threadId, input) =>
      withRoot(threadId, "Library add", (root) => library.add(root, input)),
    closeLiveEditors: (root) =>
      Effect.all([liveBlender.stop(root), liveUnity.stop(root)], { discard: true }),
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      if (action === "stop") {
        yield* cancel(root);
        yield* processes.stop(root);
        yield* liveBlender.stop(root).pipe(Effect.ignore);
        yield* liveUnity.stop(root).pipe(Effect.ignore);
        yield* gameBot.stop(root).pipe(Effect.ignore);
        yield* preview.stop(root);
        return {
          success: true,
          message: "Stopped this game's processes and preview server.",
          path: null,
          url: null,
          process: null,
        };
      }
      return yield* exclusive(
        root,
        action,
        Effect.gen(function* () {
          if (action === "export-linux") return yield* runExport(root, "Linux");
          if (action === "export-windows") return yield* runExport(root, "Windows");
          // Rebuild forces a new export and publishes it.
          if (action === "rebuild") return yield* publishWeb(root);
          const selected = yield* readSelectedBuild(root);
          const served = yield* selectedPreview(root);
          if (served !== null)
            return {
              success: true,
              message: "Loaded the selected web build.",
              path: NodePath.join(root, served.directory, "index.html"),
              url: served.url,
              process: null,
            };
          if (selected !== null)
            return {
              success: false,
              message:
                "The selected build is unavailable: its served files are missing or empty. Rebuild to export the current sources.",
              path: null,
              url: null,
              process: null,
            };
          return yield* publishWeb(root);
        }),
        String(threadId),
      );
    }),
  });
});
export const layer = Layer.effect(GameService, make).pipe(
  Layer.provide(GameEngine.layer),
  // After GameEngine, so the engine backend and the service share one live editor.
  Layer.provide(GameUnity.layer),
  Layer.provide(GameBlender.layer),
  Layer.provide(GameAssetLibrary.layer),
  Layer.provide(GameBot.layer),
  Layer.provideMerge(GameOperations.layer),
);
