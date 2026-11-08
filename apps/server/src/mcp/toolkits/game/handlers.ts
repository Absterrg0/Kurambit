import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Tool, type Toolkit } from "effect/ai";
import { GameOperationError, type ThreadId } from "@kurambit/contracts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import { GameCaller } from "../../../game/GameCaller.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as GameUnity from "../../../game/GameUnity.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  GameToolkit,
  GameAnimateToolkit,
  GameAssetsSearchToolkit,
  GameBlenderLookToolkit,
  GameBlenderRenderSpritesToolkit,
  GameUnityScreenshotToolkit,
  GameMoreTool,
  GameMoreToolkit,
} from "./tools.ts";
import { GAME_TOOL_PLACEMENTS, refusal } from "./placement.ts";
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) => McpInvocationContext.requireThreadScope(context, "Kurambit tools")),
);
/** One tool call: the calling thread's work on the game service that owns it, as an agent's. */
const withGame = <I, S, A, E>(
  service: Context.Key<I, S>,
  work: (owner: S, threadId: ThreadId) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* caller;
    return yield* work(yield* service, scope.thread.threadId).pipe(
      Effect.provideService(GameCaller, { kind: "agent" }),
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
    withGame(GameStatusService.GameStatusService, (statuses, threadId) =>
      statuses.status(threadId, { checkSources: input.checkSources }),
    ),
  ),
  game_blender_code: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.code(threadId, input)),
  ),
  game_blender_scene: McpToolAccess.readsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.scene(threadId, input)),
  ),
  game_blender_assets_search: McpToolAccess.readsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.assetsSearch(threadId, input)),
  ),
  game_assets_add: McpToolAccess.actsAsCaller((input) =>
    withGame(GameAssetLibrary.GameAssetLibrary, (library, threadId) =>
      library.add(threadId, input),
    ),
  ),
  game_blender_assets_import: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.assetsImport(threadId, input)),
  ),
  game_blender_export: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.exportGlb(threadId, input)),
  ),
  game_blender_character: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.character(threadId, input)),
  ),
  game_blender_paint: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.paint(threadId, input)),
  ),
  game_blender_carve: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.carve(threadId, input)),
  ),
  game_generate: McpToolAccess.actsAsCaller((input) =>
    withGame(GameArt.GameArt, (art, threadId) => art.generate(threadId, input)),
  ),
  game_image_edit: McpToolAccess.actsAsCaller((input) =>
    withGame(GameArt.GameArt, (art, threadId) => art.imageEdit(threadId, input)),
  ),
  game_generate_wait: McpToolAccess.readsAsCaller((input) =>
    withGame(GameArt.GameArt, (art, threadId) => art.wait(threadId, input)),
  ),
  game_unity_tools: McpToolAccess.readsAsCaller(() =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.listTools(threadId)),
  ),
  game_unity_edit: McpToolAccess.actsAsCaller((input) =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.edit(threadId, input)),
  ),
  game_unity_eval: McpToolAccess.actsAsCaller((input) =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.evaluate(threadId, input)),
  ),
  game_unity_recompile: McpToolAccess.actsAsCaller(() =>
    withGame(GameEngine.GameEngine, (engines, threadId) => engines.recompile(threadId)),
  ),
  game_unity_play: McpToolAccess.actsAsCaller((input) =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.play(threadId, input)),
  ),
  game_unity_console: McpToolAccess.readsAsCaller((input) =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.console(threadId, input)),
  ),
  game_import: McpToolAccess.actsAsCaller(() =>
    withGame(GameEngine.GameEngine, (engines, threadId) => engines.import(threadId)),
  ),
  game_check: McpToolAccess.actsAsCaller(() =>
    withGame(GameEngine.GameEngine, (engines, threadId) => engines.check(threadId)),
  ),
  game_export: McpToolAccess.actsAsCaller((input) =>
    withGame(GameExport.GameExport, (exporter, threadId) =>
      exporter.export(threadId, input.target),
    ),
  ),
  game_package_windows: McpToolAccess.actsAsCaller(() =>
    withGame(GameExport.GameExport, (exporter, threadId) => exporter.packageWindows(threadId)),
  ),
  game_package_web: McpToolAccess.actsAsCaller(() =>
    withGame(GameExport.GameExport, (exporter, threadId) => exporter.packageWeb(threadId)),
  ),
  game_media_save: McpToolAccess.actsAsCaller((input) =>
    withGame(GameSavedMediaService.GameSavedMediaService, (saved, threadId) =>
      saved.save(threadId, input.source, input.label),
    ),
  ),
  game_saved_list: McpToolAccess.readsAsCaller(() =>
    withGame(GameSavedMediaService.GameSavedMediaService, (saved, threadId) =>
      saved.list(threadId),
    ),
  ),
  game_saved_delete: McpToolAccess.actsAsCaller((input) =>
    withGame(GameSavedMediaService.GameSavedMediaService, (saved, threadId) =>
      saved.delete(threadId, input.name).pipe(Effect.as({})),
    ),
  ),
  game_preview: McpToolAccess.actsAsCaller(() =>
    withGame(GameStage.GameStage, (stage, threadId) => stage.preview(threadId)),
  ),
  game_stop: McpToolAccess.actsAsCaller(() =>
    withGame(GameStage.GameStage, (stage, threadId) => stage.stop(threadId)),
  ),
  game_explore_start: McpToolAccess.actsAsCaller((input) =>
    withGame(GameExplore.GameExplore, (explore, threadId) => explore.start(threadId, input)),
  ),
  game_explore_act: McpToolAccess.actsAsCaller((input) =>
    withGame(GameExplore.GameExplore, (explore, threadId) => explore.act(threadId, input)),
  ),
  game_explore_close: McpToolAccess.actsAsCaller((input) =>
    withGame(GameExplore.GameExplore, (explore, threadId) => explore.close(threadId, input)),
  ),
  game_bot_run: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBot.GameBot, (bots, threadId) => bots.run(threadId, input)),
  ),
  game_bot_view: McpToolAccess.readsAsCaller((input) =>
    withGame(GameBot.GameBot, (bots, threadId) => bots.view(threadId, input)),
  ),
  game_bot_report: McpToolAccess.actsAsCaller(() =>
    withGame(GameBot.GameBot, (bots, threadId) => bots.report(threadId)),
  ),
  game_builds: McpToolAccess.readsAsCaller((input) =>
    withGame(GameBuilds.GameBuilds, (builds, threadId) =>
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
    withGame(GameBuilds.GameBuilds, (builds, threadId) =>
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
    withGame(GameBuilds.GameBuilds, (builds, threadId) =>
      builds.restore(threadId, { _tag: "build", build: input.build }, input.commandId, {
        waitFor: TOOL_RESTORE_WAIT,
      }),
    ),
  ),
  game_tune: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBuilds.GameBuilds, (builds, threadId) =>
      builds.keepValues(threadId, {
        things: input.things,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
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
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.look(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderLookToolkit.tools>;
export const layerBlenderLook = McpToolAccess.toLayer(GameBlenderLookToolkit, blenderLookHandlers);

/** Registered like the Blender look, so the move's pictures become real image content. */
const animateHandlers = {
  game_animate: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) => blender.animate(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAnimateToolkit.tools>;
export const layerAnimate = McpToolAccess.toLayer(GameAnimateToolkit, animateHandlers);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const blenderRenderSpritesHandlers = {
  game_blender_render_sprites: McpToolAccess.actsAsCaller((input) =>
    withGame(GameBlender.GameBlender, (blender, threadId) =>
      blender.renderSprites(threadId, input),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderRenderSpritesToolkit.tools>;
export const layerBlenderRenderSprites = McpToolAccess.toLayer(
  GameBlenderRenderSpritesToolkit,
  blenderRenderSpritesHandlers,
);

/** Registered like the Blender look, so the capture becomes real image content. */
const unityScreenshotHandlers = {
  game_unity_screenshot: McpToolAccess.readsAsCaller((input) =>
    withGame(GameUnity.GameUnity, (unity, threadId) => unity.screenshot(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameUnityScreenshotToolkit.tools>;
export const layerUnityScreenshot = McpToolAccess.toLayer(
  GameUnityScreenshotToolkit,
  unityScreenshotHandlers,
);

/** Registered like the Blender look, so the contact sheet becomes real image content. */
const assetsSearchHandlers = {
  game_assets_search: McpToolAccess.readsAsCaller((input) =>
    withGame(GameAssetLibrary.GameAssetLibrary, (library, threadId) =>
      library.search(threadId, input),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAssetsSearchToolkit.tools>;
export const layerAssetsSearch = McpToolAccess.toLayer(
  GameAssetsSearchToolkit,
  assetsSearchHandlers,
);

const refuse = (message: string, failure?: unknown) =>
  Effect.fail(failure === undefined ? { message } : { message, failure });

/** One built toolkit, by tool name: what game_more needs to describe or run any of its tools. */
const runner = <Tools extends Record<string, Tool.Any>>(kit: Toolkit.WithHandler<Tools>) => ({
  tools: kit.tools as Record<string, Tool.Any>,
  run: (name: string, input: unknown) =>
    kit.handle(name as keyof Tools, input as never).pipe(
      Effect.flatMap((results) => Stream.run(results, Sink.last())),
      Effect.flatMap(Effect.fromOption),
      Effect.catch((error) => refuse(error instanceof Error ? error.message : `${name} failed.`)),
    ),
});

/**
 * game_more: an asked-for tool, described, or run by its own toolkit's handler
 * with its own access check, so it behaves exactly as a listed call would. It is
 * registered as an image tool, so a look's or a move's pictures arrive as images.
 */
export const layerMore = McpToolAccess.toLayer(
  GameMoreToolkit,
  Effect.gen(function* () {
    const kits = [
      runner(yield* GameToolkit),
      runner(yield* GameBlenderLookToolkit),
      runner(yield* GameAnimateToolkit),
      runner(yield* GameBlenderRenderSpritesToolkit),
    ];
    return {
      game_more: McpToolAccess.readsAsCaller((input: Tool.Parameters<typeof GameMoreTool>) =>
        Effect.gen(function* () {
          const name = input.tool;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const kit = kits.find((candidate) => name in candidate.tools);
          const why = refusal(GAME_TOOL_PLACEMENTS[name], scope);
          if (why !== null || kit === undefined)
            return yield* refuse(
              `${name} is not available in this chat: ${why ?? "game_more cannot run it"}.`,
            );
          const tool = kit.tools[name]!;
          if (input.input === undefined)
            return {
              tool: name,
              description: tool.description,
              parameters: Tool.getJsonSchema(tool),
            };
          // Every game tool is strict (a misplaced key is refused, never dropped); the toolkit's
          // own decode ignores excess keys, so the same rule is applied here first.
          // Game tool parameters decode without services; Tool.Any only erases that.
          const parameters = tool.parametersSchema as Schema.Decoder<unknown>;
          yield* Schema.decodeUnknownEffect(parameters)(input.input, {
            onExcessProperty: "error",
            errors: "all",
          }).pipe(Effect.catch((error) => refuse(`${name}: ${String(error)}`)));
          const outcome = yield* kit.run(name, input.input);
          if (!outcome.isFailure) return outcome.encodedResult;
          const encoded = outcome.encodedResult as { readonly message?: unknown } | null;
          return yield* refuse(
            typeof encoded?.message === "string" ? encoded.message : `${name} failed.`,
            outcome.encodedResult,
          );
        }),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        McpToolAccess.HandlersLayer.layer(layer),
        McpToolAccess.HandlersLayer.layer(layerBlenderLook),
        McpToolAccess.HandlersLayer.layer(layerAnimate),
        McpToolAccess.HandlersLayer.layer(layerBlenderRenderSprites),
      ),
    ),
  ),
);
