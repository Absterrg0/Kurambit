// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  GameOperationError,
  GameManifest,
  type GameCheckResult,
  type GameSceneInspectResult,
  type GameScenariosRunResult,
  type GameScenarioEvidence,
  type GameStatus,
  type GameQualificationRead,
  type GameAction,
  type GameActionResult,
  type GameBlenderInput,
  GameBlenderResult,
  GameArtFramesInput,
  GameArtFramesResult,
  GameWebPlaytestInput,
  GameWebPlaytestResult,
  type GameArtImportResult,
  type GameLibraryImportMaterialResult,
  type GameLibraryImportModelResult,
  type GameOperationEvent,
  type GameVerifyInput,
  type GameVerifyResult,
  type GameVerifyStage,
  type GameWebPackage,
  type GameWindowsPackage,
  type ThreadId,
  GameGodotApiInput,
  GameGodotApiResult,
  GameNativeCaptureInput,
  GameNativeCaptureResult,
  NATIVE_CAPTURE_BOUNDS,
  GameRuntimeCalibrateInput,
  GameRuntimeCalibrateResult,
  GameRuntimeCalibrateRun,
  RUNTIME_CALIBRATE_BOUNDS,
  GAME_GODOT_API_BOUNDS,
  GAME_BLENDER_INPUT_BOUNDS,
  GAME_ASSET_INVENTORY_BOUNDS,
  GameAssetsInspectInput,
  GameAssetsInspectResult,
  type GameAssetNativeEvidence,
  type GameAssetExportedInclusion,
  fitScreenshotsToBudget,
  gameProductionBudgetMs,
  GAME_PLAYTEST_BOUNDS,
  GAME_EXPLORE_BOUNDS,
  integerScaledCapture,
  isGameplayInputStep,
  PLAYTEST_DEFAULT_CAPTURE,
  playtestInputIssues,
  tryInputIssues,
  GAME_AUDIO_INSPECT_BOUNDS,
  GameAudioInspectInput,
  GameAudioInspectResult,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreReplayInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameExploreReplayResult,
  GameExploreStep as GameExploreStepSchema,
  GameExploreTarget,
  type GameExploreStep,
  GamePlaytestStep as GamePlaytestStepSchema,
  GameViewport as GameViewportSchema,
  type GameConsoleMessage,
  type GamePlaytestProbe,
  type GamePlaytestStep,
  type GameViewport,
} from "@t3tools/contracts";
import * as GameAdmission from "./GameAdmission.ts";
import * as GameArtKits from "./GameArtKits.ts";
import * as GameExploreBrowser from "./GameExploreBrowser.ts";
import * as GameExploreNative from "./gameExploreNative.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import {
  checkBudgets,
  downloadPlannedFiles,
  fetchLibraryJson,
  pageUrlOf,
  planMaterialFiles,
  planModelFiles,
  provenanceMarkdown,
  totalBytesOf,
} from "./GameAssetLibrary.ts";
import {
  decodeMaterialResult,
  encodeMaterialRequest,
  GODOT_ASSET_MATERIAL_SCRIPT,
} from "./gameAssetMaterialScript.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GamePreview from "./GamePreview.ts";
import { insideGame } from "./GameProjectService.ts";
import { openMediaFile, type OpenMediaFile } from "../assets/MediaFile.ts";
import { commandDetail } from "./commandDetail.ts";
import {
  CANDIDATE_BUILDS_DIRECTORY,
  WEB_BUILD_DIRECTORY,
  candidateBuildDirectory,
  candidateBuildId,
  describeWebArtifacts,
  hashWebBuild,
  hashWebBuildDirectory,
  isWebBuildFresh,
} from "./webBuild.ts";
import { comparedSource, snapshotBuildSource } from "./sourceSnapshot.ts";
import * as GameQualification from "./GameQualification.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import { BlenderRunConfig, encodeBlenderRunConfig, renderRunScript } from "./blenderScript.ts";
import { stageBlenderInputs, validateBlenderInputs } from "./gameBlenderInputs.ts";
import { GODOT_ART_FRAMES_SCRIPT } from "./gameArtFramesScript.ts";
import { inspectGlb } from "./gameGlb.ts";
import { composeContactSheet, MAX_CONTACT_SHEET_THUMBNAILS } from "./assetContactSheet.ts";
import { PNG } from "pngjs";
import * as GameWebPlaytest from "./GameWebPlaytest.ts";
import { mergeCheckIssues, parseGodotIssues, limitIssues } from "./godotCheckOutput.ts";
import { GODOT_SCENARIO_SCRIPT } from "./godotScenarioScript.ts";
import { GODOT_INSPECT_SCRIPT } from "./godotInspectScript.ts";
import { GODOT_API_SCRIPT } from "./godotApiScript.ts";
import {
  GODOT_ASSET_INVENTORY_SCRIPT,
  GODOT_ASSET_EXPORT_INCLUSION_SCRIPT,
} from "./gameAssetInventoryScript.ts";
import {
  buildResourceEntries,
  checkFamily,
  collectAuthoredPaths,
  existsInsideGame,
  imagePixelCount,
  normalizeAuthoredPath,
  preflightImportSafety,
  resolveDeclaredReferences,
  scanSourceMentions,
  summarizeCoverage,
  walkGameFiles,
} from "./gameAssetInventory.ts";
import {
  parseProjectInputActions,
  readScenarioFiles,
  sanitizeScenarioLayout,
  sanitizeScenarioSpatial,
  scenarioActionIssues,
  scenarioObservations,
  scenarioRequestJson,
} from "./gameScenarios.ts";
import {
  captureTimeoutMs,
  estimateCaptureBytes,
  findExecutable,
  freeBytes,
  godotMovieArgs,
  missingToolDetail,
  movieFrameEstimate,
  parseCalibrationRunnerReport,
  parsePhysicsTicksPerSecond,
  parseProbeJson,
  parseRunnerReport,
  plannedScenarioFrames,
  posterArgs,
  probeArgs,
  quitAfterRenderFrames,
  requiredReserveBytes,
  transcodeArgs,
  xvfbArgs,
} from "./gameNativeCapture.ts";
import {
  compareCalibratePair,
  playerDisplacementOf,
  verdictOfPairs,
  type CalibrateRunSample,
} from "./gameRuntimeCalibrate.ts";
import {
  isPathInside,
  prepareNativeUserIsolation,
  userDirConfigIssues,
} from "./gameNativeUserDir.ts";
import {
  audioMeasureArgs,
  fingerprintAudioFile,
  audioProbeArgs,
  detectPhaseCancellation,
  isNativeClipPath,
  parseAudioProbeJson,
  parseChannelStats,
  parseSilenceTotal,
  parseVolumeDetect,
  parseVolumeDetects,
  readNativeClipSourceId,
  resolveAudioPath,
} from "./gameAudioInspect.ts";
import { evaluateScenarios } from "./scenarioEvaluation.ts";
import { readLastPlaytest, writePlaytestEvidence } from "./playtestEvidence.ts";
import { satisfiedObservations } from "./playtestState.ts";
import { parseGodotViewport } from "./godotViewport.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { productionStatus } from "./gameProduction.ts";
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

/**
 * The export answer the builder reads. The first accepted submit is the first
 * playable; a later accepted submit replaces it while production continues.
 */
const WEB_READY_MESSAGE =
  "Web game is ready to play. Playtest it with input steps; the first game_submit makes it the first playable, and later accepted submits replace it as you keep producing.";

/**
 * Join the managed preview-browser install with bounded extra waits. Each
 * `executable` call already waits up to 45s on the one in-flight install and
 * then reports InstallingError while the download continues; GAME operations
 * re-join that same install up to two more times and only for InstallingError.
 * Permanent install failures and unsupported platforms fail immediately, and
 * interruption stays interruptible. No bypass of managed checks.
 */
export const withPreviewBrowserInstallRetries = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.retry({
      times: 2,
      while: (error) => error._tag === "PreviewBrowserInstallingError",
    }),
  );

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
    readonly status: (
      threadId: ThreadId,
      options?: { readonly checkSources?: boolean | undefined },
    ) => Effect.Effect<GameStatus, GameOperationError>;
    /**
     * Makes a round's candidate the build Play serves, once its bytes and
     * sources still match what was exported. An already-open preview follows,
     * and the operation event refreshes every open stage.
     */
    readonly promote: (
      threadId: ThreadId,
      roundId: string,
      options?: { readonly guard?: Effect.Effect<string | null> | undefined },
    ) => Effect.Effect<GameRoundStore.GamePromotion, GameOperationError>;
    /** Operation pushes for every game this server runs. */
    readonly events: Stream.Stream<GameOperationEvent>;
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly blender: (
      threadId: ThreadId,
      input: typeof GameBlenderInput.Type,
    ) => Effect.Effect<typeof GameBlenderResult.Type, GameOperationError>;
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly test: (
      threadId: ThreadId,
      script: string,
      timeoutMs?: number,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux" | "Windows",
      options?: { readonly roundId?: string | undefined },
    ) => Effect.Effect<GameActionResult, GameOperationError>;
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
     * Runs the native game. The creator's own Play may watch it on their
     * display; an agent's tool always asks for `headless`.
     */
    readonly native: (
      threadId: ThreadId,
      options?: { readonly display?: "headless" | "inherit" | undefined },
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    readonly webPlaytest: (
      threadId: ThreadId,
      input: GameWebPlaytestInput,
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    /** Plays recorded export bytes without importing or rebuilding editable sources. */
    readonly webPlaytestBuild: (
      threadId: ThreadId,
      buildId: string,
      input: GameWebPlaytestInput,
      experimentDirectory?: string,
      imageResponse?: "persisted",
      internal?: { readonly captureFromStep?: number },
    ) => Effect.Effect<GameWebPlaytestResult, GameOperationError>;
    /**
     * Opens a bounded persistent exploration session on one frozen export.
     * Short act/observe cycles keep one paused browser; closing saves a
     * server-owned trace for independent replay. Descriptive only: it never
     * qualifies, promotes or passes quality. Builder/repair only.
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
    /** Closes a session, saving its trace and releasing its browser. */
    readonly exploreClose: (
      threadId: ThreadId,
      input: typeof GameExploreCloseInput.Type,
    ) => Effect.Effect<typeof GameExploreCloseResult.Type, GameOperationError>;
    /**
     * Replays a saved trace against its same immutable export in a fresh
     * browser. The exploratory probe is never presented as confirmation.
     */
    readonly exploreReplay: (
      threadId: ThreadId,
      input: typeof GameExploreReplayInput.Type,
    ) => Effect.Effect<typeof GameExploreReplayResult.Type, GameOperationError>;
    /**
     * One complete iteration in one admitted operation: check, the canonical
     * suite, the approved scenario exam when the design binds nonempty
     * acceptance, then a Web export and a recorded playtest of those exact
     * bytes. Stops at the first failed stage; mechanical success is not a
     * quality verdict.
     */
    readonly verify: (
      threadId: ThreadId,
      input: GameVerifyInput,
    ) => Effect.Effect<GameVerifyResult, GameOperationError>;
    readonly check: (threadId: ThreadId) => Effect.Effect<GameCheckResult, GameOperationError>;
    readonly scenariosRun: (
      threadId: ThreadId,
    ) => Effect.Effect<GameScenariosRunResult, GameOperationError>;
    /**
     * Records a short native diagnostic clip for one validated scenario: the
     * real game under Godot MovieWriter on a private virtual display,
     * transcoded with the installed FFmpeg. Diagnostic only: it never writes a
     * qualification record and never proves gameplay. Builder/repair only;
     * critics and ballots never reach it.
     */
    readonly nativeCapture: (
      threadId: ThreadId,
      input: typeof GameNativeCaptureInput.Type,
    ) => Effect.Effect<typeof GameNativeCaptureResult.Type, GameOperationError>;
    /**
     * Replays one validated scenario route headlessly at 2-3 render cadences
     * with 2 repeats each, under a fixed seed and fresh per-run user://
     * isolation. It measures baseline/final player transforms, engine
     * physics/render counters, nominal physics seconds and final GameState;
     * it compares same-rate repeats before cross-rate pairs with documented
     * tolerances. Diagnostic only: it never writes a qualification record,
     * never promotes, and never edits scenes or scripts. Builder/repair only;
     * critics and ballots never reach it.
     */
    readonly runtimeCalibrate: (
      threadId: ThreadId,
      input: typeof GameRuntimeCalibrateInput.Type,
    ) => Effect.Effect<typeof GameRuntimeCalibrateResult.Type, GameOperationError>;
    readonly inspectScene: (
      threadId: ThreadId,
      scenePath: string,
    ) => Effect.Effect<GameSceneInspectResult, GameOperationError>;
    /**
     * Bounded local visibility over every project resource plus measured
     * family checks. Filesystem facts, declared references and source
     * mentions stay separate from native load evidence; exported usage stays
     * unknown because inclusion is not use. A whole-project import preflight
     * runs before any engine import, and pack inclusion (when a selected or
     * latest Web build exists) opens the exact recorded `.pck` in an empty
     * bootstrap project through the engine — no game project, no autoload,
     * no script execution. Read-only: the native pass loads in the game's
     * project but writes only to builds/logs scratch. Builder/repair only;
     * critics and ballots keep frozen frames.
     */
    readonly assetsInspect: (
      threadId: ThreadId,
      input: typeof GameAssetsInspectInput.Type,
    ) => Effect.Effect<typeof GameAssetsInspectResult.Type, GameOperationError>;
    /**
     * Bounded real audio measurement of one local asset file or one recorded
     * native clip, decoded with the installed FFmpeg. Size, duration, segment,
     * output-byte and time limits run before any decode; the PCM stays in the
     * filter graph and only parsed numbers leave it. Returns concrete metrics
     * plus honest unknowns, never a quality verdict: it does not prove
     * exported Web audio, composition, taste, spatial mix or "good audio".
     * Builder/repair only; critics and ballots keep frozen frames.
     */
    readonly audioInspect: (
      threadId: ThreadId,
      input: typeof GameAudioInspectInput.Type,
    ) => Effect.Effect<typeof GameAudioInspectResult.Type, GameOperationError>;
    /**
     * Queries the installed Godot's built-in ClassDB for one engine class.
     * Engine-native signatures, properties, signals, constants and inheritance
     * with no network and no guessed APIs. ClassDB covers engine classes only,
     * not script-defined or Variant builtin types.
     */
    readonly godotApi: (
      threadId: ThreadId,
      input: typeof GameGodotApiInput.Type,
    ) => Effect.Effect<typeof GameGodotApiResult.Type, GameOperationError>;
    /**
     * Copies one optional art kit's declared files into the game's Godot
     * project and returns the exact resource paths. It never edits the
     * manifest, design or mechanics.
     */
    readonly importArtKit: (
      threadId: ThreadId,
      input: { readonly id: string },
    ) => Effect.Effect<GameArtImportResult, GameOperationError>;
    /**
     * Builds a Godot SpriteFrames resource from a kit sheet's authored grid
     * and animations. The `.tres` is generated output the request rewrites;
     * the kit PNGs it references are never touched.
     */
    readonly buildArtFrames: (
      threadId: ThreadId,
      input: typeof GameArtFramesInput.Type,
    ) => Effect.Effect<typeof GameArtFramesResult.Type, GameOperationError>;
    /**
     * Downloads one Poly Haven model (bounded 1k glTF plus its pinned
     * textures) into the game's Godot library and returns the exact engine
     * paths. The raw download is the preserved source; nothing is
     * reserialized, so materials, hierarchy and extensions stay as published.
     */
    readonly importLibraryModel: (
      threadId: ThreadId,
      input: { readonly id: string; readonly resolution?: "1k" | "2k" | undefined },
    ) => Effect.Effect<GameLibraryImportModelResult, GameOperationError>;
    /**
     * Downloads one Poly Haven PBR texture set (bounded 1k albedo plus
     * OpenGL normal and roughness) and builds a reusable StandardMaterial3D
     * with Godot itself. The real PBR maps are never repainted; the shared
     * art profile stays a convention warning.
     */
    readonly importLibraryMaterial: (
      threadId: ThreadId,
      input: { readonly id: string; readonly resolution?: "1k" | "2k" | undefined },
    ) => Effect.Effect<GameLibraryImportMaterialResult, GameOperationError>;
  }
>()("t3/game/GameService") {}
const decodeGameManifest = Schema.decodeUnknownSync(Schema.fromJsonString(GameManifest));
const decodeBlenderMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      objects: Schema.Number,
      meshes: Schema.Number,
      materials: Schema.Number,
      materialDetails: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          color: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
        }),
      ),
      animations: Schema.Number,
      triangles: Schema.Number,
      dimensions: Schema.Array(Schema.Number),
      originOffset: Schema.Array(Schema.Number),
      warnings: Schema.Array(Schema.String),
    }),
  ),
);
const RawSceneInspect = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    scenePath: Schema.optionalKey(Schema.String),
    nodes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          name: Schema.String,
          type: Schema.String,
          script: Schema.optionalKey(Schema.String),
          groups: Schema.Array(Schema.String),
          position: Schema.optionalKey(Schema.Array(Schema.Number)),
          collisionLayer: Schema.optionalKey(Schema.Number),
          collisionMask: Schema.optionalKey(Schema.Number),
          children: Schema.Array(Schema.String),
        }),
      ),
    ),
    nodeCount: Schema.optionalKey(Schema.Number),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeSceneInspect = Schema.decodeUnknownSync(RawSceneInspect);
const RawGodotApi = Schema.fromJsonString(
  Schema.Struct({
    className: Schema.optionalKey(Schema.String),
    engineVersion: Schema.optionalKey(Schema.String),
    found: Schema.optionalKey(Schema.Boolean),
    parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
    inheritance: Schema.optionalKey(Schema.Array(Schema.String)),
    methods: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ name: Schema.String, signature: Schema.optionalKey(Schema.String) }),
      ),
    ),
    totalMethods: Schema.optionalKey(Schema.Number),
    properties: Schema.optionalKey(
      Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.optionalKey(Schema.String) })),
    ),
    totalProperties: Schema.optionalKey(Schema.Number),
    signals: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ name: Schema.String, signature: Schema.optionalKey(Schema.String) }),
      ),
    ),
    totalSignals: Schema.optionalKey(Schema.Number),
    constants: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ name: Schema.String, value: Schema.optionalKey(Schema.Number) }),
      ),
    ),
    totalConstants: Schema.optionalKey(Schema.Number),
    truncated: Schema.optionalKey(Schema.Boolean),
    suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
    message: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
);
const decodeGodotApi = Schema.decodeUnknownSync(RawGodotApi);
const decodeGodotApiInput = Schema.decodeUnknownEffect(GameGodotApiInput);
const decodeGodotApiResult = Schema.decodeUnknownEffect(GameGodotApiResult);
const decodeExploreReplayTrace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      sessionId: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
      threadId: Schema.String,
      root: Schema.String,
      buildId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      sourceId: Schema.NullOr(Schema.String),
      viewport: GameViewportSchema,
      timing: Schema.Union([Schema.Literal("controlled-clock"), Schema.Literal("native-paused")]),
      target: Schema.optionalKey(GameExploreTarget),
      closed: Schema.Struct({ reason: Schema.String, at: Schema.String }),
      actions: Schema.Array(
        Schema.Struct({
          steps: Schema.Array(GameExploreStepSchema).check(
            Schema.isMaxLength(GAME_EXPLORE_BOUNDS.maxStepsPerCall),
          ),
          failure: Schema.optionalKey(Schema.String),
        }),
      ).check(Schema.isMaxLength(GAME_EXPLORE_BOUNDS.maxCalls + 1)),
    }),
  ),
);
const RawAssetInventory = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    engineVersion: Schema.optionalKey(Schema.String),
    truncated: Schema.optionalKey(Schema.Boolean),
    results: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          resPath: Schema.String,
          loaded: Schema.optionalKey(Schema.Boolean),
          godotClass: Schema.optionalKey(Schema.NullOr(Schema.String)),
          error: Schema.optionalKey(Schema.NullOr(Schema.String)),
          dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
          animations: Schema.optionalKey(Schema.Array(Schema.String)),
          loops: Schema.optionalKey(Schema.Array(Schema.String)),
          transitions: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                resource: Schema.optionalKey(Schema.String),
                from: Schema.String,
                to: Schema.String,
                condition: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
          hasStateMachine: Schema.optionalKey(Schema.Boolean),
          collisionTotal: Schema.optionalKey(Schema.Number),
          collisionEnabled: Schema.optionalKey(Schema.Number),
          rootPosition: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Number))),
          rootScale: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Number))),
          pivotHint: Schema.optionalKey(Schema.NullOr(Schema.String)),
          heightHint: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          detail: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  }),
);
const decodeAssetInventory = Schema.decodeUnknownSync(RawAssetInventory);
const encodeAssetInventoryRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ targets: Schema.Array(Schema.String) })),
);
const RawExportInclusion = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    included: Schema.optionalKey(Schema.Array(Schema.String)),
    missing: Schema.optionalKey(Schema.Array(Schema.String)),
    unresolved: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decodeExportInclusion = Schema.decodeUnknownSync(RawExportInclusion);
const encodeExportInclusionRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ packPath: Schema.String, checks: Schema.Array(Schema.String) }),
  ),
);
const decodeAssetsInspectInput = Schema.decodeUnknownEffect(GameAssetsInspectInput);
const decodeAssetsInspectResult = Schema.decodeUnknownEffect(GameAssetsInspectResult);
const decodeFramesResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      animations: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            frames: Schema.Number,
            fps: Schema.Number,
            loop: Schema.Boolean,
          }),
        ),
      ),
      error: Schema.optionalKey(Schema.String),
      reused: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const encodeFramesRequest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      imageResPath: Schema.String,
      existingPath: Schema.String,
      tileWidth: Schema.Number,
      tileHeight: Schema.Number,
      columns: Schema.Number,
      rows: Schema.Number,
      tileCount: Schema.Number,
      margin: Schema.Number,
      spacing: Schema.Number,
      animations: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          cells: Schema.Array(Schema.Struct({ col: Schema.Number, row: Schema.Number })),
          fps: Schema.Number,
          loop: Schema.Boolean,
        }),
      ),
      outputPath: Schema.String,
    }),
  ),
);
const decodeText = <A>(decode: (text: string) => A, text: string | null): A | null => {
  if (text === null) return null;
  try {
    return decode(text);
  } catch {
    return null;
  }
};
const isGameOperationError = Schema.is(GameOperationError);
const encodeEvidenceJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decodeStagedJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Staged-document check: the .gltf parses, names only files the plan pinned,
 * and reads through the upstream glTF SDK with its buffers. A malformed
 * document throws before anything publishes; the caller maps it onto the
 * error channel.
 */
const checkStagedGltf = async (
  stagingDir: string,
  mainPath: string,
  plannedPaths: ReadonlySet<string>,
): Promise<void> => {
  const text = await NodeFSP.readFile(NodePath.join(stagingDir, mainPath), "utf8");
  const decoded = decodeStagedJson(text);
  if (!isRecord(decoded)) throw new Error("no glTF document");
  if (!isRecord(decoded.asset) || typeof decoded.asset.version !== "string")
    throw new Error("no asset version");
  const uris = new Set<string>();
  const images = Array.isArray(decoded.images) ? decoded.images : [];
  for (const image of images) {
    if (isRecord(image) && typeof image.uri === "string") uris.add(image.uri);
  }
  const buffers = Array.isArray(decoded.buffers) ? decoded.buffers : [];
  for (const buffer of buffers) {
    if (isRecord(buffer) && typeof buffer.uri === "string") uris.add(buffer.uri);
  }
  const mainDir = mainPath.includes("/") ? mainPath.slice(0, mainPath.lastIndexOf("/") + 1) : "";
  for (const uri of uris) {
    if (uri.startsWith("data:") || /^[a-z]+:\/\//i.test(uri)) continue;
    const resolved = mainDir + uri;
    if (!plannedPaths.has(resolved) && !plannedPaths.has(uri))
      throw new Error(`references unpinned '${uri}'`);
  }
  // The SDK reads the staged file with its external buffers: malformed
  // accessors, views or buffers throw here instead of publishing.
  const buffersDef = Array.isArray(decoded.buffers) ? decoded.buffers : [];
  const viewsDef = Array.isArray((decoded as Record<string, unknown>).bufferViews)
    ? ((decoded as Record<string, unknown>).bufferViews as Array<unknown>)
    : [];
  const accessorsDef = Array.isArray((decoded as Record<string, unknown>).accessors)
    ? ((decoded as Record<string, unknown>).accessors as Array<unknown>)
    : [];
  const COMPONENT_TYPES = new Set([5120, 5121, 5122, 5123, 5125, 5126]);
  const ACCESSOR_TYPES = new Set(["SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4"]);
  for (const entry of buffersDef) {
    if (!isRecord(entry)) throw new Error("malformed buffer");
    const byteLength = entry.byteLength;
    if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength <= 0)
      throw new Error("malformed buffer");
    if (
      typeof entry.uri === "string" &&
      !entry.uri.startsWith("data:") &&
      !/^[a-z]+:\/\//i.test(entry.uri)
    ) {
      const resolved = mainDir + entry.uri;
      const staged = NodePath.join(stagingDir, resolved);
      const stat = await NodeFSP.stat(staged).catch(() => null);
      if (stat === null || !stat.isFile() || stat.size !== byteLength)
        throw new Error(`buffer '${entry.uri}' does not match its pinned bytes`);
    }
  }
  for (const [index, entry] of viewsDef.entries()) {
    if (!isRecord(entry)) throw new Error(`malformed bufferView ${index}`);
    const buffer = entry.buffer;
    const byteLength = entry.byteLength;
    const byteOffset = entry.byteOffset ?? 0;
    if (
      typeof buffer !== "number" ||
      !Number.isInteger(buffer) ||
      buffer < 0 ||
      buffer >= buffersDef.length
    )
      throw new Error(`malformed bufferView ${index}`);
    if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength <= 0)
      throw new Error(`malformed bufferView ${index}`);
    if (typeof byteOffset !== "number" || !Number.isInteger(byteOffset) || byteOffset < 0)
      throw new Error(`malformed bufferView ${index}`);
  }
  for (const [index, entry] of accessorsDef.entries()) {
    if (!isRecord(entry)) throw new Error(`malformed accessor ${index}`);
    const count = entry.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0)
      throw new Error(`malformed accessor ${index}`);
    if (!COMPONENT_TYPES.has(entry.componentType as number))
      throw new Error(`malformed accessor ${index}`);
    if (!ACCESSOR_TYPES.has(entry.type as string)) throw new Error(`malformed accessor ${index}`);
    if (entry.bufferView !== undefined) {
      const view = entry.bufferView;
      if (
        typeof view !== "number" ||
        !Number.isInteger(view) ||
        view < 0 ||
        view >= viewsDef.length
      )
        throw new Error(`malformed accessor ${index}`);
    }
  }
  const document = await new NodeIO().read(NodePath.join(stagingDir, mainPath));
  const root = document.getRoot();
  for (const accessor of root.listAccessors()) {
    const count = accessor.getCount();
    if (!Number.isInteger(count) || count <= 0)
      throw new Error(`malformed accessor '${accessor.getName()}'`);
    if (accessor.getBuffer() === null)
      throw new Error(`accessor '${accessor.getName()}' has no buffer`);
    if (accessor.getByteLength() <= 0)
      throw new Error(`malformed accessor '${accessor.getName()}'`);
  }
};

/**
 * Judges one export against the game's shared art profile. The profile stays
 * small on purpose: palette roles, a standing height and the bottom-centre
 * origin convention. Everything here is a warning for iteration, never a
 * verdict on quality.
 */
const profileWarnings = (
  profile:
    | {
        readonly palette?: ReadonlyArray<string> | undefined;
        readonly targetHeight?: number | undefined;
      }
    | undefined,
  metadata: {
    readonly dimensions: ReadonlyArray<number>;
    readonly originOffset: ReadonlyArray<number>;
    readonly materialDetails: ReadonlyArray<{ readonly name: string }>;
  },
): Array<string> => {
  if (profile === undefined) return [];
  const warnings: Array<string> = [];
  if (profile.targetHeight !== undefined) {
    const height = metadata.dimensions[2] ?? 0;
    if (height > 0) {
      const drift = Math.abs(height - profile.targetHeight) / profile.targetHeight;
      if (drift > 0.2)
        warnings.push(
          `The asset stands ${height.toFixed(2)}m tall, ${(drift * 100).toFixed(0)}% past the ${profile.targetHeight}m profile target; scale it toward the target so the set reads at one scale.`,
        );
    }
  }
  if (profile.palette !== undefined && profile.palette.length > 0) {
    const expected = new Set(
      profile.palette.map((hex) => `StudioPalette_${hex.replace(/^#/, "").toLowerCase()}`),
    );
    const outside = metadata.materialDetails
      .map((material) => material.name)
      .filter((name) => !expected.has(name));
    if (outside.length > 0)
      warnings.push(
        `Materials outside the game palette: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""}. Assign a StudioPalette_* material so the set shares its colours.`,
      );
  }
  const [x = 0, y = 0, z = 0] = metadata.originOffset;
  if (Math.hypot(x, y) > 0.25 || Math.abs(z) > 0.05)
    warnings.push(
      `The mesh bottom-centre sits [${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}]m from the world origin; move it to the origin so the asset stands on the ground where placed.`,
    );
  return warnings;
};
const verifyInputIssues = (input: GameVerifyInput): readonly string[] => {
  const issues = [...playtestInputIssues(input)];
  if (!(input.steps ?? []).some(isGameplayInputStep))
    issues.push(
      "Provide at least one real input step (press, hold, key, keys, click, drag or mouseMove). Waits and screenshots cannot prove the game responds, and game_submit needs a playtest that dispatched input.",
    );
  // The tool schema omits exactSize, but direct and legacy callers can still
  // send it; recording it would silently change the capture they asked for.
  if ("exactSize" in input && input.exactSize === true)
    issues.push(
      "game_verify records the build's playtest, so exactSize is not accepted here; use game_web_playtest for a review-only layout capture.",
    );
  return issues;
};
const playtestCapture = (
  baseViewport: { readonly width: number; readonly height: number },
  input: GameWebPlaytestInput,
) =>
  input.exactSize === true && input.width !== undefined && input.height !== undefined
    ? { width: input.width, height: input.height, scale: 1 }
    : integerScaledCapture(baseViewport, {
        width: input.width ?? PLAYTEST_DEFAULT_CAPTURE.width,
        height: input.height ?? PLAYTEST_DEFAULT_CAPTURE.height,
      });
const captureIssue = (baseViewport: { readonly width: number; readonly height: number }) =>
  `The game's base viewport (${baseViewport.width}×${baseViewport.height}) does not fit the capture bounds (${GAME_PLAYTEST_BOUNDS.minDimension}–${GAME_PLAYTEST_BOUNDS.maxDimension} px). Change display/window/size in project.godot first.`;
const pointerIssues = (
  input: GameWebPlaytestInput,
  capture: { readonly width: number; readonly height: number },
): readonly string[] => {
  const issues: string[] = [];
  for (const [index, step] of (input.steps ?? []).entries()) {
    const points = "drag" in step ? [step.drag.from, step.drag.to] : "click" in step ? [step] : [];
    if (
      points.some(
        (point) =>
          (point.x !== undefined && (point.x < 0 || point.x > capture.width)) ||
          (point.y !== undefined && (point.y < 0 || point.y > capture.height)),
      )
    )
      issues.push(
        `Step ${index + 1} pointer coordinates exceed the frozen ${capture.width}×${capture.height} viewport.`,
      );
  }
  return issues;
};
const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const gameEngine = yield* GameEngine.GameEngine;
  const preview = yield* GamePreview.GamePreview;
  const browser = yield* PreviewBrowser.PreviewBrowser;
  // GAME operations join the same managed install with bounded extra waits.
  const previewBrowserExecutable = withPreviewBrowserInstallRetries(browser.executable);
  const qualification = yield* GameQualification.GameQualification;
  const rounds = yield* GameRoundStore.GameRoundStore;
  const admission = yield* GameAdmission.GameAdmission;
  const artKits = yield* GameArtKits.GameArtKits;
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const designApprovals = yield* GameDesignApproval.GameDesignApproval;
  const playtest = yield* GameWebPlaytest.GamePlaytest;
  const explore = yield* GameExploreBrowser.GameExploreBrowser;
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
   * `success`, the Godot check uses `ok`, and a round transition that refuses at
   * commit returns `kind: "blocked"`. The shared operation state has to see all
   * of them, or a refused promotion announces success to the stage.
   */
  const operationFailed = (result: unknown): boolean => {
    if (typeof result !== "object" || result === null) return false;
    if ("success" in result && result.success === false) return true;
    if ("ok" in result && result.ok === false) return true;
    if ("kind" in result && result.kind === "blocked") return true;
    return false;
  };
  /**
   * The honest message for a finished operation. A blocked round transition has
   * no `message`; its `detail` is the only account of why it refused, and the
   * stage must show that instead of "completed".
   */
  const operationMessage = (result: unknown, name: string): string => {
    if (typeof result !== "object" || result === null) return `${name} completed.`;
    if ("kind" in result && result.kind === "blocked")
      return "detail" in result ? String(result.detail) : `${name} was blocked.`;
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
  /**
   * Qualification says the export matches the sources and its artifact files;
   * the read verifies both, so anything else forces a rebuild.
   */
  const webBuildIsCurrent = (read: GameQualificationRead) =>
    Effect.sync(() => isWebBuildFresh(read));
  /**
   * Qualification is a server-owned record written from actual operation
   * results. Failing to persist it must not turn a real build into a crash; the
   * missing stage leaves the game uncertified either way.
   */
  const recordQualification = (root: string, input: GameQualification.QualificationRecordInput) =>
    qualification.record(root, input).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          Effect.logWarning("Could not write the game qualification record.", {
            operation: error.operation,
            reason: error.reason,
          }),
      }),
    );
  type StageOutcome = Omit<GameQualification.QualificationRecordInput, "stage">;
  const interruptedOutcome = (operation: string): StageOutcome => ({
    outcome: "cancelled",
    sourceId: null,
    buildId: null,
    evidenceDirectory: null,
    detail: `The ${operation} was cancelled before it finished.`,
  });
  const failedOutcome = (
    exit: Exit.Exit<unknown, GameOperationError>,
    operation: string,
  ): StageOutcome => {
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return interruptedOutcome(operation);
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error))
        return {
          outcome: "failed",
          sourceId: null,
          buildId: null,
          evidenceDirectory: null,
          detail: error.value.message,
        };
    }
    return {
      outcome: "unknown",
      sourceId: null,
      buildId: null,
      evidenceDirectory: null,
      detail: `The ${operation} ended without a result that can be trusted.`,
    };
  };
  /**
   * Owns one qualification attempt. The stage is removed before the work runs,
   * so an interruption, defect or failed terminal write leaves it missing
   * instead of readable as the previous pass; every exit then records an honest
   * outcome through finalization rather than only the returned results.
   */
  const ownStage = <A>(
    root: string,
    stage: GameQualification.StoredQualificationStage,
    operation: string,
    work: Effect.Effect<{ readonly value: A; readonly record: StageOutcome }, GameOperationError>,
  ): Effect.Effect<A, GameOperationError> =>
    Effect.gen(function* () {
      yield* qualification.begin(root, stage);
      const completed = yield* work.pipe(
        Effect.onExit((exit) =>
          recordQualification(root, {
            stage,
            ...(Exit.isSuccess(exit) ? exit.value.record : failedOutcome(exit, operation)),
          }),
        ),
      );
      return completed.value;
    });

  /**
   * An isolated experiment returns the same result shape without owning the
   * qualification stage: it is reviewer evidence, not the game's record.
   */
  const stageOrRun = <A>(
    root: string,
    stage: GameQualification.StoredQualificationStage,
    operation: string,
    work: Effect.Effect<{ readonly value: A; readonly record: StageOutcome }, GameOperationError>,
    writeStage: boolean,
  ): Effect.Effect<A, GameOperationError> =>
    writeStage
      ? ownStage(root, stage, operation, work)
      : work.pipe(Effect.map(({ value }) => value));

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
  /**
   * How a successful export relates to the selected build. `publish` makes it
   * the one Play serves; `candidate` is a round's challenger and must not
   * disturb Play while it is reviewed.
   */
  type ExportSelection =
    | { readonly mode: "publish" }
    | { readonly mode: "candidate"; readonly roundId: string };

  const runExport = Effect.fnUntraced(function* (
    root: string,
    target: "Web" | "Linux" | "Windows",
    selection: ExportSelection,
  ) {
    const { backend, godot, cwd, godotProject } = yield* engine(root);
    const failedExport = (sourceId: string | null, detail?: string): StageOutcome => ({
      outcome: "failed",
      sourceId,
      buildId: null,
      evidenceDirectory: null,
      ...(detail === undefined ? {} : { detail }),
    });
    const toolStatus = yield* tools.status;
    const engineStatus = toolStatus.tools.find((tool) => tool.tool === "godot");
    if (!engineStatus?.ready)
      return yield* new GameOperationError({
        operation: "Godot export",
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
        operation: "Godot Windows export",
        path: godot.templates ?? godot.path,
        reason: "templates-missing",
        detail: `Windows x86_64 export templates for Godot ${godot.version} are missing from ${godot.templates ?? "the template directory"}. Ask the user to run Install tools in Settings > General > Game tools to add them; the Godot binary and the Web/Linux templates are reused as they are. Godot executable: ${godot.path}.`,
      });
    // Import first: Godot's import writes engine-generated sidecars (*.import,
    // *.uid and .godot/) inside the project. The source identity is taken after
    // that import and never counts those files, so a fresh or repaired tree
    // imports cleanly and a snapshot never carries engine output.
    const imported = yield* importGame(root);
    if (!imported.success) return { value: imported, record: failedExport(null) };
    // The preset is part of the exported sources, so it is settled before the
    // source identity is taken. Only a Windows export touches it.
    const windowsPreset =
      target === "Windows"
        ? yield* ensureWindowsPreset(NodePath.join(cwd, "export_presets.cfg"))
        : null;
    const frozen = target === "Web" ? yield* rounds.freeze(root) : null;
    // Web exports stage in a hidden directory under the candidate root, never in
    // the served tree. A partial or failed export therefore cannot change what
    // Play loads; only a complete, hashed artifact is moved into place.
    const staging =
      target === "Web"
        ? NodePath.join(root, CANDIDATE_BUILDS_DIRECTORY, `.staging-${NodeCrypto.randomUUID()}`)
        : null;
    // The stored snapshot is immutable. The frozen import and export run on a
    // private copy of it, so a reused snapshot never keeps engine sidecars.
    const sourceStaging =
      frozen === null
        ? null
        : NodePath.join(
            root,
            CANDIDATE_BUILDS_DIRECTORY,
            `.staging-${NodeCrypto.randomUUID()}-source`,
          );
    const frozenProject =
      sourceStaging === null ? null : NodePath.join(sourceStaging, godotProject);
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
        if (sourceStaging !== null)
          await NodeFSP.rm(sourceStaging, { recursive: true, force: true });
        if (windowsStaging !== null) {
          await NodeFSP.rm(windowsStaging, { force: true });
          await NodeFSP.rm(windowsStaging.replace(/\.exe$/, ".pck"), { force: true });
        }
      }),
    );
    return yield* Effect.gen(function* () {
      if (frozen !== null && sourceStaging !== null) {
        yield* Effect.tryPromise({
          try: () =>
            NodeFSP.cp(NodePath.join(frozen.directory, "files"), sourceStaging, {
              recursive: true,
            }),
          catch: (cause) =>
            new GameOperationError({
              operation: "export",
              path: sourceStaging,
              reason: "io",
              detail: "The frozen export copy could not be made.",
              cause,
            }),
        });
        // The copy has no import cache (.godot/ is generated and excluded), so
        // it is imported before the export reads it.
        const frozenImport = yield* importGame(root, frozenProject!);
        if (!frozenImport.success)
          return { value: frozenImport, record: failedExport(frozen.sourceId) };
      }
      const before = frozen === null ? yield* snapshot(root, godotProject) : null;
      const beforeSourceId =
        frozen?.sourceId ?? (before !== null && before.kind === "known" ? before.sourceId : null);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(exportOutput), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "export", path: exportOutput, reason: "io", cause }),
      });
      const exportPresetName = windowsPreset?.name ?? target;
      const exportResult = yield* backend.runExportRelease(
        {
          root,
          projectDir: frozenProject ?? cwd,
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
      if (!result.success) return { value: result, record: failedExport(beforeSourceId) };
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of target === "Web"
            ? [
                output,
                output.replace(/\.html$/, ".wasm"),
                output.replace(/\.html$/, ".js"),
                output.replace(/\.html$/, ".pck"),
              ]
            : [exportOutput]) {
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
            value: {
              ...result,
              success: false,
              message:
                `The Windows export did not produce a usable x86_64 executable with the game's pack: ${inspection.issues.join(" ")}\n${commandDetail(result.process!)}`.slice(
                  -4096,
                ),
            },
            record: failedExport(beforeSourceId),
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
          value: result,
          record: failedExport(
            beforeSourceId,
            "The exported web build directory could not be read back.",
          ),
        };
      // The frozen copy is the export input; prove it still hashes to the
      // manifest the candidate will name before sealing the artifact. The
      // editable folder is checked too: an edit during the export means the
      // build no longer describes the current game.
      const afterSourceId = frozen === null ? null : yield* rounds.sourceId(root);
      const frozenSourceId = frozen === null ? null : yield* rounds.frozenSourceId(sourceStaging!);
      const comparison =
        frozen === null
          ? comparedSource(before!, yield* snapshot(root, godotProject), "export")
          : frozenSourceId !== frozen.sourceId
            ? {
                kind: "changed" as const,
                detail:
                  "The frozen export copy changed while the export ran; the build was not published.",
              }
            : afterSourceId !== frozen.sourceId
              ? {
                  kind: "changed" as const,
                  detail:
                    "The game folder changed during the export; the build was not published because it no longer describes the current sources.",
                }
              : { kind: "current" as const, sourceId: frozen.sourceId };
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      if (comparison.kind !== "current") {
        const detail = comparison.detail;
        return {
          value: {
            ...result,
            success: false,
            message: `${detail}\n${commandDetail(result.process!)}`.slice(-4096),
          },
          record: failedExport(beforeSourceId, detail),
        };
      }
      // Qualification identifies sources by the content-based BUILD-input
      // snapshot; the candidate's own record carries the full-tree byte identity.
      const legacyAfter = frozen === null ? null : yield* snapshot(root, godotProject);
      const qualificationSourceId =
        frozen === null
          ? comparison.sourceId
          : legacyAfter !== null && legacyAfter.kind === "known"
            ? legacyAfter.sourceId
            : null;
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
      // replaced .pck must force a rebuild before anyone plays it. Paths stay
      // game-relative so a legacy builds/web record reads the same way.
      const artifacts =
        directory === null
          ? null
          : yield* Effect.promise(() => describeWebArtifacts(root, directory));
      if (target === "Web" && (artifacts === null || hashed === null || directory === null))
        return {
          value: result,
          record: failedExport(
            beforeSourceId,
            "The exported web build directory could not be read back.",
          ),
        };
      if (hashed !== null && directory !== null) {
        // Round decisions use the byte manifest identity of the frozen input,
        // not a capture taken after the artifact was sealed.
        const roundSourceId = frozen?.sourceId ?? (yield* rounds.sourceId(root));
        const artifact = {
          buildId: hashed.buildId,
          directory,
          sourceId: roundSourceId,
          engine: "godot" as const,
          target: "Web" as const,
          entry: "index.html",
        };
        yield* rounds.recordExport(root, artifact);
        if (selection.mode === "candidate")
          yield* rounds.recordCandidate(root, selection.roundId, artifact);
        else yield* rounds.select(root, artifact);
        return {
          value: {
            ...result,
            path: NodePath.join(root, directory, "index.html"),
            message:
              selection.mode === "candidate"
                ? "Web game built as a candidate; Play keeps the selected build until the round promotes it."
                : WEB_READY_MESSAGE,
          },
          record: {
            outcome: "passed" as const,
            sourceId: qualificationSourceId,
            buildId: hashed.buildId,
            evidenceDirectory: null,
            artifacts: artifacts!,
            buildDirectory: directory,
          },
        };
      }
      return {
        value:
          windowsMessage === null
            ? result
            : { ...result, path: windowsOutput ?? result.path, message: windowsMessage },
        record: {
          outcome: "passed" as const,
          sourceId: comparison.sourceId,
          buildId: `${comparison.sourceId}:${finishedAt}`,
          evidenceDirectory: null,
        },
      };
    }).pipe(cleanedUp);
  });
  /** Unknown attribution is null, never a failed export. */
  const exporterRun = (threadId: ThreadId) =>
    projects.activeRun(threadId).pipe(Effect.catchCause(() => Effect.succeed(null)));
  /**
   * `runId` is the run whose tool call exported: a review may start only for
   * the run that produced the playable bytes, so the export names it.
   */
  const exportGame = (
    root: string,
    target: "Web" | "Linux" | "Windows",
    selection: ExportSelection,
    runId: string | null,
  ) =>
    target === "Web"
      ? ownStage(
          root,
          "export",
          "export",
          runExport(root, target, selection).pipe(
            Effect.map((completed) => ({
              ...completed,
              record: { ...completed.record, runId },
            })),
          ),
        )
      : runExport(root, target, selection).pipe(Effect.map((completed) => completed.value));

  /** The round currently repairing this game, if any. */
  const runningRound = (root: string) =>
    rounds
      .read(root)
      .pipe(
        Effect.map((state) => state.rounds.find((round) => round.status === "running") ?? null),
      );
  /**
   * Every export path uses this decision. While a round is open its export is
   * the challenger and must not replace the selected build; outside one, the
   * creator's export is a normal publish.
   */
  const exportSelection = (root: string): Effect.Effect<ExportSelection, GameOperationError> =>
    runningRound(root).pipe(
      Effect.map((active) =>
        active === null
          ? ({ mode: "publish" } as const)
          : ({ mode: "candidate", roundId: active.id } as const),
      ),
    );
  /**
   * The build Play should show: the selected one while its immutable directory
   * still hashes to its recorded id, otherwise a pre-change builds/web game, or
   * null when the game has never been built.
   */
  const selectedPreview = (root: string) =>
    Effect.gen(function* () {
      const state = yield* rounds.read(root);
      const selected = state.selected;
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
      const exported = yield* exportGame(root, "Web", { mode: "publish" }, null);
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
  /**
   * Starts the native game. `display` is the caller's claim: the creator's Play
   * may watch it on their own desktop, while every agent-facing run is headless.
   */
  const nativeGame = (root: string, display: "headless" | "inherit") =>
    Effect.gen(function* () {
      if (processes.list(root).some((entry) => entry.operation === "native"))
        return yield* new GameOperationError({
          operation: "native",
          path: root,
          reason: "busy",
        });
      const { godot, cwd } = yield* engine(root);
      const imported = yield* importGame(root);
      if (!imported.success) return imported;
      const launched = yield* processes.start({
        root,
        executable: godot.path,
        // Godot 4 needs the headless display driver, not merely an unset
        // DISPLAY: without it a windowed run fails to initialize offscreen.
        // Only the creator's own Play asks to inherit the display.
        args: display === "headless" ? ["--headless", "--path", cwd] : ["--path", cwd],
        operation: "native",
        display,
        timeoutMs: 24 * 60 * 60_000,
      });
      return {
        success: true,
        message: `Native game started with PID ${launched.pid}. Output: ${launched.logPath}`,
        path: launched.logPath,
        url: null,
        process: null,
      };
    });

  interface WebPlaytestOptions {
    readonly buildId?: string;
    /** An isolated input experiment outside the game folder; never records the playtest. */
    readonly experimentDirectory?: string;
    /** A server-allocated, game-relative folder for review-only exact-window evidence. */
    readonly reviewEvidenceDirectory?: string;
    readonly imageResponse?: "persisted";
    /**
     * INTERNAL experiment-only capture boundary (see GameWebPlaytestInput).
     * Restricted to isolated experiments; never set for normal qualification
     * or public verify.
     */
    readonly captureFromStep?: number;
  }
  const webPlaytest = (
    root: string,
    input: GameWebPlaytestInput,
    runId: string | null,
    options: WebPlaytestOptions = {},
  ) =>
    Effect.gen(function* () {
      const { buildId, experimentDirectory, imageResponse, captureFromStep } = options;
      // Reject before exporting, serving, or launching the browser: a bad capture
      // request must not cost a build or hold the game's operation lock.
      if (captureFromStep !== undefined) {
        if (experimentDirectory === undefined)
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: "captureFromStep is an internal experiment-only option.",
          });
        const fullSteps = input.steps ?? [];
        if (
          !Number.isInteger(captureFromStep) ||
          captureFromStep < 0 ||
          captureFromStep > fullSteps.length
        )
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: `captureFromStep ${String(captureFromStep)} is outside the route of ${fullSteps.length} steps.`,
          });
        const setup = fullSteps.slice(0, captureFromStep);
        const observed = fullSteps.slice(captureFromStep);
        const issues = tryInputIssues({
          setupSteps: [...setup],
          steps: [...observed],
          ...(input.captureEveryMs === undefined ? {} : { captureEveryMs: input.captureEveryMs }),
        });
        if (issues.length > 0)
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: issues.join("\n"),
          });
      } else {
        const issues = playtestInputIssues(input);
        if (issues.length > 0)
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: issues.join("\n"),
          });
      }
      if (experimentDirectory !== undefined) {
        const isolated = NodePath.resolve(experimentDirectory);
        const gameRoot = NodePath.resolve(root);
        if (isolated === gameRoot || isolated.startsWith(`${gameRoot}${NodePath.sep}`))
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: "An isolated input experiment must write outside the game folder.",
          });
        if (buildId === undefined)
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: "An isolated input experiment must name a recorded build.",
          });
      }
      const reviewRoot =
        options.reviewEvidenceDirectory === undefined
          ? null
          : NodePath.resolve(root, options.reviewEvidenceDirectory);
      if (reviewRoot !== null) {
        const gameRoot = NodePath.resolve(root);
        if (reviewRoot === gameRoot || !reviewRoot.startsWith(`${gameRoot}${NodePath.sep}`))
          return yield* new GameOperationError({
            operation: "Web playtest",
            path: root,
            reason: "invalid-input",
            detail: "Exact-window evidence must stay inside the game's evidence folder.",
          });
      }
      // Evidence-only runs keep the game's qualification stage, selected build
      // and recorded playtest untouched.
      const evidenceOnly = experimentDirectory !== undefined || reviewRoot !== null;
      return yield* stageOrRun(
        root,
        "playtest",
        "playtest",
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          const recorded = buildId === undefined ? null : yield* rounds.exported(root, buildId);
          if (buildId !== undefined) {
            if (recorded === null)
              return yield* new GameOperationError({
                operation: "Web playtest",
                path: root,
                reason: "invalid-input",
                detail: `Build ${buildId} has no recorded source binding.`,
              });
            const actual = yield* Effect.promise(() =>
              hashWebBuild(root, recorded.artifact.directory),
            );
            if (actual?.buildId !== buildId)
              return yield* new GameOperationError({
                operation: "Web playtest",
                path: root,
                reason: "invalid-input",
                detail: `Build ${buildId} is missing or its bytes changed after export.`,
              });
          } else {
            const beforePlaytest = yield* qualification.read(root, manifest.godotProject);
            if (!(yield* webBuildIsCurrent(beforePlaytest))) {
              // Public exact-window evidence names no build and must never buy
              // one: exporting here would publish a build and rewrite the very
              // qualification and round records the run promises not to touch.
              if (reviewRoot !== null)
                return yield* new GameOperationError({
                  operation: "Web playtest",
                  path: root,
                  reason: "invalid-input",
                  detail:
                    "Exact-size review evidence needs a current Web export, and this game has none (it is missing, stale, or its files changed). Run game_export (or game_verify) to build the current sources, then retry game_web_playtest with exactSize.",
                });
              const exported = yield* exportGame(root, "Web", yield* exportSelection(root), runId);
              if (!exported.success)
                return yield* new GameOperationError({
                  operation: "Web playtest",
                  path: root,
                  reason: "command-failed",
                  detail: exported.message,
                });
            }
          }
          // Read the verification policy after the build gate: a refused
          // exact-window request must not adopt a policy record on its way out.
          const identity = yield* designApprovals.readPolicy(root, manifest);
          const build =
            recorded === null
              ? (yield* qualification.read(root, manifest.godotProject)).stages.find(
                  (stage) => stage.stage === "export",
                )
              : {
                  ...recorded.artifact,
                  buildDirectory: recorded.artifact.directory,
                  status: "passed" as const,
                };
          const url = yield* preview.open(root, build?.buildDirectory ?? WEB_BUILD_DIRECTORY);
          const executable = yield* previewBrowserExecutable.pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "Web playtest",
                  path: root,
                  reason: "tool-missing",
                  detail: `Game Studio's preview browser is not ready. ${cause.message} Once the install finishes, retry game_web_playtest.`,
                }),
            ),
          );
          // The exam this run is judged against, read before the run starts so a
          // mid-run approval change cannot swap the rules under the agent's feet.
          const designSnapshot = yield* designApprovals.snapshot(root, manifest);
          const approval = designSnapshot.read.state === "approved" ? designSnapshot.record : null;
          // The game keeps its own pixel grid: capture a whole-number multiple of
          // the project's base viewport that fits the requested box, so a 640×360
          // game is recorded in real pixels instead of letterboxed into a box.
          const playtestManifest =
            recorded === null
              ? manifest
              : yield* Effect.tryPromise({
                  try: async () =>
                    decodeGameManifest(
                      await NodeFSP.readFile(
                        NodePath.join(recorded.sourceDirectory, "game.json"),
                        "utf8",
                      ),
                    ),
                  catch: (cause) =>
                    new GameOperationError({
                      operation: "Web playtest",
                      path: root,
                      reason: "io",
                      detail: "The exported build's game manifest is unreadable.",
                      cause,
                    }),
                });
          const playtestBackend = yield* gameEngine.backendFor(playtestManifest.engine.name);
          const projectSettings = yield* Effect.tryPromise({
            try: () =>
              NodeFSP.readFile(
                NodePath.join(
                  recorded?.sourceDirectory ?? root,
                  playtestBackend.projectDirectory(playtestManifest),
                  playtestBackend.projectSettingsFile,
                ),
                "utf8",
              ),
            catch: (cause) =>
              new GameOperationError({
                operation: "Web playtest",
                path: NodePath.join(
                  root,
                  playtestBackend.projectDirectory(playtestManifest),
                  playtestBackend.projectSettingsFile,
                ),
                reason: "io",
                cause,
              }),
          });
          const baseViewport = playtestBackend.projectSettings(projectSettings).viewport;
          // The review's window-shape capture asks for the window a player gets,
          // not an integer multiple of the game's viewport: only a window whose
          // aspect differs can show letterboxing, clipping or overflow. It is
          // review evidence, so it can never become the build's playtest record.
          if (input.exactSize === true && !evidenceOnly)
            return yield* new GameOperationError({
              operation: "Web playtest",
              path: root,
              reason: "invalid-input",
              detail:
                "An exact-size window capture is review evidence; use game_web_playtest, which stores it as review evidence instead of recording it as the build's playtest.",
            });
          const capture = playtestCapture(baseViewport, input);
          if (capture === null)
            return yield* new GameOperationError({
              operation: "Web playtest",
              path: root,
              reason: "invalid-input",
              detail: captureIssue(baseViewport),
            });
          const outside = pointerIssues(input, capture);
          if (outside.length > 0)
            return yield* new GameOperationError({
              operation: "Web playtest",
              path: root,
              reason: "invalid-input",
              detail: outside.join("\n"),
            });
          const result = yield* playtest.run({
            executable,
            url,
            profileDirectory:
              experimentDirectory !== undefined
                ? NodePath.join(experimentDirectory, "profile")
                : reviewRoot !== null
                  ? NodePath.join(reviewRoot, "profile")
                  : NodePath.join(root, "builds/logs", `playtest-${NodeCrypto.randomUUID()}`),
            width: capture.width,
            height: capture.height,
            bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
            steps: input.steps ?? [],
            ...(input.captureEveryMs === undefined ? {} : { captureEveryMs: input.captureEveryMs }),
            ...(input.captureAllSteps === undefined
              ? {}
              : { captureAllSteps: input.captureAllSteps }),
            ...(captureFromStep === undefined ? {} : { captureFromStep }),
            probeRequired: identity.policy.probe,
            acceptance: approval?.acceptance ?? null,
          });
          // Informational only: which approved promises this run happened to show. It
          // never feeds qualification; the evaluator and the scenario runner do.
          const observations = satisfiedObservations(approval?.acceptance ?? [], result.state);
          const hasObservable = (approval?.acceptance ?? []).some(
            (criterion) => criterion.observe !== undefined,
          );
          const observationNote = hasObservable
            ? ` Design observations satisfied here: ${observations.length === 0 ? "none" : observations.join(", ")} (informational; the scenario stage gates).`
            : "";
          const qualifies = result.qualifies ?? false;
          const blockers = result.blockers ?? [];
          // A template game owes the probe it was created with. The verification
          // policy is server-owned, so deleting scripts/studio_probe.gd or editing
          // game.json cannot downgrade the playtest to the pixel rule.
          const probeRequired = identity.policy.probe;
          const missingProbe = probeRequired && result.state === null;
          const probesMissing = "StudioProbe missing — restore scripts/studio_probe.gd autoload";
          const budgeted = fitScreenshotsToBudget(result.screenshots);
          // The playtest stage shares attribution with the export stage: a
          // playtest of an exact recorded build names the sources that export
          // covered. The round store's artifact id is the byte manifest, a
          // different identity from the legacy source snapshot, so copying it
          // into qualification made every explicit-build playtest read stale.
          // A build the current export record no longer names has no honest
          // source binding here, so it stays unknown instead of borrowing the
          // editable folder's identity.
          const exportRecord =
            buildId === undefined ? null : yield* qualification.stageRecord(root, "export");
          const qualificationSourceId =
            build?.status !== "passed"
              ? null
              : buildId === undefined
                ? build.sourceId
                : exportRecord !== null &&
                    exportRecord.outcome === "passed" &&
                    exportRecord.buildId === buildId &&
                    exportRecord.sourceId !== null
                  ? exportRecord.sourceId
                  : null;
          const droppedFrames = budgeted.dropped.length;
          const enriched = {
            ...result,
            designObservations: observations,
            baseViewport,
            captureScale: capture.scale,
          };
          const evidence = yield* Effect.tryPromise({
            try: () =>
              writePlaytestEvidence({
                root,
                ...(experimentDirectory !== undefined
                  ? { directory: NodePath.join(experimentDirectory, "evidence") }
                  : reviewRoot !== null
                    ? { directory: NodePath.join(reviewRoot, "evidence") }
                    : {}),
                result: enriched,
                steps: input.steps ?? [],
              }),
            catch: (cause) =>
              new GameOperationError({
                operation: "Web playtest evidence",
                path:
                  experimentDirectory !== undefined
                    ? NodePath.join(experimentDirectory, "evidence")
                    : reviewRoot !== null
                      ? NodePath.join(reviewRoot, "evidence")
                      : NodePath.join(root, "builds/playtests"),
                reason: "io",
                cause,
              }),
          });
          // Review evidence is game-relative so the builder can find it beside
          // the build; an isolated experiment stays an absolute internal path.
          const evidenceLocation =
            reviewRoot === null ? evidence.directory : NodePath.relative(root, evidence.directory);
          // Budgeting can skip a large frame and keep a later one; paths use
          // original capture indices so they always name the matching pixels.
          const keptScreenshots =
            imageResponse === "persisted"
              ? []
              : budgeted.kept.map((shot) => ({
                  ...shot,
                  path: `${evidenceLocation}/${evidence.files[result.screenshots.indexOf(shot)]!}`,
                }));
          if (imageResponse !== "persisted" && input.captureAllSteps && droppedFrames > 0)
            return yield* new GameOperationError({
              operation: "game_try_input",
              path: root,
              reason: "invalid-input",
              detail: `Captured frames exceed the ${GAME_PLAYTEST_BOUNDS.maxResultImageBytes} byte response limit. All frames are stored in ${evidenceLocation}; shorten the route or increase captureEveryMs.`,
            });
          // An experiment or exact-window run is reviewer evidence, never the
          // game's playtest record: it must not replace the build binding a
          // submission uses.
          if (!evidenceOnly && build?.buildId !== null && build?.buildId !== undefined)
            yield* rounds.recordBuildPlaytest(root, build.buildId, {
              booted: result.booted,
              responded: result.responded,
              ...(result.executedInputSteps === undefined
                ? {}
                : { executedInputSteps: result.executedInputSteps }),
              consoleErrors:
                result.consoleErrorCount ??
                result.consoleMessages.filter((message) => message.level === "error").length,
              steps: input.steps ?? [],
              viewport: baseViewport,
              captureScale: capture.scale,
              qualifies,
              blockers: [...blockers],
              evidenceDirectory: evidenceLocation,
            });
          const framesNote =
            droppedFrames === 0
              ? ""
              : ` ${droppedFrames} frame(s) exceeded the ${GAME_PLAYTEST_BOUNDS.maxResultImageBytes / (1024 * 1024)} MB response budget; they stay in ${evidenceLocation}.`;
          const qualificationNote = qualifies
            ? ""
            : ` Qualification: this run does not count as honest gameplay evidence${
                blockers.length === 0 ? "" : `: ${blockers.join("; ")}`
              }.${missingProbe ? ` ${probesMissing}.` : ""}`;
          const reviewNote =
            reviewRoot === null
              ? ""
              : " Review evidence only: this exact-window run was not recorded as the build's playtest and did not change qualification.";
          return {
            value: {
              ...enriched,
              screenshots: keptScreenshots,
              message: `${result.message}${qualificationNote}${observationNote}${framesNote}${reviewNote}`,
              evidenceDirectory: evidenceLocation,
            },
            record: {
              outcome: qualifies ? ("passed" as const) : ("failed" as const),
              sourceId: qualificationSourceId,
              buildId: build?.status === "passed" ? build.buildId : null,
              evidenceDirectory: evidenceLocation,
              probeRequired,
              detail: missingProbe
                ? probesMissing
                : result.state === null
                  ? "No state probe in this game; the playtest was judged on input steps and a visible response."
                  : `Interaction: ${result.interaction}.`,
            },
          };
        }),
        !evidenceOnly,
      );
    });
  /**
   * Bounded persistent exploration. One live browser session exists globally:
   * a second start is busy until the first closes, because a 16 GB host
   * cannot hold two headless browsers beside the dev server. Sessions never
   * hold the game's operation lock while idle: each call resolves the
   * canonical root, checks its lease (root plus calling thread), and
   * serializes only with its own session lock, so an act, a close and an
   * idle expiry can never use a browser after it was closed.
   *
   * The browser stays paused between calls: game time advances only through
   * explicit `runFor` slices inside one act, and captures and probe reads cost
   * no game time. Every act releases its input before returning, so nothing
   * is ever held across calls. Observations are descriptive only: nothing
   * here writes qualification, selection or review records.
   */
  interface ExploreTraceAction {
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
    /** Native only: visible text keyed <owner>.<name>. */
    readonly screenText?: Record<string, string>;
    /** Native only: visible interactive controls. */
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
    /** Native only: script/engine errors since the previous act. */
    readonly errors?: ReadonlyArray<{ readonly message: string; readonly where: string }>;
    /** Native only: per ui step, whether the control received real mouse input. */
    readonly uiResults?: ReadonlyArray<{
      readonly id: string;
      readonly action: string;
      readonly received: boolean;
      readonly detail: string;
    }>;
    /** Native only: per inspect step, the read-only values observed. */
    readonly inspections?: ReadonlyArray<{
      readonly path: string;
      readonly values: Record<string, unknown>;
      readonly error?: string;
    }>;
    /** Native headless only: why this act has no persisted screenshot. */
    readonly screenshotReason?: string;
  }
  interface ExploreNativeConn {
    socket: NodeNet.Socket;
    lineState: GameExploreNative.NativeLineState;
    token: string;
    hasDisplay: boolean;
    pid: number;
    server: NodeNet.Server;
    nextId: number;
  }
  interface ExploreSession {
    readonly id: string;
    readonly root: string;
    readonly threadId: ThreadId;
    readonly target: "web" | "native";
    readonly buildId: string;
    readonly sourceId: string | null;
    readonly viewport: GameViewport;
    readonly baseViewport: GameViewport;
    readonly captureScale: number;
    /** Honest boot timing, frozen with the session. */
    readonly bootMs: number | null;
    readonly pauseConfirmed: boolean | null;
    readonly profileDir: string;
    readonly traceDir: string;
    readonly browser: GameExploreBrowser.ExploreBrowserHandle | null;
    readonly native: ExploreNativeConn | null;
    readonly lock: Semaphore.Semaphore;
    readonly createdMs: number;
    lastActiveMs: number;
    readonly wallDeadlineMs: number;
    calls: number;
    totalSteps: number;
    totalNominalMs: number;
    images: number;
    stepCounter: number;
    readonly actions: ExploreTraceAction[];
    traceTruncated: boolean;
    closed: boolean;
    closeReason: string | null;
    closedAt: string | null;
  }
  const exploreScratchBase = () => NodePath.join(NodeOS.tmpdir(), "game-explore");
  const exploreTraceFile = (id: string) => NodePath.join(exploreScratchBase(), id, "trace.json");
  const exploreInvalid = (path: string, detail: string) =>
    new GameOperationError({ operation: "Explore session", path, reason: "invalid-input", detail });
  const writeJsonAtomic = (file: string, value: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        try {
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- The trace is a schemaless server-owned scratch record; the replay validates its shape on read.
          await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
          await NodeFSP.rename(temporary, file);
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      },
      catch: (cause) =>
        new GameOperationError({ operation: "Explore session", path: file, reason: "io", cause }),
    });
  const exploreNominalMs = (steps: readonly GamePlaytestStep[]): number => {
    let total = 0;
    for (const step of steps) {
      if ("press" in step) total += 50;
      else if ("waitMs" in step) total += step.waitMs;
      else if ("holdMs" in step) total += step.holdMs;
    }
    return total;
  };
  const exploreFrozenPointerIssues = (
    steps: readonly GameExploreStep[],
    viewport: GameViewport,
  ): readonly string[] => {
    const issues: string[] = [];
    for (const [index, step] of steps.entries()) {
      const points =
        "drag" in step ? [step.drag.from, step.drag.to] : "click" in step ? [step] : [];
      if (
        points.some(
          (point) =>
            (point.x !== undefined && (point.x < 0 || point.x > viewport.width)) ||
            (point.y !== undefined && (point.y < 0 || point.y > viewport.height)),
        )
      )
        issues.push(
          `Step ${index + 1} pointer coordinates exceed the frozen ${viewport.width}×${viewport.height} viewport.`,
        );
    }
    return issues;
  };
  /** Shape checks for native-only steps. The tool schema enforces the same bounds; direct callers bypass it. */
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
  // One live session globally, plus the close summaries of recently closed
  // ones so a racing second close still answers. No session survives a server
  // restart: both maps live only in this process.
  const exploreStartLock = Semaphore.makeUnsafe(1);
  let exploreLive: ExploreSession | null = null;
  const exploreClosed = new Map<
    string,
    {
      readonly root: string;
      readonly threadId: ThreadId;
      readonly result: typeof GameExploreCloseResult.Type;
    }
  >();
  const exploreTraceOf = (session: ExploreSession) => ({
    version: 1 as const,
    sessionId: session.id,
    threadId: String(session.threadId),
    root: session.root,
    buildId: session.buildId,
    sourceId: session.sourceId,
    viewport: session.viewport,
    baseViewport: session.baseViewport,
    captureScale: session.captureScale,
    target: session.target,
    timing: (session.target === "native" ? "native-paused" : "controlled-clock") as
      | "controlled-clock"
      | "native-paused",
    boot: { booted: true, bootMs: session.bootMs, pauseConfirmed: session.pauseConfirmed },
    actions: session.actions.map((action) => ({ ...action })),
    totals: {
      calls: session.calls,
      steps: session.totalSteps,
      nominalMs: session.totalNominalMs,
      images: session.images,
    },
    traceTruncated: session.traceTruncated,
    closed:
      session.closeReason === null ? null : { reason: session.closeReason, at: session.closedAt },
  });
  const explorePersistTrace = (session: ExploreSession) =>
    Effect.gen(function* () {
      const trace = exploreTraceOf(session);
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- The trace is a schemaless server-owned scratch record; the replay validates its shape on read.
      let text = JSON.stringify(trace, null, 2);
      // The trace stays bounded: when a long session would overflow it, the
      // oldest per-act console text is dropped first and the drop is recorded.
      // Probe and step records are never trimmed, so the replay stays exact.
      let index = 0;
      while (
        Buffer.byteLength(text, "utf8") > GAME_EXPLORE_BOUNDS.maxTraceBytes &&
        index < session.actions.length
      ) {
        const action = session.actions[index]!;
        if (action.consoleMessages.length > 0 || action.consoleTruncated > 0) {
          session.actions[index] = {
            ...action,
            consoleMessages: [],
            consoleTruncated: action.consoleTruncated + action.consoleMessages.length,
          };
          session.traceTruncated = true;
          trace.actions[index] = { ...session.actions[index]! };
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- The trace is a schemaless server-owned scratch record; the replay validates its shape on read.
          text = JSON.stringify({ ...trace, traceTruncated: true }, null, 2);
        }
        index++;
      }
      if (Buffer.byteLength(text, "utf8") > GAME_EXPLORE_BOUNDS.maxTraceBytes) {
        return yield* exploreInvalid(
          session.traceDir,
          `The exploration trace would exceed its ${GAME_EXPLORE_BOUNDS.maxTraceBytes} byte bound; close the session and replay what was saved.`,
        );
      }
      // @effect-diagnostics-next-line preferSchemaOverJson:off -- The trace is a schemaless server-owned scratch record; the replay validates its shape on read.
      yield* writeJsonAtomic(NodePath.join(session.traceDir, "trace.json"), JSON.parse(text));
    });
  /**
   * Releases a session's player and scratch and saves its trace. The caller
   * holds the session lock; the transition is uninterruptible once it starts
   * so a cancelled close cannot leave a half-removed profile behind.
   */
  const exploreFinalize = (session: ExploreSession, reason: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (session.closed) return exploreClosed.get(session.id)?.result ?? null;
        session.closed = true;
        session.closeReason = reason;
        session.closedAt = DateTime.formatIso(yield* DateTime.now);
        if (session.browser !== null)
          yield* Effect.promise(() => session.browser!.close()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing an exploration browser failed.", {
                sessionId: session.id,
                cause,
              }),
            ),
          );
        if (session.native !== null)
          yield* closeNativeConn(session).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing a native exploration session failed.", {
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
        const persisted = yield* explorePersistTrace(session).pipe(Effect.result);
        if (Result.isFailure(persisted))
          yield* Effect.logWarning("Saving an exploration trace failed.", {
            sessionId: session.id,
          });
        if (exploreLive === session) exploreLive = null;
        const result = {
          sessionId: session.id,
          traceId: session.id,
          tracePath: NodePath.join(session.traceDir, "trace.json"),
          traceSaved: Result.isSuccess(persisted),
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
            `${session.totalNominalMs}ms nominal on build ${session.buildId.slice(0, 12)}. ` +
            (Result.isSuccess(persisted)
              ? `The trace is saved at ${NodePath.join(session.traceDir, "trace.json")}. Replay covers only successfully recorded actions. `
              : "Saving the trace failed; independent replay is unavailable. ") +
            `This session never qualified the build.`,
        } satisfies typeof GameExploreCloseResult.Type;
        exploreClosed.set(session.id, { root: session.root, threadId: session.threadId, result });
        if (exploreClosed.size > 20) {
          const oldest = exploreClosed.keys().next();
          if (!oldest.done) exploreClosed.delete(oldest.value);
        }
        return result;
      }),
    );
  /** Idle and wall-clock expiry sweep. One scoped fiber owns it; sessions never sleep in a caller. */
  const exploreReap = Effect.gen(function* () {
    const live = exploreLive;
    if (live === null || live.closed) return;
    yield* live.lock.withPermits(1)(
      Effect.gen(function* () {
        if (live.closed || exploreLive !== live) return;
        const now = yield* Clock.currentTimeMillis;
        if (now < live.wallDeadlineMs && now < live.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs)
          return;
        const reason = now >= live.wallDeadlineMs ? "wall-expired" : "idle-expired";
        yield* exploreFinalize(live, reason).pipe(Effect.ignore);
      }),
    );
  });
  const exploreLease = (session: ExploreSession, root: string, threadId: ThreadId) => {
    if (session.root !== root)
      return exploreInvalid(session.id, "That exploration session belongs to another game.");
    if (String(session.threadId) !== String(threadId))
      return exploreInvalid(
        session.id,
        "That exploration session belongs to another thread; only its own thread may act, close or replay it.",
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
      const manifest = yield* projects.read(root);
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
        baseViewport.width > GAME_PLAYTEST_BOUNDS.maxDimension ||
        baseViewport.height > GAME_PLAYTEST_BOUNDS.maxDimension ||
        baseViewport.width < GAME_PLAYTEST_BOUNDS.minDimension ||
        baseViewport.height < GAME_PLAYTEST_BOUNDS.minDimension
      )
        return yield* exploreInvalid(root, captureIssue(baseViewport));
      void manifest;
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
                `-screen 0 ${baseViewport.width}x${baseViewport.height}`,
                resolved.godot.path,
                ...godotArgs,
              ],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              ownedProcessGroup: true,
            })
          : processes.start({
              root,
              executable: resolved.godot.path,
              args: [...godotArgs],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              ownedProcessGroup: true,
            })
      ).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
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
                  detail: `The native game did not boot within ${bootTimeoutMs}ms; no exploration session was opened.`,
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
                // @effect-diagnostics-next-line preferSchemaOverJson:off -- The runner protocol is line-delimited JSON by design.
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
        target: "native",
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        baseViewport,
        captureScale: 1,
        bootMs,
        pauseConfirmed: true,
        profileDir,
        traceDir,
        browser: null,
        native: {
          socket: runnerSocket!,
          lineState,
          token,
          hasDisplay,
          pid: launched.pid,
          server,
          nextId: 1,
        },
        lock: Semaphore.makeUnsafe(1),
        createdMs: now,
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalSteps: 0,
        totalNominalMs: 0,
        images: 0,
        stepCounter: 0,
        actions: [],
        traceTruncated: false,
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
      exploreLive = live;
      yield* explorePersistTrace(live).pipe(
        Effect.onError(() => exploreFinalize(live, "trace-failed")),
      );
      const noPicture =
        " Runs headless without a picture (xvfb-run was not found on PATH): state, text, ui and errors stay available.";
      return {
        sessionId: id,
        traceId: id,
        target: "native" as const,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        baseViewport,
        captureScale: 1,
        booted: true,
        bootMs,
        pauseConfirmed: true,
        message:
          `Native exploration session ${id.slice(0, 8)} opened on the current sources ${before.sourceId.slice(0, 12)} ` +
          `at ${baseViewport.width}x${baseViewport.height} (paused between calls). ` +
          `Act with short input steps plus ui and inspect steps, then game_explore_close to save the trace and ` +
          `game_explore_replay for independent confirmation. ` +
          (hasDisplay ? "" : noPicture + " ") +
          `This session never qualifies, promotes or passes quality.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
    exploreStartLock.withPermits(1)(
      Effect.gen(function* () {
        if (exploreLive !== null)
          return yield* exploreInvalid(
            exploreLive.id,
            "Another exploration session is already open; close it with game_explore_close before starting a new one. Only one live exploration session exists per host.",
          );
        const issues = playtestInputIssues({
          ...(input.width === undefined ? {} : { width: input.width }),
          ...(input.height === undefined ? {} : { height: input.height }),
          ...(input.bootTimeoutMs === undefined ? {} : { bootTimeoutMs: input.bootTimeoutMs }),
          steps: [],
        });
        if (issues.length > 0) return yield* exploreInvalid("", issues.join("\n"));
        const root = yield* projects.resolve(threadId);
        yield* refuseWhileUnapproved(root, "explore");
        const target = input.target ?? "web";
        if (target === "native") return yield* exploreStartNative(threadId, root, input);
        const state = yield* rounds.read(root);
        const buildId = input.buildId ?? state.selected?.buildId ?? undefined;
        if (buildId === undefined)
          return yield* exploreInvalid(
            root,
            "No exported build is available. Export the game before exploring.",
          );
        const recorded = yield* rounds.exported(root, buildId);
        if (recorded === null)
          return yield* exploreInvalid(root, `Build ${buildId} has no recorded source binding.`);
        // The exact recorded bytes, verified before the browser launches: a
        // missing, replaced or extra file refuses instead of exploring a
        // different build. Nothing here re-exports, promotes or qualifies.
        const actual = yield* Effect.promise(() => hashWebBuild(root, recorded.artifact.directory));
        if (actual?.buildId !== buildId)
          return yield* exploreInvalid(
            root,
            `Build ${buildId} is missing or its bytes changed after export.`,
          );
        const manifest = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.readFile(NodePath.join(recorded.sourceDirectory, "game.json"), "utf8").then(
              decodeGameManifest,
            ),
          catch: (cause) =>
            new GameOperationError({
              operation: "Explore session",
              path: root,
              reason: "io",
              detail: "The exported build's game manifest is unreadable.",
              cause,
            }),
        });
        const projectGodot = yield* Effect.tryPromise({
          try: () =>
            NodeFSP.readFile(
              NodePath.join(recorded.sourceDirectory, manifest.godotProject, "project.godot"),
              "utf8",
            ),
          catch: (cause) =>
            new GameOperationError({
              operation: "Explore session",
              path: NodePath.join(root, manifest.godotProject, "project.godot"),
              reason: "io",
              cause,
            }),
        });
        const baseViewport = parseGodotViewport(projectGodot);
        const capture = playtestCapture(baseViewport, {
          ...(input.width === undefined ? {} : { width: input.width }),
          ...(input.height === undefined ? {} : { height: input.height }),
          steps: [],
        });
        if (capture === null) return yield* exploreInvalid(root, captureIssue(baseViewport));
        const url = yield* preview.open(root, recorded.artifact.directory);
        const executable = yield* previewBrowserExecutable.pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "tool-missing",
                detail: `Game Studio's preview browser is not ready. ${cause.message} Once the install finishes, retry game_explore_start.`,
              }),
          ),
        );
        const id = NodeCrypto.randomUUID();
        const traceDir = NodePath.join(exploreScratchBase(), id);
        const profileDir = NodePath.join(traceDir, "profile");
        const now = yield* Clock.currentTimeMillis;
        // An open that fails or races an abort must not leak its scratch:
        // the browser closes in the adapter, the profile here, on any exit
        // before the session registers.
        const dropScratch = Effect.promise(() =>
          NodeFSP.rm(traceDir, { recursive: true, force: true }),
        ).pipe(Effect.ignore);
        const opened = yield* Effect.tryPromise({
          try: (signal) =>
            (async () => {
              let result: Awaited<ReturnType<GameExploreBrowser.ExploreBrowserOpen>>;
              try {
                result = await explore.open(
                  {
                    executable,
                    url,
                    profileDirectory: profileDir,
                    width: capture.width,
                    height: capture.height,
                    bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
                  },
                  signal,
                );
              } catch (cause) {
                if (signal.aborted) await NodeFSP.rm(traceDir, { recursive: true, force: true });
                throw cause;
              }
              if (signal.aborted) {
                await result.handle.close().catch(() => undefined);
                await NodeFSP.rm(traceDir, { recursive: true, force: true });
                throw new Error("aborted");
              }
              if (!result.boot.booted) {
                await result.handle.close().catch(() => undefined);
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: `The game did not boot within ${input.bootTimeoutMs ?? 90_000}ms; no exploration session was opened.`,
                });
              }
              return result;
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
          Effect.tapError(() => dropScratch),
          Effect.onInterrupt(() => dropScratch),
        );
        const live: ExploreSession = {
          id,
          root,
          threadId,
          target: "web",
          buildId,
          sourceId: recorded.artifact.sourceId,
          viewport: { width: capture.width, height: capture.height },
          baseViewport,
          captureScale: capture.scale,
          bootMs: opened.boot.bootMs,
          pauseConfirmed: opened.boot.pauseConfirmed,
          profileDir,
          traceDir,
          browser: opened.handle,
          native: null,
          lock: Semaphore.makeUnsafe(1),
          createdMs: now,
          lastActiveMs: now,
          wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
          calls: 0,
          totalSteps: 0,
          totalNominalMs: 0,
          images: 0,
          stepCounter: 0,
          actions: [],
          traceTruncated: false,
          closed: false,
          closeReason: null,
          closedAt: null,
        };
        // The boot observation is evidence of what boot did, not a first act:
        // it carries no steps and costs no call budget.
        if (opened.boot.probe !== null || opened.boot.consoleMessages.length > 0) {
          live.actions.push({
            index: 0,
            steps: [],
            executedInputSteps: 0,
            nominalMs: 0,
            probe: opened.boot.probe,
            screenshot: "",
            consoleMessages: opened.boot.consoleMessages.slice(
              0,
              GAME_EXPLORE_BOUNDS.maxConsolePerAct,
            ),
            consoleTruncated: Math.max(
              0,
              opened.boot.consoleMessages.length - GAME_EXPLORE_BOUNDS.maxConsolePerAct,
            ),
          });
        }
        exploreLive = live;
        yield* explorePersistTrace(live).pipe(
          Effect.onError(() => exploreFinalize(live, "trace-failed")),
        );
        return {
          sessionId: id,
          traceId: id,
          target: "web" as const,
          buildId,
          sourceId: recorded.artifact.sourceId,
          viewport: { width: capture.width, height: capture.height },
          baseViewport,
          captureScale: capture.scale,
          booted: true,
          bootMs: opened.boot.bootMs,
          pauseConfirmed: opened.boot.pauseConfirmed,
          message:
            `Exploration session ${id.slice(0, 8)} opened on build ${buildId.slice(0, 12)} ` +
            `at ${capture.width}x${capture.height} (controlled clock, paused between calls). ` +
            `Act with short input steps, then game_explore_close to save the trace and ` +
            `game_explore_replay for independent confirmation. ` +
            `This session never qualifies, promotes or passes quality.`,
          callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
          wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
          idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
        } satisfies typeof GameExploreStartResult.Type;
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
                throw new Error("The native act timed out after 120s.");
              }
              if (line === null) throw new Error("The native session closed.");
              const text = String(line).trim();
              if (text === "") continue;
              let parsed: unknown = null;
              try {
                // @effect-diagnostics-next-line preferSchemaOverJson:off -- The runner protocol is line-delimited JSON by design.
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
      yield* explorePersistTrace(session).pipe(
        Effect.onError(() => exploreFinalize(session, "trace-failed")),
      );
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
  const exploreAct = (threadId: ThreadId, input: typeof GameExploreActInput.Type) =>
    Effect.gen(function* () {
      const session = exploreLive;
      if (session === null || session.id !== input.sessionId)
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
          `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and replay the trace.`,
        );
      const nominalMs =
        session.target === "native"
          ? GameExploreNative.exploreStepsNominalMs(input.steps)
          : exploreNominalMs([...input.steps] as GamePlaytestStep[]);
      if (!Number.isFinite(nominalMs) || nominalMs < 0)
        return yield* exploreInvalid(session.id, "The act has an invalid duration.");
      if (nominalMs > GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall)
        return yield* exploreInvalid(
          session.id,
          `The act lasts ${nominalMs}ms; one act may last at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall}ms.`,
        );
      const stepIssues = tryInputIssues({ steps: [...input.steps] as GamePlaytestStep[] });
      if (stepIssues.length > 0) return yield* exploreInvalid(session.id, stepIssues.join("\n"));
      if (session.target === "web") {
        const rejects = GameExploreNative.webRejectsForSteps(input.steps);
        if (rejects.length > 0) return yield* exploreInvalid(session.id, rejects.join("\n"));
      } else {
        const nativeIssues = exploreNativeStepIssues(input.steps);
        if (nativeIssues.length > 0)
          return yield* exploreInvalid(session.id, nativeIssues.join("\n"));
      }
      const outside = exploreFrozenPointerIssues(input.steps, session.viewport);
      if (outside.length > 0) return yield* exploreInvalid(session.id, outside.join("\n"));
      return yield* session.lock.withPermits(1)(
        Effect.gen(function* () {
          if (session.closed || exploreLive !== session)
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
              `That exploration session ${reason}; its trace was saved. Start a new one with game_explore_start.`,
            );
          }
          // Budgets are checked under the session lock so concurrent acts
          // cannot each pass before either one accounts for itself.
          if (session.calls >= GAME_EXPLORE_BOUNDS.maxCalls)
            return yield* exploreInvalid(
              session.id,
              `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and replay the trace.`,
            );
          if (session.totalSteps + input.steps.length > GAME_EXPLORE_BOUNDS.maxTotalSteps)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalSteps} total steps; close it and replay the trace.`,
            );
          if (session.totalNominalMs + nominalMs > GAME_EXPLORE_BOUNDS.maxTotalNominalMs)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalNominalMs}ms total nominal time; close it and replay the trace.`,
            );
          // Headless native acts persist no picture, so the image bound only
          // covers acts that actually keep one.
          const keepsImage =
            session.target === "web" || (session.native !== null && session.native.hasDisplay);
          if (keepsImage && session.images + 1 > GAME_EXPLORE_BOUNDS.maxImages)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxImages} persisted images; close it and replay the trace.`,
            );
          const callIndex = session.calls + 1;
          const firstStepIndex = session.stepCounter;
          session.calls = callIndex;
          session.totalSteps += input.steps.length;
          session.stepCounter += input.steps.length;
          if (session.target === "native")
            return yield* exploreActNative(session, input, callIndex, nominalMs);
          return yield* Effect.gen(function* () {
            const observation = yield* Effect.tryPromise({
              try: (signal) => session.browser!.act([...input.steps], firstStepIndex, signal),
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
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.gen(function* () {
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
                    })
                  : Effect.void,
              ),
            );
            const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
            yield* Effect.tryPromise({
              try: () =>
                NodeFSP.writeFile(
                  NodePath.join(session.traceDir, file),
                  Buffer.from(observation.screenshotData, "base64"),
                ),
              catch: (cause) =>
                new GameOperationError({
                  operation: "Explore session",
                  path: session.traceDir,
                  reason: "io",
                  cause,
                }),
            });
            const kept = observation.consoleMessages.slice(-GAME_EXPLORE_BOUNDS.maxConsolePerAct);
            const truncated =
              Math.max(0, observation.consoleMessages.length - kept.length) +
              (observation.consoleTruncated ?? 0);
            session.actions.push({
              index: callIndex,
              steps: [...input.steps],
              executedInputSteps: observation.executedInputSteps,
              nominalMs: observation.nominalMs,
              probe: observation.probe,
              screenshot: file,
              consoleMessages: kept.map((message) => ({
                level: message.level,
                text: message.text.slice(0, GAME_EXPLORE_BOUNDS.maxConsoleChars),
              })),
              consoleTruncated: truncated,
            });
            session.totalNominalMs += observation.nominalMs;
            session.images += 1;
            session.lastActiveMs = yield* Clock.currentTimeMillis;
            yield* explorePersistTrace(session).pipe(
              Effect.onError(() => exploreFinalize(session, "trace-failed")),
            );
            return {
              sessionId: session.id,
              callIndex,
              executedInputSteps: observation.executedInputSteps,
              nominalMs: observation.nominalMs,
              probe: observation.probe,
              screenshotPath: NodePath.join(session.traceDir, file),
              consoleMessages: kept,
              consoleTruncated: truncated,
              message:
                `Act ${callIndex} ran ${input.steps.length} step(s) ` +
                `(${observation.executedInputSteps} input, +${observation.nominalMs}ms nominal); ` +
                `${GAME_EXPLORE_BOUNDS.maxCalls - callIndex} act(s) left. ` +
                `This observation is descriptive only, never a verdict.`,
              callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
              totalNominalMs: session.totalNominalMs,
            } satisfies typeof GameExploreActResult.Type;
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !session.closed
                ? Effect.gen(function* () {
                    if (!session.actions.some((action) => action.index === callIndex))
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
                  })
                : Effect.void,
            ),
          );
        }),
      );
    });
  const exploreClose = (threadId: ThreadId, input: typeof GameExploreCloseInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const cached = exploreClosed.get(input.sessionId);
      const session = exploreLive;
      if (session === null || session.id !== input.sessionId) {
        if (cached !== undefined) {
          if (cached.root !== root || String(cached.threadId) !== String(threadId))
            return yield* exploreInvalid(
              input.sessionId,
              "That exploration session belongs to another game or thread.",
            );
          return cached.result;
        }
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; start a new one with game_explore_start.",
        );
      }
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
          const prior = exploreClosed.get(input.sessionId);
          if (prior !== undefined) return prior.result;
          return yield* exploreInvalid(
            input.sessionId,
            "That exploration session is closed or expired; start a new one with game_explore_start.",
          );
        }),
      );
    });
  /**
   * Replays a native trace against the current sources in a fresh ephemeral
   * session. The sources must still match the trace's source binding;
   * anything else refuses instead of replaying something else.
   */
  const exploreReplayNative = (
    threadId: ThreadId,
    root: string,
    traceRecord: { readonly sessionId: string; readonly sourceId: string | null },
    steps: readonly GameExploreStep[],
  ) =>
    Effect.gen(function* () {
      if (
        steps.length > GAME_EXPLORE_BOUNDS.maxTotalSteps ||
        GameExploreNative.exploreStepsNominalMs(steps) > GAME_EXPLORE_BOUNDS.maxTotalNominalMs
      )
        return yield* exploreInvalid(
          traceRecord.sessionId,
          "The trace exceeds exploration bounds.",
        );
      if (steps.length === 0)
        return yield* exploreInvalid(
          traceRecord.sessionId,
          "That exploration trace recorded no input steps to replay.",
        );
      const manifest = yield* projects.read(root);
      const current = yield* snapshot(root, manifest.godotProject);
      if (current.kind !== "known" || current.sourceId !== traceRecord.sourceId)
        return yield* exploreInvalid(
          traceRecord.sessionId,
          "The game sources changed after the trace; the trace cannot be replayed against them.",
        );
      const started = yield* exploreStartNative(threadId, root, { target: "native" });
      const actResults: Array<typeof GameExploreActResult.Type> = [];
      const closed = yield* Effect.gen(function* () {
        for (let offset = 0; offset < steps.length; offset += GAME_EXPLORE_BOUNDS.maxStepsPerCall) {
          const acted = yield* exploreAct(threadId, {
            sessionId: started.sessionId,
            steps: steps.slice(offset, offset + GAME_EXPLORE_BOUNDS.maxStepsPerCall),
          });
          actResults.push(acted);
        }
        return yield* exploreClose(threadId, { sessionId: started.sessionId });
      }).pipe(
        Effect.onExit(() =>
          Effect.gen(function* () {
            if (exploreLive !== null && exploreLive.id === started.sessionId)
              yield* exploreClose(threadId, { sessionId: started.sessionId }).pipe(Effect.ignore);
            else if (!exploreClosed.has(started.sessionId))
              yield* exploreClose(threadId, { sessionId: started.sessionId }).pipe(Effect.ignore);
          }),
        ),
      );
      const executed = actResults.reduce((sum, acted) => sum + acted.executedInputSteps, 0);
      const before = actResults.length > 0 ? (actResults[0]!.probe ?? null) : null;
      const after = actResults.length > 0 ? (actResults.at(-1)!.probe ?? null) : null;
      const playerMoved =
        before?.player !== null &&
        before?.player !== undefined &&
        after?.player !== null &&
        after?.player !== undefined
          ? Math.hypot(
              after.player.x - before.player.x,
              after.player.y - before.player.y,
              after.player.z - before.player.z,
            )
          : 0;
      const probeChanged =
        JSON.stringify(before?.gameState ?? null) !== JSON.stringify(after?.gameState ?? null);
      const uiReceived = actResults.some((acted) =>
        (acted.uiResults ?? []).some((result) => result.received),
      );
      const responded = executed > 0 && (probeChanged || playerMoved > 0 || uiReceived);
      const evidenceDirectory = NodePath.dirname(closed.tracePath);
      const frames: Array<typeof GameExploreReplayFrame.Type> = [];
      for (const [index, acted] of actResults.entries()) {
        if (acted.screenshotPath === null || acted.screenshotPath === undefined) continue;
        const bytes = yield* Effect.promise(() =>
          NodeFSP.readFile(acted.screenshotPath as string).catch(() => null),
        );
        if (bytes === null) continue;
        let size: { width: number; height: number } | null = null;
        try {
          size = GameWebPlaytest.decodePngSize(bytes);
        } catch {
          size = null;
        }
        if (size === null) continue;
        frames.push({
          label: `act-${index + 1}`,
          path: acted.screenshotPath,
          width: size.width,
          height: size.height,
          ...(acted.probe === null || acted.probe === undefined ? {} : { probe: acted.probe }),
        });
      }
      return {
        traceId: traceRecord.sessionId,
        buildId: started.buildId,
        evidenceDirectory,
        success: executed > 0,
        booted: true,
        responded,
        message:
          `Replay of native exploration ${traceRecord.sessionId} on sources ${started.buildId.slice(0, 12)}: ` +
          `${executed} input step(s) across ${actResults.length} act(s). ` +
          `This replay covers only the traced sequence; unexplored parts remain unknown.`,
        state: {
          before,
          after,
          playerMoved,
          changes: [],
        },
        consoleMessages: [],
        frames,
      } satisfies typeof GameExploreReplayResult.Type;
    });
  const exploreReplay = (threadId: ThreadId, input: typeof GameExploreReplayInput.Type) =>
    exploreStartLock.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        if (exploreLive !== null)
          return yield* exploreInvalid(
            input.traceId,
            "An exploration session is still open; close it with game_explore_close first. Replays run in a fresh player so the two never share memory.",
          );
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.traceId))
          return yield* exploreInvalid(input.traceId, "Unknown exploration trace id.");
        const trace = yield* Effect.tryPromise({
          try: async () => {
            const file = exploreTraceFile(input.traceId);
            const stat = await NodeFSP.lstat(file);
            if (!stat.isFile() || stat.size > GAME_EXPLORE_BOUNDS.maxTraceBytes)
              throw new Error("Trace is not a bounded regular file.");
            const text = await NodeFSP.readFile(file, "utf8");
            if (Buffer.byteLength(text, "utf8") > GAME_EXPLORE_BOUNDS.maxTraceBytes)
              throw new Error("Trace grew beyond its byte bound.");
            return text;
          },
          catch: () =>
            exploreInvalid(
              input.traceId,
              "That exploration trace is unavailable or exceeds its bounds.",
            ),
        });
        const traceRecord = yield* decodeExploreReplayTrace(trace).pipe(
          Effect.mapError(() =>
            exploreInvalid(input.traceId, "That exploration trace is incomplete or malformed."),
          ),
        );
        if (
          traceRecord.sessionId !== input.traceId ||
          traceRecord.root !== root ||
          traceRecord.threadId !== String(threadId)
        )
          return yield* exploreInvalid(
            input.traceId,
            "That exploration trace belongs to another game or thread.",
          );
        if (traceRecord.actions.some((action) => action.failure !== undefined))
          return yield* exploreInvalid(
            input.traceId,
            "An act failed or was interrupted with unknown partial execution; this trace cannot be replayed as an exact sequence. Start a new exploration.",
          );
        const viewport = traceRecord.viewport;
        const steps = traceRecord.actions.flatMap((action) => [...action.steps]);
        const traceTarget = traceRecord.target ?? "web";
        if (traceTarget === "native")
          return yield* exploreReplayNative(threadId, root, traceRecord, steps);
        if (
          steps.length > GAME_EXPLORE_BOUNDS.maxTotalSteps ||
          exploreNominalMs(steps as GamePlaytestStep[]) > GAME_EXPLORE_BOUNDS.maxTotalNominalMs
        )
          return yield* exploreInvalid(input.traceId, "The trace exceeds exploration bounds.");
        if (steps.length === 0)
          return yield* exploreInvalid(
            input.traceId,
            "That exploration trace recorded no input steps to replay.",
          );
        const buildId = traceRecord.buildId;
        // The same byte check as exploration: a missing or changed build
        // refuses instead of replaying something else, and never rebuilds.
        const recorded = yield* rounds.exported(root, buildId);
        if (recorded === null)
          return yield* exploreInvalid(root, `Build ${buildId} has no recorded source binding.`);
        if (recorded.artifact.sourceId !== traceRecord.sourceId)
          return yield* exploreInvalid(
            input.traceId,
            "The trace source binding no longer matches its recorded export.",
          );
        const actual = yield* Effect.promise(() => hashWebBuild(root, recorded.artifact.directory));
        if (actual?.buildId !== buildId)
          return yield* exploreInvalid(
            root,
            `Build ${buildId} is missing or its bytes changed after export; the trace cannot be replayed against it.`,
          );
        const replayDir = NodePath.join(
          exploreScratchBase(),
          `replay-${input.traceId}-${NodeCrypto.randomUUID()}`,
        );
        const played = yield* webPlaytest(
          root,
          {
            steps: steps as GamePlaytestStep[],
            width: viewport.width,
            height: viewport.height,
            exactSize: true,
          },
          null,
          { buildId, experimentDirectory: replayDir },
        );
        // Fresh evidence only: the trace's probe is never presented as
        // confirmation, and the message never claims more than the replay ran.
        const frames = played.screenshots.map((shot) => ({
          label: shot.label,
          ...(shot.path === undefined ? { path: "" } : { path: shot.path }),
          width: shot.width,
          height: shot.height,
          ...(shot.probe === undefined ? {} : { probe: shot.probe }),
        }));
        return {
          traceId: input.traceId,
          buildId,
          evidenceDirectory: played.evidenceDirectory ?? replayDir,
          success: played.success,
          booted: played.booted,
          responded: played.responded,
          message:
            `Replay of exploration ${input.traceId} on build ${buildId.slice(0, 12)}: ${played.message} ` +
            `This replay covers only the traced sequence; unexplored parts remain unknown.`,
          state: played.state,
          consoleMessages: played.consoleMessages,
          frames,
        } satisfies typeof GameExploreReplayResult.Type;
      }),
    );
  /** Imports first: a fresh game has no .godot cache, so .tres files and class_names cannot resolve. */
  const checkGame = (root: string) =>
    ownStage(
      root,
      "check",
      "check",
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const { backend, godot, cwd, godotProject } = yield* engine(root);
        const manifest = yield* projects.read(root);
        // The server-owned exam, never game.json: the agent can edit that file.
        const identity = yield* designApprovals.readPolicy(root, manifest);
        const gameplayScene = identity.policy.gameplayScene ?? "";
        // Import is cache preparation, not the check itself: Godot's import can
        // write sidecar files inside the project, so the inputs are read after it
        // and before the checking script runs.
        const imported = yield* importGame(root);
        const before = yield* snapshot(root, godotProject);
        return yield* Effect.gen(function* () {
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
          if (!imported.success && importedIssues.length === 0)
            errors.unshift({
              file: "godot/project.godot",
              message: `Import failed with exit code ${imported.process?.exitCode ?? -1}. ${imported.message}`,
            });
          if (reported === null)
            errors.unshift({
              file: "godot/project.godot",
              message:
                "The Godot check script did not report a result. The project may have crashed during startup.",
            });
          if (run.timedOut)
            errors.unshift({
              file: "godot/project.godot",
              message: "The Godot check timed out before finishing its physics frames.",
            });
          if (run.exitCode !== 0 && errors.length === 0)
            errors.unshift({
              file: "godot/project.godot",
              message: `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`,
            });
          // A game created before gameplay entries is checked as it always was, but
          // the warning says what the check did not cover rather than implying it did.
          const warnings = [
            ...(reported?.warnings ?? []),
            ...(identity.policy.gameplayScene === null
              ? [
                  {
                    file: "verification policy",
                    message:
                      "The verification policy declares no gameplay scene, so the check ran only the main scene (the menu); gameplay initialization was not exercised.",
                  },
                ]
              : []),
          ];
          const after = yield* snapshot(root, godotProject);
          const comparison = comparedSource(before, after, "check");
          if (comparison.kind !== "current")
            warnings.unshift({ file: "godot/", message: comparison.detail });
          const result = {
            ok: errors.length === 0 && reported !== null && !run.timedOut,
            errors: limitIssues(errors),
            warnings: limitIssues(warnings),
            entries: reported?.entries ?? [],
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          };
          return {
            value: result,
            record: {
              outcome: result.ok
                ? comparison.kind === "current"
                  ? ("passed" as const)
                  : ("unknown" as const)
                : ("failed" as const),
              sourceId: comparison.kind === "current" ? comparison.sourceId : null,
              buildId: null,
              evidenceDirectory: null,
              policyRevision: identity.revision,
              ...(comparison.kind === "current" ? {} : { detail: comparison.detail }),
            },
          };
        });
      }),
    );
  /**
   * Runs the agent-written routes under real physics and grades them against the
   * creator's approved observations. Routes are pure input data: this method
   * supplies the exam, the game supplies the answer.
   */
  const scenariosRun = (root: string) =>
    ownStage(
      root,
      "state",
      "scenarios",
      Effect.gen(function* () {
        const { backend, godot, cwd, godotProject } = yield* engine(root);
        if (!backend.capabilities.scenarios)
          return yield* new GameOperationError({
            operation: "godot-scenarios",
            path: root,
            reason: "invalid-input",
            detail: `The "${backend.id}" engine backend does not run the scenario exam.`,
          });
        const manifest = yield* projects.read(root);
        const identity = yield* designApprovals.readPolicy(root, manifest);
        const imported = yield* importGame(root);
        // Import may write sidecars inside the project; read the inputs after it
        // and before the scenario runners execute them.
        const sourceBefore = yield* snapshot(root, godotProject);
        const designSnapshot = yield* designApprovals.snapshot(root, manifest);
        const design = designSnapshot.read;
        const approval = designSnapshot.record;
        const mode: "criteria" | "legacy" | "none" =
          design.state === "approved" && approval !== null
            ? "criteria"
            : design.state === "legacy"
              ? "legacy"
              : "none";
        const criteria = mode === "criteria" && approval !== null ? approval.acceptance : [];
        const evidenceDirectory = NodePath.join(
          root,
          "builds/logs",
          `scenarios-${NodeCrypto.randomUUID()}`,
        );
        const evidenceReference = NodePath.relative(root, evidenceDirectory);
        const writeFailure = (errors: readonly string[]): GameScenariosRunResult => {
          const summary = evaluateScenarios({ mode, criteria, runs: [] });
          const failed = {
            ...summary,
            passed: false,
            reason: "scenario-failed" as const,
            detail: errors[0] ?? summary.detail,
          };
          return {
            ok: false,
            summary: failed,
            scenarios: [],
            errors: [...errors],
            evidenceDirectory: null,
          };
        };
        if (!imported.success) {
          const errors = [`The Godot import failed before the scenarios ran: ${imported.message}`];
          const failed = writeFailure(errors);
          return {
            value: failed,
            record: {
              outcome: "failed" as const,
              sourceId: sourceBefore.kind === "known" ? sourceBefore.sourceId : null,
              buildId: null,
              evidenceDirectory: null,
              designHash: approval?.designHash ?? null,
              criteria: failed.summary.criteria,
              ...(failed.summary.coverage === undefined
                ? {}
                : { coverage: failed.summary.coverage }),
              detail: failed.summary.detail,
            },
          };
        }
        const projectText = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(cwd, "project.godot"), "utf8").catch(() => ""),
        );
        const userDirIssues = userDirConfigIssues(projectText);
        if (userDirIssues.length > 0) {
          const failed = writeFailure(userDirIssues);
          return {
            value: failed,
            record: {
              outcome: "failed" as const,
              sourceId: sourceBefore.kind === "known" ? sourceBefore.sourceId : null,
              buildId: null,
              evidenceDirectory: null,
              designHash: approval?.designHash ?? null,
              criteria: failed.summary.criteria,
              ...(failed.summary.coverage === undefined
                ? {}
                : { coverage: failed.summary.coverage }),
              detail: failed.summary.detail,
            },
          };
        }
        const projectActions = parseProjectInputActions(projectText);
        const files = yield* Effect.promise(() => readScenarioFiles(cwd));
        const errors = [...files.errors];
        const runnable = files.scenarios.filter((file) => {
          const issues = scenarioActionIssues(file.scenario, projectActions);
          if (issues.length === 0) return true;
          errors.push(`${file.scenario.id}: ${issues.join(" ")}`);
          return false;
        });
        const observations = scenarioObservations(mode, criteria);
        const scriptPath = NodePath.join(evidenceDirectory, backend.scenarioScript.fileName);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
            await NodeFSP.writeFile(scriptPath, backend.scenarioScript.text);
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "godot-scenarios",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        const runs: GameScenarioEvidence[] = [];
        for (const file of runnable) {
          const planned = file.scenario.steps.reduce(
            (total, step) =>
              total + ("press" in step ? 2 : "hold" in step ? step.frames : step.wait),
            0,
          );
          const timeoutMs = Math.min(
            300_000,
            Math.max(60_000, Math.ceil(((planned + 300) / 60) * 1000 * 3)),
          );
          const requestPath = NodePath.join(evidenceDirectory, `${file.scenario.id}.request.json`);
          const resultPath = NodePath.join(evidenceDirectory, `${file.scenario.id}.result.json`);
          // Fresh per-scenario user:// isolation: the same route must not read
          // another scenario's saved games, and one exam must not read a
          // previous exam's. Only this child sees these XDG dirs.
          const platform = yield* HostProcess.Platform;
          const isolation =
            platform === "linux"
              ? yield* Effect.promise(() => prepareNativeUserIsolation(evidenceDirectory))
              : null;
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              requestPath,
              scenarioRequestJson({
                scenarioPath: file.path,
                observations,
                sampleEvery: 6,
                bootFrames: 30,
                // The exam always asks for bounded runtime layout probes:
                // findings ride the result as diagnostic hints, never verdicts.
                recordLayout: true,
                // And for bounded runtime spatial snapshots at the same
                // schedule: portable world-geometry measurements, never a
                // verdict engine. Absent when not probed, never a gate.
                recordSpatial: true,
                expectedUserDataPrefix: isolation?.dataDir,
              }),
            ),
          );
          const startedAt = yield* Clock.currentTimeMillis;
          const executed = yield* backend.runScenario(
            { root, projectDir: cwd, projectName: godotProject, binary: godot },
            {
              scriptPath,
              requestPath,
              resultPath,
              timeoutMs,
              ...(isolation === null ? {} : { env: isolation.env }),
            },
          );
          const run = executed.run;
          const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
          const reported = executed.evidence;
          const scriptIssues = executed.issues;
          let error: string | null = null;
          if (run.timedOut) error = `The scenario timed out after ${timeoutMs} ms.`;
          else if (reported === null)
            error = `The runner did not report a result. The project may have crashed during startup. ${commandDetail(run)}`;
          else if (reported.error !== null) error = reported.error;
          else if (scriptIssues.length > 0)
            error = `Godot reported: ${scriptIssues
              .slice(0, 3)
              .map((issue) => `${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`)
              .join(" | ")}`;
          else if (scriptIssues.length === 0 && run.exitCode !== 0)
            error = `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`;
          // Additive runtime layout diagnostics, bounded before persisting.
          // Absent on runs that did not probe; the exam grades observations,
          // so these findings can never fail the mechanics gate.
          const layout = sanitizeScenarioLayout(reported?.layout);
          // Additive runtime spatial snapshots, bounded before persisting.
          // Absent on runs that did not probe; the exam grades observations,
          // so this geometry can never fail the mechanics gate.
          const spatial = sanitizeScenarioSpatial(reported?.spatial);
          runs.push({
            id: file.scenario.id,
            frames: reported?.frames ?? 0,
            durationMs: reported?.durationMs ?? elapsedMs,
            firstInputFrame: reported?.firstInputFrame ?? null,
            baselineFrame: reported?.baselineFrame ?? null,
            playerMoved: reported?.playerMoved ?? false,
            error,
            invalidActions: reported?.invalidActions ?? [],
            observations: reported?.observations ?? [],
            ...(layout === undefined ? {} : { layout }),
            ...(spatial === undefined ? {} : { spatial }),
          });
        }
        const sourceAfter = yield* snapshot(root, godotProject);
        const comparison = comparedSource(sourceBefore, sourceAfter, "scenarios");
        if (comparison.kind !== "current") errors.push(comparison.detail);
        const evaluated = evaluateScenarios({ mode, criteria, runs });
        const summary =
          errors.length > 0 && evaluated.passed
            ? {
                ...evaluated,
                passed: false,
                reason: "scenario-failed" as const,
                detail: errors[0]!,
              }
            : evaluated;
        return {
          value: {
            ok: summary.passed && errors.length === 0,
            summary,
            scenarios: runs,
            errors,
            evidenceDirectory: evidenceReference,
          },
          record: {
            outcome: summary.passed ? ("passed" as const) : ("failed" as const),
            sourceId: comparison.kind === "current" ? comparison.sourceId : null,
            buildId: null,
            evidenceDirectory: evidenceReference,
            designHash: approval?.designHash ?? null,
            criteria: summary.criteria,
            ...(summary.coverage === undefined ? {} : { coverage: summary.coverage }),
            policyRevision: identity.revision,
            detail: comparison.kind === "current" ? summary.detail : comparison.detail,
          },
        };
      }),
    );
  /**
   * One bounded native diagnostic clip. It replays a single validated route
   * through the real game under Godot MovieWriter on a private virtual
   * display, then measures the transcode with ffprobe. The xvfb wrapper owns a
   * process group so cancellation, timeout and disposal kill the display
   * server and Godot with it; failed, aborted and intermediate outputs are
   * removed instead of certified. It never writes a qualification record, so
   * the exam gates cannot move.
   */
  const nativeCapture = (root: string, input: typeof GameNativeCaptureInput.Type) =>
    Effect.gen(function* () {
      yield* refuseWhileUnapproved(root, "native-capture");
      if ((yield* HostProcess.Platform) !== "linux")
        return yield* new GameOperationError({
          operation: "native-capture",
          path: root,
          reason: "unsupported-platform",
          detail:
            "Native diagnostic capture runs on Linux (a private Xvfb display plus Godot MovieWriter). Web playtests and scenario runs are unaffected.",
        });
      const fps = input.fps ?? NATIVE_CAPTURE_BOUNDS.fpsDefault;
      // Encode-only rate: the engine still runs at `fps`; only the FFmpeg
      // transcode converts to this rate. Changing it never reruns the game at
      // another cadence, and the disk preflight below still reserves the raw
      // capture at the render cadence.
      const outputFps = input.outputFps ?? fps;
      // Cheap refusals run before the Godot import launches an engine: the
      // resolve below reads the manifest and toolchain paths only, and every
      // bound (route, viewport, physics rate, disk, tools) is checked before
      // any subprocess starts. The source snapshot stays after the import, as
      // freshness discipline requires, so an import that touches sources is
      // still covered by the before/after comparison.
      const { godot, cwd, godotProject } = yield* engine(root);
      const projectText = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(cwd, "project.godot"), "utf8").catch(() => ""),
      );
      const userIssues = userDirConfigIssues(projectText);
      if (userIssues.length > 0)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: NodePath.join(root, godotProject, "project.godot"),
          reason: "invalid-input",
          detail: userIssues.join(" "),
        });
      const baseViewport = parseGodotViewport(projectText);
      if (
        baseViewport.width > NATIVE_CAPTURE_BOUNDS.maxWidth ||
        baseViewport.height > NATIVE_CAPTURE_BOUNDS.maxHeight
      )
        return yield* new GameOperationError({
          operation: "native-capture",
          path: NodePath.join(root, godotProject, "project.godot"),
          reason: "invalid-input",
          detail: `The game's base viewport (${baseViewport.width}x${baseViewport.height}) is larger than the native capture bound (${NATIVE_CAPTURE_BOUNDS.maxWidth}x${NATIVE_CAPTURE_BOUNDS.maxHeight}). Shrink display/window/size in project.godot first; no output is better than an unbounded capture.`,
        });
      const physicsHz = parsePhysicsTicksPerSecond(projectText);
      if (!(NATIVE_CAPTURE_BOUNDS.supportedPhysicsHz as readonly number[]).includes(physicsHz))
        return yield* new GameOperationError({
          operation: "native-capture",
          path: NodePath.join(root, godotProject, "project.godot"),
          reason: "invalid-input",
          detail: `The project runs physics at ${physicsHz} Hz; a bounded diagnostic capture supports ${(NATIVE_CAPTURE_BOUNDS.supportedPhysicsHz as readonly number[]).join(", ")} Hz. Set physics/common/physics_ticks_per_second to a supported rate first; physics frames are never silently relabelled as render frames.`,
        });
      const files = yield* Effect.promise(() => readScenarioFiles(cwd));
      const file = files.scenarios.find((entry) => entry.scenario.id === input.scenarioId);
      if (file === undefined)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: NodePath.join(root, godotProject, "tests/scenarios"),
          reason: "invalid-input",
          detail:
            files.scenarios.length === 0
              ? `No scenarios found. Add godot/tests/scenarios/${input.scenarioId}.json with press, hold and wait steps.`
              : `Unknown scenario "${input.scenarioId}". Available: ${files.scenarios.map((entry) => entry.scenario.id).join(", ")}.`,
        });
      const actionIssues = scenarioActionIssues(
        file.scenario,
        parseProjectInputActions(projectText),
      );
      if (actionIssues.length > 0)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: file.path,
          reason: "invalid-input",
          detail: actionIssues.join(" "),
        });
      const planned = plannedScenarioFrames(file.scenario.steps) + NATIVE_CAPTURE_BOUNDS.bootFrames;
      if (planned > NATIVE_CAPTURE_BOUNDS.maxPlannedFrames)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: file.path,
          reason: "invalid-input",
          detail: `The route plans ${planned} physics frames; a bounded diagnostic capture runs at most ${NATIVE_CAPTURE_BOUNDS.maxPlannedFrames}. Shorten the route instead of retrying the same plan.`,
        });
      // Raw movie frames at the render cadence: the preflight reserves the
      // raw capture plus audio at this rate, never the output-only encode.
      const movieEstimate = movieFrameEstimate(planned, fps, physicsHz);
      if (movieEstimate > NATIVE_CAPTURE_BOUNDS.maxMovieFrames)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: file.path,
          reason: "invalid-input",
          detail: `The route would encode about ${movieEstimate} raw movie frames at the ${fps} fps render cadence; the bound is ${NATIVE_CAPTURE_BOUNDS.maxMovieFrames}. Use 30 fps render or a shorter route; the encode-only outputFps never changes this reserve.`,
        });
      // The viewport can override --resolution, so preflight against the larger frame.
      const quitAfter = quitAfterRenderFrames(planned, fps, physicsHz);
      const estimateBytes = estimateCaptureBytes(
        Math.max(baseViewport.width, NATIVE_CAPTURE_BOUNDS.requestWidth),
        Math.max(baseViewport.height, NATIVE_CAPTURE_BOUNDS.requestHeight),
        quitAfter,
      );
      const reserveBytes = requiredReserveBytes(estimateBytes);
      const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
      const free = yield* Effect.promise(() => freeBytes(root));
      if (free !== null && free < reserveBytes)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: root,
          reason: "invalid-input",
          detail: `The capture reserves about ${megabytes(reserveBytes)} (2x the ${megabytes(estimateBytes)} raw-frame, audio, container and poster estimate); only ${megabytes(free)} is available on this filesystem. Free space and retry; nothing was recorded.`,
        });
      const pathEnv = process.env.PATH ?? "";
      const discovered = yield* Effect.all([
        Effect.promise(() =>
          findExecutable("xvfb-run", {
            pathEnv,
            override: process.env.GAME_STUDIO_XVFB_RUN,
          }),
        ),
        Effect.promise(() =>
          findExecutable("ffmpeg", { pathEnv, override: process.env.GAME_STUDIO_FFMPEG }),
        ),
        Effect.promise(() =>
          findExecutable("ffprobe", { pathEnv, override: process.env.GAME_STUDIO_FFPROBE }),
        ),
      ]);
      const [xvfb, ffmpeg, ffprobe] = discovered;
      if (xvfb === null)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: "xvfb-run",
          reason: "tool-missing",
          detail: missingToolDetail("xvfb-run"),
        });
      if (ffmpeg === null)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: "ffmpeg",
          reason: "tool-missing",
          detail: missingToolDetail("ffmpeg"),
        });
      if (ffprobe === null)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: "ffprobe",
          reason: "tool-missing",
          detail: missingToolDetail("ffprobe"),
        });
      const imported = yield* importGame(root);
      if (!imported.success)
        return yield* new GameOperationError({
          operation: "native-capture",
          path: imported.path ?? root,
          reason: "command-failed",
          detail: `The Godot import failed before the capture ran.\n${imported.message}`.slice(
            -4096,
          ),
        });
      // A capture only covers sources it saw before and after itself.
      const sourceBefore = yield* snapshot(root, godotProject);
      if (sourceBefore.kind !== "known")
        return yield* new GameOperationError({
          operation: "native-capture",
          path: root,
          reason: "command-failed",
          detail:
            "The game sources could not be identified before the native-capture ran; the result would not be current.",
        });
      const evidenceDirectory = NodePath.join(
        root,
        "builds/native-capture",
        NodeCrypto.randomUUID(),
      );
      const evidenceReference = NodePath.relative(root, evidenceDirectory);
      const removeEvidence = Effect.promise(() =>
        NodeFSP.rm(evidenceDirectory, { recursive: true, force: true }),
      ).pipe(Effect.ignore);
      const runCapture = Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, "scenario.gd"),
              GODOT_SCENARIO_SCRIPT,
            );
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "native-capture",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        // Fresh per-capture user:// isolation: the clip must not read a
        // previous capture's saved games. Only this child sees these XDG dirs;
        // the dirs live under the evidence dir so failure cleanup removes them.
        const isolation = yield* Effect.promise(() =>
          prepareNativeUserIsolation(evidenceDirectory),
        );
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, "request.json"),
              scenarioRequestJson({
                scenarioPath: file.path,
                observations: [],
                sampleEvery: NATIVE_CAPTURE_BOUNDS.sampleEvery,
                bootFrames: NATIVE_CAPTURE_BOUNDS.bootFrames,
                recordTimeline: true,
                expectedUserDataPrefix: isolation.dataDir,
              }),
            );
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "native-capture",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        const requestPath = NodePath.join(evidenceDirectory, "request.json");
        const resultPath = NodePath.join(evidenceDirectory, "result.json");
        const aviPath = NodePath.join(evidenceDirectory, "playback.avi");
        const mp4Path = NodePath.join(evidenceDirectory, "clip.mp4");
        const posterPath = NodePath.join(evidenceDirectory, "poster.png");
        const timelinePath = NodePath.join(evidenceDirectory, "timeline.json");
        const captureJsonPath = NodePath.join(evidenceDirectory, "capture.json");
        // --quit-after counts render iterations under --fixed-fps, not physics
        // frames: convert the physics plan at the configured tick rate and cap
        // the fallback in its own unit. The runner quits on its own when the
        // route finishes; this only bounds a hung render loop.
        const timeoutMs = captureTimeoutMs(planned, fps, physicsHz);
        const capture = yield* processes.run({
          root,
          executable: xvfb,
          args: xvfbArgs(
            godot.path,
            godotMovieArgs({
              godotProjectDir: cwd,
              scriptPath: NodePath.join(evidenceDirectory, "scenario.gd"),
              requestPath,
              resultPath,
              aviPath,
              fps,
              width: NATIVE_CAPTURE_BOUNDS.requestWidth,
              height: NATIVE_CAPTURE_BOUNDS.requestHeight,
              quitAfter,
            }),
          ),
          operation: "native-capture",
          timeoutMs,
          env: {
            LIBGL_ALWAYS_SOFTWARE: "1",
            LP_NUM_THREADS: "2",
            ...isolation.env,
          },
          ownedProcessGroup: true,
        });
        if (capture.timedOut)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: capture.logPath,
            reason: "command-failed",
            detail: `The native capture timed out after ${timeoutMs} ms. Shorten the route; an overlong route is never truncated into a success.`,
          });
        const reportText = yield* Effect.promise(() =>
          NodeFSP.readFile(resultPath, "utf8").catch(() => null),
        );
        const report = reportText === null ? null : parseRunnerReport(reportText);
        const scriptIssues = parseGodotIssues(`${capture.stdout}\n${capture.stderr}`);
        if (report === null)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: capture.logPath,
            reason: "command-failed",
            detail: `The runner did not report a result. The project may have crashed during startup. ${commandDetail(capture)}`,
          });
        if (report.error !== null)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: capture.logPath,
            reason: "command-failed",
            detail: report.error,
          });
        if (scriptIssues.length > 0)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: capture.logPath,
            reason: "command-failed",
            detail: `Godot reported: ${scriptIssues
              .slice(0, 3)
              .map((issue) => `${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`)
              .join(" | ")}`,
          });
        if (capture.exitCode !== 0)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: capture.logPath,
            reason: "command-failed",
            detail: `Godot exited with code ${capture.exitCode}. ${commandDetail(capture)}`,
          });
        const comparison = comparedSource(
          sourceBefore,
          yield* snapshot(root, godotProject),
          "native-capture",
        );
        if (comparison.kind !== "current")
          return yield* new GameOperationError({
            operation: "native-capture",
            path: root,
            reason: "command-failed",
            detail: comparison.detail,
          });
        const transcode = yield* processes.run({
          root,
          executable: ffmpeg,
          args: transcodeArgs(aviPath, mp4Path, outputFps === fps ? undefined : outputFps),
          operation: "native-capture-transcode",
          timeoutMs: NATIVE_CAPTURE_BOUNDS.transcodeTimeoutMs,
        });
        if (transcode.timedOut || transcode.exitCode !== 0)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: transcode.logPath,
            reason: "command-failed",
            detail: `The FFmpeg transcode failed${transcode.timedOut ? " after its timeout" : ` with exit code ${transcode.exitCode}`}. ${commandDetail(transcode)}`,
          });
        const probe = yield* processes.run({
          root,
          executable: ffprobe,
          args: probeArgs(mp4Path),
          operation: "native-capture-probe",
          timeoutMs: NATIVE_CAPTURE_BOUNDS.probeTimeoutMs,
        });
        const measured =
          probe.exitCode === 0 && !probe.timedOut ? parseProbeJson(probe.stdout) : null;
        if (measured === null)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: probe.logPath,
            reason: "command-failed",
            detail: `ffprobe did not report usable stream metadata for the transcoded clip. ${commandDetail(probe)}`,
          });
        if (
          measured.width > NATIVE_CAPTURE_BOUNDS.maxWidth ||
          measured.height > NATIVE_CAPTURE_BOUNDS.maxHeight
        )
          return yield* new GameOperationError({
            operation: "native-capture",
            path: mp4Path,
            reason: "invalid-input",
            detail: `The actual capture is ${measured.width}x${measured.height}, past the ${NATIVE_CAPTURE_BOUNDS.maxWidth}x${NATIVE_CAPTURE_BOUNDS.maxHeight} bound. No output was kept; shrink display/window/size in project.godot first.`,
          });
        const poster = yield* processes.run({
          root,
          executable: ffmpeg,
          args: posterArgs(mp4Path, posterPath, measured.durationSeconds),
          operation: "native-capture-poster",
          timeoutMs: NATIVE_CAPTURE_BOUNDS.posterTimeoutMs,
        });
        if (poster.timedOut || poster.exitCode !== 0)
          return yield* new GameOperationError({
            operation: "native-capture",
            path: poster.logPath,
            reason: "command-failed",
            detail: `The poster extraction failed${poster.timedOut ? " after its timeout" : ` with exit code ${poster.exitCode}`}. ${commandDetail(poster)}`,
          });
        // The AVI is an intermediate: once the MP4 measures out, only it is kept.
        yield* Effect.promise(() => NodeFSP.rm(aviPath, { force: true }).catch(() => undefined));
        const warnings: string[] = [];
        if (
          measured.width !== NATIVE_CAPTURE_BOUNDS.requestWidth ||
          measured.height !== NATIVE_CAPTURE_BOUNDS.requestHeight
        )
          warnings.push(
            `Actual capture is ${measured.width}x${measured.height} from viewport policy despite the requested ${NATIVE_CAPTURE_BOUNDS.requestWidth}x${NATIVE_CAPTURE_BOUNDS.requestHeight}; sizes below are actual.`,
          );
        warnings.push(
          "The clip keeps its recorded audio for diagnosis; audio quality is unassessed.",
        );
        if (outputFps === fps) {
          warnings.push(
            `Render cadence and encoded rate are both ${fps} fps: render, raw and encoded frames share one rate here. Keep the render cadence fixed when comparing runs; different cadences can change input timing and route outcomes.`,
          );
        } else {
          warnings.push(
            `Render cadence is ${fps} fps and the encoded clip is ${outputFps} fps: the encode-only rate converted the raw capture without rerunning the game. A different output rate never proves the game behaves the same at another render cadence; compare only runs with the same render cadence.`,
          );
        }
        warnings.push(
          "Counters are measurements, not gameplay proof: scenario-physics, engine-physics and encoded movie frames are different units.",
        );
        yield* Effect.tryPromise({
          try: () =>
            Promise.all([
              NodeFSP.writeFile(timelinePath, encodeEvidenceJson(report.timeline)),
              NodeFSP.writeFile(
                captureJsonPath,
                encodeEvidenceJson({
                  scenarioId: input.scenarioId,
                  sourceId: sourceBefore.sourceId,
                  requested: {
                    fps,
                    outputFps,
                    width: NATIVE_CAPTURE_BOUNDS.requestWidth,
                    height: NATIVE_CAPTURE_BOUNDS.requestHeight,
                  },
                  renderFps: fps,
                  actual: measured,
                  scenarioFrames: report.frames,
                  movieFrames: measured.frames,
                  physicsHz: report.physicsHz,
                  playerMoved: report.playerMoved,
                  timelineEntries: report.timeline.length,
                  warnings,
                }),
              ),
            ]),
          catch: (cause) =>
            new GameOperationError({
              operation: "native-capture",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        return {
          scenarioId: input.scenarioId,
          sourceId: sourceBefore.sourceId,
          evidenceDirectory: evidenceReference,
          clipPath: NodePath.join(evidenceReference, "clip.mp4"),
          posterPath: NodePath.join(evidenceReference, "poster.png"),
          resultPath: NodePath.join(evidenceReference, "result.json"),
          timelinePath: NodePath.join(evidenceReference, "timeline.json"),
          requestedFps: fps,
          requestedOutputFps: outputFps,
          renderFps: fps,
          actualFps: measured.fps,
          requestedWidth: NATIVE_CAPTURE_BOUNDS.requestWidth,
          requestedHeight: NATIVE_CAPTURE_BOUNDS.requestHeight,
          actualWidth: measured.width,
          actualHeight: measured.height,
          scenarioFrames: report.frames,
          movieFrames: measured.frames,
          physicsHz: report.physicsHz,
          playerMoved: report.playerMoved,
          timelineEntries: report.timeline.length,
          warnings,
          message: `Native diagnostic clip for "${input.scenarioId}": ${measured.frames} encoded movie frames at ${measured.fps} fps (${measured.width}x${measured.height}) from ${report.frames} physics frames at a ${fps} fps render cadence. Diagnostic timing only: it does not prove gameplay and it is not a Web build.`,
        } satisfies typeof GameNativeCaptureResult.Type;
      });
      return yield* runCapture.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? removeEvidence : Effect.void)),
      );
    });
  /**
   * One bounded real audio measurement. The file is game-relative and must
   * resolve inside the game; symlinks escaping it are refused. Size, probe
   * and segment limits run before any decode, the PCM stays in FFmpeg's
   * filter graph, and stderr is capped. Native-clip audio is engine-mixer
   * audio from the native sources, never the exported Web build.
   */
  const audioInspect = (root: string, input: typeof GameAudioInspectInput.Type) =>
    Effect.gen(function* () {
      const bounds = GAME_AUDIO_INSPECT_BOUNDS;
      const relative = input.path;
      const absolute = yield* Effect.tryPromise({
        try: () => resolveAudioPath(root, relative),
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-audio",
            path: relative.slice(0, 512),
            reason:
              cause instanceof Error && cause.message.startsWith("refused")
                ? "invalid-path"
                : "invalid-input",
            detail:
              cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500),
            cause,
          }),
      });
      const stats = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(absolute),
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-audio",
            path: relative.slice(0, 512),
            reason: "invalid-input",
            detail: "The audio file does not exist or cannot be read.",
            cause,
          }),
      });
      if (!stats.isFile() || stats.size > bounds.maxFileBytes)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: relative.slice(0, 512),
          reason: "invalid-input",
          detail: stats.isFile()
            ? `The file is ${stats.size} bytes; the bound is ${bounds.maxFileBytes}. Measure a smaller asset or clip segment.`
            : "The audio path is not a file.",
        });
      if (
        input.segmentSeconds !== undefined &&
        (!Number.isFinite(input.segmentSeconds) ||
          input.segmentSeconds <= 0 ||
          input.segmentSeconds > bounds.maxDurationSeconds)
      )
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: relative,
          reason: "invalid-input",
          detail: "Audio segment duration must be positive and within the duration bound.",
        });
      const fileSha256 = yield* Effect.tryPromise({
        try: () => fingerprintAudioFile(absolute),
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-audio",
            path: relative,
            reason: "io",
            cause,
          }),
      });
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      const nativeClip = isNativeClipPath(relative);
      const sourceId =
        manifest === null
          ? null
          : yield* snapshot(root, manifest.godotProject).pipe(
              Effect.map((entry) => (entry.kind === "known" ? entry.sourceId : null)),
              Effect.orElseSucceed(() => null),
            );
      const pathEnv = process.env.PATH ?? "";
      const [ffmpeg, ffprobe] = yield* Effect.all([
        Effect.promise(() =>
          findExecutable("ffmpeg", { pathEnv, override: process.env.GAME_STUDIO_FFMPEG }),
        ),
        Effect.promise(() =>
          findExecutable("ffprobe", { pathEnv, override: process.env.GAME_STUDIO_FFPROBE }),
        ),
      ]);
      if (ffmpeg === null || ffprobe === null)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: ffmpeg === null ? "ffmpeg" : "ffprobe",
          reason: "tool-missing",
          detail: `${missingToolDetail(ffmpeg === null ? "ffmpeg" : "ffprobe")} Audio quality stays unknown.`,
        });
      const probe = yield* processes.run({
        root,
        executable: ffprobe,
        args: audioProbeArgs(absolute),
        operation: "inspect-audio-probe",
        timeoutMs: bounds.probeTimeoutMs,
      });
      const measured =
        probe.exitCode === 0 && !probe.timedOut ? parseAudioProbeJson(probe.stdout) : null;
      if (measured === null)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: probe.logPath,
          reason: "command-failed",
          detail: `ffprobe did not report usable audio metadata for the file. ${commandDetail(probe)}`,
        });
      if (measured.channels > bounds.maxChannels || measured.sampleRate > bounds.maxSampleRate)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: relative,
          reason: "invalid-input",
          detail: "Audio inspection supports mono/stereo at up to 192 kHz. Decode was not started.",
        });
      // Segment bound before decode: the longest honest slice, truncated with
      // a warning when the stream runs past the duration bound.
      const requested = input.segmentSeconds ?? measured.durationSeconds;
      const segment = Math.min(requested, measured.durationSeconds, bounds.maxDurationSeconds);
      const truncated = measured.durationSeconds > segment;
      const measure = yield* processes.run({
        root,
        executable: ffmpeg,
        args: audioMeasureArgs(absolute, segment, measured.channels),
        operation: "inspect-audio-measure",
        timeoutMs: bounds.measureTimeoutMs,
      });
      if (measure.timedOut || measure.exitCode !== 0)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: measure.logPath,
          reason: "command-failed",
          detail: `The FFmpeg measurement failed${measure.timedOut ? " after its timeout" : ` with exit code ${measure.exitCode}`}. ${commandDetail(measure)}`,
        });
      const stderr =
        measure.stderr.length > bounds.maxOutputBytes
          ? measure.stderr.slice(-bounds.maxOutputBytes)
          : measure.stderr;
      const volumeBlocks = parseVolumeDetects(stderr);
      const volume = volumeBlocks[0] ?? parseVolumeDetect(stderr);
      // The last block is the explicit mono mix: when the channels carry
      // energy and the mix collapses, that is cancellation, not silence.
      const mixMeanDb =
        volumeBlocks.length > 1 ? (volumeBlocks.at(-1)?.meanDb ?? null) : volume.meanDb;
      const silenceSeconds =
        parseSilenceTotal(stderr) ??
        (stderr.includes("silence_start:") || volume.meanDb === null ? null : 0);
      const channels = parseChannelStats(stderr);
      const phaseCancelled = detectPhaseCancellation({
        meanDb: volume.meanDb,
        mixMeanDb,
        channels,
      });
      const warnings: string[] = [];
      const unknowns: string[] = [];
      if (truncated)
        warnings.push(
          `Measured the first ${segment} s of a ${measured.durationSeconds.toFixed(2)} s stream; the rest is unassessed.`,
        );
      if (volume.meanDb === null || volume.maxDb === null)
        unknowns.push("FFmpeg reported no overall level; peak/RMS are unknown.");
      // Unreported stays unreported: a missing histogram is null, never an invented zero.
      const clipped =
        volume.nearClippingSamples ??
        (volume.maxDb !== null && volume.maxDb < bounds.nearClippingDb ? 0 : null);
      if (volume.maxDb !== null && volume.maxDb >= bounds.nearClippingDb)
        warnings.push(
          `Peak ${volume.maxDb.toFixed(1)} dBFS is near clipping; samples within 1 dB of full scale${clipped === null ? " were not counted" : `: ${clipped}`}.`,
        );
      if (silenceSeconds === null)
        unknowns.push("No silence interval was reported; silence is unknown.");
      if (phaseCancelled === null)
        unknowns.push("Phase cancellation is unknown: the mixed level was not reported.");
      else if (phaseCancelled)
        warnings.push(
          "Channels carry energy while the mixed level collapses: opposite-phase cancellation, not silence.",
        );
      if (nativeClip)
        warnings.push(
          "Native-clip audio is the engine mixer from the native game sources, never the exported Web build.",
        );
      else
        warnings.push(
          "A local asset file is measured as stored; audibility in the exported Web build is unassessed.",
        );
      const clipSourceId = nativeClip
        ? yield* Effect.promise(() => readNativeClipSourceId(NodePath.dirname(absolute))).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null;
      const afterHash = yield* Effect.tryPromise({
        try: () => fingerprintAudioFile(absolute),
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-audio",
            path: relative,
            reason: "io",
            cause,
          }),
      });
      if (fileSha256 !== afterHash)
        return yield* new GameOperationError({
          operation: "inspect-audio",
          path: relative,
          reason: "command-failed",
          detail:
            "The audio bytes changed during measurement; no metrics can be bound to one version.",
        });
      if (!nativeClip && manifest !== null && sourceId !== null) {
        const after = yield* snapshot(root, manifest.godotProject);
        if (after.kind !== "known" || after.sourceId !== sourceId)
          return yield* new GameOperationError({
            operation: "inspect-audio",
            path: relative,
            reason: "command-failed",
            detail:
              "The game sources changed during audio measurement; its source binding is stale.",
          });
      }
      if (nativeClip && clipSourceId === null)
        unknowns.push("The native recording has no readable capture source binding.");
      const evidenceDirectory = NodePath.join("builds/audio-inspect", NodeCrypto.randomUUID());
      const reportPath = NodePath.join(evidenceDirectory, "report.json");
      const result = {
        path: relative,
        evidenceDirectory,
        reportPath,
        logs: [probe.logPath, measure.logPath].map((path) => NodePath.relative(root, path)),
        source: {
          kind: nativeClip ? ("native-clip" as const) : ("asset" as const),
          sourceId: nativeClip ? clipSourceId : sourceId,
          fileSha256,
        },
        metrics: {
          durationSeconds: measured.durationSeconds,
          measuredSeconds: segment,
          codec: measured.codec,
          sampleRate: measured.sampleRate,
          channels: measured.channels,
          peakDb: volume.maxDb,
          meanDb: volume.meanDb,
          silenceSeconds,
          nearClippingSamples: clipped,
          ...(phaseCancelled === null ? {} : { phaseCancelled }),
        },
        warnings,
        unknowns,
        message: `Audio ${nativeClip ? "native-clip" : "asset"} "${relative}": ${measured.codec}, ${measured.sampleRate} Hz x${measured.channels}, ${measured.durationSeconds.toFixed(2)} s stream${truncated ? ` (first ${segment} s measured)` : ""}; peak ${volume.maxDb === null ? "unknown" : `${volume.maxDb.toFixed(1)} dBFS`}, mean ${volume.meanDb === null ? "unknown" : `${volume.meanDb.toFixed(1)} dBFS`}${silenceSeconds === null ? "" : `, ${silenceSeconds.toFixed(2)} s silence`}. Metrics only: not a verdict on composition, mix or Web audibility.`,
      } satisfies typeof GameAudioInspectResult.Type;
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.join(root, evidenceDirectory), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(root, reportPath), encodeEvidenceJson(result));
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-audio",
            path: reportPath,
            reason: "io",
            cause,
          }),
      });
      return result;
    });
  /**
   * One bounded headless runtime calibration. The same validated route runs
   * sequentially at 2-3 render cadences with 2 repeats each, at the project's
   * configured physics tick rate and one fixed seed, each repeat under fresh
   * per-run user:// isolation. No videos, no MovieWriter, no qualification
   * writes: the verdict compares same-rate repeats before cross-rate pairs
   * with documented tolerances, and any error, timeout, missing probe or
   * unisolated user:// is unknown, never equivalent.
   */
  const runtimeCalibrate = (root: string, input: typeof GameRuntimeCalibrateInput.Type) =>
    Effect.gen(function* () {
      yield* refuseWhileUnapproved(root, "runtime-calibrate");
      if ((yield* HostProcess.Platform) !== "linux")
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: root,
          reason: "unsupported-platform",
          detail:
            "Runtime calibration isolates user:// through per-run XDG dirs on Linux. Web playtests and scenario runs are unaffected.",
        });
      const requested = Array.isArray(input.cadences)
        ? [...input.cadences]
        : [...RUNTIME_CALIBRATE_BOUNDS.defaultCadences];
      const cadences = [...new Set(requested)].sort((a, b) => a - b);
      const seed = input.seed ?? RUNTIME_CALIBRATE_BOUNDS.defaultSeed;
      if (
        cadences.length < RUNTIME_CALIBRATE_BOUNDS.minCadences ||
        cadences.length > RUNTIME_CALIBRATE_BOUNDS.maxCadences ||
        !cadences.every((cadence) =>
          (RUNTIME_CALIBRATE_BOUNDS.cadenceOptions as readonly number[]).includes(cadence),
        )
      )
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: NodePath.join(root, "godot/tests/scenarios"),
          reason: "invalid-input",
          detail: `Name ${RUNTIME_CALIBRATE_BOUNDS.minCadences}-${RUNTIME_CALIBRATE_BOUNDS.maxCadences} unique render cadences from ${(RUNTIME_CALIBRATE_BOUNDS.cadenceOptions as readonly number[]).join(", ")}; got [${requested.join(", ")}]. Different cadences can change input timing, which is what this diagnostic measures.`,
        });
      if (!Number.isInteger(seed) || seed < 0 || seed > RUNTIME_CALIBRATE_BOUNDS.maxSeed)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: NodePath.join(root, "godot/tests/scenarios"),
          reason: "invalid-input",
          detail: `The calibration seed must be an integer 0-${RUNTIME_CALIBRATE_BOUNDS.maxSeed}; got ${String(input.seed)}.`,
        });
      const { godot, cwd, godotProject } = yield* engine(root);
      const manifest = yield* projects.read(root);
      const projectText = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(cwd, "project.godot"), "utf8").catch(() => ""),
      );
      const userIssues = userDirConfigIssues(projectText);
      if (userIssues.length > 0)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: NodePath.join(root, godotProject, "project.godot"),
          reason: "invalid-input",
          detail: userIssues.join(" "),
        });
      const physicsHz = parsePhysicsTicksPerSecond(projectText);
      if (!(RUNTIME_CALIBRATE_BOUNDS.supportedPhysicsHz as readonly number[]).includes(physicsHz))
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: NodePath.join(root, godotProject, "project.godot"),
          reason: "invalid-input",
          detail: `The project runs physics at ${physicsHz} Hz; a bounded calibration supports ${(RUNTIME_CALIBRATE_BOUNDS.supportedPhysicsHz as readonly number[]).join(", ")} Hz. Physics frames are never silently relabelled.`,
        });
      const files = yield* Effect.promise(() => readScenarioFiles(cwd));
      const file = files.scenarios.find((entry) => entry.scenario.id === input.scenarioId);
      if (file === undefined)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: NodePath.join(root, godotProject, "tests/scenarios"),
          reason: "invalid-input",
          detail:
            files.scenarios.length === 0
              ? `No scenarios found. Add godot/tests/scenarios/${input.scenarioId}.json with press, hold and wait steps.`
              : `Unknown scenario "${input.scenarioId}". Available: ${files.scenarios.map((entry) => entry.scenario.id).join(", ")}.`,
        });
      const actionIssues = scenarioActionIssues(
        file.scenario,
        parseProjectInputActions(projectText),
      );
      if (actionIssues.length > 0)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: file.path,
          reason: "invalid-input",
          detail: actionIssues.join(" "),
        });
      const planned =
        plannedScenarioFrames(file.scenario.steps) + RUNTIME_CALIBRATE_BOUNDS.bootFrames;
      if (planned > RUNTIME_CALIBRATE_BOUNDS.maxPlannedFrames)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: file.path,
          reason: "invalid-input",
          detail: `The route plans ${planned} physics frames; a bounded calibration runs at most ${RUNTIME_CALIBRATE_BOUNDS.maxPlannedFrames}. Shorten the route instead of retrying the same plan.`,
        });
      const imported = yield* importGame(root);
      if (!imported.success)
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: imported.path ?? root,
          reason: "command-failed",
          detail: `The Godot import failed before the calibration ran.\n${imported.message}`.slice(
            -4096,
          ),
        });
      const sourceBefore = yield* snapshot(root, godotProject);
      if (sourceBefore.kind !== "known")
        return yield* new GameOperationError({
          operation: "runtime-calibrate",
          path: root,
          reason: "command-failed",
          detail:
            "The game sources could not be identified before the runtime-calibration ran; the result would not be current.",
        });
      // The approved observations ride along as measurement only: the
      // calibration never writes the state stage, but a final GameState that
      // the exam would grade is worth comparing across cadences.
      const designSnapshot = yield* designApprovals.snapshot(root, manifest);
      const design = designSnapshot.read;
      const approval = designSnapshot.record;
      const mode: "criteria" | "legacy" | "none" =
        design.state === "approved" && approval !== null
          ? "criteria"
          : design.state === "legacy"
            ? "legacy"
            : "none";
      const criteria = mode === "criteria" && approval !== null ? approval.acceptance : [];
      const observations = scenarioObservations(mode, criteria);
      const evidenceDirectory = NodePath.join(
        root,
        "builds/runtime-calibrate",
        NodeCrypto.randomUUID(),
      );
      const evidenceReference = NodePath.relative(root, evidenceDirectory);
      const removeEvidence = Effect.promise(() =>
        NodeFSP.rm(evidenceDirectory, { recursive: true, force: true }),
      ).pipe(Effect.ignore);
      const runCalibrate = Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, "scenario.gd"),
              GODOT_SCENARIO_SCRIPT,
            );
          },
          catch: (cause) =>
            new GameOperationError({
              operation: "runtime-calibrate",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        const scriptPath = NodePath.join(evidenceDirectory, "scenario.gd");
        const runs: (typeof GameRuntimeCalibrateRun.Type)[] = [];
        const samples: CalibrateRunSample[] = [];
        for (const cadence of cadences) {
          for (let repeat = 0; repeat < RUNTIME_CALIBRATE_BOUNDS.repeatsPerCadence; repeat += 1) {
            const runDir = NodePath.join(evidenceDirectory, `run-${cadence}-${repeat}`);
            yield* Effect.tryPromise({
              try: () => NodeFSP.mkdir(runDir, { recursive: true }),
              catch: (cause) =>
                new GameOperationError({
                  operation: "runtime-calibrate",
                  path: runDir,
                  reason: "io",
                  cause,
                }),
            });
            // Fresh per-run user:// isolation: a repeat must not read another
            // repeat's saved games, and one calibration must not read a
            // previous calibration's. Only this child sees these XDG dirs;
            // the dirs live under the run dir so evidence cleanup removes them.
            const isolation = yield* Effect.promise(() => prepareNativeUserIsolation(runDir));
            const requestPath = NodePath.join(runDir, "request.json");
            const resultPath = NodePath.join(runDir, "result.json");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                requestPath,
                scenarioRequestJson({
                  scenarioPath: file.path,
                  observations,
                  sampleEvery: RUNTIME_CALIBRATE_BOUNDS.sampleEvery,
                  bootFrames: RUNTIME_CALIBRATE_BOUNDS.bootFrames,
                  recordTimeline: true,
                  recordRuntimeState: true,
                  seed,
                  expectedUserDataPrefix: isolation.dataDir,
                }),
              ),
            );
            // Headless fixed-fps without MovieWriter: an accelerated
            // diagnostic run, not a video. The timeout converts the physics
            // plan at the configured tick rate.
            const timeoutMs = Math.min(
              RUNTIME_CALIBRATE_BOUNDS.perRunTimeoutMs,
              captureTimeoutMs(planned, cadence, physicsHz),
            );
            const run = yield* processes.run({
              root,
              executable: godot.path,
              args: [
                "--headless",
                "--fixed-fps",
                String(cadence),
                "--path",
                cwd,
                "--script",
                scriptPath,
                "--",
                requestPath,
                resultPath,
              ],
              operation: "runtime-calibrate",
              timeoutMs,
              env: isolation.env,
              ownedProcessGroup: true,
            });
            const resultText = yield* Effect.promise(() =>
              NodeFSP.readFile(resultPath, "utf8").catch(() => null),
            );
            const reported = resultText === null ? null : parseCalibrationRunnerReport(resultText);
            const scriptIssues = parseGodotIssues(`${run.stdout}\n${run.stderr}`);
            let error: string | null = null;
            if (run.timedOut) error = `The run timed out after ${timeoutMs} ms.`;
            else if (reported === null)
              error = `The runner did not report a result. The project may have crashed during startup. ${commandDetail(run)}`;
            else if (reported.error !== null) error = reported.error;
            else if (scriptIssues.length > 0)
              error = `Godot reported: ${scriptIssues
                .slice(0, 3)
                .map(
                  (issue) => `${issue.file}${issue.line ? `:${issue.line}` : ""} ${issue.message}`,
                )
                .join(" | ")}`;
            else if (run.exitCode !== 0)
              error = `Godot exited with code ${run.exitCode}. ${commandDetail(run)}`;
            const userDataDirIsolated =
              reported?.userDataDir !== undefined &&
              reported?.userDataDir !== null &&
              isPathInside(reported.userDataDir, isolation.dataDir);
            if (error === null && !userDataDirIsolated)
              error =
                "The engine user data dir escaped the isolated per-run directory; refusing instead of claiming a clean state.";
            const gameState: Record<string, number | boolean | string | null> = {
              ...reported?.gameState,
            };
            for (const observation of reported?.observations ?? [])
              gameState[observation.key] = observation.last;
            if (error === null && reported?.gameStateComplete === false)
              error =
                "GameState contains unmeasured, non-scalar or truncated values; complete state equivalence is unknown.";
            if (
              error === null &&
              (reported?.enginePhysicsFrames == null ||
                reported?.renderFrames == null ||
                reported.physicsHz !== physicsHz)
            )
              error =
                "Engine counters or configured physics rate were not confirmed; runtime equivalence is unknown.";
            // Physical displacement rides on the gameplay baseline when play
            // started, else on the first observation; a missing end is unknown.
            const baseline = reported?.playerBaseline ?? null;
            const first = reported?.playerFirst ?? null;
            const last = reported?.playerLast ?? null;
            const displacement = playerDisplacementOf(baseline ?? first, last);
            const nominalPhysicsSeconds =
              reported?.enginePhysicsFrames !== undefined && reported?.enginePhysicsFrames !== null
                ? reported.enginePhysicsFrames / physicsHz
                : (reported?.frames ?? planned) / physicsHz;
            const runEvidencePath = NodePath.join(
              evidenceReference,
              `run-${cadence}-${repeat}`,
              "result.json",
            );
            const normalized = {
              cadence,
              repeat,
              scenarioFrames: reported?.frames ?? 0,
              enginePhysicsFrames: reported?.enginePhysicsFrames ?? 0,
              renderFrames: reported?.renderFrames ?? 0,
              nominalPhysicsSeconds: Number.isFinite(nominalPhysicsSeconds)
                ? nominalPhysicsSeconds
                : 0,
              firstInputFrame: reported?.firstInputFrame ?? null,
              baselineFrame: reported?.baselineFrame ?? null,
              playerMoved: reported?.playerMoved ?? false,
              playerFirst: first,
              playerBaseline: baseline,
              playerLast: last,
              playerDisplacement: displacement,
              userDataDirIsolated,
              gameState,
              initialGameState: reported?.initialGameState ?? {},
              error,
              timedOut: run.timedOut,
              evidencePath: runEvidencePath,
            } satisfies typeof GameRuntimeCalibrateRun.Type;
            runs.push(normalized);
            samples.push({
              cadence,
              repeat,
              scenarioFrames: normalized.scenarioFrames,
              enginePhysicsFrames: normalized.enginePhysicsFrames,
              renderFrames: normalized.renderFrames,
              nominalPhysicsSeconds: normalized.nominalPhysicsSeconds,
              firstInputFrame: normalized.firstInputFrame,
              baselineFrame: normalized.baselineFrame,
              playerMoved: normalized.playerMoved,
              playerFirst: first,
              playerBaseline: baseline,
              playerLast: last,
              playerDisplacement: displacement,
              userDataDirIsolated,
              gameState,
              initialGameState: reported?.initialGameState ?? undefined,
              error,
              timedOut: run.timedOut,
            });
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(runDir, "calibrated-run.json"),
                encodeEvidenceJson(normalized),
              ),
            );
          }
        }
        const comparison = comparedSource(
          sourceBefore,
          yield* snapshot(root, godotProject),
          "runtime-calibrate",
        );
        if (comparison.kind !== "current")
          return yield* new GameOperationError({
            operation: "runtime-calibrate",
            path: root,
            reason: "command-failed",
            detail: comparison.detail,
          });
        // Same-rate stability gates everything: a repeat variance at one
        // cadence is itself a divergence, and an unknown anywhere can never
        // be equivalent. Only then do cross-rate pairs decide.
        const pairs: ReturnType<typeof compareCalibratePair>[] = [];
        const byCadence = new Map<number, CalibrateRunSample[]>();
        for (const sample of samples) {
          const group = byCadence.get(sample.cadence) ?? [];
          group.push(sample);
          byCadence.set(sample.cadence, group);
        }
        for (const [, group] of [...byCadence.entries()].sort((a, b) => a[0] - b[0])) {
          const sorted = [...group].sort((a, b) => a.repeat - b.repeat);
          for (let index = 1; index < sorted.length; index += 1)
            pairs.push(compareCalibratePair(sorted[0]!, sorted[index]!, "same-rate"));
        }
        const ordered = [...samples].sort((a, b) => a.cadence - b.cadence || a.repeat - b.repeat);
        for (let left = 0; left < ordered.length; left += 1)
          for (let right = left + 1; right < ordered.length; right += 1) {
            const a = ordered[left]!;
            const b = ordered[right]!;
            if (a.cadence !== b.cadence) pairs.push(compareCalibratePair(a, b, "cross-rate"));
          }
        const verdict = verdictOfPairs(pairs);
        const comparedCount = pairs.reduce((total, pair) => total + pair.comparedFields, 0);
        const unknownCount = pairs.reduce((total, pair) => total + pair.unknownFields.length, 0);
        const warnings = [
          `Fixed seed ${seed} is applied before the main scene loads; autoloads that randomized earlier, plus RandomNumberGenerator.randomize, time and external state, stay outside guarantees.`,
          "Each repeat ran under fresh per-run user:// isolation; a save persists within its own run only, and a changed custom user directory refuses instead of claiming a clean state.",
          "Indices stay separate: scenario frames count runner physics frames, engine physics/render frames count engine ticks since boot, nominal physics seconds divide engine physics ticks by the configured rate, encoded movie frames belong to captures only.",
          `Player positions compare within ${RUNTIME_CALIBRATE_BOUNDS.positionToleranceUnits} engine units (2D pixels, 3D world coordinates); counters and booleans compare exactly. A missing value, unobserved probe, error or partial timeout is unknown, never equivalent.`,
          "The verdict covers the tested route, cadences, seed and sources only; it is not a global determinism certificate and it never qualifies or promotes the game.",
        ];
        const differences = pairs.flatMap((pair) => pair.differences).slice(0, 10);
        const message =
          verdict === "equivalent"
            ? `Runtime calibration for "${input.scenarioId}" is measured equivalent across ${cadences.join("/")} fps (${RUNTIME_CALIBRATE_BOUNDS.repeatsPerCadence} repeats each, seed ${seed}, physics ${physicsHz} Hz) for the tested route and settings only.`
            : verdict === "different"
              ? `Runtime calibration for "${input.scenarioId}" differs across ${cadences.join("/")} fps (seed ${seed}, physics ${physicsHz} Hz): ${differences[0] ?? "see comparisons"}. Tested route and settings only.`
              : `Runtime calibration for "${input.scenarioId}" is unknown across ${cadences.join("/")} fps (seed ${seed}, physics ${physicsHz} Hz): a run errored, timed out or left a field unobserved. See comparisons. Tested route and settings only.`;
        const result = {
          scenarioId: input.scenarioId,
          sourceId: comparison.kind === "current" ? comparison.sourceId : null,
          seed,
          physicsHz,
          cadences,
          repeatsPerCadence: RUNTIME_CALIBRATE_BOUNDS.repeatsPerCadence,
          runs,
          comparisons: pairs.map((pair) => ({
            kind: pair.label.includes("vs repeat")
              ? ("same-rate" as const)
              : ("cross-rate" as const),
            label: pair.label,
            cadenceA: pair.cadenceA,
            cadenceB: pair.cadenceB,
            equivalent: pair.equivalent,
            unknown: pair.unknown,
            comparedFields: pair.comparedFields,
            unknownFields: pair.unknownFields,
            differences: pair.differences,
          })),
          verdict,
          comparedCount,
          unknownCount,
          evidenceDirectory: evidenceReference,
          calibrationPath: NodePath.join(evidenceReference, "calibration.json"),
          warnings,
          message,
        } satisfies typeof GameRuntimeCalibrateResult.Type;
        yield* Effect.tryPromise({
          try: () =>
            NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, "calibration.json"),
              encodeEvidenceJson(result),
            ),
          catch: (cause) =>
            new GameOperationError({
              operation: "runtime-calibrate",
              path: evidenceDirectory,
              reason: "io",
              cause,
            }),
        });
        return result;
      });
      return yield* runCalibrate.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? removeEvidence : Effect.void)),
      );
    });
  const inspectScene = Effect.fnUntraced(function* (root: string, scenePath: string) {
    const { godot, cwd } = yield* engine(root);
    const relative = scenePath.replace(/^res:\/\//, "");
    const resolved = yield* Effect.try({
      try: () => insideGame(cwd, relative),
      catch: (cause) =>
        isGameOperationError(cause)
          ? cause
          : new GameOperationError({
              operation: "inspect-scene",
              path: scenePath,
              reason: "invalid-path",
              cause,
            }),
    });
    if (!resolved.endsWith(".tscn"))
      return yield* new GameOperationError({
        operation: "inspect-scene",
        path: scenePath,
        reason: "invalid-path",
      });
    const temporary = NodePath.join(
      root,
      "builds/logs",
      `godot-inspect-${NodeCrypto.randomUUID()}`,
    );
    const scriptPath = NodePath.join(temporary, "inspect.gd");
    const resultPath = NodePath.join(temporary, "result.json");
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(temporary, { recursive: true });
          await NodeFSP.writeFile(scriptPath, GODOT_INSPECT_SCRIPT);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "inspect-scene",
            path: temporary,
            reason: "io",
            cause,
          }),
      });
      const run = yield* processes.run({
        root,
        executable: godot.path,
        args: ["--headless", "--path", cwd, "--script", scriptPath, "--", resolved, resultPath],
        operation: "godot-inspect",
        timeoutMs: 60_000,
      });
      const resultText = yield* Effect.promise(() =>
        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
      );
      const raw = decodeText(decodeSceneInspect, resultText);
      if (raw === null || raw.error !== undefined)
        return yield* new GameOperationError({
          operation: "inspect-scene",
          path: scenePath,
          reason: "command-failed",
          detail: (raw?.error ?? commandDetail(run)).slice(-4096),
        });
      return {
        scenePath: `res://${NodePath.relative(cwd, resolved).split(NodePath.sep).join("/")}`,
        nodes: raw.nodes ?? [],
        nodeCount: raw.nodeCount ?? raw.nodes?.length ?? 0,
        truncated: raw.truncated ?? false,
      };
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      ),
    );
  });
  /**
   * One bounded ClassDB query against the installed engine. The probe project
   * is an isolated scratch directory (no user scene, no autoloads, no source
   * edits); only the game's operation lock, process log and cancellation apply.
   * Qualification records are never touched: this is engine documentation, not
   * a game stage.
   */
  const godotApi = Effect.fnUntraced(function* (
    root: string,
    input: typeof GameGodotApiInput.Type,
  ) {
    const decoded = yield* decodeGodotApiInput(input).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "godot-api",
            path: root,
            reason: "invalid-input",
            detail: String(cause),
            cause,
          }),
      ),
    );
    const { backend: apiBackend, godot } = yield* engine(root);
    if (!apiBackend.capabilities.classDbApi)
      return yield* new GameOperationError({
        operation: "godot-api",
        path: root,
        reason: "invalid-input",
        detail: `The "${apiBackend.id}" engine backend has no ClassDB reflection query.`,
      });
    const scratch = yield* Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "godot-api-")),
      catch: (cause) =>
        new GameOperationError({ operation: "godot-api", path: root, reason: "io", cause }),
    });
    const scriptPath = NodePath.join(scratch, "api_probe.gd");
    const resultPath = NodePath.join(scratch, "result.json");
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.writeFile(
            NodePath.join(scratch, "project.godot"),
            '[application]\nconfig/name="ClassDB probe"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
          );
          await NodeFSP.writeFile(scriptPath, GODOT_API_SCRIPT);
        },
        catch: (cause) =>
          new GameOperationError({ operation: "godot-api", path: scratch, reason: "io", cause }),
      });
      const run = yield* processes.run({
        root,
        executable: godot.path,
        args: [
          "--headless",
          "--path",
          scratch,
          "--script",
          scriptPath,
          "--",
          decoded.className,
          decoded.memberFilter ?? "",
          resultPath,
        ],
        operation: "godot-api",
        timeoutMs: GAME_GODOT_API_BOUNDS.timeoutMs,
        cwd: scratch,
      });
      const resultText = yield* Effect.promise(() =>
        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
      );
      const raw = decodeText(decodeGodotApi, resultText);
      if (raw === null)
        return yield* new GameOperationError({
          operation: "godot-api",
          path: decoded.className,
          reason: "command-failed",
          detail:
            `The ClassDB probe did not write its result.${run.timedOut ? " It timed out." : ""} See ${run.logPath}\n${commandDetail(run)}`.slice(
              -4096,
            ),
        });
      if (raw.error !== undefined)
        return yield* new GameOperationError({
          operation: "godot-api",
          path: decoded.className,
          reason: "command-failed",
          detail: raw.error.slice(-4096),
        });
      if (
        run.timedOut ||
        run.signal !== null ||
        (run.exitCode !== 0 && !(run.exitCode === 1 && raw.found === false))
      )
        return yield* new GameOperationError({
          operation: "godot-api",
          path: run.logPath,
          reason: "command-failed",
          detail: commandDetail(run),
        });
      const bound = <T>(items: ReadonlyArray<T>, total: number | undefined, max: number) => ({
        items: items.slice(0, max),
        total: total ?? items.length,
      });
      const methods = bound(
        (raw.methods ?? []).map((entry) => ({
          name: entry.name.slice(0, 128),
          signature: (entry.signature ?? `${entry.name}()`).slice(0, 500),
        })),
        raw.totalMethods,
        GAME_GODOT_API_BOUNDS.maxMethods,
      );
      const properties = bound(
        (raw.properties ?? []).map((entry) => ({
          name: entry.name.slice(0, 128),
          type: (entry.type ?? "Variant").slice(0, 128),
        })),
        raw.totalProperties,
        GAME_GODOT_API_BOUNDS.maxProperties,
      );
      const signals = bound(
        (raw.signals ?? []).map((entry) => ({
          name: entry.name.slice(0, 128),
          signature: (entry.signature ?? `${entry.name}()`).slice(0, 500),
        })),
        raw.totalSignals,
        GAME_GODOT_API_BOUNDS.maxSignals,
      );
      const constants = bound(
        (raw.constants ?? []).map((entry) => ({
          name: entry.name.slice(0, 128),
          value: entry.value ?? 0,
        })),
        raw.totalConstants,
        GAME_GODOT_API_BOUNDS.maxConstants,
      );
      const found = raw.found ?? false;
      const suggestions = (raw.suggestions ?? [])
        .slice(0, GAME_GODOT_API_BOUNDS.maxSuggestions)
        .map((name) => name.slice(0, 64));
      const truncated =
        raw.truncated ??
        (methods.items.length < methods.total ||
          properties.items.length < properties.total ||
          signals.items.length < signals.total ||
          constants.items.length < constants.total);
      const answer = {
        className: (raw.className ?? decoded.className).slice(0, 64),
        engineVersion: (raw.engineVersion ?? godot.version).slice(0, 64),
        found,
        parent: raw.parent ?? null,
        inheritance: (raw.inheritance ?? []).slice(0, 16).map((name) => name.slice(0, 64)),
        methods: methods.items,
        totalMethods: methods.total,
        properties: properties.items,
        totalProperties: properties.total,
        signals: signals.items,
        totalSignals: signals.total,
        constants: constants.items,
        totalConstants: constants.total,
        truncated,
        suggestions,
        message: (raw.message ?? (found ? "Engine class found." : "Engine class not found.")).slice(
          0,
          600,
        ),
      };
      return yield* decodeGodotApiResult(answer).pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({
              operation: "godot-api",
              path: decoded.className,
              reason: "command-failed",
              detail:
                `The ClassDB probe returned an oversized result that was bounded back into shape, but still did not validate: ${String(cause)}`.slice(
                  -4096,
                ),
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }))),
    );
  });
  /**
   * Bounded inventory over the whole game directory plus measured family
   * checks. The filesystem walk excludes generated trees, source mentions
   * never prove a load, and native edges alone prove one. Exported usage
   * stays unknown: inclusion is not use. A whole-project import preflight
   * runs before any engine import, and the native pass reads through the
   * engine and writes only to builds/logs scratch; a Godot or probe failure
   * degrades to unknown evidence, never to a lost asset.
   */
  const assetsInspect = Effect.fnUntraced(function* (
    root: string,
    input: typeof GameAssetsInspectInput.Type,
  ) {
    const decoded = yield* decodeAssetsInspectInput(input).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "inspect-assets",
            path: root,
            reason: "invalid-input",
            detail: String(cause).slice(0, 500),
            cause,
          }),
      ),
    );
    const manifest = yield* projects.read(root);
    const bounds = GAME_ASSET_INVENTORY_BOUNDS;
    const requestedPaths: string[] = [];
    for (const candidate of decoded.paths ?? []) {
      if (
        !candidate.startsWith("res://") ||
        candidate.length <= "res://".length ||
        candidate.length > 500 ||
        candidate.includes("\\") ||
        candidate.split("/").includes("..")
      )
        return yield* new GameOperationError({
          operation: "inspect-assets",
          path: candidate.slice(0, 500),
          reason: "invalid-input",
          detail: `Asset path '${candidate.slice(0, 120)}' must be a res:// path inside the game project.`,
        });
      if (!requestedPaths.includes(candidate)) requestedPaths.push(candidate);
    }
    const project = manifest.godotProject.replaceAll("\\", "/");
    const scan = yield* Effect.tryPromise({
      try: () => walkGameFiles(root, bounds),
      catch: (cause) =>
        new GameOperationError({ operation: "inspect-assets", path: root, reason: "io", cause }),
    });
    const authored = collectAuthoredPaths(manifest);
    const declared = yield* Effect.promise(() =>
      resolveDeclaredReferences(root, manifest.godotProject, authored, bounds),
    );
    const mentions = yield* Effect.promise(() => scanSourceMentions(root, scan.files, bounds)).pipe(
      Effect.orElseSucceed(() => ({
        mentions: [],
        truncated: true as const,
        filesTruncated: true,
        headsCut: 0,
      })),
    );
    const sizeByPath = new Map(scan.files.map((file) => [file.path, file.bytes]));
    const gameRelativeOfRes = (resPath: string): string | null => {
      const rest = resPath.slice("res://".length);
      if (rest.length === 0 || rest.includes("\\") || rest.split("/").includes("..")) return null;
      return project === "" ? rest : `${project}/${rest}`;
    };
    // Native target set. An explicit `paths` filter narrows the engine pass
    // to exactly those paths: every other family counts as uninspected and
    // its engine-dependent checks report unknown. Without a filter the
    // service picks family paths first, then the scenes and resources the
    // walk saw. Overlarge files never load.
    const candidateRes: string[] = [];
    const pushCandidate = (resPath: string | null) => {
      if (resPath === null || candidateRes.includes(resPath)) return;
      candidateRes.push(resPath);
    };
    const narrowed = requestedPaths.length > 0;
    if (narrowed) {
      for (const requested of requestedPaths) pushCandidate(requested);
    } else {
      for (const family of manifest.families ?? [])
        for (const target of family.paths) {
          const normalized = normalizeAuthoredPath(target, manifest.godotProject);
          if (normalized.resPath !== null) pushCandidate(normalized.resPath);
        }
      for (const file of scan.files) {
        if (file.path === project || file.path.startsWith(`${project}/`)) {
          const rest = project === "" ? file.path : file.path.slice(project.length + 1);
          if (rest.endsWith(".tscn")) pushCandidate(`res://${rest}`);
        }
      }
      for (const file of scan.files) {
        if (file.path === project || file.path.startsWith(`${project}/`)) {
          const rest = project === "" ? file.path : file.path.slice(project.length + 1);
          if (rest.endsWith(".tres") || rest.endsWith(".res")) pushCandidate(`res://${rest}`);
        }
      }
    }
    const includeNative = decoded.includeNative ?? true;
    const overlargePaths: string[] = [];
    const missingPaths: string[] = [];
    const omittedPaths: string[] = [];
    const nativeTargets: string[] = [];
    let nativeBytes = 0;
    let nativeTruncated = false;
    // Whole-project preflight before any engine import: a tiny header
    // claiming gigapixels must refuse here, so `--editor --import` never
    // runs on an unbounded project. Filesystem facts still hold; only the
    // engine pass is skipped. A preflight crash is itself a refusal, never a
    // thrown inventory failure.
    const preflight = includeNative
      ? yield* Effect.promise(() =>
          preflightImportSafety({
            root,
            godotProject: manifest.godotProject,
            scan,
            bounds,
          }).catch((cause) => ({
            ok: false as const,
            reason: `The import preflight could not bound the project (${String(cause).slice(0, 120)}); the native pass is skipped and filesystem facts below still hold.`,
          })),
        )
      : { ok: true as const, reason: "The native pass was skipped by request." };
    const preflightRefusal = includeNative && !preflight.ok ? preflight.reason : null;
    if (includeNative && preflightRefusal === null) {
      for (const resPath of candidateRes) {
        if (nativeTargets.length >= bounds.maxNativeTargets) {
          nativeTruncated = true;
          if (!omittedPaths.includes(resPath)) omittedPaths.push(resPath);
          continue;
        }
        const relative = gameRelativeOfRes(resPath);
        if (relative === null) continue;
        const size = sizeByPath.get(relative);
        if (size === undefined) {
          if (!missingPaths.includes(resPath)) missingPaths.push(resPath);
          continue;
        }
        if (size > bounds.maxFileBytes) {
          if (!overlargePaths.includes(resPath)) overlargePaths.push(resPath);
          continue;
        }
        // Image headers fail cheap: a small file decoding to gigapixels never loads.
        const pixels = yield* Effect.promise(() => imagePixelCount(root, relative)).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (pixels !== null && (pixels.width > 8192 || pixels.pixels > 16_777_216)) {
          if (!overlargePaths.includes(resPath)) overlargePaths.push(resPath);
          continue;
        }
        if (nativeBytes + size > bounds.maxNativeBytes) {
          nativeTruncated = true;
          if (!overlargePaths.includes(resPath)) overlargePaths.push(resPath);
          continue;
        }
        nativeBytes += size;
        nativeTargets.push(resPath);
      }
    }
    const skippedNative = new Set<string>();
    for (const resPath of overlargePaths) {
      const relative = gameRelativeOfRes(resPath);
      if (relative !== null) skippedNative.add(relative);
    }
    const unknownNative = (
      message: string,
      extraErrors: ReadonlyArray<string> = [],
    ): typeof GameAssetNativeEvidence.Type => ({
      status: "unknown",
      checkedPaths: [],
      missingPaths: missingPaths.slice(0, 32),
      overlargePaths: overlargePaths.slice(0, 32),
      edges: [],
      animations: [],
      collisions: [],
      scales: [],
      transitions: [],
      errors: [...extraErrors.slice(0, 15), message.slice(0, 500)].slice(0, 16),
      message: message.slice(0, 2000),
    });
    /** Causal diagnostics first: script errors head the output, leak warnings tail it. */
    const probeDiagnostics = (
      run: { readonly stdout: string; readonly stderr: string; readonly logPath: string },
      extra?: string,
    ): string[] => {
      const text = `${run.stdout}\n${run.stderr}`;
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const causal = lines
        .filter((line) =>
          /(?:SCRIPT ERROR|ERROR:|Parse Error|Nonexistent|Invalid call|Invalid access|Failed to load|does not exist)/.test(
            line,
          ),
        )
        .slice(0, 12)
        .map((line) => line.slice(0, 500));
      const head = lines.slice(0, 4).map((line) => line.slice(0, 500));
      const out: string[] = [];
      if (extra !== undefined && extra.length > 0) out.push(extra.slice(0, 500));
      for (const line of causal) if (!out.includes(line)) out.push(line);
      for (const line of head) if (!out.includes(line) && out.length < 16) out.push(line);
      if (out.length === 0) out.push(`See ${run.logPath}`.slice(0, 500));
      return out.slice(0, 16);
    };
    let native: typeof GameAssetNativeEvidence.Type;
    const nativeClasses = new Map<string, string>();
    if (!includeNative) {
      native = unknownNative(
        "The native pass was skipped by request; engine facts are unknown and family checks needing them report unknown.",
      );
    } else if (preflightRefusal !== null) {
      native = unknownNative(preflightRefusal);
    } else {
      const engineAttempt = yield* Effect.result(engine(root));
      if (Result.isFailure(engineAttempt)) {
        native = unknownNative(
          `Godot is not available, so no resource was loaded; filesystem facts below still hold. ${engineAttempt.failure.message}`.slice(
            0,
            2000,
          ),
        );
      } else {
        const { godot, cwd } = engineAttempt.success;
        // Pristine projects have no import cache: .tres class names, .glb
        // imports and script classes only resolve after an editor import.
        // The import writes only engine sidecars (.godot/, *.import, *.uid),
        // which the walk and the no-mutation snapshot both exclude.
        const importResult = yield* Effect.result(
          processes.run({
            root,
            executable: godot.path,
            args: ["--headless", "--path", cwd, "--editor", "--import"],
            operation: "godot-import",
            timeoutMs: 180_000,
          }),
        );
        const importNote =
          importResult._tag === "Failure"
            ? `Editor import did not complete; some resources may report missing until imported.`
            : null;
        const temporary = NodePath.join(
          root,
          "builds/logs",
          `asset-inventory-${NodeCrypto.randomUUID()}`,
        );
        const scriptPath = NodePath.join(temporary, "inventory.gd");
        const requestPath = NodePath.join(temporary, "request.json");
        const resultPath = NodePath.join(temporary, "result.json");
        const probe = yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(temporary, { recursive: true });
              await NodeFSP.writeFile(scriptPath, GODOT_ASSET_INVENTORY_SCRIPT);
              await NodeFSP.writeFile(
                requestPath,
                encodeAssetInventoryRequest({ targets: nativeTargets }),
              );
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "inspect-assets",
                path: temporary,
                reason: "io",
                cause,
              }),
          });
          const run = yield* processes.run({
            root,
            executable: godot.path,
            args: [
              "--headless",
              "--path",
              cwd,
              "--script",
              scriptPath,
              "--",
              requestPath,
              resultPath,
            ],
            operation: "inspect-assets",
            timeoutMs: bounds.timeoutMs,
          });
          // Read before the scratch directory is removed below.
          const resultText = yield* Effect.promise(() =>
            NodeFSP.readFile(resultPath, "utf8").catch(() => null),
          );
          return { run, resultText };
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
          ),
          Effect.result,
        );
        if (Result.isFailure(probe)) {
          native = unknownNative(
            `The native probe could not run; filesystem facts below still hold. ${probe.failure.message}`.slice(
              0,
              2000,
            ),
          );
        } else {
          const { run, resultText } = probe.success;
          const raw = decodeText(decodeAssetInventory, resultText);
          if (raw === null || raw.error !== undefined || raw.results === undefined) {
            const diagnostics = probeDiagnostics(run, raw?.error);
            native = unknownNative(
              `The native probe returned no usable result; filesystem facts below still hold. ${diagnostics[0] ?? `See ${run.logPath}`}`.slice(
                0,
                2000,
              ),
              diagnostics,
            );
          } else {
            const edges: Array<{ readonly from: string; readonly to: string }> = [];
            const animations: Array<{
              readonly resource: string;
              readonly animations: ReadonlyArray<string>;
              readonly loops?: ReadonlyArray<string>;
            }> = [];
            const transitions: Array<{
              readonly resource: string;
              readonly from: string;
              readonly to: string;
              readonly condition: string;
            }> = [];
            const collisions: Array<{
              readonly scene: string;
              readonly total: number;
              readonly enabledWithShape: number;
            }> = [];
            const scales: Array<{
              readonly resource: string;
              readonly heightM: number | null;
              readonly pivot: "ground" | "center" | null;
              readonly detail: string;
            }> = [];
            const checked: string[] = [];
            const probeMissing: string[] = [...missingPaths];
            const probeOverlarge: string[] = [...overlargePaths];
            const errors: string[] = [];
            if (importNote !== null && errors.length < 16) errors.push(importNote.slice(0, 500));
            for (const entry of raw.results.slice(0, bounds.maxNativeTargets)) {
              const resPath = entry.resPath.slice(0, 500);
              if (
                entry.loaded === true &&
                typeof entry.godotClass === "string" &&
                entry.godotClass.length > 0
              ) {
                checked.push(resPath);
                nativeClasses.set(resPath, entry.godotClass.slice(0, 128));
              } else {
                const reason = (typeof entry.error === "string" ? entry.error : "unloadable").slice(
                  0,
                  120,
                );
                const causal = (entry.detail ?? "").slice(0, 280);
                if (reason === "missing") {
                  if (!probeMissing.includes(resPath)) probeMissing.push(resPath);
                } else if (reason === "overlarge") {
                  if (!probeOverlarge.includes(resPath)) probeOverlarge.push(resPath);
                  const relative = gameRelativeOfRes(resPath);
                  if (relative !== null) skippedNative.add(relative);
                } else if (errors.length < 16) {
                  errors.push(
                    `${resPath}: ${reason}${causal.length > 0 ? ` — ${causal}` : ""}`.slice(0, 500),
                  );
                }
              }
              for (const dep of (entry.dependencies ?? []).slice(0, 64)) {
                if (edges.length >= bounds.maxEdges) break;
                const clean = dep.slice(0, 500);
                if (clean.startsWith("res://")) edges.push({ from: resPath, to: clean });
              }
              const names = (entry.animations ?? []).slice(0, 64).map((name) => name.slice(0, 64));
              const loops = (entry.loops ?? []).slice(0, 64).map((name) => name.slice(0, 64));
              if (names.length > 0 && animations.length < 32)
                animations.push({
                  resource: resPath,
                  animations: names,
                  ...(entry.loops === undefined ? {} : { loops }),
                });
              const rawTransitions = (entry.transitions ?? []).slice(0, 64);
              for (const edge of rawTransitions) {
                if (transitions.length >= 64) break;
                const from = edge.from.slice(0, 64);
                const to = edge.to.slice(0, 64);
                if (from.length === 0 || to.length === 0) continue;
                transitions.push({
                  resource: resPath,
                  from,
                  to,
                  condition: (edge.condition ?? "").slice(0, 280),
                });
              }
              if (
                (entry.collisionTotal ?? 0) > 0 ||
                (entry.collisionEnabled ?? 0) > 0 ||
                entry.godotClass === "PackedScene"
              ) {
                if (collisions.length < 32)
                  collisions.push({
                    scene: resPath,
                    total: Math.max(0, Math.floor(entry.collisionTotal ?? 0)),
                    enabledWithShape: Math.max(0, Math.floor(entry.collisionEnabled ?? 0)),
                  });
              }
              const pivot =
                entry.pivotHint === "ground" || entry.pivotHint === "center"
                  ? entry.pivotHint
                  : null;
              const height =
                typeof entry.heightHint === "number" && Number.isFinite(entry.heightHint)
                  ? entry.heightHint
                  : null;
              if ((pivot !== null || height !== null) && scales.length < 32)
                scales.push({
                  resource: resPath,
                  heightM: height,
                  pivot,
                  detail: (entry.detail ?? "Measured natively.").slice(0, 500),
                });
            }
            // Symlink escapes never enter the evidence: a probed res:// path
            // whose file is a link or resolves outside the game is dropped.
            const safeRes = new Set<string>();
            const unsafeRes: string[] = [];
            const resPathsToCheck = new Set<string>([
              ...checked,
              ...edges.map((edge) => edge.to),
              ...animations.map((entry) => entry.resource),
              ...collisions.map((entry) => entry.scene),
              ...scales.map((entry) => entry.resource),
              ...transitions.map((entry) => entry.resource),
            ]);
            for (const resPath of resPathsToCheck) {
              const relative = gameRelativeOfRes(resPath);
              if (relative === null) continue;
              const inside = yield* Effect.promise(() => existsInsideGame(root, relative)).pipe(
                Effect.orElseSucceed(() => ({ exists: false, bytes: 0 })),
              );
              if (inside.exists) safeRes.add(resPath);
              else if (!unsafeRes.includes(resPath)) unsafeRes.push(resPath);
            }
            const safeEdges = edges.filter(
              (edge) => !unsafeRes.includes(edge.from) && !unsafeRes.includes(edge.to),
            );
            const safeAnimations = animations.filter(
              (entry) => !unsafeRes.includes(entry.resource),
            );
            const safeCollisions = collisions.filter((entry) => !unsafeRes.includes(entry.scene));
            const safeScales = scales.filter((entry) => !unsafeRes.includes(entry.resource));
            const safeTransitions = transitions.filter(
              (entry) => !unsafeRes.includes(entry.resource),
            );
            const safeChecked = checked.filter((resPath) => !unsafeRes.includes(resPath));
            if (unsafeRes.length > 0 && errors.length < 16)
              errors.push(
                `omitted ${unsafeRes.length} native reference(s) outside the game; links are never read`.slice(
                  0,
                  500,
                ),
              );
            // Dependencies count against the byte bound, not just the tiny target.
            let closureBytes = 0;
            const closureSeen = new Set<string>();
            for (const resPath of [...safeChecked, ...safeEdges.map((edge) => edge.to)]) {
              if (closureSeen.has(resPath)) continue;
              closureSeen.add(resPath);
              const relative = gameRelativeOfRes(resPath);
              if (relative === null) continue;
              closureBytes += sizeByPath.get(relative) ?? 0;
            }
            const closureOver = closureBytes > bounds.maxNativeBytes;
            for (const resPath of omittedPaths) {
              if (errors.length < 16 && !errors.some((line) => line.includes(resPath)))
                errors.push(
                  `omitted ${resPath} (native target bound ${bounds.maxNativeTargets})`.slice(
                    0,
                    500,
                  ),
                );
              const relative = gameRelativeOfRes(resPath);
              if (relative !== null) skippedNative.add(relative);
            }
            const truncatedProbe =
              (raw.truncated ?? false) || nativeTruncated || omittedPaths.length > 0;
            const status =
              safeChecked.length === 0 &&
              (errors.length > 0 || probeMissing.length > 0 || probeOverlarge.length > 0)
                ? ("unknown" as const)
                : errors.length > 0 ||
                    probeMissing.length > 0 ||
                    probeOverlarge.length > 0 ||
                    truncatedProbe ||
                    closureOver ||
                    unsafeRes.length > 0
                  ? ("partial" as const)
                  : ("complete" as const);
            native = {
              status,
              checkedPaths: safeChecked.slice(0, 32),
              missingPaths: probeMissing.slice(0, 32),
              overlargePaths: probeOverlarge.slice(0, 32),
              edges: safeEdges,
              animations: safeAnimations,
              collisions: safeCollisions,
              scales: safeScales,
              transitions: safeTransitions,
              errors: errors.slice(0, 16),
              message: (status === "complete"
                ? `Native pass loaded ${safeChecked.length} resource(s); edges and facts below are engine-observed.`
                : `Native pass loaded ${safeChecked.length} resource(s); the rest are named in missing/overlarge/errors rather than guessed.${closureOver ? ` Dependencies hold ${(closureBytes / 1_000_000).toFixed(1)} MB, past the ${(bounds.maxNativeBytes / 1_000_000).toFixed(0)} MB bound.` : ""}${truncatedProbe ? " The target list hit its bound; unlisted targets count as uninspected." : ""}`
              ).slice(0, 2000),
            };
          }
        }
      }
    }
    // Measured GLB heights for declared models, bounded and never throwing.
    // Symlink escapes are never read: only regular files inside the game load.
    const glbHeights = new Map<string, number>();
    const glbCandidates = declared.refs
      .filter(
        (ref) =>
          ref.exists &&
          ref.resolvedPath !== null &&
          ref.resolvedPath.toLowerCase().endsWith(".glb"),
      )
      .slice(0, 16);
    for (const ref of glbCandidates) {
      const relative = ref.resolvedPath!;
      const size = sizeByPath.get(relative) ?? 0;
      if (size <= 0 || size > bounds.maxFileBytes) continue;
      const inside = yield* Effect.promise(() => existsInsideGame(root, relative)).pipe(
        Effect.orElseSucceed(() => ({ exists: false, bytes: 0 })),
      );
      if (!inside.exists) continue;
      const inspection = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, ...relative.split("/")))
          .then((bytes) => inspectGlb(bytes))
          .catch(() => null),
      );
      const height = inspection?.bounds?.size[1];
      if (typeof height === "number" && Number.isFinite(height) && height > 0)
        glbHeights.set(relative, height);
    }
    const provenanceCandidates = scan.files
      .filter((file) => {
        const base = file.path.split("/").at(-1)?.toUpperCase() ?? "";
        return base === "PROVENANCE.MD" || base === "PROVENANCE" || base.startsWith("LICENSE");
      })
      .slice(0, 64);
    const readableProvenance = new Set<string>();
    const unreadableProvenance: string[] = [];
    for (const file of provenanceCandidates) {
      const readable = yield* Effect.promise(() =>
        existsInsideGame(root, file.path)
          .then((inside) => {
            if (!inside.exists) return false;
            return NodeFSP.open(NodePath.join(root, ...file.path.split("/")), "r")
              .then(async (handle) => {
                try {
                  const buffer = Buffer.alloc(64);
                  await handle.read(buffer, 0, 64, 0);
                  return true;
                } finally {
                  await handle.close();
                }
              })
              .catch(() => false);
          })
          .catch(() => false),
      );
      if (readable) readableProvenance.add(file.path);
      else unreadableProvenance.push(file.path);
    }
    const declaredByPath = new Map<string, string[]>();
    const declaredPathSet = new Set<string>();
    for (const ref of declared.refs) {
      if (ref.exists && ref.resolvedPath !== null) {
        declaredPathSet.add(ref.resolvedPath);
        const list = declaredByPath.get(ref.resolvedPath) ?? [];
        if (!list.includes(ref.from)) list.push(ref.from);
        declaredByPath.set(ref.resolvedPath, list);
      }
    }
    const declaredMap = new Map(declared.refs.map((ref) => [`${ref.from}\0${ref.target}`, ref]));
    const families = (manifest.families ?? []).map((family) =>
      checkFamily(family, manifest.godotProject, {
        declared: declaredMap,
        native,
        provenanceFiles: readableProvenance,
        glbHeights,
        declaredTruncated: declared.truncated,
      }),
    );
    const mentionTargets = new Set(mentions.mentions.map((mention) => mention.target));
    let mentionedInputs = 0;
    for (const asset of manifest.assets) {
      for (const entry of asset.inputs ?? []) {
        const normalized = normalizeAuthoredPath(entry.path, manifest.godotProject);
        const resPath = entry.path.startsWith("res://") ? entry.path : (normalized.resPath ?? null);
        if (resPath !== null && mentionTargets.has(resPath)) mentionedInputs += 1;
      }
    }
    const coverageBase = summarizeCoverage(scan.files, manifest.godotProject, native, manifest);
    const coverage: typeof coverageBase = {
      ...coverageBase,
      unreadableProvenance: unreadableProvenance.slice(0, 64),
      mentionedInputs,
    };
    const { entries: resources, truncated: resourcesTruncated } = buildResourceEntries({
      files: scan.files,
      godotProject: manifest.godotProject,
      declaredPaths: declaredPathSet,
      declaredBy: declaredByPath,
      nativeClasses,
      skippedNative,
    });
    const incomplete: string[] = [
      ...scan.incomplete,
      ...(declared.truncated
        ? ["declared references passed 200; unlisted paths count as unverified, never missing"]
        : []),
      ...(mentions.truncated
        ? [
            `source mentions passed 200${mentions.filesTruncated ? `; source files passed ${bounds.maxSourceFiles}, unlisted files never checked` : ""}${mentions.headsCut > 0 ? `; ${mentions.headsCut} file(s) read as a ${bounds.maxSourceBytesPerFile / 1024} KB head, content past the head never checked` : ""}`,
          ]
        : []),
      ...(resourcesTruncated ? ["resources passed 300; the rest are unlisted"] : []),
      ...(omittedPaths.length > 0
        ? [
            `native targets passed ${bounds.maxNativeTargets}; ${omittedPaths.length} omitted target(s) count as uninspected`,
          ]
        : []),
      ...(native.status === "unknown"
        ? ["native evidence is unknown; engine facts need a Godot pass"]
        : []),
    ].slice(0, 16);
    const missingRefs = declared.refs.filter((ref) => !ref.exists).length;
    const includeExported = decoded.includeExported ?? true;
    const unknownInclusion = (
      message: string,
      extra: Partial<{
        readonly buildId: string | null;
        readonly sourceId: string | null;
        readonly directory: string | null;
        readonly packFile: string | null;
        readonly errors: ReadonlyArray<string>;
      }> = {},
    ): typeof GameAssetExportedInclusion.Type => ({
      status: "unknown",
      buildId: extra.buildId ?? null,
      sourceId: extra.sourceId ?? null,
      directory: extra.directory ?? null,
      packFile: extra.packFile ?? null,
      checkedPaths: [],
      includedPaths: [],
      missingPaths: [],
      unresolvedPaths: [],
      errors: [...(extra.errors ?? [])].slice(0, 16),
      message: message.slice(0, 2000),
    });
    let exportedInclusion: typeof GameAssetExportedInclusion.Type = unknownInclusion(
      includeExported
        ? "No selected or latest Web build is recorded, so pack inclusion is unknown and filesystem facts below still hold. Export the game to check inclusion."
        : "The export inclusion probe was skipped by request; pack inclusion is unknown.",
    );
    if (includeExported) {
      const stateResult = yield* Effect.result(rounds.read(root));
      if (Result.isFailure(stateResult)) {
        exportedInclusion = unknownInclusion(
          `The review record is unreadable, so pack inclusion is unknown and filesystem facts below still hold. ${stateResult.failure.message}`.slice(
            0,
            2000,
          ),
        );
      } else {
        const state = stateResult.success;
        const selectedWeb =
          state.selected !== null && state.selected.target === "Web" ? state.selected : null;
        let artifact: {
          readonly buildId: string;
          readonly directory: string;
          readonly sourceId: string | null;
          readonly target: string;
        } | null = selectedWeb;
        if (artifact === null) {
          for (const round of state.rounds) {
            if (round.candidate !== null && round.candidate.target === "Web") {
              artifact = round.candidate;
              break;
            }
          }
        }
        if (artifact === null) {
          exportedInclusion = unknownInclusion(
            "No selected or latest Web build is recorded, so pack inclusion is unknown and filesystem facts below still hold. Export the game to check inclusion.",
          );
        } else if (candidateBuildId(artifact.directory) !== artifact.buildId) {
          exportedInclusion = unknownInclusion(
            "The recorded Web build names a directory outside its own content hash, so pack inclusion is unknown and filesystem facts below still hold.",
            { buildId: null, sourceId: artifact.sourceId ?? null, directory: null },
          );
        } else {
          const artifactFiles = yield* Effect.promise(() =>
            describeWebArtifacts(root, artifact.directory),
          );
          const withinArtifactBudget =
            artifactFiles !== null &&
            artifactFiles.every((file) => file.size <= bounds.maxPackBytes) &&
            artifactFiles.reduce((total, file) => total + file.size, 0) <= 2 * bounds.maxPackBytes;
          const hashedBefore = yield* Effect.promise(() =>
            withinArtifactBudget
              ? hashWebBuild(root, artifact.directory).catch(() => null)
              : Promise.resolve(null),
          );
          if (hashedBefore === null || hashedBefore.buildId !== artifact.buildId) {
            exportedInclusion = unknownInclusion(
              "The recorded Web build is missing, exceeds the inventory byte budget, or changed after export; pack inclusion is unknown. Re-export a bounded build before checking inclusion.",
              {
                buildId: artifact.buildId,
                sourceId: artifact.sourceId ?? null,
                directory: artifact.directory,
              },
            );
          } else {
            const directoryAbsolute = NodePath.join(root, artifact.directory);
            const dirEntries = yield* Effect.promise(() =>
              NodeFSP.readdir(directoryAbsolute, {
                withFileTypes: true,
              }).catch(() => null),
            );
            const packNames =
              dirEntries === null
                ? []
                : dirEntries
                    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pck"))
                    .map((entry) => entry.name)
                    .sort();
            if (packNames.length !== 1) {
              exportedInclusion = unknownInclusion(
                "The recorded Web build must hold exactly one .pck for this probe; pack inclusion is unknown and filesystem facts below still hold.",
                {
                  buildId: artifact.buildId,
                  sourceId: artifact.sourceId ?? null,
                  directory: artifact.directory,
                },
              );
            } else {
              const packName = packNames[0]!;
              const packGameRelative = `${artifact.directory}/${packName}`;
              const packAbsolute = NodePath.join(root, packGameRelative);
              const link = yield* Effect.promise(() =>
                NodeFSP.lstat(packAbsolute)
                  .then((stat) => ({ symlink: stat.isSymbolicLink(), size: stat.size }))
                  .catch(() => null),
              );
              if (link === null || link.symlink) {
                exportedInclusion = unknownInclusion(
                  "The recorded pack is missing or a link, so pack inclusion is unknown and filesystem facts below still hold. Re-export before checking inclusion.",
                  {
                    buildId: artifact.buildId,
                    sourceId: artifact.sourceId ?? null,
                    directory: artifact.directory,
                    packFile: packGameRelative,
                  },
                );
              } else if (link.size > bounds.maxPackBytes) {
                exportedInclusion = unknownInclusion(
                  `The recorded pack holds ${(link.size / 1_000_000).toFixed(1)} MB, past the ${(bounds.maxPackBytes / 1_000_000).toFixed(0)} MB pack bound; inclusion is unknown without loading it and filesystem facts below still hold.`,
                  {
                    buildId: artifact.buildId,
                    sourceId: artifact.sourceId ?? null,
                    directory: artifact.directory,
                    packFile: packGameRelative,
                  },
                );
              } else {
                const checks = candidateRes.slice(0, bounds.maxExportedPaths);
                if (checks.length === 0) {
                  exportedInclusion = unknownInclusion(
                    "No res:// paths were named to check in the pack, so pack inclusion is unknown and filesystem facts below still hold.",
                    {
                      buildId: artifact.buildId,
                      sourceId: artifact.sourceId ?? null,
                      directory: artifact.directory,
                      packFile: packGameRelative,
                    },
                  );
                } else {
                  const engineForPack = yield* Effect.result(engine(root));
                  if (Result.isFailure(engineForPack)) {
                    exportedInclusion = unknownInclusion(
                      `Godot is not available, so the pack was not opened; filesystem facts below still hold. ${engineForPack.failure.message}`.slice(
                        0,
                        2000,
                      ),
                      {
                        buildId: artifact.buildId,
                        sourceId: artifact.sourceId ?? null,
                        directory: artifact.directory,
                        packFile: packGameRelative,
                      },
                    );
                  } else {
                    const packTemporary = NodePath.join(
                      root,
                      "builds/logs",
                      `asset-export-${NodeCrypto.randomUUID()}`,
                    );
                    const packProbe = yield* Effect.gen(function* () {
                      const temporary = packTemporary;
                      const bootstrapDir = NodePath.join(temporary, "bootstrap");
                      const scriptPath = NodePath.join(temporary, "inclusion.gd");
                      const requestPath = NodePath.join(temporary, "request.json");
                      const resultPath = NodePath.join(temporary, "result.json");
                      yield* Effect.tryPromise({
                        try: async () => {
                          await NodeFSP.mkdir(bootstrapDir, { recursive: true });
                          await NodeFSP.writeFile(
                            NodePath.join(bootstrapDir, "project.godot"),
                            `config_version=5\n\n[application]\n\nconfig/name="AssetExportProbe"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n`,
                          );
                          await NodeFSP.writeFile(scriptPath, GODOT_ASSET_EXPORT_INCLUSION_SCRIPT);
                          await NodeFSP.writeFile(
                            requestPath,
                            encodeExportInclusionRequest({ packPath: packAbsolute, checks }),
                          );
                        },
                        catch: (cause) =>
                          new GameOperationError({
                            operation: "inspect-assets",
                            path: temporary,
                            reason: "io",
                            cause,
                          }),
                      });
                      const run = yield* processes.run({
                        root,
                        executable: engineForPack.success.godot.path,
                        args: [
                          "--headless",
                          "--path",
                          bootstrapDir,
                          "--script",
                          scriptPath,
                          "--",
                          requestPath,
                          resultPath,
                        ],
                        operation: "inspect-assets",
                        timeoutMs: bounds.timeoutMs,
                      });
                      const resultText = yield* Effect.promise(() =>
                        NodeFSP.readFile(resultPath, "utf8").catch(() => null),
                      );
                      return { run, resultText };
                    }).pipe(
                      Effect.ensuring(
                        Effect.promise(() =>
                          NodeFSP.rm(packTemporary, { recursive: true, force: true }).catch(
                            () => undefined,
                          ),
                        ).pipe(Effect.orElseSucceed(() => undefined)),
                      ),
                      Effect.result,
                    );
                    if (Result.isFailure(packProbe)) {
                      const failure = packProbe.failure;
                      const detail = isGameOperationError(failure)
                        ? failure.message
                        : String(failure).slice(0, 280);
                      exportedInclusion = unknownInclusion(
                        `The pack probe could not run; inclusion is unknown and filesystem facts below still hold. ${detail}`.slice(
                          0,
                          2000,
                        ),
                        {
                          buildId: artifact.buildId,
                          sourceId: artifact.sourceId ?? null,
                          directory: artifact.directory,
                          packFile: packGameRelative,
                          errors: [detail.slice(0, 500)],
                        },
                      );
                    } else {
                      const { resultText } = packProbe.success;
                      const raw = decodeText(decodeExportInclusion, resultText);
                      if (raw === null || raw.error !== undefined || !Array.isArray(raw.included)) {
                        const detail = (raw?.error ?? "no usable result").slice(0, 500);
                        exportedInclusion = unknownInclusion(
                          `The pack probe returned no usable result; inclusion is unknown and filesystem facts below still hold. ${detail}`.slice(
                            0,
                            2000,
                          ),
                          {
                            buildId: artifact.buildId,
                            sourceId: artifact.sourceId ?? null,
                            directory: artifact.directory,
                            packFile: packGameRelative,
                            errors: [detail],
                          },
                        );
                      } else {
                        const included = (raw.included ?? [])
                          .slice(0, 32)
                          .map((entry) => entry.slice(0, 500))
                          .filter((entry) => entry.startsWith("res://"));
                        const missing = (raw.missing ?? [])
                          .slice(0, 32)
                          .map((entry) => entry.slice(0, 500))
                          .filter((entry) => entry.startsWith("res://"));
                        const unresolved = (raw.unresolved ?? [])
                          .slice(0, 32)
                          .map((entry) => entry.slice(0, 500));
                        const outcomes = [...included, ...missing, ...unresolved];
                        const completePartition =
                          outcomes.length === checks.length &&
                          new Set(outcomes).size === checks.length &&
                          outcomes.every((path) => checks.includes(path));
                        const hashedAfter = yield* Effect.promise(() =>
                          hashWebBuild(root, artifact.directory).catch(() => null),
                        );
                        if (
                          !completePartition ||
                          hashedAfter === null ||
                          hashedAfter.buildId !== artifact.buildId
                        ) {
                          exportedInclusion = unknownInclusion(
                            "The pack check was incomplete or its recorded Web build changed during inspection; inclusion is unknown. Re-export before checking inclusion.",
                            {
                              buildId: artifact.buildId,
                              sourceId: artifact.sourceId ?? null,
                              directory: artifact.directory,
                              packFile: packGameRelative,
                            },
                          );
                        } else {
                          exportedInclusion = {
                            status: "checked",
                            buildId: artifact.buildId,
                            sourceId: artifact.sourceId ?? null,
                            directory: artifact.directory,
                            packFile: packGameRelative,
                            checkedPaths: checks.slice(0, 32),
                            includedPaths: included,
                            missingPaths: missing,
                            unresolvedPaths: unresolved,
                            errors: [],
                            message:
                              `Pack inclusion checked ${included.length}/${checks.length} path(s) in Web build ${artifact.buildId.slice(0, 12)} pack ${packName}: inclusion proves the pack contains the bytes, not that the game loads, shows or plays them. Exported usage stays unknown.`.slice(
                                0,
                                2000,
                              ),
                          };
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    const answer = {
      scannedFiles: scan.scannedFiles,
      scannedBytes: scan.scannedBytes,
      truncated: scan.truncated,
      incomplete,
      resources,
      resourcesTruncated,
      declaredReferences: declared.refs.slice(0, bounds.maxDeclaredRefs),
      sourceMentions: mentions.mentions.slice(0, bounds.maxMentions),
      sourceMentionsTruncated: mentions.truncated,
      native,
      families,
      coverage,
      exportedUsage: "unknown" as const,
      exportedInclusion,
      message: (
        `Scanned ${scan.scannedFiles} files; ${declared.refs.length} declared references (${missingRefs} missing); ` +
        `native pass ${native.status} over ${native.checkedPaths.length} loaded target(s); ` +
        `${families.length} families checked. ` +
        (exportedInclusion.status === "checked"
          ? `${exportedInclusion.message} `
          : "Exported usage is unknown: no export artifact was parsed, so included resources cannot be distinguished from runtime use. A Web PCK would need exact build-identity pack loading; that loader is not part of this bounded inventory. ") +
        (exportedInclusion.status === "checked" ? "" : `${exportedInclusion.message} `)
      ).slice(0, 2000),
    };
    return yield* decodeAssetsInspectResult(answer).pipe(
      Effect.mapError(
        (cause) =>
          new GameOperationError({
            operation: "inspect-assets",
            path: root,
            reason: "command-failed",
            detail: `The inventory result did not validate: ${String(cause)}`.slice(-4096),
            cause,
          }),
      ),
    );
  });
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* exclusive(root, name, work(root));
  });
  /**
   * For a reviewed design, the design phase is the gate between planning and
   * building: while the current DESIGN.md has no matching approval record the game must not export,
   * preview, run or playtest, and must not mint Blender assets. The record is
   * authoritative, so editing game.json cannot lift the gate.
   */
  const refuseWhileUnapproved = (root: string, operation: string) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      if (manifest === null) return;
      const design = yield* designApprovals.status(root, manifest);
      // A game without design review records revisions as they land; its
      // design is evidence for the exam, never a gate on building.
      if (design.autoRevision !== undefined) return;
      if (
        design.state !== "draft" &&
        design.state !== "changed" &&
        design.state !== "revision-pending"
      )
        return;
      return yield* new GameOperationError({
        operation,
        path: NodePath.join(root, "DESIGN.md"),
        reason:
          design.state === "changed"
            ? "design-changed"
            : design.state === "revision-pending"
              ? "design-revision-pending"
              : "design-draft",
      });
    });
  /**
   * The one Web export decision for the direct tool and `game_verify`: while a
   * round is open its export is the challenger and must not replace the build
   * Play serves; outside one it is a normal publish. A caller that names a
   * round fails when that round expired instead of silently publishing.
   */
  const webExport = (root: string, runId: string | null, roundId?: string) =>
    Effect.gen(function* () {
      yield* refuseWhileUnapproved(root, "export");
      const active = yield* runningRound(root);
      if (roundId !== undefined) {
        if (active === null || active.id !== roundId)
          return yield* new GameOperationError({
            operation: "Export Web",
            path: root,
            reason: "invalid-input",
            detail:
              "That repair round is no longer running; its export was not published or recorded.",
          });
        return yield* exportGame(root, "Web", { mode: "candidate", roundId: active.id }, runId);
      }
      return yield* exportGame(
        root,
        "Web",
        active === null ? { mode: "publish" } : { mode: "candidate", roundId: active.id },
        runId,
      );
    });
  /** The policy's canonical suite; only it owns the test stage. */
  const canonicalTest = (root: string, timeoutMs = 60_000) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const identity = yield* designApprovals.readPolicy(root, manifest);
      return yield* ownStage(
        root,
        "test",
        "test",
        testGame(root, identity.policy.testSuite, timeoutMs, identity.revision),
      );
    });
  /**
   * One iteration, one lock. Every stage records its own qualification result
   * through the same core the individual tools use; this method only sequences
   * them and refuses to let stages that covered different sources count as one
   * verification.
   */
  const verifyGame = (root: string, input: GameVerifyInput, runId: string | null) =>
    Effect.gen(function* () {
      const issues = verifyInputIssues(input);
      if (issues.length > 0)
        return yield* new GameOperationError({
          operation: "verify",
          path: root,
          reason: "invalid-input",
          detail: issues.join("\n"),
        });
      yield* refuseWhileUnapproved(root, "verify");
      // Pointer bounds need the base viewport. Reading project settings costs no
      // engine work, so a mistake here never becomes a build. The playtest
      // rechecks the same bounds against the exported artifact.
      const pointer = yield* Effect.gen(function* () {
        const manifest = yield* projects.read(root);
        const pointerBackend = yield* gameEngine.backendFor(manifest.engine.name);
        const project = yield* Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(
              root,
              pointerBackend.projectDirectory(manifest),
              pointerBackend.projectSettingsFile,
            ),
            "utf8",
          ).catch(() => null),
        );
        if (project === null) return [];
        const baseViewport = pointerBackend.projectSettings(project).viewport;
        const capture = playtestCapture(baseViewport, input);
        return capture === null ? [captureIssue(baseViewport)] : pointerIssues(input, capture);
      });
      if (pointer.length > 0)
        return yield* new GameOperationError({
          operation: "verify",
          path: root,
          reason: "invalid-input",
          detail: pointer.join("\n"),
        });
      const completed: GameVerifyStage[] = [];

      const check = yield* checkGame(root);
      const checkRecord = yield* qualification.stageRecord(root, "check");
      if (!check.ok)
        return {
          success: false,
          message:
            "Stopped at the Godot check; the canonical test, Web export and playtest did not run. Check returned the exact errors.",
          completed,
          failedStage: "check" as const,
          check,
          screenshots: [],
        } satisfies GameVerifyResult;
      if (checkRecord === null || checkRecord.outcome !== "passed" || checkRecord.sourceId === null)
        return {
          success: false,
          message: `Stopped at the Godot check: ${checkRecord?.detail ?? "its qualification record is missing, so the result cannot be tied to the current sources."} The later stages did not run.`,
          completed,
          failedStage: "check" as const,
          check,
          screenshots: [],
        } satisfies GameVerifyResult;
      completed.push("check");

      const test = yield* canonicalTest(root);
      const testRecord = yield* qualification.stageRecord(root, "test");
      if (!test.success)
        return {
          success: false,
          message:
            "Stopped at the canonical test; the Web export and playtest did not run. The test result has the exact errors and log path.",
          completed,
          failedStage: "test" as const,
          check,
          test,
          screenshots: [],
        } satisfies GameVerifyResult;
      if (testRecord === null || testRecord.outcome !== "passed" || testRecord.sourceId === null)
        return {
          success: false,
          message: `Stopped at the canonical test: ${testRecord?.detail ?? "its qualification record is missing, so the result cannot be tied to the current sources."} The export and playtest did not run.`,
          completed,
          failedStage: "test" as const,
          check,
          test,
          screenshots: [],
        } satisfies GameVerifyResult;
      if (testRecord.sourceId !== checkRecord.sourceId)
        return {
          success: false,
          message:
            "Stopped at the canonical test: the game sources changed after the check, so that check does not cover this test. The export and playtest did not run; verify again on the current sources.",
          completed,
          failedStage: "test" as const,
          check,
          test,
          screenshots: [],
        } satisfies GameVerifyResult;
      completed.push("test");

      // An approved design with nonempty acceptance owns a scenario exam. The
      // same operation re-runs it here so a stale pass cannot certify edited
      // sources, and a failure stops before any export. Legacy, skipped and
      // no-acceptance games keep the original four stages.
      const stateManifest = yield* projects.read(root);
      const stateDesign = yield* designApprovals.snapshot(root, stateManifest);
      const needsState =
        stateDesign.read.state === "approved" &&
        stateDesign.record !== null &&
        (stateDesign.record.acceptance?.length ?? 0) > 0;
      let scenariosForResult: GameScenariosRunResult | undefined = undefined;
      let stateSourceId: string | null = null;
      if (needsState) {
        const scenarios = yield* scenariosRun(root);
        scenariosForResult = scenarios;
        const stateRecord = yield* qualification.stageRecord(root, "state");
        const stateDetail =
          stateRecord?.detail ?? scenarios.summary.detail ?? "the state exam did not pass.";
        if (!scenarios.ok || !scenarios.summary.passed)
          return {
            success: false,
            message: `Stopped at the state exam: ${scenarios.summary.detail} The Web export and playtest did not run.`,
            completed,
            failedStage: "state" as const,
            check,
            test,
            scenarios,
            screenshots: [],
          } satisfies GameVerifyResult;
        if (
          stateRecord === null ||
          stateRecord.outcome !== "passed" ||
          stateRecord.sourceId === null
        )
          return {
            success: false,
            message: `Stopped at the state exam: ${stateDetail} The export and playtest did not run.`,
            completed,
            failedStage: "state" as const,
            check,
            test,
            scenarios,
            screenshots: [],
          } satisfies GameVerifyResult;
        if (
          stateRecord.sourceId !== checkRecord.sourceId ||
          stateRecord.sourceId !== testRecord.sourceId
        )
          return {
            success: false,
            message:
              "Stopped at the state exam: the game sources changed after the check and canonical test, so those results do not cover this state result. The export and playtest did not run; verify again on the current sources.",
            completed,
            failedStage: "state" as const,
            check,
            test,
            scenarios,
            screenshots: [],
          } satisfies GameVerifyResult;
        if (stateDesign.record === null || stateRecord.designHash !== stateDesign.record.designHash)
          return {
            success: false,
            message:
              "Stopped at the state exam: the approved design changed while the exam ran, so this result does not grade the current acceptance. The export and playtest did not run; verify again on the current sources.",
            completed,
            failedStage: "state" as const,
            check,
            test,
            scenarios,
            screenshots: [],
          } satisfies GameVerifyResult;
        stateSourceId = stateRecord.sourceId;
        completed.push("state");
      }

      const exported = yield* webExport(root, runId);
      if (!exported.success)
        return {
          success: false,
          message:
            "Stopped at the Web export; the recorded playtest did not run. The export result has the exact errors and log path.",
          completed,
          failedStage: "export" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          screenshots: [],
        } satisfies GameVerifyResult;
      const exportRecord = yield* qualification.stageRecord(root, "export");
      const build =
        exportRecord !== null &&
        exportRecord.outcome === "passed" &&
        exportRecord.buildId !== null &&
        exportRecord.buildDirectory !== undefined
          ? {
              buildId: exportRecord.buildId,
              directory: exportRecord.buildDirectory,
              path: NodePath.join(root, exportRecord.buildDirectory, "index.html"),
            }
          : null;
      if (build === null || exportRecord === null)
        return {
          success: false,
          message:
            "Stopped at the Web export: the export reported success but no usable build record was written, so no playtest could be tied to its bytes.",
          completed,
          failedStage: "export" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          screenshots: [],
        } satisfies GameVerifyResult;
      if (exportRecord.sourceId !== checkRecord.sourceId)
        return {
          success: false,
          message:
            "Stopped at the Web export: the game sources changed after the check and canonical test, so that check does not cover this build. The recorded playtest did not run; verify again on the current sources.",
          completed,
          failedStage: "export" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          build,
          screenshots: [],
        } satisfies GameVerifyResult;
      if (stateSourceId !== null && exportRecord.sourceId !== stateSourceId)
        return {
          success: false,
          message:
            "Stopped at the Web export: the game sources changed after the state exam, so that exam does not cover this build. The recorded playtest did not run; verify again on the current sources.",
          completed,
          failedStage: "export" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          build,
          screenshots: [],
        } satisfies GameVerifyResult;
      completed.push("export");

      const played = yield* webPlaytest(root, input, runId, { buildId: build.buildId });
      const { screenshots, ...playtest } = played;
      const playtestRecord = yield* qualification.stageRecord(root, "playtest");
      // A playtest is only usable when its record names the same artifact, which
      // is what game_submit's submission facts read.
      if (playtestRecord === null || playtestRecord.buildId !== build.buildId)
        return {
          success: false,
          message:
            "The playtest finished but its record does not name the exported build, so submission facts cannot use it. Inspect the frames; run game_verify again.",
          completed,
          failedStage: "playtest" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          build,
          playtest,
          screenshots,
        } satisfies GameVerifyResult;
      // `success` is only the capture outcome: boot, input and pixels ran. The
      // exam's verdict lives on `qualifies`, which is what the recorded stage's
      // outcome holds, so a capture that missed required evidence must stop here.
      if (!played.success || played.qualifies !== true || playtestRecord.outcome !== "passed")
        return {
          success: false,
          message:
            played.success && played.qualifies !== true
              ? `The recorded playtest did not qualify: ${played.message}`
              : `The recorded playtest did not pass: ${played.message}`,
          completed,
          failedStage: "playtest" as const,
          check,
          test,
          ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
          export: exported,
          build,
          playtest,
          screenshots,
        } satisfies GameVerifyResult;
      completed.push("playtest");
      if (needsState) {
        const finalDesign = yield* designApprovals.snapshot(root, yield* projects.read(root));
        if (
          finalDesign.read.state !== "approved" ||
          finalDesign.record?.designHash !== stateDesign.record?.designHash
        )
          return {
            success: false,
            message:
              "The approved design changed after the state exam; these observations do not verify the current acceptance. Run game_verify again.",
            completed,
            failedStage: "state" as const,
            check,
            test,
            ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
            export: exported,
            build,
            playtest,
            screenshots,
          } satisfies GameVerifyResult;
      }
      return {
        success: true,
        message:
          scenariosForResult === undefined
            ? `Mechanical verification passed for build ${build.buildId}: check, canonical test, Web export and a recorded playtest of those exact bytes. This is not a quality verdict or all-criteria certification; inspect the frames, then submit the build you stand behind.`
            : `Mechanical verification passed for build ${build.buildId}: check, canonical test, state exam, Web export and a recorded playtest of those exact bytes. This is not a quality verdict, a visual check, or proof beyond the measured observations; inspect the frames, then submit the build you stand behind.`,
        completed,
        check,
        test,
        ...(scenariosForResult === undefined ? {} : { scenarios: scenariosForResult }),
        export: exported,
        build,
        playtest,
        screenshots,
      } satisfies GameVerifyResult;
    });
  /** Runs one engine test entry and returns its stage outcome. */
  const testGame = (root: string, script: string, timeoutMs: number, policyRevision?: string) =>
    Effect.gen(function* () {
      const { backend, godot, cwd, godotProject } = yield* engine(root);
      // The suite must have been the source Godot loaded, not a later edit.
      const before = yield* snapshot(root, godotProject);
      const result = yield* backend.runTestScript(
        { root, projectDir: cwd, projectName: godotProject, binary: godot },
        { scriptPath: script, timeoutMs },
      );
      const after = yield* snapshot(root, godotProject);
      const comparison = comparedSource(before, after, "test");
      return {
        value:
          comparison.kind === "current"
            ? result
            : { ...result, message: `${result.message} ${comparison.detail}` },
        record: {
          outcome: result.success
            ? comparison.kind === "current"
              ? ("passed" as const)
              : ("unknown" as const)
            : ("failed" as const),
          sourceId: comparison.kind === "current" ? comparison.sourceId : null,
          buildId: null,
          evidenceDirectory: null,
          ...(policyRevision === undefined ? {} : { policyRevision }),
          ...(comparison.kind === "current" ? {} : { detail: comparison.detail }),
        },
      };
    });
  /**
   * Redraws the asset set's contact sheet from the thumbnails on disk. A
   * missing or unreadable thumbnail is skipped, never an error: the sheet is
   * evidence for the builder, not a gate on the export that just landed.
   */
  const refreshContactSheet = (
    root: string,
  ): Effect.Effect<
    { readonly path: string | null; readonly warning: string | null },
    GameOperationError
  > =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const thumbnails: Array<{ readonly id: string; readonly png: Buffer }> = [];
      const assets = manifest.assets.filter((asset) => asset.thumbnail !== undefined);
      for (const asset of assets.slice(-MAX_CONTACT_SHEET_THUMBNAILS)) {
        const bytes = yield* Effect.promise(() =>
          NodeFSP.readFile(insideGame(root, asset.thumbnail!)).catch(() => null),
        );
        if (bytes !== null) thumbnails.push({ id: asset.id, png: bytes });
      }
      if (thumbnails.length === 0) return { path: null, warning: null };
      const relative = "art/previews/contact_sheet.png";
      yield* Effect.try({
        try: () => composeContactSheet({ thumbnails }),
        catch: (cause) =>
          new GameOperationError({
            operation: "blender-contact-sheet",
            path: relative,
            reason: "io",
            cause,
          }),
      }).pipe(
        Effect.flatMap((sheet) =>
          Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(NodePath.dirname(insideGame(root, relative)), {
                recursive: true,
              });
              await NodeFSP.writeFile(insideGame(root, relative), sheet.png);
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "blender-contact-sheet",
                path: relative,
                reason: "io",
                cause,
              }),
          }),
        ),
      );
      return {
        path: relative,
        warning:
          assets.length > MAX_CONTACT_SHEET_THUMBNAILS
            ? `The contact sheet shows the latest ${MAX_CONTACT_SHEET_THUMBNAILS} of ${assets.length} assets to bound memory use.`
            : null,
      };
    });

  // A restart never keeps a session: the process owns them, and shutdown
  // releases the one live browser instead of leaking it.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const live = exploreLive;
      if (live !== null)
        yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
    }),
  );
  // Idle and wall-clock expiry without a caller: one scoped fiber sweeps the
  // single live session. Production timers own it; tests drive it with a
  // TestClock, and every act/close also checks the same deadlines lazily.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.seconds(30));
        yield* exploreReap;
      }
    }),
  );
  return GameService.of({
    events: operations.events,
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
        const live = exploreLive;
        if (live !== null && live.root === root)
          yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
        // A user turn that was cancelled supersedes the round it was repairing;
        // the round is persisted terminal so a later restart cannot revive it.
        yield* rounds.stopRunning(
          root,
          "The user's turn was cancelled, so the open repair round was stopped and its candidate is not selected.",
        );
      }
    }),
    status: Effect.fn("GameService.status")(function* (threadId, statusOptions) {
      const root = yield* projects.resolve(threadId);
      // Qualification first: its source snapshot is also the inventory cache
      // key, so a status read that finds unchanged sources does no file walk
      // beyond the snapshot it already needed for freshness.
      const manifest = yield* projects.read(root);
      const designSnapshot = yield* designApprovals.snapshot(root, manifest);
      const design = designSnapshot.read;
      // The record this read used; a separate read could observe a newer
      // automatic revision and bind the exam to a different design.
      const approval = designSnapshot.record;
      const policy = yield* designApprovals.readPolicy(root, manifest);
      const qualificationRead = yield* qualification.read(
        root,
        manifest.godotProject,
        design.state,
        approval?.designHash ?? null,
        { policyRevision: policy.revision, probeRequired: policy.policy.probe },
        approval?.acceptance ?? design.acceptance,
      );
      const inventory = yield* projects.inventory(root, qualificationRead.sourceId);
      const roundState = yield* rounds.read(root);
      const selected = roundState.selected;
      const selectedPresent =
        selected === null
          ? null
          : yield* Effect.promise(async () => {
              // Cheap structural check for status polling: a missing or empty
              // artifact file must read as stale. Byte identity is checked when
              // Play actually opens the build, not on every poll.
              for (const name of ["index.html", "index.js", "index.wasm", "index.pck"]) {
                const stat = await NodeFSP.stat(
                  NodePath.join(root, selected.directory, name),
                ).catch(() => null);
                if (stat === null || !stat.isFile() || stat.size === 0) return false;
              }
              return true;
            });
      // The inventory reports what exists under builds/, but Play follows the
      // selected record. Name that build honestly: a stale candidate export must
      // not make the served build look newer than it is. With nothing selected,
      // only the legacy mutable build can be played; candidates are evidence.
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
                updatedAt: selected.promotedAt,
              },
            ];
      const legacyExport = qualificationRead.stages.find((stage) => stage.stage === "export");
      const legacyBuildCurrent =
        selected === null &&
        (legacyExport?.buildDirectory ?? WEB_BUILD_DIRECTORY) === WEB_BUILD_DIRECTORY &&
        // A candidate export record is evidence about the challenger, not the
        // legacy build Play would fall back to.
        (yield* webBuildIsCurrent(qualificationRead));
      // Play identity is a byte question, and hashing every source (Blender
      // originals included) is not a status read's job: polls, pushes and every
      // MCP status call would read the whole tree. Status reports the cheap
      // answer, `unknown`, and only an explicit check pays for the bytes. Round
      // decisions take their own uncached capture.
      const sourcesDifferFromPlay: boolean | "unknown" =
        selected === null
          ? false
          : statusOptions?.checkSources !== true
            ? "unknown"
            : yield* rounds.sourceId(root).pipe(
                Effect.map((sourceId): boolean | "unknown" => sourceId !== selected.sourceId),
                // An unreadable tree cannot be shown to match, but it is also
                // not proven to differ.
                Effect.catch(() => Effect.succeed("unknown" as const)),
              );
      const playtestStage = qualificationRead.stages.find((stage) => stage.stage === "playtest");
      const lastPlaytest = yield* Effect.tryPromise({
        try: () =>
          // The approved exam the cover selection reads the same way the
          // playtest stage did: unapproved drafts prove nothing.
          readLastPlaytest(
            root,
            builds,
            design.state === "approved" ? (approval?.acceptance ?? design.acceptance) : null,
          ),
        catch: () =>
          new GameOperationError({
            operation: "read-playtest",
            path: NodePath.join(root, "builds/playtests"),
            reason: "io",
          }),
      }).pipe(
        Effect.orElseSucceed(() => null),
        // Qualification owns freshness: a run that qualified is current only
        // while its recorded source and build still match the game. A run that
        // failed the exam already says so through `qualifies`; marking it stale
        // too would claim its build changed, which may be false.
        Effect.map((playtest) =>
          playtest === null
            ? null
            : {
                ...playtest,
                stale:
                  playtest.qualifies === false
                    ? playtest.stale
                    : playtestStage?.status !== "passed",
              },
        ),
      );
      // Status observes the preview; it never switches it. Promotion owns the
      // switch (and its event), so a status read that started against an older
      // selection cannot move Play back, and a stopped preview stays stopped.
      const previewUrl = preview.url(root);
      return {
        root,
        ...inventory,
        builds,
        design,
        // What Play would show, not what the last export produced: a good
        // candidate export does not make the selected build fresh, and a source
        // edit does not make the selected artifact unplayable.
        webBuildStale: selected !== null ? !selectedPresent : !legacyBuildCurrent,
        selectedBuildId: selected?.buildId ?? null,
        selectedArtifactUsable: selectedPresent,
        // Usability and source freshness are separate answers: the selected
        // build can be perfectly playable while the editable sources have moved
        // on, which is the normal state during a review round.
        sourcesDifferFromPlay,
        qualification: qualificationRead,
        toolchain: yield* tools.status,
        processes: processes.list(root),
        previewUrl,
        logsDirectory: NodePath.join(root, "builds/logs"),
        lastPlaytest,
        production: productionStatus({
          production: roundState.production ?? null,
          budgetMs: gameProductionBudgetMs(manifest),
          activeRun: yield* projects.activeRun(threadId),
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        }),
        operation: operations.current(root),
      };
    }),
    promote: (threadId, roundId, options) =>
      withRoot(threadId, "Promote build", (root) =>
        rounds.promote(root, roundId, {
          guard: options?.guard,
          serve: (selected) =>
            Effect.gen(function* () {
              // Only an already-open preview follows the promotion. A game whose
              // preview was never used stays quiet: opening a server is Play's
              // decision, not a promotion's, and a stopped one stays stopped.
              if (preview.url(root) === null) return;
              // The selection is committed. A preview that cannot open is not a
              // failed promotion; the next Play call reports that honestly.
              yield* preview.select(root, selected.directory).pipe(Effect.ignore);
            }),
        }),
      ),
    import: (threadId) => withRoot(threadId, "Import", importGame),
    export: (threadId, target, options) =>
      withRoot(threadId, `Export ${target}`, (root) =>
        target === "Web"
          ? Effect.gen(function* () {
              const exporter = yield* exporterRun(threadId);
              return yield* webExport(root, exporter, options?.roundId);
            })
          : Effect.gen(function* () {
              yield* refuseWhileUnapproved(root, "export");
              // Only a Web export can be a repair round's challenger, so a
              // non-Web export naming one is as invalid as an expired round:
              // never let it silently become a publish.
              if (options?.roundId !== undefined)
                return yield* new GameOperationError({
                  operation: `Export ${target}`,
                  path: root,
                  reason: "invalid-input",
                  detail:
                    "That repair round is no longer running; its export was not published or recorded.",
                });
              return yield* exportGame(root, target, { mode: "publish" }, null);
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
          const state = yield* rounds.read(root);
          const selected = state.selected;
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
        const selected = (yield* rounds.read(root)).selected;
        const path = webPackageArchivePath(root, buildId);
        if (selected === null || selected.buildId !== buildId)
          return yield* new GameOperationError({
            operation: "Download Web package",
            path,
            reason: "download",
            detail:
              "The selected Web build changed after this download link was created. Open Builds and download the package for the selected build.",
          });
        const opened = yield* openMediaFile(path).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "Download Web package",
                path,
                reason: "io",
                detail: "The Web package could not be opened.",
                cause,
              }),
          ),
        );
        if (opened === null)
          return yield* new GameOperationError({
            operation: "Download Web package",
            path,
            reason: "download",
            detail:
              "No complete Web package is ready for the selected build. Open Builds, then choose Download package on the selected Web build.",
          });
        const verified = yield* Effect.tryPromise({
          try: () => hashOpenFile(opened),
          catch: (cause) =>
            new GameOperationError({
              operation: "Download Web package",
              path,
              reason: "io",
              detail: "The Web package could not be read.",
              cause,
            }),
        });
        const after = yield* Effect.tryPromise({
          try: () => opened.handle.stat({ bigint: true }),
          catch: (cause) =>
            new GameOperationError({
              operation: "Download Web package",
              path,
              reason: "io",
              detail: "The Web package could not be checked.",
              cause,
            }),
        });
        if (BigInt(verified.bytes) !== after.size || verified.sha256 !== packageSha256)
          return yield* new GameOperationError({
            operation: "Download Web package",
            path,
            reason: "checksum",
            detail:
              "The Web package changed after this download link was created. Open Builds, then choose Download package again.",
          });
        return {
          path,
          fileName: WEB_PACKAGE_FILE,
          bytes: verified.bytes,
          sha256: verified.sha256,
          identity: { device: after.dev.toString(), inode: after.ino.toString() },
        };
      }).pipe(Effect.scoped),
    windowsPackageFile: (threadId, packageSha256) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const path = windowsPackageArchivePath(root);
        const opened = yield* openMediaFile(path).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "Download Windows package",
                path,
                reason: "io",
                detail: "The Windows package could not be opened.",
                cause,
              }),
          ),
        );
        if (opened === null)
          return yield* new GameOperationError({
            operation: "Download Windows package",
            path,
            reason: "download",
            detail:
              "No Windows package is ready. Open Builds, then choose Download package on the Windows build.",
          });
        const verified = yield* Effect.tryPromise({
          try: () => hashOpenFile(opened),
          catch: (cause) =>
            new GameOperationError({
              operation: "Download Windows package",
              path,
              reason: "io",
              detail: "The Windows package could not be read.",
              cause,
            }),
        });
        const after = yield* Effect.tryPromise({
          try: () => opened.handle.stat({ bigint: true }),
          catch: (cause) =>
            new GameOperationError({
              operation: "Download Windows package",
              path,
              reason: "io",
              detail: "The Windows package could not be checked.",
              cause,
            }),
        });
        if (BigInt(verified.bytes) !== after.size || verified.sha256 !== packageSha256)
          return yield* new GameOperationError({
            operation: "Download Windows package",
            path,
            reason: "checksum",
            detail:
              "The Windows package changed after this download link was created. Open Builds, then choose Download package again.",
          });
        return {
          path,
          fileName: WINDOWS_PACKAGE_FILE,
          bytes: verified.bytes,
          sha256: verified.sha256,
          identity: { device: after.dev.toString(), inode: after.ino.toString() },
        };
      }).pipe(Effect.scoped),
    native: (threadId, options) =>
      withRoot(threadId, "Native game", (root) =>
        Effect.andThen(
          refuseWhileUnapproved(root, "native"),
          // Default to headless: a caller that did not ask to watch a window
          // must never inherit the creator's display.
          nativeGame(root, options?.display ?? "headless"),
        ),
      ),
    webPlaytest: (threadId, input) =>
      withRoot(threadId, "Web playtest", (root) =>
        Effect.andThen(
          refuseWhileUnapproved(root, "web-playtest"),
          Effect.flatMap(exporterRun(threadId), (runId) =>
            webPlaytest(
              root,
              input,
              runId,
              // The public exact-size option is review evidence, so the server
              // allocates its folder and the run never becomes the build's
              // recorded playtest. The caller never names a filesystem path.
              input.exactSize === true
                ? {
                    reviewEvidenceDirectory: `builds/review-evidence/${NodeCrypto.randomUUID()}`,
                  }
                : {},
            ),
          ),
        ),
      ),
    webPlaytestBuild: (threadId, buildId, input, experimentDirectory, imageResponse, internal) =>
      withRoot(threadId, "Web playtest", (root) =>
        webPlaytest(root, input, null, {
          buildId,
          ...(experimentDirectory === undefined ? {} : { experimentDirectory }),
          ...(imageResponse === undefined ? {} : { imageResponse }),
          ...(internal?.captureFromStep === undefined
            ? {}
            : { captureFromStep: internal.captureFromStep }),
        }),
      ),
    exploreStart: (threadId, input) => exploreStart(threadId, input),
    exploreAct: (threadId, input) => exploreAct(threadId, input),
    exploreClose: (threadId, input) => exploreClose(threadId, input),
    exploreReplay: (threadId, input) => exploreReplay(threadId, input),
    verify: (threadId, input) =>
      withRoot(threadId, "Game verify", (root) =>
        Effect.gen(function* () {
          const exporter = yield* exporterRun(threadId);
          return yield* verifyGame(root, input, exporter);
        }),
      ),
    check: (threadId) => withRoot(threadId, "Godot check", checkGame),
    scenariosRun: (threadId) => withRoot(threadId, "Godot scenarios", scenariosRun),
    nativeCapture: (threadId, input) =>
      withRoot(threadId, "Native capture", (root) => nativeCapture(root, input)),
    runtimeCalibrate: (threadId, input) =>
      withRoot(threadId, "Runtime calibration", (root) => runtimeCalibrate(root, input)),
    inspectScene: (threadId, scenePath) =>
      withRoot(threadId, "Inspect scene", (root) => inspectScene(root, scenePath)),
    godotApi: (threadId, input) => withRoot(threadId, "Godot API", (root) => godotApi(root, input)),
    assetsInspect: (threadId, input) =>
      withRoot(threadId, "Inspect assets", (root) => assetsInspect(root, input)),
    audioInspect: (threadId, input) =>
      withRoot(threadId, "Inspect audio", (root) => audioInspect(root, input)),
    importArtKit: (threadId, input) =>
      withRoot(threadId, "Import art kit", (root) =>
        Effect.gen(function* () {
          // Art is building work: a reviewed draft and a changed design are the
          // same gate as Blender, export and playtest. The manifest supplies the
          // engine project path, never a destination from the caller.
          yield* refuseWhileUnapproved(root, "import-art-kit");
          const manifest = yield* projects.read(root);
          return yield* artKits.install({
            root,
            godotProject: manifest.godotProject,
            id: input.id,
          });
        }),
      ),
    buildArtFrames: (threadId, input) =>
      withRoot(threadId, "Build sprite frames", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "build-art-frames");
          const manifest = yield* projects.read(root);
          const kit = (yield* artKits.get({ id: input.id }).pipe(
            Effect.mapError(
              (error) =>
                new GameOperationError({
                  operation: "build-art-frames",
                  path: input.id,
                  reason: "unknown-art-kit",
                  detail: `Available ids: ${error.availableIds.join(", ")}.`,
                }),
            ),
          )).kit;
          const sheet = kit.additionalSheets.find((entry) => entry.name === input.sheet);
          if (sheet === undefined) {
            const names = kit.additionalSheets.map((entry) => entry.name);
            return yield* new GameOperationError({
              operation: "build-art-frames",
              path: input.sheet,
              reason: "invalid-input",
              detail:
                names.length === 0
                  ? `Kit '${kit.id}' ships no animated sheets; use the atlas region layout from game_art_get instead.`
                  : `Kit '${kit.id}' has no sheet named '${input.sheet}'. Available sheets: ${names.join(", ")}.`,
            });
          }
          const authored = sheet.animations ?? [];
          if (authored.length === 0)
            return yield* new GameOperationError({
              operation: "build-art-frames",
              path: sheet.image,
              reason: "invalid-input",
              detail: `Sheet '${sheet.name}' carries no authored animations; use its cell regions from game_art_get instead of inventing frames.`,
            });
          const wanted = input.animations ?? authored.map((entry) => entry.name);
          const unknown = wanted.filter((name) => !authored.some((entry) => entry.name === name));
          if (unknown.length > 0)
            return yield* new GameOperationError({
              operation: "build-art-frames",
              path: unknown.join(", "),
              reason: "invalid-input",
              detail: `Unknown animations for sheet '${sheet.name}': ${unknown.join(", ")}. Available: ${authored.map((entry) => entry.name).join(", ")}.`,
            });
          const animations = authored.filter((entry) => wanted.includes(entry.name));
          // Frames derive from the installed kit bytes, never from edited art:
          // a missing or re-decoded sheet fails here instead of blessing a mix.
          const kitRelative = `assets/art/kits/${kit.id}`;
          const destinationRelative = `${manifest.godotProject}/${kitRelative}`;
          const imageRelative = `${destinationRelative}/${sheet.image}`;
          const sheetBytes = yield* Effect.tryPromise({
            try: () => NodeFSP.readFile(insideGame(root, imageRelative)),
            catch: (cause) =>
              new GameOperationError({
                operation: "build-art-frames",
                path: imageRelative,
                reason: "invalid-path",
                detail: `Import the '${kit.id}' kit first with game_art_import, then build its frames.`,
                cause,
              }),
          });
          const decoded = yield* Effect.try({
            try: () => {
              const png = PNG.sync.read(sheetBytes);
              return { width: png.width, height: png.height };
            },
            catch: (cause) =>
              new GameOperationError({
                operation: "build-art-frames",
                path: imageRelative,
                reason: "art-kit-corrupt",
                detail: `The installed ${sheet.image} does not decode as a PNG; re-import the kit.`,
                cause,
              }),
          });
          if (decoded.width !== sheet.imageWidth || decoded.height !== sheet.imageHeight)
            return yield* new GameOperationError({
              operation: "build-art-frames",
              path: imageRelative,
              reason: "art-kit-corrupt",
              detail: `The installed ${sheet.image} is ${decoded.width}x${decoded.height} but the catalog declares ${sheet.imageWidth}x${sheet.imageHeight}; re-import the kit.`,
            });
          // The sheet texture must be imported before a headless script loads
          // it, the same import every engine run starts from.
          const { godot, cwd } = yield* engine(root);
          const imported = yield* importGame(root);
          if (!imported.success)
            return yield* new GameOperationError({
              operation: "build-art-frames",
              path: imported.path ?? root,
              reason: "command-failed",
              detail:
                `The project import failed, so no frames were built.\n${imported.message}`.slice(
                  -4096,
                ),
            });
          const temporary = NodePath.join(
            root,
            "builds/logs",
            `art-frames-${NodeCrypto.randomUUID()}`,
          );
          const variant =
            animations.length === authored.length
              ? ""
              : `_${NodeCrypto.createHash("sha256")
                  .update(animations.map((entry) => entry.name).join("\0"))
                  .digest("hex")
                  .slice(0, 12)}`;
          const framesBase = `${sheet.name}${variant}_frames.tres`;
          const framesRelative = `${destinationRelative}/${framesBase}`;
          const framesResPath = `res://${kitRelative}/${framesBase}`;
          const built = yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(temporary, { recursive: true });
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "build_frames.gd"),
                  GODOT_ART_FRAMES_SCRIPT,
                );
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "request.json"),
                  encodeFramesRequest({
                    imageResPath: `res://${kitRelative}/${sheet.image}`,
                    existingPath: framesResPath,
                    tileWidth: sheet.tileWidth,
                    tileHeight: sheet.tileHeight,
                    columns: sheet.columns,
                    rows: sheet.rows,
                    tileCount: sheet.tileCount,
                    margin: sheet.margin,
                    spacing: sheet.spacing,
                    animations: animations.map((entry) => ({
                      name: entry.name,
                      cells: entry.cells.map((cell) => ({ col: cell.col, row: cell.row })),
                      fps: entry.fps,
                      loop: entry.loop,
                    })),
                    outputPath: NodePath.join(temporary, framesBase),
                  }),
                );
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "build-art-frames",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const result = yield* processes.run({
              root,
              executable: godot.path,
              args: [
                "--headless",
                "--path",
                cwd,
                "--script",
                NodePath.join(temporary, "build_frames.gd"),
                "--",
                NodePath.join(temporary, "request.json"),
                NodePath.join(temporary, "result.json"),
              ],
              operation: "build-art-frames",
              timeoutMs: 120_000,
            });
            const text = yield* Effect.tryPromise({
              try: () =>
                NodeFSP.readFile(NodePath.join(temporary, "result.json"), "utf8").catch(() => null),
              catch: (cause) =>
                new GameOperationError({
                  operation: "build-art-frames",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const outcome = yield* Effect.try({
              try: () => (text === null ? null : decodeFramesResult(text)),
              catch: (cause) =>
                new GameOperationError({
                  operation: "build-art-frames",
                  path: result.logPath,
                  reason: "command-failed",
                  detail: "The frames script returned an unreadable result.",
                  cause,
                }),
            });
            if (result.exitCode !== 0 || outcome === null || outcome.animations === undefined) {
              const scriptError = outcome?.error ?? null;
              return yield* new GameOperationError({
                operation: "build-art-frames",
                path: result.logPath,
                reason: "command-failed",
                detail: (scriptError ?? commandDetail(result)).slice(-4096),
              });
            }
            if (outcome.reused !== true)
              yield* Effect.tryPromise({
                try: async () => {
                  const staged = NodePath.join(temporary, framesBase);
                  const destination = insideGame(root, framesRelative);
                  try {
                    await NodeFSP.link(staged, destination);
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
                    const [before, after] = await Promise.all([
                      NodeFSP.readFile(destination),
                      NodeFSP.readFile(staged),
                    ]);
                    if (!before.equals(after))
                      throw new GameOperationError({
                        operation: "build-art-frames",
                        path: framesRelative,
                        reason: "art-kit-conflict",
                        detail:
                          "The existing frames resource differs from the generated resource. Move it aside to regenerate; it was not overwritten.",
                      });
                  }
                },
                catch: (cause) =>
                  isGameOperationError(cause)
                    ? cause
                    : new GameOperationError({
                        operation: "build-art-frames",
                        path: framesRelative,
                        reason: "io",
                        cause,
                      }),
              });
            const built = outcome.animations;
            return built;
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
            ),
          );
          const summary = built.map((entry) => ({
            name: entry.name,
            frames: entry.frames,
            fps: entry.fps,
            loop: entry.loop,
          }));
          return {
            kit: {
              id: kit.id,
              version: kit.version,
              name: kit.name,
              summary: kit.summary,
              styles: kit.styles,
              contents: kit.contents,
              license: kit.license,
              source: kit.source,
              atlas: kit.atlas,
              additionalSheets: kit.additionalSheets,
              usage: kit.usage,
            },
            sheet: sheet.name,
            framesPath: framesRelative,
            framesResPath,
            animations: summary,
            license: kit.license,
            source: kit.source,
            message: `Built ${summary.length} animations (${summary.map((entry) => entry.name).join(", ")}) into ${framesRelative} from the '${kit.name}' sheet '${sheet.name}'. Use it with AnimatedSprite2D: sprite_frames = load("${framesResPath}"). Pixel art stays crisp at whole-number scales with nearest filtering. License: ${kit.license.name} — ${kit.license.attribution}. Source: ${kit.source.title} (${kit.source.url}).`,
          };
        }),
      ),
    importLibraryModel: (threadId, input) =>
      withRoot(threadId, "Import library model", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "import-library-model");
          const manifest = yield* projects.read(root);
          const slug = input.id;
          if (!/^[A-Za-z0-9_]{1,80}$/.test(slug))
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: slug,
              reason: "invalid-input",
              detail: `Library id '${slug}' is not a Poly Haven slug.`,
            });
          const resolution = input.resolution ?? "1k";
          if (resolution !== "1k" && resolution !== "2k")
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: slug,
              reason: "invalid-input",
              detail:
                "Resolution is 1k (default) or 2k; larger scans stay out of the bounded import.",
            });
          const detail = yield* library.get({ id: slug });
          if (detail.asset.type !== "model")
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: slug,
              reason: "invalid-input",
              detail: `Library asset '${slug}' is a ${detail.asset.type}, not a model; use game_library_import_material for textures.`,
            });
          const filesJson =
            resolution === "1k"
              ? null
              : ((yield* fetchLibraryJson(`https://api.polyhaven.com/files/${slug}`)) as unknown);
          const plan =
            filesJson === null
              ? { format: detail.defaultFormat, files: detail.files }
              : yield* Effect.try({
                  try: () => planModelFiles(slug, filesJson, resolution),
                  catch: (cause) =>
                    isGameOperationError(cause)
                      ? cause
                      : new GameOperationError({
                          operation: "import-library-model",
                          path: slug,
                          reason: "invalid-input",
                          cause,
                        }),
                });
          if (filesJson !== null)
            yield* Effect.try({
              try: () => checkBudgets(slug, plan.files),
              catch: (cause) =>
                isGameOperationError(cause)
                  ? cause
                  : new GameOperationError({
                      operation: "import-library-model",
                      path: slug,
                      reason: "invalid-input",
                      cause,
                    }),
            });
          const total = totalBytesOf(plan.files);
          const main = plan.files.find((file) => file.path.toLowerCase().endsWith(".gltf"));
          if (main === undefined)
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: slug,
              reason: "invalid-input",
              detail: `Library model '${slug}' has no glTF entry; its available formats are ${detail.availableFormats.join(", ") || "unknown"}.`,
            });
          const kitRelative = `assets/library/models/${slug}`;
          const destinationRelative = `${manifest.godotProject}/${kitRelative}`;
          const destination = insideGame(root, destinationRelative);
          const parent = NodePath.dirname(destination);
          const gameRoot = NodePath.resolve(root);
          // Reuse is byte-exact against the pinned MD5s: a retry writes
          // nothing, and creator edits refuse instead of being overwritten.
          const md5Of = async (path: string): Promise<string | null> => {
            try {
              const bytes = await NodeFSP.readFile(path);
              return NodeCrypto.createHash("md5").update(bytes).digest("hex");
            } catch {
              return null;
            }
          };
          const existingDir = yield* Effect.promise(() =>
            NodeFSP.lstat(destination).then(
              () => true,
              () => false,
            ),
          );
          if (existingDir) {
            const mismatches: Array<string> = [];
            for (const file of plan.files) {
              const md5 = yield* Effect.promise(() => md5Of(NodePath.join(destination, file.path)));
              if (md5 === null || md5.toLowerCase() !== file.md5.toLowerCase())
                mismatches.push(file.path);
            }
            if (mismatches.length === 0) {
              const gltfResPath = `res://${kitRelative}/${main.path}`;
              return {
                slug,
                destination: destinationRelative,
                files: yield* Effect.promise(async () => {
                  const out: Array<{
                    path: string;
                    resPath: string | null;
                    role: "gltf" | "bin" | "texture" | "material" | "provenance";
                    bytes: number;
                    sha256: string;
                  }> = [];
                  for (const file of plan.files) {
                    const abs = NodePath.join(destination, file.path);
                    const bytes = await NodeFSP.readFile(abs);
                    out.push({
                      path: `${destinationRelative}/${file.path}`,
                      resPath: `res://${kitRelative}/${file.path}`,
                      role: file.path.toLowerCase().endsWith(".gltf")
                        ? "gltf"
                        : file.path.toLowerCase().endsWith(".bin")
                          ? "bin"
                          : "texture",
                      bytes: bytes.byteLength,
                      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                    });
                  }
                  return out;
                }),
                gltfResPath,
                license: detail.asset.license,
                source: detail.asset.source,
                alreadyPresent: true,
                credit: detail.credit,
                message: `${detail.asset.name} is already imported unchanged at ${destinationRelative}; no files were written. Run game_godot_import before using it: var scene = load("${gltfResPath}"). License: ${detail.asset.license.name}. ${detail.credit}.`,
              };
            }
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: destination,
              reason: "art-kit-conflict",
              detail: `Existing files differ or are missing: ${mismatches.join(", ")}. Nothing was written; move ${destinationRelative} aside to re-import.`,
            });
          }
          const staging = yield* Effect.tryPromise({
            try: () =>
              NodeFSP.mkdtemp(
                NodePath.join(parent === destination ? gameRoot : parent, `.${slug}-`),
              ),
            catch: (cause) =>
              new GameOperationError({
                operation: "import-library-model",
                path: parent,
                reason: "io",
                cause,
              }),
          }).pipe(
            Effect.catchTags({
              GameOperationError: (cause) =>
                Effect.tryPromise({
                  try: () => NodeFSP.mkdtemp(NodePath.join(gameRoot, `.${slug}-`)),
                  catch: () => cause,
                }),
            }),
          );
          const published = yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => NodeFSP.mkdir(parent, { recursive: true }),
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-model",
                  path: parent,
                  reason: "io",
                  cause,
                }),
            });
            yield* downloadPlannedFiles(staging, plan.files, "import-library-model");
            // The staged .gltf parses, names only files the plan pinned, and
            // reads through the upstream glTF SDK; a malformed document
            // fails here, before anything publishes.
            const stagedGltf = yield* Effect.tryPromise({
              try: async () => {
                await checkStagedGltf(
                  staging,
                  main.path,
                  new Set(plan.files.map((file) => file.path)),
                );
                return true;
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-model",
                  path: main.path,
                  reason: "command-failed",
                  detail: `The staged glTF does not parse or names files outside the pinned plan: ${cause instanceof Error ? cause.message : String(cause)}.`,
                  cause,
                }),
            });
            if (!stagedGltf)
              return yield* new GameOperationError({
                operation: "import-library-model",
                path: main.path,
                reason: "command-failed",
              });
            yield* Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  try {
                    await NodeFSP.lstat(destination);
                    throw new GameOperationError({
                      operation: "import-library-model",
                      path: destination,
                      reason: "art-kit-conflict",
                      detail: `The destination appeared while downloading. Nothing was replaced.`,
                    });
                  } catch (cause) {
                    if (isGameOperationError(cause)) throw cause;
                    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
                  }
                  await NodeFSP.rename(staging, destination);
                },
                catch: (cause) =>
                  isGameOperationError(cause)
                    ? cause
                    : new GameOperationError({
                        operation: "import-library-model",
                        path: destination,
                        reason: "io",
                        cause,
                      }),
              }),
            );
            const provenance = provenanceMarkdown({
              slug,
              name: detail.asset.name,
              kind: "model",
              authors: detail.asset.authors,
              pageUrl: pageUrlOf(slug),
              files: plan.files,
              resolution,
              format: plan.format,
              retrievedAt: DateTime.formatIso(yield* DateTime.now).slice(0, 10),
            });
            const provenanceRelative = `art/library/models/${slug}/PROVENANCE.md`;
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(NodePath.dirname(insideGame(root, provenanceRelative)), {
                  recursive: true,
                });
                await NodeFSP.writeFile(insideGame(root, provenanceRelative), provenance, {
                  flag: "w",
                });
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-model",
                  path: provenanceRelative,
                  reason: "io",
                  cause,
                }),
            }).pipe(
              Effect.catchTags({
                GameOperationError: (cause) =>
                  Effect.logWarning(
                    "Library provenance could not be written; the model files are published.",
                    {
                      path: cause.path,
                    },
                  ).pipe(Effect.asVoid),
              }),
            );
            return true;
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
            ),
          );
          if (!published)
            return yield* new GameOperationError({
              operation: "import-library-model",
              path: slug,
              reason: "command-failed",
            });
          const gltfResPath = `res://${kitRelative}/${main.path}`;
          const installed = yield* Effect.promise(async () => {
            const out: Array<{
              path: string;
              resPath: string | null;
              role: "gltf" | "bin" | "texture" | "material" | "provenance";
              bytes: number;
              sha256: string;
            }> = [];
            for (const file of plan.files) {
              const bytes = await NodeFSP.readFile(NodePath.join(destination, file.path));
              out.push({
                path: `${destinationRelative}/${file.path}`,
                resPath: `res://${kitRelative}/${file.path}`,
                role: file.path.toLowerCase().endsWith(".gltf")
                  ? "gltf"
                  : file.path.toLowerCase().endsWith(".bin")
                    ? "bin"
                    : "texture",
                bytes: bytes.byteLength,
                sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              });
            }
            return out;
          });
          return {
            slug,
            destination: destinationRelative,
            files: installed,
            gltfResPath,
            license: detail.asset.license,
            source: detail.asset.source,
            alreadyPresent: false,
            credit: detail.credit,
            message: `Imported ${detail.asset.name} (${resolution} glTF, ${(total / 1024).toFixed(0)} KB) into ${destinationRelative}. Load it with load("${gltfResPath}"); its PBR textures travel beside it. Run game_godot_import before using it. License: ${detail.asset.license.name} — ${detail.asset.license.attribution}. Source: ${detail.asset.source.title} (${detail.asset.source.url}). ${detail.credit}.`,
          };
        }),
      ),
    importLibraryMaterial: (threadId, input) =>
      withRoot(threadId, "Import library material", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "import-library-material");
          const manifest = yield* projects.read(root);
          const slug = input.id;
          if (!/^[A-Za-z0-9_]{1,80}$/.test(slug))
            return yield* new GameOperationError({
              operation: "import-library-material",
              path: slug,
              reason: "invalid-input",
              detail: `Library id '${slug}' is not a Poly Haven slug.`,
            });
          const resolution = input.resolution ?? "1k";
          if (resolution !== "1k" && resolution !== "2k")
            return yield* new GameOperationError({
              operation: "import-library-material",
              path: slug,
              reason: "invalid-input",
              detail:
                "Resolution is 1k (default) or 2k; larger scans stay out of the bounded import.",
            });
          const detail = yield* library.get({ id: slug });
          if (detail.asset.type !== "texture")
            return yield* new GameOperationError({
              operation: "import-library-material",
              path: slug,
              reason: "invalid-input",
              detail: `Library asset '${slug}' is a ${detail.asset.type}, not a PBR texture; use game_library_import_model for models.`,
            });
          const filesJson =
            resolution === "1k"
              ? null
              : ((yield* fetchLibraryJson(`https://api.polyhaven.com/files/${slug}`)) as unknown);
          const plan =
            filesJson === null
              ? { format: detail.defaultFormat, files: detail.files }
              : yield* Effect.try({
                  try: () => planMaterialFiles(slug, filesJson, resolution),
                  catch: (cause) =>
                    isGameOperationError(cause)
                      ? cause
                      : new GameOperationError({
                          operation: "import-library-material",
                          path: slug,
                          reason: "invalid-input",
                          cause,
                        }),
                });
          if (filesJson !== null)
            yield* Effect.try({
              try: () => checkBudgets(slug, plan.files),
              catch: (cause) =>
                isGameOperationError(cause)
                  ? cause
                  : new GameOperationError({
                      operation: "import-library-material",
                      path: slug,
                      reason: "invalid-input",
                      cause,
                    }),
            });
          const total = totalBytesOf(plan.files);
          const kitRelative = `assets/library/materials/${slug}`;
          const destinationRelative = `${manifest.godotProject}/${kitRelative}`;
          const destination = insideGame(root, destinationRelative);
          const parent = NodePath.dirname(destination);
          const gameRoot = NodePath.resolve(root);
          const albedo = plan.files[0]!;
          const normal = plan.files[1]!;
          const roughness = plan.files[2]!;
          const tresBase = `${slug}_${resolution}.tres`;
          const tresRelative = `${destinationRelative}/${tresBase}`;
          const tresResPath = `res://${kitRelative}/${tresBase}`;
          const md5Of = async (path: string): Promise<string | null> => {
            try {
              const bytes = await NodeFSP.readFile(path);
              return NodeCrypto.createHash("md5").update(bytes).digest("hex");
            } catch {
              return null;
            }
          };
          const texturesMatch = yield* Effect.promise(async () => {
            for (const file of plan.files) {
              const md5 = await md5Of(NodePath.join(destination, file.path));
              if (md5 === null || md5.toLowerCase() !== file.md5.toLowerCase()) return false;
            }
            return true;
          });
          // Textures reuse byte-exact; the .tres itself is judged by the
          // engine script below, so an edited material refuses there instead
          // of reading back as already present here.
          if (!texturesMatch) {
            const preExists = yield* Effect.promise(() =>
              NodeFSP.lstat(destination).then(
                () => true,
                () => false,
              ),
            );
            if (preExists)
              return yield* new GameOperationError({
                operation: "import-library-material",
                path: destination,
                reason: "art-kit-conflict",
                detail: `Existing files under ${destinationRelative} differ from the pinned 1k plan. Nothing was written; move the folder aside to re-import.`,
              });
            const staging = yield* Effect.tryPromise({
              try: () => NodeFSP.mkdtemp(NodePath.join(gameRoot, `.${slug}-`)),
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-material",
                  path: gameRoot,
                  reason: "io",
                  cause,
                }),
            });
            yield* Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => NodeFSP.mkdir(parent, { recursive: true }),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "import-library-material",
                    path: parent,
                    reason: "io",
                    cause,
                  }),
              });
              yield* downloadPlannedFiles(staging, plan.files, "import-library-material");
              yield* Effect.tryPromise({
                try: async () => {
                  for (const file of plan.files) {
                    const bytes = await NodeFSP.readFile(NodePath.join(staging, file.path));
                    if (bytes.byteLength === 0) throw new Error(`empty '${file.path}'`);
                    if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
                      throw new Error(`not JPEG '${file.path}'`);
                  }
                },
                catch: (cause) =>
                  new GameOperationError({
                    operation: "import-library-material",
                    path: staging,
                    reason: "command-failed",
                    detail: `A staged texture does not decode: ${cause instanceof Error ? cause.message : String(cause)}.`,
                    cause,
                  }),
              });
              yield* Effect.uninterruptible(
                Effect.tryPromise({
                  try: async () => {
                    await NodeFSP.rename(staging, destination);
                  },
                  catch: (cause) =>
                    new GameOperationError({
                      operation: "import-library-material",
                      path: destination,
                      reason: "io",
                      cause,
                    }),
                }),
              );
            }).pipe(
              Effect.ensuring(
                Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true })),
              ),
            );
            const provenance = provenanceMarkdown({
              slug,
              name: detail.asset.name,
              kind: "material",
              authors: detail.asset.authors,
              pageUrl: pageUrlOf(slug),
              files: plan.files,
              resolution,
              format: plan.format,
              retrievedAt: DateTime.formatIso(yield* DateTime.now).slice(0, 10),
            });
            const provenanceRelative = `art/library/materials/${slug}/PROVENANCE.md`;
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(NodePath.dirname(insideGame(root, provenanceRelative)), {
                  recursive: true,
                });
                await NodeFSP.writeFile(insideGame(root, provenanceRelative), provenance, {
                  flag: "w",
                });
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-material",
                  path: provenanceRelative,
                  reason: "io",
                  cause,
                }),
            }).pipe(
              Effect.catchTags({
                GameOperationError: () => Effect.void,
              }),
            );
          }
          const { godot, cwd } = yield* engine(root);
          const imported = yield* importGame(root);
          if (!imported.success)
            return yield* new GameOperationError({
              operation: "import-library-material",
              path: imported.path ?? root,
              reason: "command-failed",
              detail:
                `The project import failed, so no material was built.\n${imported.message}`.slice(
                  -4096,
                ),
            });
          const temporary = NodePath.join(
            root,
            "builds/logs",
            `asset-material-${NodeCrypto.randomUUID()}`,
          );
          const built = yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(temporary, { recursive: true });
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "build_material.gd"),
                  GODOT_ASSET_MATERIAL_SCRIPT,
                );
                await NodeFSP.writeFile(
                  NodePath.join(temporary, "request.json"),
                  encodeMaterialRequest({
                    albedoResPath: `res://${kitRelative}/${albedo.path}`,
                    normalResPath: `res://${kitRelative}/${normal.path}`,
                    roughnessResPath: `res://${kitRelative}/${roughness.path}`,
                    existingPath: tresResPath,
                    materialName: slug,
                    metallic: 0,
                    uvScale: [1, 1],
                    outputPath: NodePath.join(temporary, tresBase),
                  }),
                );
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-material",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const result = yield* processes.run({
              root,
              executable: godot.path,
              args: [
                "--headless",
                "--path",
                cwd,
                "--script",
                NodePath.join(temporary, "build_material.gd"),
                "--",
                NodePath.join(temporary, "request.json"),
                NodePath.join(temporary, "result.json"),
              ],
              operation: "import-library-material",
              timeoutMs: 120_000,
            });
            const text = yield* Effect.tryPromise({
              try: () =>
                NodeFSP.readFile(NodePath.join(temporary, "result.json"), "utf8").catch(() => null),
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-material",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const outcome = yield* Effect.try({
              try: () => (text === null ? null : decodeMaterialResult(text)),
              catch: (cause) =>
                new GameOperationError({
                  operation: "import-library-material",
                  path: result.logPath,
                  reason: "command-failed",
                  detail: "The material script returned an unreadable result.",
                  cause,
                }),
            });
            if (result.exitCode !== 0 || outcome === null || outcome.material === undefined) {
              const scriptError = outcome?.error ?? null;
              return yield* new GameOperationError({
                operation: "import-library-material",
                path: result.logPath,
                reason: "command-failed",
                detail: (scriptError ?? commandDetail(result)).slice(-4096),
              });
            }
            if (outcome.reused !== true)
              yield* Effect.tryPromise({
                try: async () => {
                  const staged = NodePath.join(temporary, tresBase);
                  const final = insideGame(root, tresRelative);
                  try {
                    await NodeFSP.link(staged, final);
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
                    const [before, after] = await Promise.all([
                      NodeFSP.readFile(final),
                      NodeFSP.readFile(staged),
                    ]);
                    if (!before.equals(after))
                      throw new GameOperationError({
                        operation: "import-library-material",
                        path: tresRelative,
                        reason: "art-kit-conflict",
                        detail:
                          "The existing material was modified; move it aside to regenerate. It was not overwritten.",
                      });
                  }
                },
                catch: (cause) =>
                  isGameOperationError(cause)
                    ? cause
                    : new GameOperationError({
                        operation: "import-library-material",
                        path: tresRelative,
                        reason: "io",
                        cause,
                      }),
              });
            return outcome.reused === true;
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
            ),
          );
          const physical = detail.asset.dimensionsMm
            ? detail.asset.dimensionsMm.map((mm) => mm / 1000)
            : null;
          const installed = yield* Effect.promise(async () => {
            const out: Array<{
              path: string;
              resPath: string | null;
              role: "gltf" | "bin" | "texture" | "material" | "provenance";
              bytes: number;
              sha256: string;
            }> = [];
            for (const file of plan.files) {
              const bytes = await NodeFSP.readFile(NodePath.join(destination, file.path));
              out.push({
                path: `${destinationRelative}/${file.path}`,
                resPath: `res://${kitRelative}/${file.path}`,
                role: "texture",
                bytes: bytes.byteLength,
                sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
              });
            }
            const tres = await NodeFSP.readFile(NodePath.join(destination, tresBase));
            out.push({
              path: tresRelative,
              resPath: tresResPath,
              role: "material",
              bytes: tres.byteLength,
              sha256: NodeCrypto.createHash("sha256").update(tres).digest("hex"),
            });
            return out;
          });
          const sizeNote = physical
            ? ` covering ${physical.map((m) => m.toFixed(2)).join("×")} m`
            : "";
          return {
            slug,
            destination: destinationRelative,
            files: installed,
            materialResPath: tresResPath,
            maps: ["Diffuse", "nor_gl", "Rough"],
            physicalSizeM: physical,
            license: detail.asset.license,
            source: detail.asset.source,
            alreadyPresent: built,
            credit: detail.credit,
            message: built
              ? `${detail.asset.name} material is already built unchanged at ${tresRelative}; no files were written. Assign it to every mesh that shares the finish. License: ${detail.asset.license.name}. ${detail.credit}.`
              : `Built reusable ${detail.asset.name} PBR material${sizeNote} at ${tresRelative} from ${resolution} JPEGs (${(total / 1024).toFixed(0)} KB): albedo colour plus OpenGL normal and roughness as non-colour data. Assign material_override = load("${tresResPath}") on each MeshInstance3D that shares the finish; several objects can reuse the one resource. License: ${detail.asset.license.name} — ${detail.asset.license.attribution}. Source: ${detail.asset.source.title} (${detail.asset.source.url}). ${detail.credit}.`,
            usage: `material_override = load("${tresResPath}") on each MeshInstance3D that shares the finish. The texture covers${sizeNote || " its authored size"}; on larger meshes raise uv1_scale proportionally instead of repainting the maps.`,
          };
        }),
      ),
    test: (threadId, script, timeoutMs = 60_000) =>
      withRoot(threadId, "Test", (root) =>
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          // The canonical suite comes from the server-owned policy, not the
          // manifest an agent can edit.
          const identity = yield* designApprovals.readPolicy(root, manifest);
          const suite = identity.policy.testSuite;
          const canonical = suite.replace(/^res:\/\//, "").replaceAll("\\", "/");
          const requested = NodePath.normalize(script.replace(/^res:\/\//, ""))
            .split(NodePath.sep)
            .join("/");
          // Only the game's canonical suite owns the test stage; any other script
          // is a diagnostic run and must not change qualification.
          if (requested !== canonical) {
            const diagnostic = yield* testGame(root, script, timeoutMs);
            return {
              ...diagnostic.value,
              message: `${diagnostic.value.message} Only the canonical suite (${suite}) records qualification, so this run did not change it.`,
            };
          }
          return yield* ownStage(
            root,
            "test",
            "test",
            testGame(root, script, timeoutMs, identity.revision),
          );
        }),
      ),
    blender: (threadId, input) =>
      withRoot(threadId, "Blender asset", (root) =>
        Effect.gen(function* () {
          yield* refuseWhileUnapproved(root, "blender");
          const blender = yield* tools.executable("blender");
          const manifest = yield* projects.read(root);
          if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))
            return yield* new GameOperationError({
              operation: "blender",
              path: input.id,
              reason: "invalid-path",
            });
          // The input replaces the game's profile when given; otherwise the
          // stored profile still judges this export. Either way the run only
          // reads the profile, and the manifest changes after a good export.
          const profile = input.art ?? manifest.artProfile;
          const requested = yield* Effect.try({
            try: () => validateBlenderInputs(input.inputs, input.id),
            catch: (cause) =>
              isGameOperationError(cause)
                ? cause
                : new GameOperationError({
                    operation: "blender",
                    path: input.id,
                    reason: "invalid-input",
                    cause,
                  }),
          });
          if (requested.length > GAME_BLENDER_INPUT_BOUNDS.maxInputs)
            return yield* new GameOperationError({
              operation: "blender",
              path: input.id,
              reason: "invalid-input",
              detail: `Too many inputs: ${requested.length} were supplied but at most ${GAME_BLENDER_INPUT_BOUNDS.maxInputs} are staged.`,
            });
          const previousAsset = manifest.assets.find((entry) => entry.id === input.id);
          const assetBase = {
            id: input.id,
            kind: "model" as const,
            source: `art/blender/${input.id}.blend`,
            script: `art/scripts/${input.id}.py`,
            export: `${manifest.godotProject}/assets/models/${input.id}.glb`,
            ...(input.thumbnail === false ? {} : { thumbnail: `art/previews/${input.id}.png` }),
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const temporary = NodePath.join(
            root,
            "builds/logs",
            `blender-${NodeCrypto.randomUUID()}`,
          );
          // Blender writes only these staged paths. The game's files move into
          // place after the export validates, so a failure, a thumbnail crash
          // or an interruption keeps the last good .blend, .glb and script.
          // Named inputs are staged reads: source game files are never written.
          const staged = {
            source: NodePath.join(temporary, "work.blend"),
            script: NodePath.join(temporary, "asset.py"),
            exported: NodePath.join(temporary, "work.glb"),
            thumbnail: assetBase.thumbnail ? NodePath.join(temporary, "work.png") : null,
            metadata: NodePath.join(temporary, "result.json"),
            config: NodePath.join(temporary, "config.json"),
            run: NodePath.join(temporary, "run.py"),
          };
          const publishWarnings: Array<string> = [];
          const output = yield* Effect.gen(function* () {
            const stagedInputs = yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.mkdir(temporary, { recursive: true });
                return stageBlenderInputs({
                  root,
                  godotProject: manifest.godotProject,
                  bindings: requested,
                  temporary,
                  inputId: input.id,
                });
              },
              catch: (cause) =>
                isGameOperationError(cause)
                  ? cause
                  : new GameOperationError({
                      operation: "blender-prepare",
                      path: temporary,
                      reason: "io",
                      cause,
                    }),
            });
            const supplied =
              requested.length === 0
                ? undefined
                : stagedInputs.map((entry) => ({
                    name: entry.binding.name,
                    path: entry.binding.path,
                  }));
            // A revision without new inputs keeps the previous trace so the
            // record still names what the live .blend was built from; a run
            // with inputs replaces it. Reset without new inputs starts a fresh
            // .blend, so it clears stale bindings instead of inheriting them.
            // Old requests stay compatible.
            const asset =
              supplied !== undefined
                ? { ...assetBase, inputs: supplied }
                : input.reset === true
                  ? assetBase
                  : previousAsset?.inputs !== undefined
                    ? { ...assetBase, inputs: previousAsset.inputs }
                    : assetBase;
            yield* Effect.tryPromise({
              try: async () => {
                for (const relative of [
                  asset.source,
                  asset.script,
                  asset.export,
                  ...(asset.thumbnail ? [asset.thumbnail] : []),
                ])
                  await NodeFSP.mkdir(NodePath.dirname(insideGame(root, relative)), {
                    recursive: true,
                  });
                // A revision edits the existing source; a reset or a first
                // build starts from an empty scene. The seed is a copy, so the
                // game file is never open while Blender writes.
                if (input.reset !== true) {
                  const seed = await NodeFSP.readFile(insideGame(root, asset.source)).catch(
                    () => null,
                  );
                  if (seed !== null) await NodeFSP.writeFile(staged.source, seed);
                }
                await NodeFSP.writeFile(staged.script, input.script);
                const config: BlenderRunConfig = {
                  source: staged.source,
                  reset: input.reset ?? false,
                  script: staged.script,
                  exported: staged.exported,
                  thumbnail: staged.thumbnail,
                  metadata: staged.metadata,
                  palette: [...(profile?.palette ?? [])],
                  inputs: Object.fromEntries(
                    stagedInputs.map((entry) => [entry.name, entry.staged]),
                  ),
                };
                await NodeFSP.writeFile(staged.config, encodeBlenderRunConfig(config));
                await NodeFSP.writeFile(staged.run, renderRunScript(staged.config));
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-prepare",
                  path: temporary,
                  reason: "io",
                  cause,
                }),
            });
            const result = yield* processes.run({
              root,
              executable: blender.path,
              args: [
                "--background",
                "--factory-startup",
                "--threads",
                "2",
                "--python-exit-code",
                "1",
                "--python",
                staged.run,
                "--",
                staged.config,
              ],
              operation: "blender-asset",
              timeoutMs: 300_000,
            });
            if (result.exitCode !== 0)
              return yield* new GameOperationError({
                operation: "blender-asset",
                path: result.logPath,
                reason: "command-failed",
                detail: commandDetail(result),
                cause: result,
              });
            const metadata = yield* Effect.tryPromise({
              try: async () => {
                for (const file of [
                  staged.source,
                  staged.exported,
                  ...(staged.thumbnail ? [staged.thumbnail] : []),
                ])
                  if ((await NodeFSP.stat(file)).size === 0) throw new Error("Empty asset");
                return decodeBlenderMetadata(await NodeFSP.readFile(staged.metadata, "utf8"));
              },
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-output",
                  path: temporary,
                  reason: "command-failed",
                  detail:
                    `Expected asset files or metadata were missing or invalid.\n${commandDetail(result)}`.slice(
                      -4096,
                    ),
                  cause,
                }),
            });
            // The bytes Blender wrote parse as the game-ready format before
            // anything in the game moves. A malformed GLB is a failed export,
            // not a published asset.
            const glbBytes = yield* Effect.tryPromise({
              try: () => NodeFSP.readFile(staged.exported),
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-output",
                  path: temporary,
                  reason: "command-failed",
                  detail: "The staged export vanished before it could be checked.",
                  cause,
                }),
            });
            const inspection = yield* Effect.tryPromise({
              try: () => inspectGlb(new Uint8Array(glbBytes)),
              catch: (cause) =>
                new GameOperationError({
                  operation: "blender-output",
                  path: temporary,
                  reason: "command-failed",
                  detail: `The staged export is not a readable GLB: ${String(cause).slice(0, 500)}`,
                  cause,
                }),
            });
            const warnings = [...metadata.warnings, ...inspection.warnings];
            if (metadata.meshes !== inspection.meshes)
              warnings.push(
                `Blender reported ${metadata.meshes} meshes but the exported GLB holds ${inspection.meshes}; check modifiers the export did not apply.`,
              );
            warnings.push(...profileWarnings(profile, metadata));
            const replaced: Array<{
              destination: string;
              backup: string | null;
              published: boolean;
            }> = [];
            // Keep rollback copies until the manifest commits, and finish this short
            // exchange before acknowledging cancellation. Backups survive a failed restore.
            yield* Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  const moves: Array<readonly [string, string]> = [
                    [staged.source, insideGame(root, asset.source)],
                    [staged.exported, insideGame(root, asset.export)],
                    [staged.script, insideGame(root, asset.script)],
                  ];
                  if (asset.thumbnail !== undefined && staged.thumbnail !== null)
                    moves.push([staged.thumbnail, insideGame(root, asset.thumbnail)]);
                  for (const [from, to] of moves) {
                    const existing = await NodeFSP.lstat(to).catch(
                      (cause: NodeJS.ErrnoException) => {
                        if (cause.code === "ENOENT") return null;
                        throw cause;
                      },
                    );
                    if (existing !== null && !existing.isFile())
                      throw new Error("An asset destination is not a regular file.");
                    const backup =
                      existing === null ? null : `${to}.${NodeCrypto.randomUUID()}.backup`;
                    if (backup !== null) await NodeFSP.rename(to, backup);
                    const entry = { destination: to, backup, published: false };
                    replaced.push(entry);
                    await NodeFSP.rename(from, to);
                    entry.published = true;
                  }
                },
                catch: (cause) =>
                  new GameOperationError({
                    operation: "blender-publish",
                    path: temporary,
                    reason: "io",
                    cause,
                  }),
              }).pipe(
                Effect.andThen(
                  projects.upsertAsset(
                    root,
                    asset,
                    input.art === undefined ? undefined : { artProfile: input.art },
                  ),
                ),
                Effect.catchCause((originalFailure) =>
                  Effect.tryPromise({
                    try: async () => {
                      let failed = false;
                      for (const entry of replaced.toReversed()) {
                        try {
                          if (entry.published) await NodeFSP.rm(entry.destination, { force: true });
                          if (entry.backup !== null)
                            await NodeFSP.rename(entry.backup, entry.destination);
                        } catch {
                          failed = true;
                        }
                      }
                      if (failed) throw new Error("Asset rollback was incomplete.");
                    },
                    catch: (cause) =>
                      new GameOperationError({
                        operation: "blender-restore",
                        path: root,
                        reason: "io",
                        detail:
                          "The previous asset could not be fully restored. Preserved .backup files remain beside the asset files.",
                        cause,
                      }),
                  }).pipe(Effect.andThen(Effect.failCause(originalFailure))),
                ),
                Effect.tap(() =>
                  Effect.promise(async () => {
                    for (const entry of replaced) {
                      if (entry.backup === null) continue;
                      await NodeFSP.rm(entry.backup, { force: true }).catch(() => {
                        publishWarnings.push("An older asset backup could not be removed.");
                      });
                    }
                  }),
                ),
              ),
            );
            const contact = yield* refreshContactSheet(root).pipe(
              // A sheet failure is evidence lost, never an export lost; only
              // the typed failure is caught so an interruption still propagates.
              Effect.catchTags({
                GameOperationError: () =>
                  Effect.succeed({
                    path: null as string | null,
                    warning: "The contact sheet could not be refreshed." as string | null,
                  }),
              }),
            );
            if (contact.warning !== null) publishWarnings.push(contact.warning);
            return {
              asset,
              process: result,
              metadata,
              inspection,
              warnings: [...warnings, ...publishWarnings],
              contactSheet: contact.path,
            };
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
            ),
          );
          return {
            asset: output.asset,
            objects: output.metadata.objects,
            meshes: output.metadata.meshes,
            materials: output.metadata.materials,
            materialDetails: output.metadata.materialDetails,
            animations: output.metadata.animations,
            triangles: output.metadata.triangles,
            dimensions: output.metadata.dimensions,
            originOffset: output.metadata.originOffset,
            warnings: output.warnings,
            ...(output.contactSheet === null ? {} : { contactSheet: output.contactSheet }),
            process: output.process,
          };
        }),
      ),
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      // Rebuild and Stop are creator decisions that outrank a live review. The
      // admission barrier joins the loop before this action touches the game,
      // and lives here so the websocket and MCP paths cannot diverge.
      if (action === "rebuild" || action === "stop")
        yield* admission.admit({
          root,
          threadId,
          reason:
            action === "rebuild"
              ? "An explicit Rebuild superseded the review; its candidate was not selected."
              : "The creator stopped the game, so the review was superseded.",
        });
      if (action === "stop") {
        yield* cancel(root);
        yield* processes.stop(root);
        yield* preview.stop(root);
        // Stopping the game is a user decision; a round that is repairing it
        // must not keep owning the folder afterwards.
        yield* rounds.stopRunning(
          root,
          "The creator stopped the game, so the open repair round was stopped.",
        );
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
          if (action === "verify") {
            const status = yield* tools.verify;
            return {
              success: status.tools.every((tool) => tool.ready && tool.verified),
              message: status.tools.map((tool) => `${tool.tool}: ${tool.message}`).join("\n"),
              path: status.toolsDirectory,
              url: null,
              process: null,
            };
          }
          // Only the toolchain check stays open during a draft; every staging
          // action here moves the game toward a playable build.
          yield* refuseWhileUnapproved(root, action);
          if (action === "export-linux")
            return yield* exportGame(root, "Linux", { mode: "publish" }, null);
          if (action === "export-windows")
            return yield* exportGame(root, "Windows", { mode: "publish" }, null);
          // The creator's own Play may watch a native window; every agent-facing
          // run goes through the headless native method instead.
          if (action === "native") return yield* nativeGame(root, "inherit");
          // Rebuild forces a new export and publishes it. It is an explicit
          // user decision, so it supersedes an open round rather than becoming
          // that round's candidate.
          if (action === "rebuild") {
            yield* rounds.stopRunning(
              root,
              "An explicit Rebuild superseded the open repair round; its candidate was not selected.",
            );
            return yield* publishWeb(root);
          }
          const state = yield* rounds.read(root);
          const served = yield* selectedPreview(root);
          if (served !== null)
            return {
              success: true,
              message: "Loaded the selected web build.",
              path: NodePath.join(root, served.directory, "index.html"),
              url: served.url,
              process: null,
            };
          if (state.selected !== null)
            return {
              success: false,
              message:
                "The selected build is unavailable: its served files are missing or empty. Rebuild to export the current sources; Play does not publish unreviewed repair sources.",
              path: null,
              url: null,
              process: null,
            };
          // A first build with no round open is ordinary development. While a
          // round is open, its sources are the repair's and must be reviewed.
          const active = yield* runningRound(root);
          if (active !== null)
            return {
              success: false,
              message:
                "A repair round is open and there is no selected build to play. The round's candidate is not published automatically.",
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
  Layer.provide(GameArtKits.layer),
  Layer.provide(GameAssetLibrary.layer),
  Layer.provide(GameWebPlaytest.layer),
  Layer.provide(GameExploreBrowser.layer),
  Layer.provideMerge(GameOperations.layer),
);
/** Tests inject a fake browser run; production uses the real playtest. */
export const layerWithPlaytest = (run: typeof GameWebPlaytest.playtest) =>
  Layer.effect(GameService, make).pipe(
    Layer.provide(GameEngine.layer),
    Layer.provide(GameArtKits.layer),
    Layer.provide(GameAssetLibrary.layer),
    Layer.provide(GameWebPlaytest.layerOf(run)),
    Layer.provide(GameExploreBrowser.layer),
    Layer.provideMerge(GameOperations.layer),
  );
/**
 * Tests inject a fake persistent browser (and optionally a fake one-shot
 * playtest run for replays); production uses the real players.
 */
export const layerWithExploreBrowser = (
  open: GameExploreBrowser.ExploreBrowserOpen,
  run?: typeof GameWebPlaytest.playtest,
) =>
  Layer.effect(GameService, make).pipe(
    Layer.provide(GameEngine.layer),
    Layer.provide(GameArtKits.layer),
    Layer.provide(GameAssetLibrary.layer),
    Layer.provide(run === undefined ? GameWebPlaytest.layer : GameWebPlaytest.layerOf(run)),
    Layer.provide(GameExploreBrowser.layerOf(open)),
    Layer.provideMerge(GameOperations.layer),
  );
