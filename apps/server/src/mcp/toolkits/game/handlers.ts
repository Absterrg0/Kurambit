import * as Effect from "effect/Effect";
import * as GameReviewApi from "../../../game/GameReviewApi.ts";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GameToolkit, GamePlaytestToolkit } from "./tools.ts";
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
  game_godot_check: McpToolAccess.actsAsCaller(() =>
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
  game_godot_test: McpToolAccess.actsAsCaller((input) =>
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
  game_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.export(scope.thread.threadId, input.target);
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
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
// Contextual input typing comes from the satisfies check below.
const playtestHandlers = {
  game_web_playtest: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.webPlaytest(scope.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GamePlaytestToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
/**
 * Registered separately over the HTTP transport so the playtest frames become
 * real image content; see McpHttpServer.registerGameWebPlaytest.
 */
export const layerPlaytest = McpToolAccess.toLayer(GamePlaytestToolkit, playtestHandlers);
