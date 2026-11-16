// @effect-diagnostics nodeBuiltinImport:off -- Reads the check's and the model sheet's pictures to attach them as images.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GameActionResult,
  GameAnimateResult,
  GameAssetsAddResult,
  GameAssetsSearchResult,
  GameBlenderAssetsImportResult,
  GameBlenderAssetsSearchResult,
  GameBlenderCarveResult,
  GameBlenderCharacterResult,
  GameBlenderCodeResult,
  GameBlenderExportResult,
  GameBlenderLookResult,
  GameBlenderLookScreenshot,
  GameBlenderPaintResult,
  GameBlenderRenderSpritesResult,
  GameBlenderSceneResult,
  GameBotRunResult,
  GameBotViewResult,
  GameBuildComparison,
  GameBuildFacts,
  GameBuildRestoreResult,
  GameBuildsResult,
  GameCheckResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameExploreStartResult,
  GameGenerateResult,
  GameKeepGoingStatus,
  GameModelSheetResult,
  GameOperationError,
  GameReplayResult,
  GameSavedPlaysReading,
  GameSavedPlaysResult,
  GameSavedListResult,
  GameStatus,
  GameUnityRecompileResult,
  GameUnityScreenshotResult,
  GameUnityTextResult,
  GameUnityToolsResult,
  GameWebPackage,
  GameWindowsPackage,
  gameModelChoice,
  THREE_VIEWPORT,
  type ThreadId,
} from "@kurambit/contracts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import * as GamePlays from "../../../game/GamePlays.ts";
import { GameCaller } from "../../../game/GameCaller.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GameProjectService from "../../../game/GameProjectService.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as GameUnity from "../../../game/GameUnity.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  GameAssetsToolkit,
  GameBlenderToolkit,
  GameCheckToolkit,
  GamePlayToolkit,
  GameToolkit,
  GameUnityToolkit,
} from "./tools.ts";
import { GAME_TOOL_OPS, opRefusal, type GameToolName } from "./placement.ts";
import type { GameEngineCapability } from "../../../game/engineProfile.ts";
import { besideReference, gameReference } from "../../../game/gameReference.ts";

const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) => McpInvocationContext.requireThreadScope(context, "Kurambit tools")),
);
/** One op: the calling thread's work on the game service that owns it, as an agent's. */
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
/** One op's answer, encoded by its own schema: the tool's success passes it on as it is. */
const as =
  <S extends Schema.Top>(schema: S) =>
  <E, R>(effect: Effect.Effect<S["Type"], E, R>) =>
    effect.pipe(
      Effect.flatMap((value) => Schema.encodeUnknownEffect(schema)(value).pipe(Effect.orDie)),
    ) as Effect.Effect<unknown, E, R | S["EncodingServices"]>;
// Within the shortest tool-call timeout a provider gives an MCP server (Codex's is 60s).
const TOOL_FACTS_WAIT = "30 seconds";

const invalid = (operation: string, detail: string) =>
  new GameOperationError({ operation, path: "", reason: "invalid-input", detail });

/**
 * Runs the one op a call names, after its game and machine allowed it. A call that names none
 * runs `fallback` when the tool has one.
 */
const dispatch = <
  Input extends object,
  Ops extends {
    readonly [Op in keyof Input]-?: (
      value: NonNullable<Input[Op]>,
    ) => Effect.Effect<unknown, unknown, unknown>;
  },
>(
  tool: GameToolName,
  input: Input,
  ops: Ops,
  fallback?: keyof Input & string,
): Effect.Effect<
  unknown,
  GameOperationError | Effect.Error<ReturnType<Ops[keyof Ops]>>,
  McpInvocationContext.McpInvocationContext | Effect.Services<ReturnType<Ops[keyof Ops]>>
> =>
  Effect.gen(function* () {
    const given = (Object.keys(input) as Array<keyof Input & string>).filter(
      (key) => input[key] !== undefined,
    );
    const op = given.length === 0 ? fallback : given.length === 1 ? given[0] : undefined;
    const all: Record<string, ReadonlyArray<GameEngineCapability>> = GAME_TOOL_OPS[tool];
    if (op === undefined)
      return yield* invalid(
        tool,
        `Pass exactly one op as the only key: ${Object.keys(all).join(", ")}${given.length > 1 ? ` (this call named ${given.join(", ")})` : ""}.`,
      );
    const why = opRefusal(all[op] ?? [], yield* McpInvocationContext.McpInvocationContext);
    if (why !== null) return yield* invalid(`${tool} ${op}`, `${tool} ${op}: ${why}.`);
    // Looked up by name, an op takes its own input: the key it was found under. The signature
    // above carries every op's errors and services, which the lookup erases.
    const run = ops[op] as unknown as (value: unknown) => Effect.Effect<unknown>;
    return yield* run(input[op] ?? {});
  }) as never;

/**
 * How this game's models are made is the person's choice. While a keep-going step's turn is at
 * work, art and Blender ops refuse a game.json whose choice moved since the step started (the
 * step's record), and the step's end puts it back (GameRunTurnReactor).
 */
const personsModelChoice = Effect.gen(function* () {
  const threadId = (yield* caller).thread.threadId;
  const started = yield* (yield* GameRunControl.GameRunControl).stepModelChoice(threadId);
  if (started === null) return;
  const projects = yield* GameProjectService.GameProjectService;
  const now = gameModelChoice(yield* projects.read(yield* projects.resolve(threadId)));
  if (now.route === started.route && now.library === started.library) return;
  return yield* new GameOperationError({
    operation: "model-choice",
    path: "game.json",
    reason: "invalid-input",
    detail: `Keep going is working a step on this game, and game.json's model choice changed since the step started (characters ${started.route} → ${now.route}, library ${started.library} → ${now.library}). How models are made is the person's choice and stays as it was while the step runs: put characters back to "${started.route}" and library to ${started.library} (the step's end puts them back anyway), and say in your reply what the work needed.`,
  });
});

/**
 * How the agent judges its frame against the reference, carried by every check of a game that has
 * one, so it arrives at each look, including the last: a clean check is not a matching picture.
 */
const FRAME_REVIEW =
  "Before you change anything, and before you end the turn, write a numbered critique of the game's frame (top) against the reference (bottom), biggest difference first. 1. The camera comes first, solved rather than judged by eye: measure landmarks in the reference in pixels (where the horizon crosses, the subject's ends, top and waterline or ground line, how much larger its near end draws than its far end) and solve its camera from them, in a few lines of code: height above the ground or water, lens (the vertical field of view; a long lens of 15 to 30 degrees draws near and far ends at nearly one size) and angle round the subject, and so its distance. Put that camera in the game as a picture camera the player can switch to (a key) and that play starts in, so each check's frame is taken through it, and look until the subject's outline lies over the reference's. Then 2. silhouette and proportions, 3. colour, light and mood (sky and clouds, ground or sea, the subject's own colours, the time of day and the atmosphere; write the game's own sky, water or shader for it where the picture needs one, rather than settle), 4. surface and detail, 5. anything else the picture shows that the game lacks (its effects, its interface: the game draws its own). Fix the first item and look again, as many times as it takes. A clean check, final or not, says the game runs, not that it matches: the turn ends when this critique finds nothing major. When the person asked the game to match this picture, pass critique on your final check: the biggest difference left, and whether it is still major.";

/**
 * The same look for a game without a reference: the brief is the only target, so the light and
 * atmosphere are judged against what it describes, never against a look the harness prefers.
 */
const BRIEF_REVIEW =
  "Before you end the turn, critique this frame as a player would, biggest gap first: does it read at a glance (the player big enough and seen from a side that reads, nothing washed out or too dark), do its light and atmosphere fit the mood the brief describes (the time of day, the weather, the place's own lights), and do its title and HUD look made for this game? Fix the biggest gap and look again.";

/** A check's answer, with its pictures attached as images (the views' PNGs, title then play). */
const GameCheckAnswer = Schema.Struct({
  ...GameCheckResult.fields,
  screenshots: Schema.optionalKey(Schema.Array(GameBlenderLookScreenshot)),
  /** How to judge the frame (beside the reference, when the game has one) before ending. */
  review: Schema.optionalKey(Schema.String),
});

const png = (bytes: Buffer) => ({
  mimeType: "image/png" as const,
  data: bytes.toString("base64"),
  ...THREE_VIEWPORT,
});

/**
 * A check, with its views as images: the agent sees its game before it ends the turn. When the
 * game has a reference picture, play's frame comes stacked above it at the same size, every check:
 * matching a picture is a loop of looks, and each look needs both.
 */
const check = (final: boolean) =>
  Effect.gen(function* () {
    const result = yield* withGame(GameEngine.GameEngine, (engines, threadId) =>
      engines.check(threadId, undefined, { final }),
    );
    const views = result.views ?? [];
    if (views.length === 0) return result;
    const root = yield* withGame(GameProjectService.GameProjectService, (projects, threadId) =>
      projects.resolve(threadId),
    );
    const reference = yield* gameReference(root);
    const screenshots = yield* Effect.promise(() =>
      Promise.all(
        views.map((view) =>
          NodeFSP.readFile(NodePath.join(root, view.path)).then(
            (bytes) =>
              (view.entry === "gameplay" && reference !== null
                ? besideReference(bytes, reference)
                : null) ?? png(bytes),
            () => null,
          ),
        ),
      ),
    );
    const shown = screenshots.filter((shot) => shot !== null);
    return {
      ...result,
      ...(shown.length === 0 ? {} : { screenshots: shown }),
      ...(shown.length === 0 ? {} : { review: reference === null ? BRIEF_REVIEW : FRAME_REVIEW }),
    };
  }).pipe(as(GameCheckAnswer));

const checkHandlers = {
  game_check: McpToolAccess.actsAsCaller((input) =>
    dispatch(
      "game_check",
      input,
      {
        look: () => check(false),
        // The critique is read back from this call's input by keep going (GameRunStepRunner).
        final: () => check(true),
        facts: (facts) =>
          withGame(GameBuilds.GameBuilds, (builds, threadId) =>
            Effect.gen(function* () {
              const build =
                facts.build ?? (yield* builds.list(threadId, { limit: 1 })).builds[0]?.id;
              if (build === undefined)
                return yield* invalid(
                  "Build facts",
                  "This game has no builds yet: a turn that changes the game makes one.",
                );
              return yield* builds.measure(
                threadId,
                { _tag: "build", build },
                {
                  waitFor: TOOL_FACTS_WAIT,
                  queue: "background",
                  ...(facts.skilled === true ? { skilled: true } : {}),
                },
              );
            }),
          ).pipe(as(GameBuildFacts)),
        status: (status) =>
          withGame(GameStatusService.GameStatusService, (statuses, threadId) =>
            statuses.status(threadId, { checkSources: status.checkSources }),
          ).pipe(as(GameStatus)),
      },
      "look",
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameCheckToolkit.tools>;
export const layerCheck = McpToolAccess.toLayer(GameCheckToolkit, checkHandlers);

/** Named models drawn from every side, with the reference picture after them, as images. */
const modelSheet = (input: Parameters<GameEngine.GameEngine["Service"]["modelSheet"]>[1]) =>
  Effect.gen(function* () {
    const result = yield* withGame(GameEngine.GameEngine, (engines, threadId) =>
      engines.modelSheet(threadId, input),
    );
    const root = yield* withGame(GameProjectService.GameProjectService, (projects, threadId) =>
      projects.resolve(threadId),
    );
    const screenshots = yield* Effect.promise(() =>
      Promise.all(
        result.sheets.map((sheet) =>
          NodeFSP.readFile(NodePath.join(root, sheet.image)).then(png, () => null),
        ),
      ),
    );
    const reference = yield* gameReference(root, input.reference);
    const shown = [
      ...screenshots.filter((shot) => shot !== null),
      ...(reference === null ? [] : [reference.image]),
    ];
    return {
      ...result,
      ...(reference === null ? {} : { reference: reference.path }),
      ...(shown.length === 0 ? {} : { screenshots: shown }),
    };
  }).pipe(
    as(
      Schema.Struct({
        ...GameModelSheetResult.fields,
        screenshots: Schema.optionalKey(Schema.Array(GameBlenderLookScreenshot)),
      }),
    ),
  );

const playHandlers = {
  game_play: McpToolAccess.actsAsCaller((input) =>
    dispatch("game_play", input, {
      preview: () =>
        withGame(GameStage.GameStage, (stage, threadId) => stage.preview(threadId)).pipe(
          as(GameActionResult),
        ),
      start: (start) =>
        withGame(GameExplore.GameExplore, (explore, threadId) =>
          explore.start(threadId, start),
        ).pipe(as(GameExploreStartResult)),
      act: (act) =>
        withGame(GameExplore.GameExplore, (explore, threadId) => explore.act(threadId, act)).pipe(
          as(GameExploreActResult),
        ),
      close: (close) =>
        withGame(GameExplore.GameExplore, (explore, threadId) =>
          explore.close(threadId, close),
        ).pipe(as(GameExploreCloseResult)),
      bot: (bot) =>
        withGame(GameBot.GameBot, (bots, threadId) => bots.run(threadId, bot)).pipe(
          as(GameBotRunResult),
        ),
      bot_view: (view) =>
        withGame(GameBot.GameBot, (bots, threadId) => bots.view(threadId, view)).pipe(
          as(GameBotViewResult),
        ),
      // A save or a delete answers with the saved plays as they are then; else they replay.
      replay: (input) =>
        input.save === undefined && input.delete === undefined
          ? withGame(GamePlays.GamePlays, (plays, threadId) => plays.replaySaved(threadId)).pipe(
              as(Schema.Union([GameSavedPlaysReading, GameReplayResult])),
            )
          : withGame(GamePlays.GamePlays, (plays, threadId) =>
              Effect.gen(function* () {
                if (input.save !== undefined) yield* plays.save(threadId, { name: input.save });
                if (input.delete !== undefined) yield* plays.remove(threadId, input.delete);
                return yield* plays.saved(threadId);
              }),
            ).pipe(as(GameSavedPlaysResult)),
      model_sheet: modelSheet,
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GamePlayToolkit.tools>;
export const layerPlay = McpToolAccess.toLayer(GamePlayToolkit, playHandlers);

const assetsHandlers = {
  game_assets: McpToolAccess.actsAsCaller((input) =>
    personsModelChoice.pipe(
      Effect.andThen(
        dispatch("game_assets", input, {
          search: (search) =>
            withGame(GameAssetLibrary.GameAssetLibrary, (library, threadId) =>
              library.search(threadId, search),
            ).pipe(as(GameAssetsSearchResult)),
          add: (add) =>
            withGame(GameAssetLibrary.GameAssetLibrary, (library, threadId) =>
              library.add(threadId, add),
            ).pipe(as(GameAssetsAddResult)),
          generate: (generate) =>
            withGame(GameArt.GameArt, (art, threadId) => art.generate(threadId, generate)).pipe(
              as(GameGenerateResult),
            ),
          wait: (wait) =>
            withGame(GameArt.GameArt, (art, threadId) => art.wait(threadId, wait)).pipe(
              as(GameGenerateResult),
            ),
          image_edit: (edit) =>
            withGame(GameArt.GameArt, (art, threadId) => art.imageEdit(threadId, edit)).pipe(
              as(GameGenerateResult),
            ),
          import: () =>
            withGame(GameEngine.GameEngine, (engines, threadId) => engines.import(threadId)).pipe(
              as(GameActionResult),
            ),
        }),
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAssetsToolkit.tools>;
export const layerAssets = McpToolAccess.toLayer(GameAssetsToolkit, assetsHandlers);

const blenderHandlers = {
  game_blender: McpToolAccess.actsAsCaller((input) =>
    personsModelChoice.pipe(
      Effect.andThen(
        dispatch("game_blender", input, {
          code: (code) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.code(threadId, code),
            ).pipe(as(GameBlenderCodeResult)),
          look: (look) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.look(threadId, look),
            ).pipe(as(GameBlenderLookResult)),
          scene: (scene) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.scene(threadId, scene),
            ).pipe(as(GameBlenderSceneResult)),
          export: (exported) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.exportGlb(threadId, exported),
            ).pipe(as(GameBlenderExportResult)),
          character: (character) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.character(threadId, character),
            ).pipe(as(GameBlenderCharacterResult)),
          paint: (paint) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.paint(threadId, paint),
            ).pipe(as(GameBlenderPaintResult)),
          carve: (carve) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.carve(threadId, carve),
            ).pipe(as(GameBlenderCarveResult)),
          sprites: (sprites) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.renderSprites(threadId, sprites),
            ).pipe(as(GameBlenderRenderSpritesResult)),
          animate: (move) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.animate(threadId, move),
            ).pipe(as(GameAnimateResult)),
          asset_search: (search) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.assetsSearch(threadId, search),
            ).pipe(as(GameBlenderAssetsSearchResult)),
          asset_import: (asset) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.assetsImport(threadId, asset),
            ).pipe(as(GameBlenderAssetsImportResult)),
        }),
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderToolkit.tools>;
export const layerBlender = McpToolAccess.toLayer(GameBlenderToolkit, blenderHandlers);

const unityHandlers = {
  game_unity: McpToolAccess.actsAsCaller((input) =>
    dispatch("game_unity", input, {
      tools: () =>
        withGame(GameUnity.GameUnity, (unity, threadId) => unity.listTools(threadId)).pipe(
          as(GameUnityToolsResult),
        ),
      edit: (edit) =>
        withGame(GameUnity.GameUnity, (unity, threadId) => unity.edit(threadId, edit)).pipe(
          as(GameUnityTextResult),
        ),
      eval: (code) =>
        withGame(GameUnity.GameUnity, (unity, threadId) => unity.evaluate(threadId, code)).pipe(
          as(GameUnityTextResult),
        ),
      recompile: () =>
        withGame(GameEngine.GameEngine, (engines, threadId) => engines.recompile(threadId)).pipe(
          as(GameUnityRecompileResult),
        ),
      play: (play) =>
        withGame(GameUnity.GameUnity, (unity, threadId) => unity.play(threadId, play)).pipe(
          as(GameUnityTextResult),
        ),
      console: (console) =>
        withGame(GameUnity.GameUnity, (unity, threadId) => unity.console(threadId, console)).pipe(
          as(GameUnityTextResult),
        ),
      screenshot: (screenshot) =>
        withGame(GameUnity.GameUnity, (unity, threadId) =>
          unity.screenshot(threadId, screenshot),
        ).pipe(as(GameUnityScreenshotResult)),
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameUnityToolkit.tools>;
export const layerUnity = McpToolAccess.toLayer(GameUnityToolkit, unityHandlers);

const handlers = {
  game_builds: McpToolAccess.actsAsCaller((input) =>
    dispatch(
      "game_builds",
      input,
      {
        list: (list) =>
          withGame(GameBuilds.GameBuilds, (builds, threadId) =>
            builds.list(threadId, { before: list.before, limit: list.limit }),
          ).pipe(as(GameBuildsResult)),
        compare: (pair) =>
          withGame(GameBuilds.GameBuilds, (builds, threadId) =>
            builds.compare(
              threadId,
              { _tag: "build", build: pair.from },
              { _tag: "build", build: pair.to },
            ),
          ).pipe(as(GameBuildComparison)),
        restore: (restore) =>
          withGame(GameBuilds.GameBuilds, (builds, threadId) =>
            builds.restore(threadId, { _tag: "build", build: restore.build }, restore.commandId),
          ).pipe(as(GameBuildRestoreResult)),
        saved: (saved) =>
          withGame(GameSavedMediaService.GameSavedMediaService, (media, threadId) =>
            Effect.gen(function* () {
              if (saved.save !== undefined)
                yield* media.save(threadId, saved.save.source, saved.save.label);
              if (saved.delete !== undefined) yield* media.delete(threadId, saved.delete);
              // An answer is an object: a tool's structured content cannot be a bare list.
              return { saved: yield* media.list(threadId) };
            }),
          ).pipe(as(Schema.Struct({ saved: GameSavedListResult }))),
        export: (release) =>
          withGame(GameExport.GameExport, (exporter, threadId) =>
            exporter.export(threadId, release.target),
          ).pipe(as(GameActionResult)),
        package: (pack) =>
          withGame(GameExport.GameExport, (exporter, threadId) =>
            pack.target === "web"
              ? exporter.packageWeb(threadId).pipe(as(GameWebPackage))
              : exporter.packageWindows(threadId).pipe(as(GameWindowsPackage)),
          ),
        stop: () =>
          withGame(GameStage.GameStage, (stage, threadId) => stage.stop(threadId)).pipe(
            as(GameActionResult),
          ),
      },
      "list",
    ),
  ),
  // Keep going: the same service the composer control and the banner reach.
  game_keep_going: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const why = opRefusal(
        GAME_TOOL_OPS.game_keep_going.set,
        yield* McpInvocationContext.McpInvocationContext,
      );
      if (why !== null) return yield* invalid("game_keep_going", `game_keep_going: ${why}.`);
      const scope = yield* caller;
      const threadId = scope.thread.threadId;
      const runs = yield* GameRunControl.GameRunControl;
      return yield* Effect.gen(function* () {
        if (input.steer !== undefined)
          yield* runs.steer(threadId, {
            threadId,
            text: input.steer,
            ...(input.commandId === undefined ? {} : { commandId: `${input.commandId}:steer` }),
          });
        if (input.mode === undefined) return yield* runs.status(threadId);
        return yield* runs.set(threadId, {
          threadId,
          mode: input.mode,
          ...(input.budgetMinutes === undefined ? {} : { budgetMinutes: input.budgetMinutes }),
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        });
      }).pipe(
        Effect.mapError((cause) =>
          GameRunControl.GameRunError.toOperationError(`keep-going-${cause.operation}`, cause),
        ),
        as(GameKeepGoingStatus),
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
