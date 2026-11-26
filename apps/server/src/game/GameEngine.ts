// @effect-diagnostics nodeBuiltinImport:off -- The check reads the source tree around the engine's run.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GameOperationError,
  gameOperationFault,
  GAME_ENGINES,
  GameEngineId,
  manifestRuntime,
  type GameManifest,
  type GameActionResult,
  type GameCheckIssue,
  type GameCheckResult,
  type GameCheckView,
  type GameCheckQa,
  type GameCheckScreens,
  type GameProcessResult,
  type GamePlay,
  type GameReplayRun,
  type GameModelSheetInput,
  type GameModelSheetResult,
  GamePicturesInput,
  type GamePicturesResult,
  type GameToolStatus,
  type GameViewport,
  type ThreadId,
} from "@kurambit/contracts";
import { commandDetail } from "./commandDetail.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { inGame } from "./gamePath.ts";
import { makeThreeBackend } from "./GameThreeEngine.ts";
import { runtimesDirectory } from "./gameRuntime.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { type GameEngineProfile, type GameExportTarget } from "./engineProfile.ts";
import * as GameOperations from "./GameOperations.ts";
import { limitIssues, mergeCheckIssues } from "./checkIssues.ts";
import { HERO_KINDS, keepHeroSheet } from "./heroSheets.ts";
import { comparedSource, makeSourceIdentity, sourceIdentityError } from "./sourceTree.ts";
import { gameReference } from "./gameReference.ts";
import { readGameStyle } from "./gameStyle.ts";
import { renderPictures } from "./pictures.ts";
import type { SheetView } from "./webPlaySession.ts";

/**
 * How an agent judges a model sheet, carried by the sheet's own result so it arrives exactly
 * when it is needed and costs the turn's instructions nothing.
 */
const MODEL_REVIEW =
  "Look at these sheets against the brief, biggest difference first: silhouette (the side profile, then the plan), proportions (each part against the 1.8 m figure), how the main parts meet, then surface.";

/** The same review against a reference picture, drawn from the side and from the picture's angle. */
const REFERENCE_REVIEW = MODEL_REVIEW.replace(
  "these sheets against the brief",
  "these sheets against the reference at the same angle (the side profile against a side view, the reference's view against the picture; set `view` to the picture's angle first)",
);

/** Against a reference: the side profile, and the reference's angle (a low front three-quarter unless named). */
const referenceViews = (view?: {
  readonly around: number;
  readonly up: number;
}): ReadonlyArray<SheetView> => {
  const around = ((view?.around ?? 50) * Math.PI) / 180;
  const up = ((view?.up ?? 8) * Math.PI) / 180;
  return [
    { label: "side profile", dir: [1, 0.06, 0] },
    {
      label: "the reference's view",
      dir: [Math.sin(around) * Math.cos(up), Math.sin(up), Math.cos(around) * Math.cos(up)],
    },
  ];
};

export interface GameEngineBinary {
  readonly path: string;
  readonly version: string;
  readonly templates: string | null;
}

/** A replay stopped at a second of play, its frame kept as a PNG at `image`. */
export interface ReplayMoment {
  readonly at: number;
  readonly image: string;
}

export interface GameEngineContext {
  readonly root: string;
  /** Absolute directory of the engine project. */
  readonly projectDir: string;
  /** Game-relative engine project directory. */
  readonly projectName: string;
  readonly binary: GameEngineBinary;
  /** The Kurambit runtime major the game loads (game.json `runtime`); null when it carries its own copy. */
  readonly runtime: number | null;
}

export interface GameEngineCheckReport {
  readonly reported: {
    readonly entries: ReadonlyArray<string>;
    readonly errors: ReadonlyArray<GameCheckIssue>;
    readonly warnings: ReadonlyArray<GameCheckIssue>;
  } | null;
  /** Issues parsed from the check run's own stdout/stderr. */
  readonly issues: ReadonlyArray<GameCheckIssue>;
  readonly run: GameProcessResult;
  /** Pictures of the entries it ran, from an engine that can take them. */
  readonly views?: ReadonlyArray<GameCheckView>;
  /** How its play ran, and a warning when it missed 60 fps or spent more than a laptop has. */
  readonly performance?: { readonly line: string; readonly warning: string | null };
  /** The QA play's report and what to fix, or why it was not played (three.js). */
  readonly qa?: GameCheckQa;
  /** With the QA play: the game at phone portrait and widescreen (three.js). */
  readonly screens?: GameCheckScreens;
  /** With the QA play: the first minute as a player meets it (three.js, playerProbe.ts). */
  readonly player?: GameCheckResult["player"];
}

/** One release the engine wrote into a staging folder. */
export interface GameEngineRelease {
  /** success ⇒ `artifact` names the release's file inside the staging folder. */
  readonly result: GameActionResult;
  readonly artifact: string | null;
  /** Lines the export's message carries (a preset added, how the release ships). */
  readonly notes: ReadonlyArray<string>;
}

/**
 * One engine's driver. It owns everything engine-specific: the project and its
 * binary, its tool's status, import, check, the releases it makes and their
 * files, replays and model sheets. The core (GameEngine, GameExport, GameStage)
 * owns stage order, source identity, staging, publication and operation
 * ownership, and asks this interface (or the profile), never the engine's
 * name, wherever engines differ. A new engine is one more of these, with its
 * profile (engineProfile.ts), its GAME_ENGINES entry, template and skill.
 */
export interface GameEngineBackend {
  readonly profile: GameEngineProfile;
  readonly resolveProject: (
    root: string,
    manifest: GameManifest,
  ) => Effect.Effect<Omit<GameEngineContext, "root" | "runtime">, GameOperationError>;
  /** The one tool this game's engine needs, for this project; null when it needs none. */
  readonly toolStatus: (
    root: string,
    manifest: GameManifest,
  ) => Effect.Effect<GameToolStatus | null>;
  /** The resolution the game boots, explores and bot-plays at, from the project folder alone. */
  readonly viewport: (projectDir: string) => Effect.Effect<GameViewport, GameOperationError>;
  /** The project's settings file, relative to the project: where a check names project-wide errors. */
  readonly projectSettingsFile: string;
  /**
   * The editor import, read by the engine's one error reading: success
   * exactly when the run ended cleanly and `issues` is empty.
   */
  readonly importProject: (
    ctx: GameEngineContext,
  ) => Effect.Effect<
    { readonly result: GameActionResult; readonly issues: ReadonlyArray<GameCheckIssue> },
    GameOperationError
  >;
  /**
   * Boot check of the entries the engine boots: what the player opens first, then the
   * gameplay entry. With `qa`, an engine that has a QA play plays it, then the other screen
   * sizes, and the first minute on the page as a player opens it. With `look`, an engine that can opens
   * only the gameplay entry for a moment of play and returns its frame, errors and frame rate:
   * the agent's quick look between edits.
   */
  readonly runCheck: (
    ctx: GameEngineContext,
    input: {
      readonly gameplayScene: string;
      readonly qa: boolean;
      readonly look: boolean;
    },
  ) => Effect.Effect<GameEngineCheckReport, GameOperationError>;
  /** Refuses an export the installed engine cannot make (missing export templates), before any import. */
  readonly exportReady: (
    binary: GameEngineBinary,
    target: GameExportTarget,
  ) => Effect.Effect<void, GameOperationError>;
  /**
   * The export preset a release uses, settled after the import and before the
   * source identity is taken, because the preset is part of the sources.
   */
  readonly exportPreset: (
    ctx: GameEngineContext,
    target: GameExportTarget,
  ) => Effect.Effect<{ readonly name: string; readonly added: boolean }, GameOperationError>;
  /**
   * Writes one release of the current sources into `staging`, an empty folder
   * the core made beside the destination, and checks its own files. The core
   * compares the sources around it and publishes the folder.
   */
  readonly release: (
    ctx: GameEngineContext,
    input: {
      readonly target: GameExportTarget;
      readonly preset: string;
      readonly staging: string;
      readonly operation: string;
    },
  ) => Effect.Effect<GameEngineRelease, GameOperationError>;
  /**
   * Runs a person's kept play again on the game at `ctx` (its folder or a build's copy) from
   * the gameplay entry; "no-replay" when that game's shell has none. Null for engines whose
   * shell keeps no plays. With `moment`, it stops at that second of play and keeps the frame
   * there as `moment.image`.
   */
  readonly replay:
    | ((
        ctx: GameEngineContext,
        input: {
          readonly gameplayScene: string;
          readonly play: GamePlay;
          readonly moment?: ReplayMoment;
        },
      ) => Effect.Effect<GameReplayRun | "no-replay", GameOperationError>)
    | null;
  /**
   * Model sheets of things the game named, drawn by its shell in a page of their own (images
   * kept under `folder`). Null for engines whose games have no such shell.
   */
  readonly modelSheet:
    | ((
        ctx: GameEngineContext,
        input: {
          readonly gameplayScene: string;
          readonly things: ReadonlyArray<string> | null;
          readonly folder: string;
          /** The views to draw, larger for being fewer; null for the shell's six. */
          readonly views: ReadonlyArray<SheetView> | null;
        },
      ) => Effect.Effect<GameModelSheetResult | "no-sheet", GameOperationError>)
    | null;
}

const unsupportedEngine = (engineName: string) =>
  new GameOperationError({
    operation: "resolve-engine",
    path: engineName === "" ? "(missing engine name)" : engineName,
    reason: "invalid-input",
    detail:
      `Unsupported game engine "${engineName === "" ? "(missing)" : engineName}". ` +
      `This build supports: ${GameEngineId.literals.join(", ")}. ` +
      `The project was not imported, checked or exported; no engine process started.`,
  });

export class GameEngine extends Context.Service<
  GameEngine,
  {
    /**
     * Return the backend for a manifest-declared engine name. Anything outside
     * the supported list fails before any executable lookup or process launch.
     */
    readonly backendFor: (
      engineName: string,
    ) => Effect.Effect<GameEngineBackend, GameOperationError>;
    /**
     * Resolve a game's engine and its project context: validate the
     * manifest's engine first, then resolve the executable. An unsupported
     * engine never reaches the toolchain lookup.
     */
    readonly context: (
      root: string,
    ) => Effect.Effect<
      { readonly backend: GameEngineBackend; readonly ctx: GameEngineContext },
      GameOperationError
    >;
    /** The engine's import of the game's project, as an action result. */
    readonly importProject: (root: string) => Effect.Effect<GameActionResult, GameOperationError>;
    /** `game_assets` op `import`: the engine's import of the thread's game, as the game's operation. */
    readonly import: (threadId: ThreadId) => Effect.Effect<GameActionResult, GameOperationError>;
    /**
     * The agent's quick look at the thread's game (GameEngineBackend.runCheck), as the thread's
     * game's operation (`owner` names whose work it is, the thread by default). Everything the
     * game did is in the result (a failed import, an entry that does not load, a freeze, compile
     * errors); it fails only when the check could not be made: a tool or the machine. The full
     * check is the build's measure after the turn (checkIn), never run twice for one build.
     */
    readonly check: (
      threadId: ThreadId,
      owner?: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
    /**
     * The full check of a checkout no thread owns (a build's copy), as its own operation:
     * the boot, the QA play, the other screen sizes and the first minute.
     */
    readonly checkIn: (
      root: string,
      owner: string,
    ) => Effect.Effect<GameCheckResult, GameOperationError>;
    /**
     * A person's kept play run again on the game at `root` (its folder or a build's copy);
     * refused for an engine or a shell with no replay.
     */
    readonly replayIn: (
      root: string,
      play: GamePlay,
      moment?: ReplayMoment,
    ) => Effect.Effect<GameReplayRun, GameOperationError>;
    /** `game_assets` op `pictures`: a template drawn once per row into texture sheets. */
    readonly pictures: (
      threadId: ThreadId,
      input: unknown,
    ) => Effect.Effect<GamePicturesResult, GameOperationError>;
    /** `game_play` op `model_sheet`: the named things alone, from four sides, with their size and cost. */
    readonly modelSheet: (
      threadId: ThreadId,
      input: GameModelSheetInput,
    ) => Effect.Effect<GameModelSheetResult, GameOperationError>;
    /**
     * The one tool this game's engine needs, as the toolchain sees it for this
     * project. Asked on every status read, so an answer is kept briefly per game.
     */
    readonly toolStatus: (root: string) => Effect.Effect<GameToolStatus | null, GameOperationError>;
    /** The resolution the game boots, explores and bot-plays at. */
    readonly viewport: (root: string) => Effect.Effect<GameViewport, GameOperationError>;
  }
>()("kurambit/game/GameEngine") {}

const decodePictures = Schema.decodeUnknownResult(GamePicturesInput, {
  errors: "all",
  onExcessProperty: "error",
});

const make = Effect.gen(function* () {
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  const gameBrowser = yield* makeGameBrowser;
  const templates = yield* GameTemplates.GameTemplates;
  const identify = yield* makeSourceIdentity;
  const backends = new Map<string, GameEngineBackend>([
    ["three", makeThreeBackend(gameBrowser, Effect.map(templates.directory, runtimesDirectory))],
  ]);
  const backendFor = (engineName: string): Effect.Effect<GameEngineBackend, GameOperationError> => {
    const backend = backends.get(engineName);
    return backend === undefined
      ? Effect.fail(unsupportedEngine(engineName))
      : Effect.succeed(backend);
  };
  /** The backend that runs a game's engine work. */
  const runner = (manifest: GameManifest) => backendFor(manifest.engine.name);
  const context = Effect.fn("GameEngine.context")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* runner(manifest);
    const project = yield* backend.resolveProject(root, manifest);
    return { backend, ctx: { root, ...project, runtime: manifestRuntime(manifest) } };
  });
  const importProject = Effect.fn("GameEngine.importProject")(function* (root: string) {
    const { backend, ctx } = yield* context(root);
    return (yield* backend.importProject(ctx)).result;
  });

  const snapshot = (root: string, project: string) => identify(root, project);

  /**
   * Imports first: an engine's import prepares its caches, and may write
   * files inside the project, so the inputs are read after it and before the
   * check runs.
   */
  const checkSources = (
    root: string,
    backend: GameEngineBackend,
    ctx: GameEngineContext,
    manifest: GameManifest,
    startedAt: number,
    qa: boolean,
    look: boolean,
  ) =>
    Effect.gen(function* () {
      const { profile } = backend;
      const project = ctx.projectName;
      const imported = yield* backend.importProject(ctx);
      const before = yield* snapshot(root, project);
      // Sources that cannot be identified: a link or too many files is the
      // game's (a check error, through asResult), an unreadable tree ours.
      if (before.kind === "unknown")
        return yield* sourceIdentityError(`${profile.displayName} check`, root, project, before);
      const executed = yield* backend.runCheck(ctx, {
        gameplayScene: manifest.gameplayScene ?? "",
        qa,
        look,
      });
      const { run, reported } = executed;
      const errors = mergeCheckIssues(reported?.errors ?? [], [
        ...imported.issues,
        ...executed.issues,
      ]);
      // File labels name the engine project, whichever engine it is.
      const projectFile = `${project}/${backend.projectSettingsFile}`;
      if (!imported.result.success && imported.issues.length === 0)
        errors.unshift({
          file: projectFile,
          message: `Import failed with exit code ${imported.result.process?.exitCode ?? -1}. ${imported.result.message}`,
        });
      if (reported === null)
        errors.unshift({
          file: projectFile,
          message: `The ${profile.displayName} check script did not report a result. The project may have crashed during startup.`,
        });
      if (run.timedOut) errors.unshift({ file: projectFile, message: profile.check.timedOut });
      if (run.exitCode !== 0 && errors.length === 0)
        errors.unshift({
          file: projectFile,
          message: `${profile.displayName} exited with code ${run.exitCode}. ${commandDetail(run)}`,
        });
      const warnings = [
        ...(reported?.warnings ?? []),
        ...(executed.performance?.warning == null
          ? []
          : [{ file: `${project}/`, message: executed.performance.warning }]),
      ];
      const after = yield* snapshot(root, project);
      if (after.kind === "unknown")
        return yield* sourceIdentityError(`${profile.displayName} check`, root, project, after);
      // Sources that moved during the check (the game may write its own
      // folder as it runs) leave the verdict standing, with a warning.
      const comparison = comparedSource(before, after, "check");
      if (comparison.kind !== "current")
        warnings.unshift({ file: `${project}/`, message: comparison.detail });
      return {
        ok: errors.length === 0 && reported !== null && !run.timedOut,
        errors: limitIssues(errors),
        warnings: limitIssues(warnings),
        entries: reported?.entries ?? [],
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        ...(executed.views === undefined || executed.views.length === 0
          ? {}
          : { views: executed.views }),
        ...(executed.performance === undefined ? {} : { performance: executed.performance.line }),
        ...(executed.qa === undefined ? {} : { qa: executed.qa }),
        ...(executed.screens === undefined ? {} : { screens: executed.screens }),
        ...(executed.player === undefined ? {} : { player: executed.player }),
      } satisfies GameCheckResult;
    });

  const check = Effect.fn("GameEngine.check")(function* (
    root: string,
    options?: { readonly qa?: boolean; readonly look?: boolean },
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    // A failure the game's own files cause (an unreadable game.json, an editor
    // that will not open the project for its compile errors) is a check
    // result, so the check fails only when a tool or the machine kept it from
    // being made.
    const asResult = (error: GameOperationError) =>
      gameOperationFault(error.reason) !== "build"
        ? Effect.fail(error)
        : Effect.map(Clock.currentTimeMillis, (now) => ({
            ok: false,
            errors: limitIssues([
              { file: error.path, message: `${error.operation}: ${error.detail ?? error.reason}` },
            ]),
            warnings: [],
            entries: [],
            durationMs: now - startedAt,
          }));
    return yield* Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const backend = yield* runner(manifest);
      const project = yield* backend.resolveProject(root, manifest);
      const ctx = { root, ...project, runtime: manifestRuntime(manifest) };
      return yield* checkSources(
        root,
        backend,
        ctx,
        manifest,
        startedAt,
        options?.qa === true,
        options?.look === true,
      );
    }).pipe(Effect.catchTags({ GameOperationError: asResult }));
  });

  const toolAnswers = yield* Cache.make({
    lookup: (root: string) =>
      Effect.gen(function* () {
        const manifest = yield* projects.read(root);
        const backend = yield* backendFor(manifest.engine.name);
        return yield* backend.toolStatus(root, manifest);
      }),
    capacity: 256,
    timeToLive: "30 seconds",
  });
  const toolStatus = (root: string) => Cache.get(toolAnswers, root);

  const viewport = Effect.fn("GameEngine.viewport")(function* (root: string) {
    const manifest = yield* projects.read(root);
    const backend = yield* runner(manifest);
    // The project folder alone answers this; no binary is resolved.
    return yield* backend.viewport(yield* inGame(root, manifest.project));
  });

  const checkLabel = (root: string) =>
    Effect.map(
      projects.read(root),
      (manifest) => `${GAME_ENGINES[manifest.engine.name].name} check`,
    );
  const replayIn: GameEngine["Service"]["replayIn"] = (root, play, moment) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const { backend, ctx } = yield* context(root);
      const refused = (detail: string) =>
        new GameOperationError({
          operation: "replay",
          path: root,
          reason: "invalid-input",
          detail,
        });
      if (backend.replay === null)
        return yield* refused(
          `${backend.profile.displayName} games do not keep plays yet; three.js games do.`,
        );
      const run = yield* backend.replay(ctx, {
        gameplayScene: manifest.gameplayScene ?? "",
        play,
        ...(moment === undefined ? {} : { moment }),
      });
      if (run === "no-replay")
        return yield* refused(
          "This build's copy of the shell predates replays, so it cannot play a kept run.",
        );
      return run;
    });
  return GameEngine.of({
    backendFor,
    context,
    importProject,
    import: (threadId) => projects.exclusive(threadId, "Import", importProject),
    check: (threadId, owner) =>
      Effect.gen(function* () {
        const root = yield* projects.resolve(threadId);
        const label = yield* checkLabel(root);
        return yield* projects.exclusive(threadId, label, (root) => check(root, { look: true }), {
          owner,
        });
      }),
    checkIn: (root, owner) =>
      Effect.flatMap(checkLabel(root), (label) =>
        // The QA play's report is a build fact of its own, measured with the boot.
        operations.exclusive(root, label, check(root, { qa: true }), owner),
      ),
    replayIn,
    pictures: (threadId, input) =>
      projects.exclusive(threadId, "Pictures", (root) =>
        Effect.gen(function* () {
          const decoded = decodePictures(input);
          if (Result.isFailure(decoded))
            return yield* new GameOperationError({
              operation: "game-pictures",
              path: root,
              reason: "invalid-input",
              detail: `${decoded.failure.message.replace(/\s+/g, " ").slice(0, 400)}. pictures takes output, template, rows [{name, ...}], size [w, h], and for animations frames, fps, loop; pivot [x, y].`,
            });
          const manifest = yield* projects.read(root);
          const realRoot = yield* Effect.tryPromise({
            try: () => NodeFSP.realpath(root),
            catch: (cause) =>
              new GameOperationError({
                operation: "game-pictures",
                path: root,
                reason: "io",
                cause,
              }),
          });
          const browser = yield* gameBrowser("game-pictures", root);
          return yield* renderPictures(
            {
              browser,
              realRoot,
              engine: manifest.engine.name,
              project: manifest.project,
              style: yield* readGameStyle(realRoot),
            },
            decoded.success,
          );
        }),
      ),
    modelSheet: (threadId, input) =>
      projects.exclusive(threadId, "Model sheet", (root) =>
        Effect.gen(function* () {
          const manifest = yield* projects.read(root);
          const { backend, ctx } = yield* context(root);
          const refused = (detail: string) =>
            new GameOperationError({
              operation: "model-sheet",
              path: root,
              reason: "invalid-input",
              detail,
            });
          if (backend.modelSheet === null)
            return yield* refused(
              `${backend.profile.displayName} games have no model sheet; three.js games do.`,
            );
          // Against a reference only the views it is compared from, larger: the side profile and
          // the reference's own angle.
          const reference = yield* gameReference(root, input.reference);
          const sheets = yield* backend.modelSheet(ctx, {
            gameplayScene: manifest.gameplayScene ?? "",
            things: input.things ?? null,
            folder: NodePath.join(root, "builds/logs", `model-sheet-${NodeCrypto.randomUUID()}`),
            views: reference === null ? null : referenceViews(input.view),
          });
          if (sheets === "no-sheet")
            return yield* refused(
              "This game's copy of the shell predates model sheets (an older game that carries its own shell).",
            );
          if (sheets.sheets.length === 0) return sheets;
          // A character's or creature's sheet is its hero sheet (heroSheets.ts).
          const kept = yield* Effect.forEach(
            sheets.sheets.filter((sheet) => HERO_KINDS.has(sheet.kind)),
            (sheet) =>
              Effect.tryPromise({
                try: () => keepHeroSheet(root, sheet.name, NodePath.join(root, sheet.image)),
                catch: (cause) =>
                  new GameOperationError({
                    operation: "model-sheet",
                    path: root,
                    reason: "io",
                    detail: "The hero sheet could not be kept in art/sheets.",
                    cause,
                  }),
              }),
          );
          const review = reference === null ? MODEL_REVIEW : REFERENCE_REVIEW;
          return {
            ...sheets,
            review:
              kept.length === 0
                ? review
                : `${review} Kept as hero sheets: ${kept.join(", ")}. Write each one's critique beside it (${kept.map((sheet) => sheet.replace(/\.png$/, ".md")).join(", ")}).`,
          };
        }),
      ),
    toolStatus,
    viewport,
  });
});

export const layer = Layer.effect(GameEngine, make);
