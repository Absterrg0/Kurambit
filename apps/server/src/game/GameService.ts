// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of status and checks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  GameOperationError,
  type GameCheckResult,
  type GameStatus,
  type GameAction,
  type GameActionResult,
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
  type GameBlenderCodeInput,
  type GameBlenderCodeResult,
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
  type GameSetSecretInput,
  type GameSetSecretResult,
  type GameSecretsStatusResult,
} from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { commandDetail } from "./commandDetail.ts";
import { engineProfile } from "./engineProfile.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameBlender from "./GameBlender.ts";
import * as GameBot from "./GameBot.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameExplore from "./GameExplore.ts";
import * as GameExport from "./GameExport.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import * as GameUnity from "./GameUnity.ts";
import {
  SAVED_DIR,
  SAVED_EVENT,
  SavedMediaError,
  deleteSaved,
  listSaved,
  saveMedia,
} from "./gameSavedMedia.ts";
import { limitIssues, mergeCheckIssues } from "./godotCheckOutput.ts";
import { comparedSource, type SourceHashCache, snapshotBuildSource } from "./sourceSnapshot.ts";
import { WEB_BUILD_DIRECTORY } from "./webBuild.ts";
import { textOf } from "./liveProcess.ts";

/**
 * A Godot bot peaked at 710 MB in its import and 505 MB playing (Godot,
 * ffmpeg recording, its display, bot child); a Chromium bot at 630 MB. Its
 * Chromium launches after the memory gate, so two bots admitted together
 * must both fit.
 */
const BOT_ROOM: MemoryRoom = {
  what: "bot run",
  neededMb: 1536,
  env: "KURAMBIT_BOT_MEMORY_MB",
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
     * Since this thread's last finishExploration: how long its explore starts
     * waited for memory, how many were refused `low-memory` and whether the
     * latest was; with the input steps its sessions have executed in all.
     */
    readonly exploreMemoryWait: (threadId: ThreadId) => Effect.Effect<
      {
        readonly waitedMs: number;
        readonly refusals: number;
        readonly refused: boolean;
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
    /** The pushes for one thread's game; empty when the thread has no game. */
    readonly threadEvents: (threadId: ThreadId) => Stream.Stream<GameOperationEvent>;
    readonly action: (
      threadId: ThreadId,
      action: GameAction,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
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
    /**
     * Opens the game's live editor (Unity's) once and closes it, so its
     * first full import is paid outside any role's clock. A no-op when the
     * engine has no live editor or the project already has an import cache.
     */
    readonly warmEditor: (root: string) => Effect.Effect<boolean, GameOperationError>;
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
    readonly export: (
      threadId: ThreadId,
      target: "Web" | "Linux" | "Windows",
      owner?: string,
    ) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * Which export targets the game's engine backend declares, with its display
     * name. Internal loop fact resolved through the existing engine path; not
     * an MCP tool. Runs no processes.
     */
    readonly exportTargets: (
      threadId: ThreadId,
      owner?: string,
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
    readonly check: (
      threadId: ThreadId,
      owner?: string,
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
  const library = yield* GameAssetLibrary.GameAssetLibrary;
  const gameBot = yield* GameBot.GameBot;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const operations = yield* GameOperations.GameOperations;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const exporter = yield* GameExport.GameExport;
  const explore = yield* GameExplore.GameExplore;
  const players = yield* GamePlayer.GamePlayer;
  const snapshot = (root: string, project: string) =>
    Effect.promise((signal) => snapshotBuildSource(root, project, { signal }));
  // Status is read on every push for the thread, so its freshness answer reuses
  // hashes of files whose stat identity is unchanged. An explicit check rereads
  // every byte and refreshes the cache. The most recently read checkouts keep
  // theirs (a run's sample copies are checkouts too); one dropped costs a
  // single full read. A cache holds up to 10k files, about 3 MB.
  const statusHashes = new Map<string, SourceHashCache>();
  const statusSnapshot = (root: string, project: string, reread: boolean) =>
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
      return snapshotBuildSource(root, project, { signal, cache });
    });
  // No exclusive() here: a real-time run takes minutes and must not hold the
  // game's operation lock. The bot service refuses a second concurrent run
  // per checkout as busy.
  const botRunIn = Effect.fnUntraced(function* (root: string, input: GameBotRunInput) {
    const engine = engineProfile((yield* projects.read(root)).engine.name);
    yield* gate.admit(
      "Bot run",
      root,
      BOT_ROOM,
      // A prepared player imports in its own build, and only when it builds.
      engine.play === "player"
        ? Effect.void
        : Effect.gen(function* () {
            // An engine with no import step (three.js) succeeds here at once.
            const imported = yield* engines.importProject(root);
            if (!imported.success)
              return yield* new GameOperationError({
                operation: "Bot run",
                path: imported.path ?? root,
                reason: "command-failed",
                detail:
                  `The ${engine.displayName} import failed before the bot run started.\n${imported.message}`.slice(
                    -2000,
                  ),
              });
          }),
    );
    return yield* gameBot.run(root, input);
  });
  /**
   * Imports first: a fresh game has no .godot cache, so .tres files and
   * class_names can resolve. With a live editor, import and check share one
   * hold, as export does: another game cannot take the editor between them.
   */
  const checkGame = (root: string) =>
    Effect.flatMap(engines.context(root), ({ backend }) =>
      backend.editor === null ? checkSources(root) : backend.editor.hold(root)(checkSources(root)),
    );
  const checkSources = (root: string) =>
    Effect.gen(function* () {
      {
        const startedAt = yield* Clock.currentTimeMillis;
        const { backend, ctx } = yield* engines.context(root);
        const { profile } = backend;
        const godotProject = ctx.projectName;
        const manifest = yield* projects.read(root);
        const gameplayScene = manifest.gameplayScene ?? "";
        // Import is cache preparation, not the check itself: Godot's import can
        // write sidecar files inside the project, so the inputs are read after it
        // and before the checking script runs.
        const imported = (yield* backend.importProject(ctx)).result;
        const before = yield* snapshot(root, godotProject);
        {
          const executed = yield* backend.runCheck(ctx, { gameplayScene });
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
              message: `The ${profile.displayName} check script did not report a result. The project may have crashed during startup.`,
            });
          if (run.timedOut)
            errors.unshift({
              file: projectFile,
              message: profile.check.timedOut,
            });
          if (run.exitCode !== 0 && errors.length === 0)
            errors.unshift({
              file: projectFile,
              message: `${profile.displayName} exited with code ${run.exitCode}. ${commandDetail(run)}`,
            });
          // A game created before gameplay entries is checked as it always was, but
          // the warning says what the check did not cover rather than implying it did.
          // A three.js game's gameplay entry is a page URL (the starter's is
          // index.html?play) that the check loads after the page itself.
          const warnings = [
            ...(reported?.warnings ?? []),
            ...(manifest.gameplayScene == null && profile.check.withoutGameplayScene !== null
              ? [{ file: "game.json", message: profile.check.withoutGameplayScene }]
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
  // The game_unity_* tools are the Unity editor's own front, so only a Unity game has them.
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
    owner: string = String(threadId),
  ) {
    const root = yield* projects.resolve(threadId);
    return yield* operations.exclusive(root, name, work(root), owner);
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
    threadEvents: (threadId) =>
      Stream.unwrap(
        projects.resolve(threadId).pipe(
          Effect.map((root) =>
            operations.events.pipe(Stream.filter((event) => event.root === root)),
          ),
          Effect.orElseSucceed(() => Stream.empty),
        ),
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
    }),
    status: Effect.fn("GameService.status")(function* (threadId, statusOptions) {
      const root = yield* projects.resolve(threadId);
      const manifest = yield* projects.read(root);
      const inventory = yield* projects.inventory(root);
      const selected = yield* exporter.selected(root);
      const served = engineProfile(manifest.engine.name).web?.served ?? [];
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
      const current = yield* statusSnapshot(
        root,
        manifest.godotProject,
        statusOptions?.checkSources === true,
      ).pipe(Effect.option);
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
        // The toolchain picks a Unity editor by the project's own version; no other engine has one per project.
        toolchain: yield* tools.status(
          manifest.engine.name === "unity"
            ? { unityProject: GameProjectService.insideGame(root, manifest.godotProject) }
            : undefined,
        ),
        processes: processes.list(root),
        previewUrl,
        operation: operations.current(root),
      };
    }),
    import: (threadId) => withRoot(threadId, "Import", engines.importProject),
    export: (threadId, target, owner) =>
      withRoot(threadId, `Export ${target}`, (root) => exporter.export(root, target), owner),
    exportTargets: (threadId, owner) =>
      withRoot(
        threadId,
        "Export targets",
        (root) =>
          Effect.gen(function* () {
            const { profile } = (yield* engines.context(root)).backend;
            return { targets: profile.exportTargets, displayName: profile.displayName };
          }),
        owner,
      ),
    packageWindows: (threadId) =>
      withRoot(threadId, "Package Windows build", exporter.packageWindows),
    packageWeb: (threadId) => withRoot(threadId, "Package Web build", exporter.packageWeb),
    exploreStart: explore.start,
    exploreAct: explore.act,
    exploreClose: explore.close,
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
    check: (threadId, owner) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const manifest = yield* projects.read(root);
        const label = `${engineProfile(manifest.engine.name).displayName} check`;
        return yield* withRoot(threadId, label, checkGame, owner);
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
                Effect.map(textOf),
                Effect.orElseSucceed(() => "Saving the scene failed."),
              );
              return { text: `${textOf(result).slice(0, 8000)}\n${saved}` };
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
          Effect.map((result) => ({ text: textOf(result).slice(0, 8000) })),
        ),
      ),
    unityRecompile: (threadId) =>
      withRoot(threadId, "Unity recompile", (root) =>
        Effect.gen(function* () {
          yield* unityRoot(root);
          const { backend, ctx } = yield* engines.context(root);
          const imported = yield* backend.importProject(ctx);
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
          return { text: textOf(result) };
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
          Effect.map((result) => ({ text: textOf(result).slice(0, 12000) })),
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
    blenderRenderSprites: (threadId, input) =>
      withRoot(threadId, "Blender sprites", (root) => liveBlender.renderSprites(root, input)),
    // Search only reads the game and writes its contact sheet under builds/, so it never waits on the game's lock.
    assetsSearch: (threadId, input) =>
      projects.resolve(threadId).pipe(Effect.flatMap((root) => library.search(root, input))),
    assetsAdd: (threadId, input) =>
      withRoot(threadId, "Library add", (root) => library.add(root, input)),
    closeLiveEditors: (root) =>
      Effect.all([liveBlender.stop(root), liveUnity.stop(root)], { discard: true }),
    preparePlayer: players.prepare,
    warmEditor: players.warmEditor,
    action: Effect.fn("GameService.action")(function* (threadId, action) {
      const root = yield* projects.resolve(threadId);
      if (action === "stop") {
        // The production run's builds, bots and editors are its own: Stop game
        // cancels only the caller's work while a run holds the game.
        const hold = yield* projects.runHold(threadId);
        if (hold !== null) {
          yield* operations.cancel(root, String(threadId));
          return {
            success: true,
            message:
              hold === "finishing"
                ? "Stopped your work on this game. The production run is finishing; its exports end on their own."
                : hold === "restoring"
                  ? "Stopped your work on this game. A round of the production run is being restored; the restore ends on its own."
                  : "Stopped your work on this game. The production run's builds, bots and editors keep running; stop the run to stop them.",
            path: null,
            url: null,
            process: null,
          };
        }
        yield* operations.cancel(root);
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
      return yield* operations.exclusive(
        root,
        action,
        action === "export-linux"
          ? exporter.export(root, "Linux")
          : action === "export-windows"
            ? exporter.export(root, "Windows")
            : // Rebuild forces a new export and publishes it.
              action === "rebuild"
              ? exporter.publishWeb(root)
              : exporter.play(root),
        String(threadId),
      );
    }),
  });
});
export const layer = Layer.effect(GameService, make).pipe(
  Layer.provide(GameExplore.layer),
  Layer.provide(GameBot.layer),
  Layer.provide(GameExport.layer),
  Layer.provide(GamePlayer.layer),
  Layer.provide(GameEngine.layer),
  // After GameEngine, so the engine backend and the service share one live editor.
  Layer.provide(GameUnity.layer),
  Layer.provide(GameBlender.layer),
  // After the editors, so every heavy start, editor opens included, shares one gate.
  Layer.provide(GameMemoryGate.layer),
  Layer.provide(GameAssetLibrary.layer),
  Layer.provideMerge(GameOperations.layer),
);
