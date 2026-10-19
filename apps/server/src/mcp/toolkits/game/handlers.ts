import * as Effect from "effect/Effect";
import * as GameService from "../../../game/GameService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GameToolkit } from "./tools.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) =>
    McpInvocationContext.requireThreadScope(context, "Game Studio tools"),
  ),
);
const handlers = {
  game_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.status(scope.thread.threadId);
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
  game_godot_test: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* caller;
      const game = yield* GameService.GameService;
      return yield* game.test(scope.thread.threadId, input.script, input.timeoutMs);
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
      return yield* game.action(scope.thread.threadId, "native");
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
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
