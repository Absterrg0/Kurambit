import * as Effect from "effect/Effect";
import { GameOperationError, type ThreadId } from "@kurambit/contracts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import { GameCaller } from "../../../game/GameCaller.ts";
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
/**
 * One tool call: the calling thread's work on the game service, as an agent's.
 * Whether it is a production run's own role comes from the MCP session, never
 * from the thread a person may be viewing.
 */
const withGame = <A, E>(
  work: (game: GameService.GameService["Service"], threadId: ThreadId) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* GameService.GameService, scope.thread.threadId).pipe(
      Effect.provideService(GameCaller, { kind: "agent", runRole: scope.gameRunRole === "run" }),
    );
  });
/** One tool call on the calling thread's game builds, as an agent's. */
const withBuilds = <A, E>(
  work: (builds: GameBuilds.GameBuilds["Service"], threadId: ThreadId) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* GameBuilds.GameBuilds, scope.thread.threadId).pipe(
      Effect.provideService(GameCaller, { kind: "agent", runRole: scope.gameRunRole === "run" }),
    );
  });
/** One tool call on the calling chat's keep going, its refusals as operation errors. */
const withKeepGoing = <A>(
  work: (
    runs: GameRunControl.GameRunControl["Service"],
    threadId: ThreadId,
  ) => Effect.Effect<A, GameRunControl.GameRunError>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* GameRunControl.GameRunControl, scope.thread.threadId).pipe(
      Effect.mapError((cause) =>
        GameRunControl.GameRunError.toOperationError(`keep-going-${cause.operation}`, cause),
      ),
    );
  });
// Within the shortest tool-call timeout a provider gives an MCP server (Codex's is 60s).
const TOOL_RESTORE_WAIT = "30 seconds";

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
  game_blender_character: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.blenderCharacter(threadId, input)),
  ),
  game_generate: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.generate(threadId, input)),
  ),
  game_image_edit: McpToolAccess.actsAsCaller((input) =>
    withGame((game, threadId) => game.imageEdit(threadId, input)),
  ),
  game_generate_wait: McpToolAccess.readsAsCaller((input) =>
    withGame((game, threadId) => game.generateWait(threadId, input)),
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
    withGame((game, threadId) => game.preview(threadId)),
  ),
  game_stop: McpToolAccess.actsAsCaller(() => withGame((game, threadId) => game.stop(threadId))),
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
  game_builds: McpToolAccess.readsAsCaller((input) =>
    withBuilds((builds, threadId) =>
      Effect.gen(function* () {
        if (input.compare === undefined)
          return yield* builds.list(threadId, { before: input.before, limit: input.limit });
        return yield* builds.compare(
          threadId,
          { _tag: "build", build: input.compare[0] },
          { _tag: "build", build: input.compare[1] },
        );
      }),
    ),
  ),
  game_facts: McpToolAccess.actsAsCaller((input) =>
    withBuilds((builds, threadId) =>
      Effect.gen(function* () {
        const build = input.build ?? (yield* builds.list(threadId, { limit: 1 })).builds[0]?.id;
        if (build === undefined)
          return yield* new GameOperationError({
            operation: "Build facts",
            path: threadId,
            reason: "invalid-input",
            detail: "This game has no builds yet: a turn that changes the game makes one.",
          });
        return yield* builds.measure(
          threadId,
          { _tag: "build", build },
          { waitFor: TOOL_RESTORE_WAIT, queue: "background" },
        );
      }),
    ),
  ),
  game_build_restore: McpToolAccess.actsAsCaller((input) =>
    withBuilds((builds, threadId) =>
      builds.restore(threadId, { _tag: "build", build: input.build }, input.commandId, {
        waitFor: TOOL_RESTORE_WAIT,
      }),
    ),
  ),
  game_keep_going: McpToolAccess.actsAsCaller((input) =>
    withKeepGoing((runs, threadId) =>
      runs.set(threadId, {
        threadId,
        mode: input.mode,
        ...(input.budgetMinutes === undefined ? {} : { budgetMinutes: input.budgetMinutes }),
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      }),
    ),
  ),
  game_keep_going_status: McpToolAccess.readsAsCaller(() =>
    withKeepGoing((runs, threadId) => runs.status(threadId)),
  ),
  game_keep_going_steer: McpToolAccess.actsAsCaller((input) =>
    withKeepGoing((runs, threadId) =>
      runs.steer(threadId, {
        threadId,
        text: input.text,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      }),
    ),
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
