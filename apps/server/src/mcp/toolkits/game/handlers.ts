import * as Effect from "effect/Effect";
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
const handlers = {
  game_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.status(scope.thread.threadId, { checkSources: input.checkSources });
    }),
  ),
  game_blender_code: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderCode(scope.thread.threadId, input);
    }),
  ),
  game_blender_scene: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderScene(scope.thread.threadId, input);
    }),
  ),
  game_blender_assets_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderAssetsSearch(scope.thread.threadId, input);
    }),
  ),
  game_assets_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.assetsAdd(scope.thread.threadId, input);
    }),
  ),
  game_blender_assets_import: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderAssetsImport(scope.thread.threadId, input);
    }),
  ),
  game_blender_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderExport(scope.thread.threadId, input);
    }),
  ),
  game_unity_tools: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityTools(scope.thread.threadId);
    }),
  ),
  game_unity_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityEdit(scope.thread.threadId, input);
    }),
  ),
  game_unity_eval: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityEval(scope.thread.threadId, input);
    }),
  ),
  game_unity_recompile: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityRecompile(scope.thread.threadId);
    }),
  ),
  game_unity_play: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityPlay(scope.thread.threadId, input);
    }),
  ),
  game_unity_console: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityConsole(scope.thread.threadId, input);
    }),
  ),
  game_import: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.import(scope.thread.threadId);
    }),
  ),
  game_check: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.check(scope.thread.threadId);
    }),
  ),
  game_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.export(scope.thread.threadId, input.target);
    }),
  ),
  game_package_windows: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.packageWindows(scope.thread.threadId);
    }),
  ),
  game_package_web: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.packageWeb(scope.thread.threadId);
    }),
  ),
  game_preview: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.action(scope.thread.threadId, "preview");
    }),
  ),
  game_stop: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.action(scope.thread.threadId, "stop");
    }),
  ),
  game_explore_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.exploreStart(scope.thread.threadId, input);
    }),
  ),
  game_explore_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.exploreAct(scope.thread.threadId, input);
    }),
  ),
  game_explore_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.exploreClose(scope.thread.threadId, input);
    }),
  ),
  game_bot_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.botRun(scope.thread.threadId, input);
    }),
  ),
  game_bot_view: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.botView(scope.thread.threadId, input);
    }),
  ),
  game_bot_report: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.botReport(scope.thread.threadId);
    }),
  ),
  game_run_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs.runStatus(scope.thread.threadId).pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_round: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      const { detail } = yield* runs
        .roundDetail(scope.thread.threadId, input.round)
        .pipe(Effect.mapError(runFailure));
      return detail;
    }),
  ),
  game_run_checks: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs.runChecks(scope.thread.threadId).pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_steer: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runSteer(scope.thread.threadId, input.text, input.commandId)
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_decide: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runDecide({ threadId: scope.thread.threadId, ...input })
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runStart({ threadId: scope.thread.threadId, ...input })
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runStop(scope.thread.threadId, input.commandId)
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runSubmit(scope.thread.threadId, input.submission)
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_restore: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .restoreRound(scope.thread.threadId, input.round)
        .pipe(Effect.mapError(runFailure));
    }),
  ),
  game_run_profile: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* runs
        .runProfile(scope.thread.threadId, input.profile, input.commandId)
        .pipe(Effect.mapError(runFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
/**
 * Registered separately over the HTTP transport so the look image becomes
 * real image content; see McpHttpServer.registerGameBlenderLook.
 */
const blenderLookHandlers = {
  game_blender_look: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderLook(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderLookToolkit.tools>;
export const layerBlenderLook = McpToolAccess.toLayer(GameBlenderLookToolkit, blenderLookHandlers);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const blenderRenderSpritesHandlers = {
  game_blender_render_sprites: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderRenderSprites(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderRenderSpritesToolkit.tools>;
export const layerBlenderRenderSprites = McpToolAccess.toLayer(
  GameBlenderRenderSpritesToolkit,
  blenderRenderSpritesHandlers,
);

/** Registered like the Blender look, so the capture becomes real image content. */
const unityScreenshotHandlers = {
  game_unity_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.unityScreenshot(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameUnityScreenshotToolkit.tools>;
export const layerUnityScreenshot = McpToolAccess.toLayer(
  GameUnityScreenshotToolkit,
  unityScreenshotHandlers,
);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const assetsSearchHandlers = {
  game_assets_search: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.assetsSearch(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAssetsSearchToolkit.tools>;
export const layerAssetsSearch = McpToolAccess.toLayer(
  GameAssetsSearchToolkit,
  assetsSearchHandlers,
);
