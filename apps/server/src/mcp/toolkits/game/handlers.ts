// @effect-diagnostics nodeBuiltinImport:off -- Reads the check's and the model sheet's pictures to attach them as images.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { LRUCache } from "lru-cache";
import * as Schema from "effect/Schema";
import {
  GameActionResult,
  GameAnimateResult,
  GameAssetsAddResult,
  GameAssetsSearchResult,
  GamePicturesResult,
  GameBlenderAssetsImportResult,
  GameBlenderAssetsSearchResult,
  GameBlenderCharacterResult,
  GameBlenderCodeResult,
  GameBlenderExportResult,
  GameBlenderLookResult,
  GameBlenderLookScreenshot,
  GameBlenderPaintResult,
  GameBlenderRenderSpritesResult,
  GameBlenderSceneResult,
  GameBotRunResult,
  GameBuildFacts,
  type GameBuild,
  GameBuildRestoreResult,
  GameBuildUndoResult,
  GameBringInResult,
  GameCopiesResult,
  GameCopyUpdateResult,
  GameBuildsResult,
  GameCheckResult,
  GameEvalResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameKeepGoingStatus,
  GameModelSheetResult,
  GameOperationError,
  GameReplayResult,
  GameSavedPlaysReading,
  GameReplayMoment,
  GameSavedPlaysResult,
  GameWebPackage,
  gameModelChoice,
  THREE_VIEWPORT,
  type ThreadId,
} from "@kurambit/contracts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import { CheckpointStore } from "../../../checkpointing/CheckpointStore.ts";
import * as GameCopies from "../../../game/GameCopies.ts";
import * as GamePlays from "../../../game/GamePlays.ts";
import { GameCaller } from "../../../game/GameCaller.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GameProjectService from "../../../game/GameProjectService.ts";
import { recipeLines } from "../../../game/recipes.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  GameAssetsToolkit,
  GameBlenderToolkit,
  GameCheckToolkit,
  GamePlayToolkit,
  GameToolkit,
} from "./tools.ts";
import { GAME_TOOL_OPS, opRefusal, type GameToolName } from "./placement.ts";
import type { GameEngineCapability } from "../../../game/engineProfile.ts";
import { besideReference, gameReference } from "../../../game/gameReference.ts";
import { fill, STUDIO_TEXT } from "../../../game/studioText.ts";
import { present, refusal, type GameToolRefusal } from "./results.ts";
import { verdictOf } from "./verdicts.ts";

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
  GameToolRefusal,
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
    const answer = (yield* run(input[op] ?? {})) as Record<string, unknown>;
    return present(tool, op, verdictOf(tool, op, answer), answer);
  }).pipe(Effect.mapError(refusal)) as never;

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
    detail: fill(STUDIO_TEXT.results.modelChoiceMoved, {
      startedRoute: started.route,
      nowRoute: now.route,
      startedLibrary: started.library,
      nowLibrary: now.library,
    }),
  });
});

/**
 * How the agent judges its frame: against the reference when the game has one (carried by every
 * check, including the last: a clean check is not a matching picture), else against the brief,
 * never against a look the harness prefers. The opening line is said first when the check shows
 * the page as a player opens it beside play: an eye, not a rule.
 */
const REVIEW = STUDIO_TEXT.results;

/**
 * The provider sessions that already read which picture is which: a review was 22% of all result
 * text when every look carried it (TOOLS.md). A session keeps its context, so once per session is once per
 * chat; a restarted server says it once more.
 */
const reviewed = new LRUCache<string, true>({ max: 2_000 });
const firstReview = (session: string) => {
  if (reviewed.has(session)) return false;
  reviewed.set(session, true);
  return true;
};

/** A check's answer, with its pictures attached as images (the views' PNGs, title then play). */
const GameCheckAnswer = Schema.Struct({
  ...GameCheckResult.fields,
  screenshots: Schema.optionalKey(Schema.Array(GameBlenderLookScreenshot)),
  /** Which picture is the reference, once per session, when the game has one. */
  review: Schema.optionalKey(Schema.String),
  /** One line of numbers per recipe game.json `recipes` picks (recipes.ts). */
  recipes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Minutes from the game's creation to the first build (or this check) that moved. */
  stageMinutes: Schema.optionalKey(Schema.Number),
});

const png = (bytes: Buffer) => ({
  mimeType: "image/png" as const,
  data: bytes.toString("base64"),
  ...THREE_VIEWPORT,
});

/** The builds read for the first one that moved: a game's opening, never its whole history. */
const STAGE_BUILDS = 20;
const TURN_REFS = "refs/kurambit/orchestration-v2/checkpoints/";
/** A turn's end capture; ordinal 0 is the capture before a chat's first turn. */
const ENDED_TURN = /\/ordinal\/[1-9]\d*$/;
/**
 * Minutes from the brief (the game's repository created) to the Stage first moving: the oldest
 * build whose first minute measured a moving frame, or this check's when no build moved yet. Its
 * builds are made at turn ends, so this is the latest it can have moved, never sooner. Undefined
 * when its earliest builds were not measured moving (made before the first minute was measured),
 * or when its turns were made somewhere this server never listed.
 */
const stageMinutes = (store: CheckpointStore["Service"], root: string, moves: boolean) =>
  Effect.gen(function* () {
    const born = yield* Effect.promise(() =>
      NodeFSP.stat(NodePath.join(root, ".git")).then(
        (stat) => (stat.birthtimeMs > 0 ? stat.birthtimeMs : null),
        () => null,
      ),
    );
    if (born === null) return undefined;
    const oldest: Array<GameBuild> = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = yield* withGame(GameBuilds.GameBuilds, (builds, threadId) =>
        builds.list(threadId, { before, limit: 100 }),
      );
      oldest.unshift(...listed.builds.toReversed());
      if (listed.next === null) break;
      before = listed.next;
    }
    for (const build of oldest.slice(0, STAGE_BUILDS)) {
      const facts = yield* withGame(GameBuilds.GameBuilds, (builds, threadId) =>
        builds.facts(threadId, { _tag: "build", build: build.id }),
      );
      // A build stored before the first minute was measured may have moved; when is unknown.
      if (facts.player.status === "not-measured" && facts.player.retry) return undefined;
      if (facts.player.status !== "measured") continue;
      if (facts.player.value.moves === true) return (Date.parse(build.at) - born) / 60_000;
    }
    if (oldest.length > 0 || !moves) return undefined;
    // No build listed is a game's first turn only when its folder holds no ended turn either: a
    // game whose turns were made in another install (imported, copied in) would read its whole age.
    const turns = yield* store.listCheckpointRefs({ cwd: root, prefix: TURN_REFS });
    if (turns.some((ref) => ENDED_TURN.test(ref.checkpointRef))) return undefined;
    const now = yield* Clock.currentTimeMillis;
    return (now - born) / 60_000;
  }).pipe(Effect.orElseSucceed(() => undefined));

/** game.json's `recipes`, read leniently: a game without the field, or a bad one, picked none. */
const pickedRecipes = (root: string) =>
  Effect.promise(() =>
    NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8")
      .then((text) => {
        const recipes: unknown = (JSON.parse(text) as { recipes?: unknown }).recipes;
        return Array.isArray(recipes)
          ? recipes.filter((each): each is string => typeof each === "string")
          : [];
      })
      .catch((): ReadonlyArray<string> => []),
  );

/**
 * A check, with its views as images: the agent sees its game before it ends the turn. When the
 * game has a reference picture, play's frame comes stacked above it at the same size, every check:
 * matching a picture is a loop of looks, and each look needs both.
 */
const check = (store: CheckpointStore["Service"], final: boolean) =>
  Effect.gen(function* () {
    const result = yield* withGame(GameEngine.GameEngine, (engines, threadId) =>
      engines.check(threadId, undefined, { final }),
    );
    const root = yield* withGame(GameProjectService.GameProjectService, (projects, threadId) =>
      projects.resolve(threadId),
    );
    const moved = result.player?.status === "measured" && result.player.report.moves === true;
    const minutes = final ? yield* stageMinutes(store, root, moved) : undefined;
    const measured = minutes === undefined ? result : { ...result, stageMinutes: minutes };
    const picked = yield* pickedRecipes(root);
    const recipes = picked.length === 0 ? [] : yield* recipeLines(root, picked, measured);
    const views = result.views ?? [];
    if (views.length === 0) return recipes.length === 0 ? measured : { ...measured, recipes };
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
    const session = (yield* caller).thread.providerSessionId;
    // A brief alone needs no words beside the frames; a reference says which picture is which.
    const review = shown.length > 0 && reference !== null && firstReview(session);
    return {
      ...measured,
      ...(recipes.length === 0 ? {} : { recipes }),
      ...(shown.length === 0 ? {} : { screenshots: shown }),
      ...(review
        ? {
            review: `${views[0]?.entry === "boot" && shown.length > 1 ? REVIEW.openingReview : ""}${REVIEW.frameReview}`,
          }
        : {}),
    };
  }).pipe(as(GameCheckAnswer));

/**
 * The status line a final check ends with (what op status answered): how models are made and the
 * Blender the game's tools would run.
 */
const statusLine = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const status = yield* withGame(GameStatusService.GameStatusService, (statuses, threadId) =>
    statuses.status(threadId, {}),
  );
  return [
    `models ${status.characters}${status.library ? " with the library" : ""}`,
    scope.blenderMissing == null ? "Blender ready" : `no Blender (${scope.blenderMissing})`,
  ].join(" · ");
});

const checkHandlers = (store: CheckpointStore["Service"]) =>
  ({
    game_check: McpToolAccess.actsAsCaller((input) =>
      dispatch(
        "game_check",
        input,
        {
          look: () => check(store, false),
          // The critique is read back from this call's input by keep going (GameRunStepRunner).
          final: () =>
            check(store, true).pipe(
              Effect.flatMap((answer) =>
                statusLine.pipe(
                  Effect.map((status) => ({ ...(answer as object), status })),
                  Effect.orElseSucceed(() => answer),
                ),
              ),
            ),
        },
        "look",
      ),
    ),
  }) satisfies McpToolAccess.Handlers<typeof GameCheckToolkit.tools>;
export const layerCheck = McpToolAccess.toLayer(
  GameCheckToolkit,
  Effect.gen(function* () {
    return checkHandlers(yield* CheckpointStore);
  }),
);

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

/** One run replayed to a moment, its frame as an image. */
const replayMoment = (input: { readonly run: string; readonly at?: number }) =>
  Effect.gen(function* () {
    const moment = yield* withGame(GamePlays.GamePlays, (plays, threadId) =>
      plays.moment(threadId, input),
    );
    const root = yield* withGame(GameProjectService.GameProjectService, (projects, threadId) =>
      projects.resolve(threadId),
    );
    const shot =
      moment.image === null
        ? null
        : yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(root, moment.image!)).then(png, () => null),
          );
    return { ...moment, ...(shot === null ? {} : { screenshots: [shot] }) };
  }).pipe(
    as(
      Schema.Struct({
        ...GameReplayMoment.fields,
        screenshots: Schema.optionalKey(Schema.Array(GameBlenderLookScreenshot)),
      }),
    ),
  );

const playHandlers = {
  game_play: McpToolAccess.actsAsCaller((input) =>
    dispatch("game_play", input, {
      act: (act) =>
        withGame(GameExplore.GameExplore, (explore, threadId) => explore.play(threadId, act)).pipe(
          as(GameExploreActResult),
        ),
      close: (close) =>
        withGame(GameExplore.GameExplore, (explore, threadId) =>
          explore.close(threadId, close),
        ).pipe(as(GameExploreCloseResult)),
      eval: (evaluation) =>
        withGame(GameExplore.GameExplore, (explore, threadId) =>
          explore.evaluate(threadId, evaluation),
        ).pipe(as(GameEvalResult)),
      bot: (bot) =>
        withGame(GameBot.GameBot, (bots, threadId) => bots.run(threadId, bot)).pipe(
          as(GameBotRunResult),
        ),
      // A save (of the last ended run, or of `run`) or a delete answers with the saved plays as
      // they are then; a run, with its moment as an image; else the saved plays replay.
      replay: (input) =>
        input.run !== undefined && input.save === undefined
          ? replayMoment({ run: input.run, ...(input.at === undefined ? {} : { at: input.at }) })
          : input.save === undefined && input.delete === undefined
            ? withGame(GamePlays.GamePlays, (plays, threadId) => plays.replaySaved(threadId)).pipe(
                as(Schema.Union([GameSavedPlaysReading, GameReplayResult])),
              )
            : withGame(GamePlays.GamePlays, (plays, threadId) =>
                Effect.gen(function* () {
                  if (input.save !== undefined)
                    yield* plays.save(threadId, {
                      name: input.save,
                      ...(input.run === undefined ? {} : { kept: input.run }),
                    });
                  if (input.delete !== undefined) yield* plays.remove(threadId, input.delete);
                  // An answer is an object: a tool's structured content cannot be a bare list.
                  return { saved: yield* plays.saved(threadId) };
                }),
              ).pipe(as(Schema.Struct({ saved: GameSavedPlaysResult }))),
      model_sheet: modelSheet,
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GamePlayToolkit.tools>;
export const layerPlay = McpToolAccess.toLayer(GamePlayToolkit, playHandlers);

const LibraryText = Schema.Struct({ text: Schema.String });

const assetsHandlers = {
  game_assets: McpToolAccess.actsAsCaller((input) =>
    personsModelChoice.pipe(
      Effect.mapError(refusal),
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
          lock: (lock) =>
            withGame(GameAssetLibrary.GameAssetLibrary, (library, threadId) =>
              library.lock(threadId, lock),
            ).pipe(as(LibraryText)),
          pictures: (pictures) =>
            withGame(GameEngine.GameEngine, (engines, threadId) =>
              engines.pictures(threadId, pictures),
            ).pipe(as(GamePicturesResult)),
        }),
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameAssetsToolkit.tools>;
export const layerAssets = McpToolAccess.toLayer(GameAssetsToolkit, assetsHandlers);

const blenderHandlers = {
  game_blender: McpToolAccess.actsAsCaller((input) =>
    personsModelChoice.pipe(
      Effect.mapError(refusal),
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
          addon: (addon) =>
            withGame(GameBlender.GameBlender, (blender, threadId) =>
              blender.addon(threadId, addon),
            ).pipe(as(GameBlenderSceneResult)),
        }),
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof GameBlenderToolkit.tools>;
export const layerBlender = McpToolAccess.toLayer(GameBlenderToolkit, blenderHandlers);

const handlers = {
  game_builds: McpToolAccess.actsAsCaller((input) =>
    dispatch(
      "game_builds",
      input,
      {
        // One build answers with what the harness measured on it (what op facts did).
        list: ({ build, ...list }) =>
          build === undefined
            ? withGame(GameBuilds.GameBuilds, (builds, threadId) =>
                builds.list(threadId, { before: list.before, limit: list.limit }),
              ).pipe(as(GameBuildsResult))
            : withGame(GameBuilds.GameBuilds, (builds, threadId) =>
                builds.measure(
                  threadId,
                  { _tag: "build", build },
                  { waitFor: TOOL_FACTS_WAIT, queue: "background" },
                ),
              ).pipe(as(GameBuildFacts)),
        // `to` goes back to the build (what op restore did); else its change alone is undone.
        undo: (undo) =>
          undo.to === true
            ? withGame(GameBuilds.GameBuilds, (builds, threadId) =>
                builds.restore(threadId, { _tag: "build", build: undo.build }, undo.commandId),
              ).pipe(as(GameBuildRestoreResult))
            : withGame(GameBuilds.GameBuilds, (builds, threadId) =>
                builds.undo(threadId, undo.build, undefined),
              ).pipe(as(GameBuildUndoResult)),
        export: (release) =>
          withGame(GameExport.GameExport, (exporter, threadId) =>
            release.zip === true
              ? exporter
                  .export(threadId, "Web")
                  .pipe(Effect.andThen(exporter.packageWeb(threadId)), as(GameWebPackage))
              : exporter.export(threadId, "Web").pipe(as(GameActionResult)),
          ),
      },
      "list",
    ),
  ),
  game_copy: McpToolAccess.actsAsCaller((input) =>
    dispatch("game_copy", input, {
      copies: () =>
        withGame(GameCopies.GameCopies, (copies, threadId) => copies.copies(threadId)).pipe(
          as(GameCopiesResult),
        ),
      // An agent brings in its own copy or a child's: what it, or what it delegated, made.
      bring_in: (bring) =>
        withGame(GameCopies.GameCopies, (copies, threadId) =>
          copies.bringIn(
            {
              threadId,
              // A child's copy is done once brought in; the agent's own copy goes on.
              ...(bring.chat === undefined || bring.chat === threadId
                ? {}
                : { chat: bring.chat, close: true }),
            },
            { agent: true },
          ),
        ).pipe(as(GameBringInResult)),
      update: () =>
        withGame(GameCopies.GameCopies, (copies, threadId) =>
          copies.update(threadId, threadId),
        ).pipe(as(GameCopyUpdateResult)),
    }),
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
        Effect.map((answer) =>
          present(
            "game_keep_going",
            input.mode ?? "status",
            {
              line: `${(answer as { mode?: string }).mode ?? "off"}${(answer as { step?: number | null }).step == null ? "" : ` · step ${(answer as { step?: number }).step}`}`,
              next: "none.",
            },
            answer as Record<string, unknown>,
          ),
        ),
      );
    }).pipe(Effect.mapError(refusal)),
  ),
} satisfies McpToolAccess.Handlers<typeof GameToolkit.tools>;
export const layer = McpToolAccess.toLayer(GameToolkit, handlers);
