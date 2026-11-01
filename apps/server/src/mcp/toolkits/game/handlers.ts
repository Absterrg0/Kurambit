import * as Effect from "effect/Effect";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GameToolkit, GameBlenderLookToolkit } from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) =>
    McpInvocationContext.requireThreadScope(context, "Game Studio tools"),
  ),
);
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
  game_blender_assets_import: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderAssetsImport(scope.thread.threadId, input);
    }),
  ),
  game_blender_generate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.blenderGenerate(scope.thread.threadId, input);
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
