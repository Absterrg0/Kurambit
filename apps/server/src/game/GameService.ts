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
  type GameBlenderGenerateInput,
  type GameBlenderGenerateResult,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotReportResult,
  type GameBotViewInput,
  type GameBotViewResult,
  type GameSecretName,
  type GameSetSecretInput,
  type GameSetSecretResult,
  type GameSecretsStatusResult,
} from "@t3tools/contracts";
import * as GameExploreNative from "./gameExploreNative.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameBlender from "./GameBlender.ts";
import * as GameBot from "./GameBot.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
import { comparedSource, snapshotBuildSource } from "./sourceSnapshot.ts";
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
     * under godot/ the game can load, saving the .blend source. Run
     * game_import after so Godot sees it.
     */
    readonly blenderExport: (
      threadId: ThreadId,
      input: GameBlenderExportInput,
    ) => Effect.Effect<GameBlenderExportResult, GameOperationError>;
    /** Live Blender scene: forward to the upstream generator; reports clearly when none is available. */
    readonly blenderGenerate: (
      threadId: ThreadId,
      input: GameBlenderGenerateInput,
    ) => Effect.Effect<GameBlenderGenerateResult, GameOperationError>;
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
  }
>()("t3/game/GameService") {}
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
  const preview = yield* GamePreview.GamePreview;
  const liveBlender = yield* GameBlender.GameBlender;
  const gameBot = yield* GameBot.GameBot;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const operations = yield* GameOperations.GameOperations;
  const active = new Map<
    string,
    { cancelled: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
  const cancel = Effect.fnUntraced(function* (root: string) {
    const operation = active.get(root);
    if (operation === undefined) return;
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
  const exclusive = <A>(root: string, name: string, work: Effect.Effect<A, GameOperationError>) =>
    Effect.gen(function* () {
      if (active.has(root))
        return yield* new GameOperationError({ operation: name, path: root, reason: "busy" });
      const cancelled = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const at = DateTime.formatIso(yield* DateTime.now);
      active.set(root, { cancelled, done });
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
  const emptyExploreEvidence = () => ({
    sessions: 0,
    actions: 0,
    executedInputSteps: 0,
    nominalMs: 0,
    images: 0,
  });
  const exploreEvidence = new Map<string, ReturnType<typeof emptyExploreEvidence>>();
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
        const owner = String(session.threadId);
        const evidence = exploreEvidence.get(owner) ?? emptyExploreEvidence();
        evidence.sessions += 1;
        evidence.actions += session.actions.length;
        evidence.executedInputSteps += session.actions.reduce(
          (sum, action) => sum + action.executedInputSteps,
          0,
        );
        evidence.nominalMs += session.totalNominalMs;
        evidence.images += session.images;
        exploreEvidence.delete(owner);
        exploreEvidence.set(owner, evidence);
        if (exploreEvidence.size > 128) {
          const oldest = exploreEvidence.keys().next().value;
          if (oldest !== undefined) exploreEvidence.delete(oldest);
        }
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
                if (signal?.aborted) throw new Error("aborted");
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
          `Act with short input steps plus ui and inspect steps, then game_explore_close. ` +
          (hasDisplay ? "" : noPicture + " ") +
          `This session never qualifies the build.`,
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
          `Act with short input steps, then game_explore_close. ` +
          `This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
    exploreStartLock.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
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
              "Godot web play is not in this build; start the session without a target (or with target native).",
            );
          return yield* exploreStartWeb(threadId, root, input);
        }
        if (manifest.engine.name === "three")
          return yield* exploreInvalid(
            root,
            "This is a three.js browser game; start the session with target web.",
          );
        return yield* exploreStartNative(threadId, root, input);
      }),
    );
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
          `${GAME_EXPLORE_BOUNDS.maxCalls - callIndex} act(s) left. ` +
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
          `${GAME_EXPLORE_BOUNDS.maxCalls - callIndex} act(s) left. ` +
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
          if (session.web !== null)
            return yield* exploreActWeb(session, input, callIndex, nominalMs);
          return yield* exploreActNative(session, input, callIndex, nominalMs);
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
  /** Imports first: a fresh game has no .godot cache, so .tres files and class_names can resolve. */
  const checkGame = (root: string) =>
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
              message: `The ${backend.displayName} check timed out before finishing its physics frames.`,
            });
          if (run.exitCode !== 0 && errors.length === 0)
            errors.unshift({
              file: projectFile,
              message: `${backend.displayName} exited with code ${run.exitCode}. ${commandDetail(run)}`,
            });
          // A game created before gameplay entries is checked as it always was, but
          // the warning says what the check did not cover rather than implying it did.
          // three.js games have no gameplay scene concept; the check loads the page.
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
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* exclusive(root, name, work(root));
  });
  // Idle and wall-clock expiry without a caller: one scoped fiber sweeps the
  // live sessions. Production timers own it; every act/close also
  // checks the same deadlines lazily.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.seconds(30));
        yield* exploreReap;
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
      const evidence = exploreEvidence.get(String(threadId)) ?? emptyExploreEvidence();
      return evidence;
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
        yield* cancel(root);
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
      Effect.gen(function* () {
        // No exclusive() here: a real-time run takes minutes and must not
        // hold the game's operation lock. The bot service refuses a second
        // concurrent run per game as busy.
        const root = yield* projects.resolve(threadId);
        const manifest = yield* projects.read(root);
        // Static sources need no editor import; the bot plays the folder.
        if (manifest.engine.name !== "three") {
          const imported = yield* importGame(root);
          if (!imported.success)
            return yield* new GameOperationError({
              operation: "Bot run",
              path: imported.path ?? root,
              reason: "command-failed",
              detail:
                `The Godot import failed before the bot run started.\n${imported.message}`.slice(
                  -2000,
                ),
            });
        }
        return yield* gameBot.run(root, input);
      }),
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
        const label = manifest.engine.name === "three" ? "three.js check" : "Godot check";
        return yield* withRoot(threadId, label, checkGame);
      }),
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
    blenderGenerate: (threadId, input) =>
      withRoot(threadId, "Blender generate", (root) => liveBlender.generate(root, input)),
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      if (action === "stop") {
        yield* cancel(root);
        yield* processes.stop(root);
        yield* liveBlender.stop(root).pipe(Effect.ignore);
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
      );
    }),
  });
});
export const layer = Layer.effect(GameService, make).pipe(
  Layer.provide(GameEngine.layer),
  Layer.provide(GameBlender.layer),
  Layer.provide(GameBot.layer),
  Layer.provideMerge(GameOperations.layer),
);
