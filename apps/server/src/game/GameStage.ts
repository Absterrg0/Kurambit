// @effect-diagnostics nodeBuiltinImport:off -- A play answer names the files it serves.
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  GAME_LIVE_EVENT,
  type GameAction,
  type GameActionResult,
  type GameManifest,
  GameOperationError,
  OLD_SHELL_MESSAGE,
  type ThreadId,
} from "@kurambit/contracts";
import { engineProfile, type GameEngineProfile } from "./engineProfile.ts";
import * as GameBlender from "./GameBlender.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameExport from "./GameExport.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GamePreview from "./GamePreview.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameStatusService from "./GameStatusService.ts";
import { carriesOldShell } from "./gameRuntime.ts";

/**
 * What the Stage plays and stops: Play, Rebuild and the agent's preview of the
 * current sources, Stop game, and the live editors a restore must close.
 */
export class GameStage extends Context.Service<
  GameStage,
  {
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
    /**
     * `game_play` op `preview`: a playable build of the current sources. A Web build
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
     * Close the live editors (Blender) without saving, so a scene held
     * in memory cannot save over files restored on disk; the next call reopens them.
     */
    readonly closeLiveEditors: (root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameStage") {}

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const preview = yield* GamePreview.GamePreview;
  const liveBlender = yield* GameBlender.GameBlender;
  const operations = yield* GameOperations.GameOperations;
  const exporter = yield* GameExport.GameExport;
  const copies = yield* GameBuildCopies.GameBuildCopies;
  const statuses = yield* GameStatusService.GameStatusService;
  // Every client rereads a live game's status when its serve opens or stops.
  yield* Stream.runForEach(preview.liveStates, ({ root, state }) =>
    operations.changed(root, GAME_LIVE_EVENT, state === "serving" ? "Serving" : "Stopped"),
  ).pipe(Effect.forkScoped);
  // A live-staged game's Web export is a release only: Play keeps the live folder.
  const rebuild = (threadId: ThreadId) =>
    Effect.flatMap(projects.resolve(threadId), projects.read).pipe(
      Effect.flatMap((manifest) =>
        engineProfile(manifest.engine.name).stage === "live"
          ? exporter.export(threadId, "Web")
          : projects.exclusive(threadId, "Build Web", exporter.publishWeb),
      ),
    );
  const oldShell = (root: string, manifest: GameManifest) =>
    Effect.promise(() => carriesOldShell(root, manifest));
  const oldShellRefused = (root: string) =>
    Effect.fail(
      new GameOperationError({
        operation: "play",
        path: root,
        reason: "unsupported",
        detail: OLD_SHELL_MESSAGE,
      }),
    );
  /** What a game whose engine makes no Web build answers Play with. */
  const noWebPlay = (root: string, displayName: string): GameActionResult => ({
    success: false,
    message: `${displayName} games make no Web build to play here. Export a release from Export… in the Stage's More menu (game_builds op export for an agent).`,
    path: root,
    url: null,
    process: null,
  });
  // A live-staged game is its folder, served as its dev server: nothing is
  // built or written, so there is no operation and no write admission.
  // `message` is read by whoever asked: the person's Stage shows Play's, an agent reads game_play op preview's.
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
  const play = Effect.fn("GameStage.play")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const manifest = yield* projects.read(root);
    // A game on the old shell plays nothing, not even an export it made before.
    if (yield* oldShell(root, manifest)) return yield* oldShellRefused(root);
    const profile = engineProfile(manifest.engine.name);
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
    return yield* projects.exclusive(threadId, "Build Web", (root) =>
      Effect.flatMap(exporter.serve(root), (again) =>
        again === null ? exporter.publishWeb(root) : Effect.succeed(again),
      ),
    );
  });
  const playIn = Effect.fn("GameStage.playIn")(function* (root: string, owner: string) {
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
    if (yield* statuses.webFresh(root, manifest)) {
      const result = yield* served();
      if (result !== null || !options.serveFresh) return result;
    }
    return yield* projects.exclusive(
      threadId,
      "Build Web",
      (root) =>
        Effect.flatMap(statuses.webFresh(root, manifest), (fresh) =>
          fresh
            ? Effect.flatMap(served(), (result) =>
                result !== null || !options.serveFresh
                  ? Effect.succeed(result)
                  : exporter.publishWeb(root),
              )
            : exporter.publishWeb(root),
        ),
      { waitUntil: options.waitUntil },
    );
  });
  const playCurrent = Effect.fn("GameStage.playCurrent")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const manifest = yield* projects.read(root);
    if (!engineProfile(manifest.engine.name).exportTargets.includes("Web")) return;
    // A turn's own check or Play may still hold the game for a moment.
    const waitUntil = (yield* Clock.currentTimeMillis) + 120_000;
    yield* currentWeb(threadId, root, manifest, { serveFresh: false, waitUntil });
  });
  const gamePreview = Effect.fn("GameStage.preview")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    const manifest = yield* projects.read(root);
    if (yield* oldShell(root, manifest)) return yield* oldShellRefused(root);
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
    return noWebPlay(root, profile.displayName);
  });
  const stop = Effect.fn("GameStage.stop")(function* (threadId: ThreadId) {
    const root = yield* projects.resolve(threadId);
    yield* operations.cancel(root);
    yield* processes.stop(root);
    // Plays and measurements of the game's builds run in copies of their own.
    yield* copies.stopFor(root);
    // Each stop is tried; one that did not end its processes is said, never reported stopped.
    const notStopped: string[] = [];
    for (const [what, stopping] of [["the live Blender", liveBlender.stop(root)]] as const) {
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
  return GameStage.of({
    action: (threadId, action) =>
      action === "stop"
        ? stop(threadId)
        : action === "preview"
          ? play(threadId)
          : rebuild(threadId),
    play,
    playIn,
    preview: gamePreview,
    playCurrent,
    stop,
    closeLiveEditors: (root) => liveBlender.stop(root),
  });
});

export const layer = Layer.effect(GameStage, make);
