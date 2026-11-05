import * as Effect from "effect/Effect";
import type { ThreadId } from "@kurambit/contracts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  GameToolkit,
  GameAssetsSearchToolkit,
  GameBlenderLookToolkit,
  GameBlenderRenderSpritesToolkit,
  GameUnityScreenshotToolkit,
} from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) => McpInvocationContext.requireThreadScope(context, "Kurambit tools")),
);
const runFailure = (cause: GameRunControl.GameRunError) =>
  GameRunControl.GameRunError.toOperationError(`game-${cause.operation}`, cause);
/** One tool call: the calling thread's work on the game service. */
const withGame = <A, E>(
  work: (game: GameService.GameService["Service"], threadId: ThreadId) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* GameService.GameService, scope.thread.threadId);
  });
/** One tool call on the calling thread's production run, its refusals as operation errors. */
const withRuns = <A>(
  work: (
    runs: GameRunControl.GameRunControl["Service"],
    threadId: ThreadId,
  ) => Effect.Effect<A, GameRunControl.GameRunError>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* GameRunControl.GameRunControl, scope.thread.threadId).pipe(
      Effect.mapError(runFailure),
    );
  });
const handlers = {
  game_status: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.status(threadId, { checkSources: input.checkSources })),
  ),
  game_blender_code: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.blenderCode(threadId, input)),
  ),
  game_blender_scene: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.blenderScene(threadId, input)),
  ),
  game_blender_assets_search: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.blenderAssetsSearch(threadId, input)),
  ),
  game_assets_add: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.assetsAdd(threadId, input)),
  ),
  game_blender_assets_import: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.blenderAssetsImport(threadId, input)),
  ),
  game_blender_export: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.blenderExport(threadId, input)),
  ),
  game_unity_tools: McpToolAccess.readsAsCaller(() =>
    withGame((game, threadId) => game.unityTools(threadId)),
  ),
  game_unity_edit: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.unityEdit(threadId, input)),
  ),
  game_unity_eval: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.unityEval(threadId, input)),
  ),
  game_unity_recompile: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.unityRecompile(threadId)),
  ),
  game_unity_play: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.unityPlay(threadId, input)),
  ),
  game_unity_console: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.unityConsole(threadId, input)),
  ),
  game_import: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.import(threadId)),
  ),
  game_check: McpToolAccess.actsAsCaller(() => withGame((game, threadId) => game.check(threadId))),
  game_export: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.export(threadId, input.target)),
  ),
  game_package_windows: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.packageWindows(threadId)),
  ),
  game_package_web: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.packageWeb(threadId)),
  ),
  game_media_save: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.saveMedia(threadId, input.source, input.label)),
  ),
  game_saved_list: McpToolAccess.readsAsCaller(() =>
    withGame((game, threadId) => game.listSaved(threadId)),
  ),
  game_saved_delete: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.deleteSaved(threadId, input.name).pipe(Effect.as({}))),
  ),
  game_preview: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.action(threadId, "preview")),
  ),
  game_stop: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.action(threadId, "stop")),
  ),
  game_explore_start: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.exploreStart(threadId, input)),
  ),
  game_explore_act: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.exploreAct(threadId, input)),
  ),
  game_explore_close: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.exploreClose(threadId, input)),
  ),
  game_bot_run: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.botRun(threadId, input)),
  ),
  game_bot_view: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.botView(threadId, input)),
  ),
  game_bot_report: McpToolAccess.actsAsCaller(() =>
    withGame((game, threadId) => game.botReport(threadId)),
  ),
  game_run_status: McpToolAccess.readsAsCaller(() =>
    withRuns((runs, threadId) => runs.runStatus(threadId)),
  ),
  game_run_round: McpToolAccess.readsAsCaller((input) =>
    withRuns((runs, threadId) =>
      runs.roundDetail(threadId, input.round).pipe(Effect.map(({ detail }) => detail)),
    ),
  ),
  game_run_checks: McpToolAccess.actsAsCaller(() =>
    withRuns((runs, threadId) => runs.runChecks(threadId)),
  ),
  game_run_steer: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runSteer(threadId, input.text, input.commandId)),
  ),
  game_run_decide: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runDecide({ threadId: threadId, ...input })),
  ),
  game_run_start: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runStart({ threadId: threadId, ...input })),
  ),
  game_run_stop: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runStop(threadId, input.commandId)),
  ),
  game_run_submit: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runSubmit(threadId, input.submission)),
  ),
  game_run_restore: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.restoreRound(threadId, input.round)),
  ),
  game_run_profile: McpToolAccess.actsAsCaller((input) =>
    withRuns((runs, threadId) => runs.runProfile(threadId, input.profile, input.commandId)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
/**
 * Registered separately over the HTTP transport so the look image becomes
 * real image content; see McpHttpServer.registerGameBlenderLook.
 */
const blenderLookHandlers = {
  game_blender_look: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.blenderLook(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderLookToolkit.tools>;
export const layerBlenderLook = McpToolAccess.toLayer(GameBlenderLookToolkit, blenderLookHandlers);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const blenderRenderSpritesHandlers = {
  game_blender_render_sprites: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.blenderRenderSprites(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderRenderSpritesToolkit.tools>;
export const layerBlenderRenderSprites = McpToolAccess.toLayer(
  GameBlenderRenderSpritesToolkit,
  blenderRenderSpritesHandlers,
);

/** Registered like the Blender look, so the capture becomes real image content. */
const unityScreenshotHandlers = {
  game_unity_screenshot: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.unityScreenshot(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameUnityScreenshotToolkit.tools>;
export const layerUnityScreenshot = McpToolAccess.toLayer(
  GameUnityScreenshotToolkit,
  unityScreenshotHandlers,
);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const assetsSearchHandlers = {
  game_assets_search: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.assetsSearch(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAssetsSearchToolkit.tools>;
export const layerAssetsSearch = McpToolAccess.toLayer(
  GameAssetsSearchToolkit,
  assetsSearchHandlers,
);
