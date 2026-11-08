// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of status and checks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import {
  GameOperationError,
  gameOperationFault,
  type GameToolchainStatus,
  type GameCheckResult,
  type GameStatus,
  type GameAction,
  type GameActionResult,
  type GameManifest,
  type GameOperationEvent,
  type GameSavedMedia,
  type GameWebPackage,
  type GameWindowsPackage,
  type ThreadId,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  type GameBlenderCarveInput,
  type GameBlenderCarveResult,
  type GameAnimateInput,
  type GameAnimateResult,
  type GameBlenderCharacterInput,
  type GameArtProvidersResult,
  type GameGenerateInput,
  type GameImageEditInput,
  imageEditName,
  type GameGenerateResult,
  type GameGenerateWaitInput,
  type GameGenerationChangeResult,
  type GameGenerationsResult,
  type GameBlenderCharacterResult,
  type GameBlenderPaintInput,
  type GameBlenderPaintResult,
  type GameBlenderCodeInput,
  type GameBlenderCodeResult,
  GAME_CHARACTER_ROUTE_UNAVAILABLE,
  type GameCharacterRoute,
  type GameSetCharacterRouteResult,
  type GameBlenderExportInput,
  type GameBlenderExportResult,
  type GameBlenderRenderSpritesInput,
  type GameBlenderRenderSpritesResult,
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
  GAME_LIVE_EVENT,
  isGameEngineActive,
  manifestProject,
} from "@kurambit/contracts";
import { engineProfile, type GameEngineProfile } from "./engineProfile.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameBlender from "./GameBlender.ts";
import * as GameArt from "./art/GameArt.ts";
import * as GameBot from "./GameBot.ts";
import type * as BotEvidence from "./botEvidence.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameExplore from "./GameExplore.ts";
import * as GameExport from "./GameExport.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameUnity from "./GameUnity.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  SAVED_DIR,
  SAVED_EVENT,
  SavedMediaError,
  deleteSaved,
  listSaved,
  saveMedia,
} from "./gameSavedMedia.ts";
import type { GameSourceRules } from "./engineProfile.ts";
import { type SourceHashCache, snapshotBuildSource } from "./sourceSnapshot.ts";
import { COPY_OF } from "./unityPlayerCache.ts";
import { characterRoute } from "./gameStyle.ts";

/** game.json as a plain object, so a write that sets one key keeps every other as it was. */
const decodeManifestObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export class GameService extends Context.Service<
  GameService,
  {
    readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void, GameOperationError>;
    readonly finishExploration: (
      threadId: ThreadId,
      options?: { readonly keepMarks?: boolean },
    ) => Effect.Effect<
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
    readonly limitExploreInput: (
      threadId: ThreadId,
      totalMs: number,
      root: string,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Since this thread's last finishExploration: how long its explore starts
     * waited and why the latest was refused (`low-memory`, or `busy` behind
     * another start); with the input steps its sessions have executed in all.
     */
    readonly exploreMemoryWait: (threadId: ThreadId) => Effect.Effect<
      {
        readonly waitedMs: number;
        readonly refused: "low-memory" | "busy" | "tool-failed" | null;
        /** The refusal is one waiting cannot clear (isStandingFault). */
        readonly standing: boolean;
        readonly executedInputSteps: number;
      },
      GameOperationError
    >;
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
    /** The pushes for one thread's game; the stream fails when the thread's game cannot be resolved. */
    readonly threadEvents: (
      threadId: ThreadId,
    ) => Stream.Stream<GameOperationEvent, GameOperationError>;
    /**
     * The pushes a games library shows: games' own folders only, never the
     * production run's sample copies, whose checks and builds change no card.
     */
    readonly libraryEvents: Stream.Stream<GameOperationEvent>;
    /** The Game panel's actions: each one is the method below of the same name. */
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Play: serves the selected Web build as it is, and exports one only when
     * none was ever built. An engine without a Web release has nothing to serve.
     */
    readonly play: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Play of a checkout no thread owns (a build's copy): its Web build
     * served as it is, or exported once when it has none.
     */
    readonly playIn: (
      root: string,
      owner: string,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /** Exports the current sources for Web and serves that build. */
    readonly rebuild: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * `game_preview`: a playable build of the current sources. A Web build
     * older than the sources is rebuilt (the same export the Stage's Rebuild runs); a live-staged game serves its folder instead;
     * an engine whose games play as a built player gets that player prepared.
     */
    readonly preview: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Makes the folder's Web build current, as the thread's own operation: the
     * same freshness rule as `preview`, waiting a while behind another
     * operation rather than refusing. A build already fresh is left as it is
     * (served or stopped). A failure is the operation's news on the Stage.
     * Nothing for an engine without a Web build.
     */
    readonly playCurrent: (threadId: ThreadId) => Effect.Effect<void, GameOperationError>;
    /** Stop game: the caller's work, and while no run holds the game, every process of it; says what did not stop. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Close the live Blender and Unity editors without saving, so a scene held
     * in memory cannot save over files restored on disk; the next call reopens them.
     */
    readonly closeLiveEditors: (root: string) => Effect.Effect<void>;
    /**
     * Gives a game folder whose engine plays a built player (Unity) a
     * complete Linux player of its current sources: the one it has, a copy of
     * its main checkout's of identical sources, or a build under the game's
     * lock and the live editor's memory guard. Idempotent. A blind sample's
     * worktree gets this before its thread exists, so no sample spends its
     * play time on a build.
     */
    readonly preparePlayer: (root: string) => Effect.Effect<
      {
        readonly origin: "cached" | "reused" | "built";
        readonly ms: number;
        readonly sourceId: string;
      },
      GameOperationError
    >;
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
    /** Live Blender scene: a rigged, animated character conformed to the standard skeleton. */
    readonly blenderCharacter: (
      threadId: ThreadId,
      input: GameBlenderCharacterInput,
    ) => Effect.Effect<GameBlenderCharacterResult, GameOperationError>;
    /** Live Blender scene: a move spec compiled onto a character as a clip, measured and pictured. */
    readonly animate: (
      threadId: ThreadId,
      input: GameAnimateInput,
    ) => Effect.Effect<GameAnimateResult, GameOperationError>;
    /** Live Blender scene: meshes painted from their turnaround sheet. */
    readonly blenderPaint: (
      threadId: ThreadId,
      input: GameBlenderPaintInput,
    ) => Effect.Effect<GameBlenderPaintResult, GameOperationError>;
    /** Live Blender scene: an organic hard prop carved from its three-view sheet. */
    readonly blenderCarve: (
      threadId: ThreadId,
      input: GameBlenderCarveInput,
    ) => Effect.Effect<GameBlenderCarveResult, GameOperationError>;
    /** Generated art (GameArt): never under the game's operation lock, a generation takes minutes. */
    readonly generate: (
      threadId: ThreadId,
      input: GameGenerateInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    /** A change to a game image, from words: generate's image lane with options.edit. */
    readonly imageEdit: (
      threadId: ThreadId,
      input: GameImageEditInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    readonly generateWait: (
      threadId: ThreadId,
      input: GameGenerateWaitInput,
    ) => Effect.Effect<GameGenerateResult, GameOperationError>;
    readonly generations: (
      threadId: ThreadId,
    ) => Effect.Effect<GameGenerationsResult, GameOperationError>;
    readonly chooseGeneration: (
      threadId: ThreadId,
      id: string,
      candidate: number,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    readonly cancelGeneration: (
      threadId: ThreadId,
      id: string,
    ) => Effect.Effect<GameGenerationChangeResult, GameOperationError>;
    readonly artProviders: Effect.Effect<GameArtProvidersResult, GameOperationError>;
    /**
     * The person's choice of how this game's characters are made, written into game.json.
     * Only the person makes it: the client's control, or the agent when they asked in chat.
     */
    readonly setCharacterRoute: (
      threadId: ThreadId,
      route: GameCharacterRoute,
    ) => Effect.Effect<GameSetCharacterRouteResult, GameOperationError>;
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
    /** Live Blender scene: sprite PNGs with a camera fitted across every frame, plus a contact sheet. */
    readonly blenderRenderSprites: (
      threadId: ThreadId,
      input: GameBlenderRenderSpritesInput,
    ) => Effect.Effect<GameBlenderRenderSpritesResult, GameOperationError>;
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
    /** `owner` names whose work the export is, for owner-scoped cancels; the thread by default. */
    /** `waitUntil` (epoch ms) queues behind another operation until then instead of failing busy. */
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux" | "Windows",
      owner?: string,
      waitUntil?: number,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Which export targets the game's engine backend declares, with its display
     * name. Internal loop fact resolved through the existing engine path; not
     * an MCP tool. Runs no processes.
     */
    readonly exportTargets: (
      threadId: ThreadId,
      owner?: string,
      waitUntil?: number,
    ) => Effect.Effect<
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
    /**
     * The bot runs the bot service recorded for this thread's game_bot_run
     * calls, kept on the server: a run decides by these, never by the game
     * folder's .studio/bot-results.jsonl, which a role agent can write.
     */
    readonly botRuns: (
      threadId: ThreadId,
    ) => Effect.Effect<BotEvidence.ThreadBots, GameOperationError>;
    /** Rebuild the facts-only player report across this game's bot runs. */
    readonly botReport: (
      threadId: ThreadId,
    ) => Effect.Effect<GameBotReportResult, GameOperationError>;
    /**
     * The facts-only player report of exactly these bot runs, read-only: it
     * never writes .studio/player-report.md. Null when none of them has a
     * trace; an unreadable trace is skipped and counted in the text.
     */
    readonly botReportText: (
      root: string,
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<string | null, GameOperationError>;
    /**
     * The toolchain's status for the Settings row and the stage's readiness,
     * cached; with a thread, Unity's entry speaks for that game's editor version.
     */
    readonly toolchain: (
      threadId?: ThreadId,
    ) => Effect.Effect<GameToolchainStatus, GameOperationError>;
    /** A quick look at a finished bot run: summary, findings and evidence paths. */
    readonly botView: (
      threadId: ThreadId,
      input: GameBotViewInput,
    ) => Effect.Effect<GameBotViewResult, GameOperationError>;
    readonly check: (
      threadId: ThreadId,
      owner?: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
    /** The boot check of a checkout no thread owns (a build's copy), as its own operation. */
    readonly checkIn: (
      root: string,
      owner: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
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
    /** Copies a generated video or image into the game's saved/, past the log cleanup. */
    readonly saveMedia: (
      threadId: ThreadId,
      source: string,
      label?: string,
    ) => Effect.Effect<GameSavedMedia, GameOperationError>;
    readonly listSaved: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<GameSavedMedia>, GameOperationError>;
    /** Removes one file directly inside saved/. */
    readonly deleteSaved: (
      threadId: ThreadId,
      name: string,
    ) => Effect.Effect<void, GameOperationError>;
    /** Live Unity editor: recent console entries. */
    readonly unityConsole: (
      threadId: ThreadId,
      input: GameUnityConsoleInput,
    ) => Effect.Effect<GameUnityTextResult, GameOperationError>;
  }
>()("kurambit/game/GameService") {}

/** Checkouts whose status hashes are kept; see statusSnapshot. */
const STATUS_HASH_CHECKOUTS = 16;

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const engines = yield* GameEngine.GameEngine;
  const liveUnity = yield* GameUnity.GameUnity;
  const preview = yield* GamePreview.GamePreview;
  const liveBlender = yield* GameBlender.GameBlender;
  const art = yield* GameArt.GameArt;
  // A landed motion's strip and a model's views before its rig are rendered in the game's live
  // Blender, which reads GameArt's records.
  yield* art.renderWith({
    motionStrip: liveBlender.motionStrip,
    modelViews: liveBlender.modelViews,
  });
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const gameBot = yield* GameBot.GameBot;
  const operations = yield* GameOperations.GameOperations;
  const exporter = yield* GameExport.GameExport;
  const explore = yield* GameExplore.GameExplore;
  const players = yield* GamePlayer.GamePlayer;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // Status is read on every push for the thread, so its freshness answer reuses
  // hashes of files whose stat identity is unchanged. An explicit check rereads
  // every byte and refreshes the cache. The most recently read checkouts keep
  // theirs (a run's sample copies are checkouts too); one dropped costs a
  // single full read. A cache holds up to 10k files, about 3 MB.
  const statusHashes = new Map<string, SourceHashCache>();
  const statusSnapshot = (root: string, project: string, reread: boolean, rules: GameSourceRules) =>
    Effect.promise((signal) => {
      const key = `${root}\0${project}`;
      const cache = statusHashes.get(key) ?? new Map();
      statusHashes.delete(key);
      statusHashes.set(key, cache);
      if (statusHashes.size > STATUS_HASH_CHECKOUTS) {
        const oldest = statusHashes.keys().next().value;
        if (oldest !== undefined) statusHashes.delete(oldest);
      }
      if (reread) cache.clear();
      return snapshotBuildSource(root, project, { signal, cache, rules });
    });
  // The machine's toolchain, cached: the stage reads it on its own query,
  // never on every status read. Keyed by the toolchain's revision, so a fetch
  // is seen at once; a settings change clears it.
  const toolchainStatus = yield* Cache.make({
    lookup: (_revision: number) => tools.status(),
    capacity: 4,
    timeToLive: "30 seconds",
  });
  const toolchainOf = () => Cache.get(toolchainStatus, tools.revision());
  // Every client rereads a live game's status when its serve opens or stops.
  yield* Stream.runForEach(preview.liveStates, ({ root, state }) =>
    operations.changed(root, GAME_LIVE_EVENT, state === "serving" ? "Serving" : "Stopped"),
  ).pipe(Effect.forkScoped);
  yield* settings.subscribeChanges.pipe(
    Effect.flatMap((changes) =>
      Stream.runForEach(changes, () => Cache.invalidateAll(toolchainStatus)),
    ),
    Effect.forkScoped,
  );
  // An operation that may write the game.
  const withRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
    owner: string = String(threadId),
    waitUntil?: number,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* operations.exclusive(
      root,
      name,
      work(root),
      owner,
      waitUntil === undefined ? undefined : { waitUntil },
    );
  });
  // Reads only, so a production run never refuses it.
  const readRoot = Effect.fnUntraced(function* <A>(
    threadId: ThreadId,
    name: string,
    work: (root: string) => Effect.Effect<A, GameOperationError>,
    owner: string = String(threadId),
    waitUntil?: number,
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* operations.exclusive(
      root,
      name,
      work(root),
      owner,
      waitUntil === undefined ? undefined : { waitUntil },
    );
  });
  // No operation lock: a saved copy touches neither the engine nor the folder Kurambit works in.
  const savedMedia = <A>(
    operation: string,
    threadId: ThreadId,
    work: (root: string) => Promise<A>,
  ) =>
    Effect.flatMap(projects.resolve(threadId), (root) =>
      Effect.tryPromise({
        try: () => work(root),
        catch: (cause) =>
          new GameOperationError({
            operation,
            path: NodePath.join(root, SAVED_DIR),
            reason: cause instanceof SavedMediaError ? cause.reason : "io",
            detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000),
            cause,
          }),
      }),
    );
  // A production run's sample copies name their game folder in COPY_OF; their
  // checks and builds change nothing a library card shows.
  const libraryRoots = new Map<string, boolean>();
  const isLibraryRoot = (root: string) =>
    Effect.promise(async () => {
      const known = libraryRoots.get(root);
      if (known !== undefined) return known;
      const copy = await NodeFSP.stat(NodePath.join(root, COPY_OF)).then(
        () => true,
        () => false,
      );
      if (libraryRoots.size > 512) libraryRoots.clear();
      libraryRoots.set(root, !copy);
      return !copy;
    });
  /** The selection Play serves; one whose record does not decode reads as "damaged", never as a failure of the read. */
  const selectionOf = (root: string) =>
    exporter.selected(root).pipe(
      Effect.catchTags({
        GameOperationError: (error) =>
          error.reason === "invalid-project"
            ? Effect.succeed("damaged" as const)
            : Effect.fail(error),
      }),
    );
  const exportAs = (threadId: ThreadId, target: "Linux" | "Windows") =>
    withRoot(threadId, `Export ${target}`, (root) => exporter.export(root, target));
  // A live-staged game's Web export is a release only: Play keeps the live folder.
  const rebuild = (threadId: ThreadId) =>
    Effect.flatMap(projects.resolve(threadId), projects.read).pipe(
      Effect.flatMap((manifest) =>
        engineProfile(manifest.engine.name).stage === "live"
          ? withRoot(threadId, "Export Web", (root) => exporter.export(root, "Web"))
          : withRoot(threadId, "Build Web", exporter.publishWeb),
      ),
    );
  /** What a game whose engine makes no Web build answers Play with. */
  const noWebPlay = (root: string, displayName: string): GameActionResult => ({
    success: false,
    message: `${displayName} games make no Web build to play here. Export a Linux or Windows release from Export… in the Stage's More menu (game_export for an agent), or explore and bot-play the game, which play its built player.`,
    path: root,
    url: null,
    process: null,
  });
  // A live-staged game is its folder, served as its dev server: nothing is
  // built or written, so there is no operation and no write admission.
  // `message` is read by whoever asked: the person's Stage shows Play's, an agent reads game_preview's.
  const playLive = (root: string, profile: GameEngineProfile, message: (url: string) => string) =>
    preview
      .live(root, profile.projectDirectory, (path) =>
        operations.changed(root, GAME_LIVE_EVENT, `Changed ${profile.projectDirectory}/${path}`),
      )
      .pipe(
        Effect.map((url): GameActionResult => ({
          success: true,
          message: message(url),
          path: NodePath.join(root, profile.projectDirectory, "index.html"),
          url,
          process: null,
        })),
      );
  const play = Effect.fn("GameService.play")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const engine = (yield* projects.read(root)).engine.name;
    // A parked engine's game plays nothing, not even an export it made before.
    if (!isGameEngineActive(engine)) return yield* GameEngine.parkedEngine(engine);
    const profile = engineProfile(engine);
    if (profile.stage === "live")
      return yield* playLive(
        root,
        profile,
        () => "Playing live: the game reloads as its files change.",
      );
    // Play of a build already exported only reads, so it never takes the
    // lock a run's capture or check may hold; one it must export is a write.
    const served = yield* exporter.serve(root);
    if (served !== null) return served;
    const { targets, displayName } = yield* exporter.exportTargets(root);
    if (!targets.includes("Web")) return noWebPlay(root, displayName);
    // Another Play may have exported meanwhile.
    return yield* withRoot(threadId, "Build Web", (root) =>
      Effect.flatMap(exporter.serve(root), (again) =>
        again === null ? exporter.publishWeb(root) : Effect.succeed(again),
      ),
    );
  });
  const playIn = Effect.fn("GameService.playIn")(function* (root: string, owner: string) {
    const served = yield* exporter.serve(root);
    if (served !== null) return served;
    const { targets, displayName } = yield* exporter.exportTargets(root);
    if (!targets.includes("Web")) return noWebPlay(root, displayName);
    return yield* operations.exclusive(
      root,
      "Build Web",
      Effect.flatMap(exporter.serve(root), (again) =>
        again === null ? exporter.publishWeb(root) : Effect.succeed(again),
      ),
      owner,
    );
  });
  // Whether the selected Web build is of the folder's sources: an unreadable
  // tree cannot be shown current, and a damaged selection record is no build
  // of these sources, so neither is fresh.
  const webFresh = (root: string, manifest: GameManifest) =>
    Effect.gen(function* () {
      const profile = engineProfile(manifest.engine.name);
      const selected = yield* selectionOf(root);
      const current = yield* statusSnapshot(
        root,
        manifestProject(manifest),
        false,
        profile.buildInputs,
      );
      return (
        selected !== null &&
        selected !== "damaged" &&
        selected.sourceId !== null &&
        current.kind === "known" &&
        current.sourceId === selected.sourceId
      );
    });
  // The folder's Web build, rebuilt only when it is not fresh. Freshness is
  // decided again inside the lock, as Play does: a build that queued behind
  // another Build Web of the same sources finds it done. `serveFresh` false
  // leaves a fresh build alone, so a turn that changed nothing playable never
  // restarts a game the person stopped.
  const currentWeb = Effect.fnUntraced(function* (
    threadId: ThreadId,
    root: string,
    manifest: GameManifest,
    options: { readonly serveFresh: boolean; readonly waitUntil?: number },
  ) {
    const served = (): Effect.Effect<GameActionResult | null, GameOperationError> =>
      options.serveFresh
        ? Effect.map(exporter.serve(root), (result) => (result?.success === true ? result : null))
        : Effect.succeed(null);
    if (yield* webFresh(root, manifest)) {
      const result = yield* served();
      if (result !== null || !options.serveFresh) return result;
    }
    return yield* withRoot(
      threadId,
      "Build Web",
      (root) =>
        Effect.flatMap(webFresh(root, manifest), (fresh) =>
          fresh
            ? Effect.flatMap(served(), (result) =>
                result !== null || !options.serveFresh
                  ? Effect.succeed(result)
                  : exporter.publishWeb(root),
              )
            : exporter.publishWeb(root),
        ),
      String(threadId),
      options.waitUntil,
    );
  });
  const playCurrent = Effect.fn("GameService.playCurrent")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const manifest = yield* projects.read(root);
    if (
      !isGameEngineActive(manifest.engine.name) ||
      !engineProfile(manifest.engine.name).exportTargets.includes("Web")
    )
      return;
    // A turn's own check or Play may still hold the game for a moment.
    const waitUntil = (yield* Clock.currentTimeMillis) + 120_000;
    yield* currentWeb(threadId, root, manifest, { serveFresh: false, waitUntil });
  });
  const gamePreview = Effect.fn("GameService.preview")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const manifest = yield* projects.read(root);
    if (!isGameEngineActive(manifest.engine.name))
      return yield* GameEngine.parkedEngine(manifest.engine.name);
    const profile = engineProfile(manifest.engine.name);
    if (profile.stage === "live")
      return yield* playLive(
        root,
        profile,
        (url) =>
          `The game's folder ${profile.projectDirectory}/ is served live at ${url}: it reloads on the person's Stage as files are saved. Exports are made on demand.`,
      );
    if (profile.exportTargets.includes("Web")) {
      const result = yield* currentWeb(threadId, root, manifest, { serveFresh: true });
      if (result !== null) return result;
      return yield* rebuild(threadId);
    }
    if (profile.play === "player") {
      const prepared = yield* players.prepare(root);
      return {
        success: true,
        message: `${profile.displayName} games play as a player of the current sources: ${prepared.player} is ready (${prepared.origin}). game_explore_start and game_bot_run play it.`,
        path: prepared.player,
        url: null,
        process: null,
      };
    }
    return noWebPlay(root, profile.displayName);
  });
  const stop = Effect.fn("GameService.stop")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    yield* operations.cancel(root);
    yield* processes.stop(root);
    // Plays and measurements of the game's builds run in copies of their own.
    yield* copies.stopFor(root);
    // Each stop is tried; one that did not end its processes is said, never reported stopped.
    const notStopped: string[] = [];
    for (const [what, stopping] of [
      ["the live Blender", liveBlender.stop(root)],
      ["the live engine editor", closeEngineEditor(root)],
      ["its bot runs", gameBot.stop(root)],
    ] as const) {
      const exit = yield* Effect.exit(stopping);
      if (exit._tag === "Failure") {
        notStopped.push(what);
        yield* Effect.logWarning("Stop game: a stop failed", { root, what, cause: exit.cause });
      }
    }
    yield* preview.stop(root, { markStopped: true });
    return {
      success: notStopped.length === 0,
      message:
        notStopped.length === 0
          ? "Stopped this game's processes and preview server."
          : `Stopped this game's processes and preview server, but ${notStopped.join(" and ")} did not stop; see the server log, and press Stop game again.`,
      path: null,
      url: null,
      process: null,
    };
  });
  const closeEngineEditor = (root: string) =>
    projects.read(root).pipe(
      Effect.flatMap((manifest) => engines.backendFor(manifest.engine.name)),
      Effect.flatMap((backend) => backend.editor?.close(root) ?? Effect.void),
    );
  return GameService.of({
    saveMedia: (threadId, source, label) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        // The day on the server's own clock and zone: the creator's machine.
        const day = DateTime.formatIsoDate(
          DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }),
        );
        // Pushed to every client of the game, so a save an agent made shows in the Saved list.
        return savedMedia("Save media", threadId, (root) =>
          saveMedia(root, source, label, day, now),
        ).pipe(
          Effect.tap((saved) =>
            Effect.flatMap(projects.resolve(threadId), (root) =>
              operations.changed(root, SAVED_EVENT, `Saved ${saved.name}`),
            ).pipe(Effect.ignore),
          ),
        );
      }),
    listSaved: (threadId) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        savedMedia("List saved media", threadId, (root) => listSaved(root, now)),
      ),
    deleteSaved: (threadId, name) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        savedMedia("Delete saved media", threadId, (root) => deleteSaved(root, name, now)),
      ).pipe(
        Effect.tap(() =>
          Effect.flatMap(projects.resolve(threadId), (root) =>
            operations.changed(root, SAVED_EVENT, `Deleted ${name}`),
          ).pipe(Effect.ignore),
        ),
      ),
    events: operations.events,
    // A thread whose game cannot be resolved fails the stream with why, so a
    // client shows it instead of an empty stream that never pushes again.
    threadEvents: (threadId) =>
      Stream.unwrap(
        Effect.map(projects.resolve(threadId), (root) =>
          operations.events.pipe(Stream.filter((event) => event.root === root)),
        ),
      ),
    libraryEvents: operations.events.pipe(
      Stream.filterEffect((event) => isLibraryRoot(event.root)),
    ),
    finishExploration: explore.finish,
    limitExploreInput: explore.limitInput,
    exploreMemoryWait: explore.memoryWait,
    exploreSheet: explore.sheet,
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
        yield* operations.cancel(root, String(threadId));
        yield* explore.release(threadId, root);
      }
      // Bot runs are keyed by their own checkout, which may be another one.
      yield* gameBot.stopOwned(threadId);
    }),
    status: Effect.fn("GameService.status")(function* (threadId, statusOptions) {
      const root = yield* projects.resolve(threadId);
      const manifest = yield* projects.read(root);
      const inventory = yield* projects.inventory(root);
      const profile = engineProfile(manifest.engine.name);
      const read = yield* selectionOf(root);
      // A damaged selection record is a stale build (Rebuild writes a fresh
      // one), never a reason the game cannot be shown.
      const damaged = read === "damaged";
      const selected = damaged ? null : read;
      const served = profile.web?.served ?? [];
      const selectedPresent =
        selected === null
          ? null
          : yield* Effect.promise(async () => {
              // Cheap structural check for status polling: a missing or empty
              // artifact file must read as stale. Byte identity is checked when
              // Play actually opens the build, not on every poll; the engine
              // names the files its Web build needs.
              for (const name of served) {
                const stat = await NodeFSP.stat(
                  NodePath.join(root, selected.directory, name),
                ).catch(() => null);
                if (stat === null || !stat.isFile() || stat.size === 0) return false;
              }
              return true;
            });
      // Freshness is a byte question against the snapshot the export recorded.
      // An unreadable tree cannot be shown to match, but it is also not proven
      // to differ.
      const current = yield* statusSnapshot(
        root,
        manifestProject(manifest),
        statusOptions?.checkSources === true,
        profile.buildInputs,
      );
      const currentId = current.kind === "known" ? current.sourceId : null;
      const matchesSelected =
        selected === null || selected.sourceId === null || currentId === null
          ? null
          : currentId === selected.sourceId;
      // What Play would show: a good export does not make the selected build
      // fresh, and a source edit does not make the selected artifact unplayable.
      // A live-staged game plays its folder, which is never older than itself.
      const live = profile.stage === "live";
      const webBuildStale =
        !live &&
        (damaged ||
          (selected === null ? false : selectedPresent !== true || matchesSelected === false));
      const sourcesDifferFromPlay: boolean | "unknown" =
        live || selected === null
          ? false
          : statusOptions?.checkSources !== true
            ? "unknown"
            : (matchesSelected ?? "unknown");
      return {
        root,
        manifest: inventory.manifest,
        viewport: inventory.viewport,
        // The releases the engine makes, as their files are now: Play follows
        // the selected record, dated by when it was selected.
        builds: [...(yield* exporter.releases(root))],
        exportTargets: [...profile.exportTargets],
        // Usability and source freshness are separate answers: the selected
        // build can be perfectly playable while the editable sources have moved
        // on, which is the normal state after an export.
        webBuildStale,
        sourcesDifferFromPlay,
        // The game's own engine tool, kept briefly per game by the engine service.
        engineTool: yield* engines.toolStatus(root),
        processes: processes.list(root),
        // Status observes the preview; it never switches it.
        previewUrl: live ? preview.liveUrl(root) : preview.url(root),
        // The serve's state, held by GamePreview.
        live: live ? preview.liveState(root) : ("off" as const),
        characters: characterRoute(manifest),
        ...(yield* art.lanes.pipe(
          Effect.map((artLanes) => ({ artLanes })),
          Effect.orElseSucceed(() => ({})),
        )),
        buildPlays: copies.plays(root),
        operation: operations.current(root),
      };
    }),
    setCharacterRoute: (threadId, route) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const unavailable = GAME_CHARACTER_ROUTE_UNAVAILABLE[route];
        if (unavailable !== undefined)
          return yield* new GameOperationError({
            operation: "set-characters",
            path: NodePath.join(root, "game.json"),
            reason: "invalid-input",
            detail: `${route}: ${unavailable}`,
          });
        // A valid manifest first; the write keeps every key it holds, only characters changes.
        yield* projects.read(root);
        const file = NodePath.join(root, "game.json");
        const raw = yield* Effect.tryPromise({
          try: () => NodeFSP.readFile(file, "utf8"),
          catch: (cause) =>
            new GameOperationError({
              operation: "set-characters",
              path: file,
              reason: "io",
              cause,
            }),
        }).pipe(
          Effect.flatMap((text) =>
            decodeManifestObject(text).pipe(
              Effect.mapError(
                (cause) =>
                  new GameOperationError({
                    operation: "set-characters",
                    path: file,
                    reason: "invalid-project",
                    cause,
                  }),
              ),
            ),
          ),
        );
        yield* writeFileStringAtomically({
          filePath: file,
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- game.json keeps the indented form people read and diff.
          contents: `${JSON.stringify({ ...raw, characters: route }, null, 2)}\n`,
          followLink: false,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "set-characters",
                path: file,
                reason: "io",
                cause,
              }),
          ),
        );
        // Every client's status signal rereads on an operation push.
        yield* operations.changed(root, "characters", `Make characters with ${route}`);
        return { route };
      }),
    import: (threadId) => withRoot(threadId, "Import", engines.importProject),
    export: (threadId, target, owner, waitUntil) =>
      withRoot(
        threadId,
        `Export ${target}`,
        (root) => exporter.export(root, target),
        owner,
        waitUntil,
      ),
    // A profile read: no lock, so it neither waits on nor fails beside another operation.
    exportTargets: (threadId) =>
      Effect.flatMap(projects.resolve(threadId), (root) => exporter.exportTargets(root)),
    packageWindows: (threadId) =>
      withRoot(threadId, "Package Windows build", exporter.packageWindows),
    packageWeb: (threadId) => withRoot(threadId, "Package Web build", exporter.packageWeb),
    exploreStart: explore.start,
    exploreAct: explore.act,
    exploreClose: explore.close,
    // Its video lands in the game folder; the run is recorded on the thread.
    botRun: (threadId, input) =>
      Effect.flatMap(projects.resolve(threadId), (root) =>
        Effect.suspend(() => {
          // A start refused for a cause not about the game (queued past its
          // bound, memory short, a tool of ours) is marked with its wait, as
          // an explore start's is.
          const waited = { ms: 0, refused: null as "low-memory" | "busy" | null };
          return gameBot
            .run(root, input, threadId, {
              onWaited: (ms, refused) => {
                waited.ms += ms;
                waited.refused = refused;
              },
            })
            .pipe(
              Effect.tapError((error) => {
                const fault = gameOperationFault(error.reason);
                return error.reason === "cancelled" || (fault !== "machine" && fault !== "tool")
                  ? Effect.void
                  : explore
                      .markRefused(threadId, root, waited.refused ?? error.reason, waited.ms)
                      .pipe(Effect.ignore({ log: true }));
              }),
            );
        }),
      ),
    // The run itself takes minutes and holds no game lock: GameBot takes the
    // game's operation lock and the memory gate only around each run's import
    // and boot, and refuses a second call on the same checkout as busy.
    botRunIn: (root, input) => gameBot.run(root, input),
    botRuns: (threadId) => gameBot.runs(threadId),
    botView: (threadId, input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* gameBot.view(root, input);
      }),
    botReportText: (root, runIds) => gameBot.reportText(root, runIds),
    toolchain: (threadId) =>
      Effect.gen(function* () {
        const status = yield* toolchainOf();
        if (threadId === undefined) return status;
        // The game's own engine speaks for its project (Unity picks its editor
        // by the project's version); the engine says which tool that is.
        const own = yield* engines.toolStatus(yield* projects.resolve(threadId));
        return own === null
          ? status
          : { tools: status.tools.map((tool) => (tool.tool === own.tool ? own : tool)) };
      }),
    botReport: (threadId) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* gameBot.report(root);
      }),
    checkIn: (root, owner) =>
      Effect.gen(function* () {
        const manifest = yield* projects.read(root);
        const label = `${engineProfile(manifest.engine.name).displayName} check`;
        return yield* operations.exclusive(root, label, engines.check(root), owner);
      }),
    check: (threadId, owner) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const manifest = yield* projects.read(root);
        const label = `${engineProfile(manifest.engine.name).displayName} check`;
        // The agent's and the person's check also looks at the scene; a build's facts read it
        // from their own random-input play instead.
        return yield* withRoot(
          threadId,
          label,
          (root) => engines.check(root, { scene: true }),
          owner,
        );
      }),
    unityTools: (threadId) => withRoot(threadId, "Unity tools", liveUnity.listTools),
    unityEdit: (threadId, input) =>
      withRoot(threadId, "Unity edit", (root) => liveUnity.edit(root, input)),
    unityEval: (threadId, input) =>
      withRoot(threadId, "Unity eval", (root) => liveUnity.evaluate(root, input)),
    unityRecompile: (threadId) =>
      withRoot(threadId, "Unity recompile", (root) =>
        Effect.gen(function* () {
          const { backend, ctx } = yield* engines.context(root);
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
    unityPlay: (threadId, input) =>
      withRoot(threadId, "Unity play", (root) => liveUnity.play(root, input)),
    unityScreenshot: (threadId, input) =>
      withRoot(threadId, "Unity screenshot", (root) => liveUnity.screenshot(root, input)),
    unityConsole: (threadId, input) =>
      withRoot(threadId, "Unity console", (root) => liveUnity.console(root, input)),
    blenderCode: (threadId, input) =>
      withRoot(threadId, "Blender code", (root) => liveBlender.code(root, input)),
    blenderLook: (threadId, input) =>
      readRoot(threadId, "Blender look", (root) => liveBlender.look(root, input)),
    blenderCharacter: (threadId, input) =>
      withRoot(threadId, "Blender character", (root) => liveBlender.character(root, input)),
    animate: (threadId, input) =>
      withRoot(threadId, "Animate", (root) => liveBlender.animate(root, input)),
    blenderPaint: (threadId, input) =>
      withRoot(threadId, "Blender paint", (root) => liveBlender.paint(root, input)),
    blenderCarve: (threadId, input) =>
      withRoot(threadId, "Blender carve", (root) => liveBlender.carve(root, input)),
    generate: (threadId, input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* art.generate(
          root,
          threadId,
          input,
          characterRoute(yield* projects.read(root)),
        );
      }),
    imageEdit: (threadId, input) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* art.generate(
          root,
          threadId,
          {
            lane: "image",
            name: imageEditName(input.path),
            prompt: input.change,
            ...(input.references === undefined ? {} : { references: input.references }),
            options: {
              edit: input.path,
              ...(input.transparent === true ? { transparent: true } : {}),
            },
          },
          characterRoute(yield* projects.read(root)),
        );
      }),
    generateWait: (threadId, input) =>
      projects.resolve(threadId).pipe(Effect.flatMap((root) => art.wait(root, input))),
    generations: (threadId) => projects.resolve(threadId).pipe(Effect.flatMap(art.list)),
    chooseGeneration: (threadId, id, candidate) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* art.choose(root, id, candidate);
      }),
    cancelGeneration: (threadId, id) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        return yield* art.cancel(root, id);
      }),
    artProviders: art.providers,
    blenderScene: (threadId, input) =>
      readRoot(threadId, "Blender scene", (root) => liveBlender.scene(root, input)),
    blenderAssetsSearch: (threadId, input) =>
      readRoot(threadId, "Blender assets search", (root) => liveBlender.assetsSearch(root, input)),
    blenderAssetsImport: (threadId, input) =>
      withRoot(threadId, "Blender assets import", (root) => liveBlender.assetsImport(root, input)),
    blenderExport: (threadId, input) =>
      withRoot(threadId, "Blender export", (root) => liveBlender.exportGlb(root, input)),
    blenderRenderSprites: (threadId, input) =>
      withRoot(threadId, "Blender sprites", (root) => liveBlender.renderSprites(root, input)),
    // Search only reads the game and writes its contact sheet under builds/, so it never waits on the game's lock.
    assetsSearch: (threadId, input) =>
      projects.resolve(threadId).pipe(Effect.flatMap((root) => library.search(root, input))),
    assetsAdd: (threadId, input) =>
      withRoot(threadId, "Library add", (root) => library.add(root, input)),
    // Blender serves every engine's art; the engine's own live editor is its driver's.
    closeLiveEditors: (root) =>
      Effect.all([liveBlender.stop(root), closeEngineEditor(root).pipe(Effect.ignore)], {
        discard: true,
      }),
    preparePlayer: players.prepare,
    playIn,
    action: (threadId, action) =>
      action === "stop"
        ? stop(threadId)
        : action === "preview"
          ? play(threadId)
          : action === "rebuild"
            ? rebuild(threadId)
            : exportAs(threadId, action === "export-linux" ? "Linux" : "Windows"),
    play,
    rebuild,
    preview: gamePreview,
    playCurrent,
    stop,
  });
});
export const layer = Layer.effect(GameService, make).pipe(
  Layer.provide(GameExplore.layer),
  // Shared with the builds' facts, so Stop game and the facts reach the same bot runs.
  Layer.provideMerge(GameBuildCopies.layer),
  Layer.provideMerge(GameBot.layer),
  Layer.provide(GameExport.layer),
  Layer.provide(GamePlayer.layer),
  Layer.provide(GameEngine.layer),
  // After GameEngine, so the engine backend and the service share one live editor.
  Layer.provide(GameUnity.layer),
  Layer.provide(GameBlender.layer),
  Layer.provide(GameArt.layer),
  // After the editors, so every heavy start, editor opens included, shares one gate.
  Layer.provide(GameMemoryGate.layer),
  Layer.provide(GameAssetLibrary.layer),
  Layer.provideMerge(GameOperations.layer),
);
