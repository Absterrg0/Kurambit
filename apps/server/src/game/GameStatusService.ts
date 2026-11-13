// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem boundary of status reads.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  manifestProject,
  type GameManifest,
  type GameOperationError,
  type GameOperationEvent,
  type GameStatus,
  type GameToolchainStatus,
  type ThreadId,
} from "@kurambit/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as GameArt from "./art/GameArt.ts";
import { engineProfile } from "./engineProfile.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameExport from "./GameExport.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameToolchain from "./GameToolchain.ts";
import { characterRoute } from "./gameStyle.ts";
import { makeSourceIdentity } from "./sourceTree.ts";
import { COPY_OF } from "./unityPlayerCache.ts";

/** What a client sees of a game: its status, the pushes that say it changed, and the tools it needs. */
export class GameStatusService extends Context.Service<
  GameStatusService,
  {
    readonly status: (
      threadId: ThreadId,
      options?: { readonly checkSources?: boolean | undefined },
    ) => Effect.Effect<GameStatus, GameOperationError>;
    /** The pushes for one thread's game; the stream fails when the thread's game cannot be resolved. */
    readonly threadEvents: (
      threadId: ThreadId,
    ) => Stream.Stream<GameOperationEvent, GameOperationError>;
    /**
     * The pushes a games library shows: games' own folders only, never the
     * production run's sample copies, whose checks and builds change no card.
     */
    readonly libraryEvents: Stream.Stream<GameOperationEvent>;
    /**
     * The toolchain's status for the Settings row and the stage's readiness,
     * cached; with a thread, Unity's entry speaks for that game's editor version.
     */
    readonly toolchain: (
      threadId?: ThreadId,
    ) => Effect.Effect<GameToolchainStatus, GameOperationError>;
    /**
     * Whether the selected Web build is of the folder's sources: an unreadable
     * tree cannot be shown current, and a damaged selection record is no build
     * of these sources, so neither is fresh.
     */
    readonly webFresh: (
      root: string,
      manifest: GameManifest,
    ) => Effect.Effect<boolean, GameOperationError>;
  }
>()("kurambit/game/GameStatusService") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const tools = yield* GameToolchain.GameToolchain;
  const engines = yield* GameEngine.GameEngine;
  const preview = yield* GamePreview.GamePreview;
  const art = yield* GameArt.GameArt;
  const operations = yield* GameOperations.GameOperations;
  const exporter = yield* GameExport.GameExport;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const settings = yield* ServerSettings.ServerSettingsService;
  const identify = yield* makeSourceIdentity;
  // The machine's toolchain, cached: the stage reads it on its own query,
  // never on every status read. Keyed by the toolchain's revision, so a fetch
  // is seen at once; a settings change clears it.
  const toolchainStatus = yield* Cache.make({
    lookup: (_revision: number) => tools.status(),
    capacity: 4,
    timeToLive: "30 seconds",
  });
  const toolchainOf = () => Cache.get(toolchainStatus, tools.revision());
  yield* settings.subscribeChanges.pipe(
    Effect.flatMap((changes) =>
      Stream.runForEach(changes, () => Cache.invalidateAll(toolchainStatus)),
    ),
    Effect.forkScoped,
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
  return GameStatusService.of({
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
    webFresh: (root, manifest) =>
      Effect.gen(function* () {
        const profile = engineProfile(manifest.engine.name);
        const selected = yield* selectionOf(root);
        if (selected === null || selected === "damaged" || selected.sourceId === null) return false;
        const current = yield* identify(root, manifestProject(manifest), profile.derivedInput);
        return current.kind === "known" && current.sourceId === selected.sourceId;
      }),
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
    status: Effect.fn("GameStatusService.status")(function* (threadId, statusOptions) {
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
      // A live-staged game plays its folder, which is never older than itself,
      // so its status reads no source identity at all.
      const live = profile.stage === "live";
      // Freshness is a byte question against the snapshot the export recorded.
      // An unreadable tree cannot be shown to match, but it is also not proven
      // to differ.
      const current =
        live || selected === null || selected.sourceId === null
          ? null
          : yield* identify(root, manifestProject(manifest), profile.derivedInput);
      const currentId = current?.kind === "known" ? current.sourceId : null;
      const matchesSelected =
        selected === null || selected.sourceId === null || currentId === null
          ? null
          : currentId === selected.sourceId;
      // What Play would show: a good export does not make the selected build
      // fresh, and a source edit does not make the selected artifact unplayable.
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
  });
});

export const layer = Layer.effect(GameStatusService, make);
