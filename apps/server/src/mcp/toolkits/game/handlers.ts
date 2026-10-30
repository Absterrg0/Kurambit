import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as GameRecipes from "../../../game/GameRecipes.ts";
import * as GameArtKits from "../../../game/GameArtKits.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameReviewSessions from "../../../game/GameReviewSessions.ts";
import * as GameReviewApi from "../../../game/GameReviewApi.ts";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  GameToolkit,
  GameArtToolkit,
  GamePlaytestToolkit,
  GameRecipeToolkit,
  GameReviewAnswerToolkit,
} from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) =>
    McpInvocationContext.requireThreadScope(context, "Game Studio tools"),
  ),
);
const handlers = {
  game_review_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const reviews = yield* GameReviewApi.GameReviewApi;
      return yield* reviews.status(scope.thread.threadId);
    }),
  ),
  game_review_history: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const reviews = yield* GameReviewApi.GameReviewApi;
      return yield* reviews.history({ ...input, threadId: scope.thread.threadId });
    }),
  ),
  game_review_stop: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const reviews = yield* GameReviewApi.GameReviewApi;
      return yield* reviews.stop(scope.thread.threadId);
    }),
  ),
  game_review_restore: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const reviews = yield* GameReviewApi.GameReviewApi;
      return yield* reviews.restore(scope.thread.threadId);
    }),
  ),
  game_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const reviews = yield* GameReviewApi.GameReviewApi;
      return yield* reviews.submit(scope.thread.threadId, input);
    }),
  ),

  game_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.status(scope.thread.threadId, { checkSources: input.checkSources });
    }),
  ),
  game_blender_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blender(scope.thread.threadId, input);
    }),
  ),
  game_godot_import: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.import(scope.thread.threadId);
    }),
  ),
  game_import: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.import(scope.thread.threadId);
    }),
  ),
  game_godot_check: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.check(scope.thread.threadId);
    }),
  ),
  game_check: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.check(scope.thread.threadId);
    }),
  ),
  game_scene_inspect: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.inspectScene(scope.thread.threadId, input.scenePath);
    }),
  ),
  game_godot_api: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.godotApi(scope.thread.threadId, input);
    }),
  ),
  game_assets_inspect: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.assetsInspect(scope.thread.threadId, input);
    }),
  ),
  game_godot_test: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.test(scope.thread.threadId, input.script, input.timeoutMs);
    }),
  ),
  game_test: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.test(scope.thread.threadId, input.script, input.timeoutMs);
    }),
  ),
  game_scenarios_run: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.scenariosRun(scope.thread.threadId);
    }),
  ),
  game_native_capture: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.nativeCapture(scope.thread.threadId, input);
    }),
  ),
  game_runtime_calibrate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.runtimeCalibrate(scope.thread.threadId, input);
    }),
  ),
  game_audio_inspect: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.audioInspect(scope.thread.threadId, input);
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
  game_run_native: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      // An agent's run is always headless; only the creator's own Play action
      // may inherit the desktop display.
      return yield* game.native(scope.thread.threadId, { display: "headless" });
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
  game_explore_replay: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.exploreReplay(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
// Contextual input typing comes from the satisfies check below.
const playtestHandlers = {
  game_try_input: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const sessions = yield* GameReviewSessions.GameReviewSessions;
      return yield* sessions.tryInput(scope.thread, input);
    }),
  ),
  game_review_detail: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const sessions = yield* GameReviewSessions.GameReviewSessions;
      return yield* sessions.inspectDetail(scope.thread, input);
    }),
  ),
  game_web_playtest: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.webPlaytest(scope.thread.threadId, input);
    }),
  ),
  game_verify: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.verify(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GamePlaytestToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
/**
 * Registered separately over the HTTP transport so the playtest frames become
 * real image content; see McpHttpServer.registerGameWebPlaytest.
 */
export const layerPlaytest = McpToolAccess.toLayer(GamePlaytestToolkit, playtestHandlers);

// A read-only toolkit over the static catalog: the transport only maps input to
// one service method, and the service can never read the game or start work.
// The call itself is counted against the calling thread, so loop usage can say
// whether a role reached for know-how; a failed lookup still counts as a reach.
const noteRecipeCall = Effect.gen(function* () {
  const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  if (!Option.isSome(invocation)) return;
  const threadId = invocation.value.thread?.threadId;
  if (threadId === undefined) return;
  const sessions = yield* Effect.serviceOption(GameReviewSessions.GameReviewSessions);
  if (!Option.isSome(sessions)) return;
  // Counting is evidence, never a reason for a retrieval to fail.
  yield* sessions.value.noteRecipeCall(threadId).pipe(Effect.catchCause(() => Effect.void));
});
const recipeHandlers = {
  game_recipe_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const recipes = yield* GameRecipes.GameRecipes;
      return yield* recipes.search(input).pipe(Effect.mapError((error) => error.message));
    }).pipe(Effect.ensuring(noteRecipeCall)),
  ),
  game_recipe_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const recipes = yield* GameRecipes.GameRecipes;
      return yield* recipes.get(input).pipe(Effect.mapError((error) => error.message));
    }).pipe(Effect.ensuring(noteRecipeCall)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameRecipeToolkit.tools>;
export const layerRecipes = McpToolAccess.toLayer(GameRecipeToolkit, recipeHandlers);

const artHandlers = {
  game_art_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const kits = yield* GameArtKits.GameArtKits;
      return yield* kits.search(input);
    }),
  ),
  game_art_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const kits = yield* GameArtKits.GameArtKits;
      return yield* kits.get(input).pipe(Effect.mapError((error) => error.message));
    }),
  ),
  game_art_import: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.importArtKit(scope.thread.threadId, input);
    }),
  ),
  game_art_frames: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.buildArtFrames(scope.thread.threadId, input);
    }),
  ),
  game_library_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const library = yield* GameAssetLibrary.GameAssetLibrary;
      return yield* library.search(input).pipe(Effect.mapError((error) => error.message));
    }),
  ),
  game_library_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const library = yield* GameAssetLibrary.GameAssetLibrary;
      return yield* library.get(input).pipe(Effect.mapError((error) => error.message));
    }),
  ),
  game_library_import_model: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.importLibraryModel(scope.thread.threadId, input);
    }),
  ),
  game_library_import_material: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.importLibraryMaterial(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameArtToolkit.tools>;
export const layerArt = McpToolAccess.toLayer(GameArtToolkit, artHandlers);

const reviewAnswer = (role: "critic" | "ballot") =>
  McpToolAccess.readsAsCaller((input: unknown) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const sessions = yield* GameReviewSessions.GameReviewSessions;
      return yield* sessions.report(scope.thread, role, input);
    }),
  );
export const layerReviewAnswers = McpToolAccess.toLayer(GameReviewAnswerToolkit, {
  game_critic_report: reviewAnswer("critic"),
  game_ballot: reviewAnswer("ballot"),
});
