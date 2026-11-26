// @effect-diagnostics globalDate:off globalTimers:off globalDateInEffect:off nodeBuiltinImport:off -- This backend owns the headless-Chromium boundary for the three.js lane: wall-clock boot polling, real sleeps and loopback serving.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GAME_SCREEN_SIZES,
  THREE_PINNED_VERSION,
  THREE_VIEWPORT,
  GameOperationError,
  GameQaReport,
  GameReplayRun,
  gamePlayerLines,
  gameQaFindings,
  gameQaProblems,
  type GameCheckResult,
  type GameActionResult,
  type GameCheckIssue,
  type GameCheckQa,
  type GameCheckScene,
  type GameCheckScreens,
  type GameScreenSize,
  gameScreensFindings,
  type GameCheckView,
  type GameModelSheet,
  type GameModelSheetResult,
  type GameProcessResult,
  sceneLines,
} from "@kurambit/contracts";
import { inGame } from "./gamePath.ts";
import { commandDetail } from "./commandDetail.ts";
import { stackToGameFile, type GameBrowser } from "./gameChromium.ts";
import { playLane } from "./playLane.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import {
  openWebPlaySession,
  WebBrowserGone,
  WebBrowserLaunchFailed,
  WebPageCrashed,
  WebPageNotReady,
  type WebPageEvent,
  type SheetView,
  type WebPlaySession,
} from "./webPlaySession.ts";
import type { GameEngineBackend, GameEngineContext } from "./GameEngine.ts";
import { copyRuntimeInto, hasRuntime } from "./gameRuntime.ts";
import { gameLookJson, LOOK_ROUTE } from "./gameStyle.ts";
import { copyTree } from "./gameFiles.ts";
import { THREE_PROFILE } from "./threeProfile.ts";
import {
  keepSceneReport,
  playRandomly,
  SCENE_CHECK_PLAY_MS,
  SCENE_OLD_SHELL,
  type PageScene,
} from "./sceneReport.ts";
import { checkPerformance } from "./playPerf.ts";
import { measurePlayer, PLAYER_PROBE } from "./playerProbe.ts";

const BOOT_TIMEOUT_MS = 60_000;
/**
 * A replay draws one frame in this many: the harness reads how the run went, never its picture.
 * In SwiftShader it is what makes a replay fit a build's measure (a 60 s play of a sword duel:
 * 106 s drawing every frame, 8 s at one in 30); on a GPU stepping costs the most either way.
 */
const REPLAY_DRAW_EVERY = 30;
/** A quick look's play: long enough for a frame rate (two seconds of frames) and a moved frame. */
const LOOK_PLAY_MS = 2_500;
/** Play before the sheet is drawn: start() has built the run and the clips have begun. */
const SHEET_SETTLE_MS = 1_500;
/** With no names: this many things, characters and creatures first. */
const SHEET_DEFAULT_COUNT = 4;
const SHEET_FIRST_KINDS = ["character", "creature", "prop"];

const PageSheet = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  size: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  triangles: Schema.Number,
  drawCalls: Schema.Number,
});
const PageThings = Schema.Struct({
  things: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.String })),
});
const decodeSheet = Schema.decodeUnknownOption(PageSheet);
const decodeThings = Schema.decodeUnknownOption(PageThings);
const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "thing";

/** Each named thing's sheet from the open page; with no names, the first few it has. */
const drawSheets = async (
  session: WebPlaySession,
  input: {
    readonly things: ReadonlyArray<string> | null;
    readonly folder: string;
    readonly views: ReadonlyArray<SheetView> | null;
  },
  root: string,
): Promise<GameModelSheetResult | "no-sheet"> => {
  const listed = await session.sheet(null);
  if (listed === "no-sheet") return "no-sheet";
  if (listed === null)
    return {
      sheets: [],
      missing: [...(input.things ?? [])],
      things: [],
      note: "The game did not answer in time (still loading, or its main thread is stuck), so nothing was drawn. Run game_check, then call again.",
    };
  const things = Option.match(decodeThings(listed), {
    onNone: () => [],
    onSome: (value) => value.things,
  });
  const wanted =
    input.things ??
    things
      .toSorted(
        (a, b) =>
          (SHEET_FIRST_KINDS.indexOf(a.kind) + 1 || 9) -
          (SHEET_FIRST_KINDS.indexOf(b.kind) + 1 || 9),
      )
      .slice(0, SHEET_DEFAULT_COUNT)
      .map((thing) => thing.name);
  const sheets: Array<GameModelSheet> = [];
  const missing: Array<string> = [];
  for (const [index, name] of wanted.entries()) {
    const drawn = decodeSheet(await session.sheet(name, input.views ?? undefined));
    if (Option.isNone(drawn)) {
      missing.push(name);
      continue;
    }
    const image = NodePath.join(input.folder, `${index + 1}-${fileSafe(name)}.png`);
    if (!(await session.still(image))) {
      missing.push(name);
      continue;
    }
    sheets.push({ ...drawn.value, image: NodePath.relative(root, image) });
  }
  return { sheets, missing, things };
};

/** The check's scene report, its frames kept in the check's own log folder. */
const sceneOf = async (
  play: { readonly page: PageScene; readonly ms: number } | null,
  folder: string,
  relative: string,
  browser: GameBrowser,
): Promise<GameCheckScene> => {
  if (play === null)
    return {
      status: "not-measured",
      why: "the gameplay entry did not open, so there was no play to look at",
    };
  if (play.page === "no-shell") return { status: "not-measured", why: SCENE_OLD_SHELL };
  const report =
    play.page === null
      ? null
      : await keepSceneReport(play.page.raw, folder, `${relative.split(NodePath.sep).join("/")}/`);
  if (report === null)
    return { status: "not-measured", why: "the page's scene report could not be read" };
  return {
    status: "measured",
    lines: sceneLines(report).map((line) =>
      line.frame === null ? line.text : `${line.text} [frame: ${line.frame}]`,
    ),
    report,
    ms: play.ms,
    ...(browser.software
      ? {
          note: `Drawn in software (${browser.renderer ?? "SwiftShader"}): this machine's GPU was not found, so the play ran slowly; what the report measures is the scene's geometry, which is the same.`,
        }
      : {}),
  };
};

const decodeQa = Schema.decodeUnknownOption(GameQaReport);
const decodeReplay = Schema.decodeUnknownOption(GameReplayRun);
/** The QA play's report as the check's: what to fix, or why it was not played. */
const qaOf = (played: { readonly raw: unknown; readonly ms: number }): GameCheckQa => {
  if (played.raw === "no-qa")
    return {
      status: "not-measured",
      why: "the game's copy of the shell predates the QA play",
      cause: "old-shell",
    };
  if (played.raw === null)
    return { status: "not-measured", why: "the QA play did not finish in time" };
  const report = decodeQa(played.raw);
  if (Option.isNone(report))
    return { status: "not-measured", why: "the QA play's report did not read" };
  return {
    status: "measured",
    problems: [...gameQaProblems(gameQaFindings(report.value))],
    report: report.value,
    ms: played.ms,
  };
};

/** Play at each other screen size: long enough to draw at it and throw what the size makes it throw. */
const SCREEN_PLAY_MS = 1_000;
const decodeScreenRead = Schema.decodeUnknownOption(
  Schema.Struct({
    canvas: Schema.NullOr(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
    hud: Schema.NullOr(
      Schema.Struct({
        texts: Schema.optionalKey(Schema.Finite),
        off: Schema.Array(Schema.String),
      }),
    ),
  }),
);

/**
 * The gameplay page resized to phone portrait, then to widescreen, as a player's window would be,
 * each played a moment and read as a player there sees it: what it throws that the check's own
 * size did not (`known`), how much of the window its canvas covers and whether the HUD's DOM text
 * stays on it, with a frame. One page, not a fresh boot per size: in software a 3D game's start
 * costs seconds a page. A HUD drawn in the canvas is not in the DOM: not measured.
 */
const playScreens = async (
  session: WebPlaySession,
  input: {
    readonly root: string;
    readonly folder: string;
    readonly signal: AbortSignal;
    readonly known: ReadonlySet<string>;
    readonly listen: (listener: (event: WebPageEvent) => void) => void;
  },
): Promise<GameCheckScreens> => {
  const started = Date.now();
  const sizes: Array<GameScreenSize> = [];
  for (const size of GAME_SCREEN_SIZES) {
    const errors: Array<string> = [];
    const heard = (text: string) => {
      const line = text.slice(0, 200);
      if (!input.known.has(line) && !errors.includes(line) && errors.length < 3) errors.push(line);
    };
    input.listen((event) => {
      if (event.kind === "pageerror") heard(event.text);
      else if (event.kind === "script-failed")
        heard(`script failed to load: ${event.url} (${event.status})`);
      else if (event.level === "error" && !/favicon\.ico/i.test(event.text)) heard(event.text);
    });
    await session.resize(size.width, size.height);
    await playRandomly(session.input, SCREEN_PLAY_MS, input.signal);
    const read = Option.getOrNull(decodeScreenRead(await session.screen()));
    const frame = NodePath.join(input.folder, `screen-${size.name}.png`);
    const kept = await session.still(frame);
    if (read === null) heard("the page stopped answering at this size");
    const hud = read?.hud ?? null;
    sizes.push({
      name: size.name,
      width: size.width,
      height: size.height,
      booted: true,
      canvas:
        read?.canvas == null
          ? null
          : { width: Math.round(read.canvas.width), height: Math.round(read.canvas.height) },
      errors,
      hudOff: hud === null || hud.texts === 0 ? null : hud.off.slice(0, 8),
      frame: kept ? NodePath.relative(input.root, frame) : null,
    });
  }
  // The bytes the page loaded to start and play are read as it closes, after this.
  const report = { sizes, bytes: null };
  return {
    status: "measured",
    problems: gameScreensFindings(report).map((found) => `${found.said}: ${found.fix}`),
    report,
    ms: Date.now() - started,
  };
};

const response = (
  process: GameProcessResult,
  outputPath: string | null = null,
): GameActionResult => {
  const success = process.exitCode === 0 && !process.timedOut;
  return {
    success,
    message: success
      ? "Completed successfully."
      : `Command failed${process.timedOut ? " after its timeout" : ` with exit code ${process.exitCode}`}. See ${process.logPath}\n${commandDetail(process)}`,
    path: outputPath,
    url: null,
    process,
  };
};

/**
 * The three.js backend: the static folder is the game, so there is no
 * editor import and no compile. Check loads the page in headless Chromium
 * and reports console and page errors; export copies the static folder.
 */
export const makeThreeBackend = (
  gameBrowser: (operation: string, path: string) => Effect.Effect<GameBrowser, GameOperationError>,
  /** The server's runtimes folder (gameRuntime.ts). */
  runtimes: Effect.Effect<string, GameOperationError>,
): GameEngineBackend => {
  /** The runtimes folder for a game that loads one, refused when this server lacks its major. */
  const runtimeOf = (ctx: GameEngineContext, operation: string) => {
    const major = ctx.runtime;
    return major === null
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const folder = yield* runtimes;
          const shipped = yield* Effect.promise(() => hasRuntime(folder, "three", major));
          if (!shipped)
            return yield* new GameOperationError({
              operation,
              path: NodePath.join(ctx.root, "game.json"),
              reason: "tool-missing",
              detail: `This game loads Kurambit's three.js runtime ${major}, which this Kurambit does not ship. Update Kurambit to open it.`,
            });
          return folder;
        });
  };
  const runCheck: GameEngineBackend["runCheck"] = (ctx, input) =>
    Effect.gen(function* () {
      const temporary = NodePath.join(
        ctx.root,
        "builds/logs",
        `three-check-${NodeCrypto.randomUUID()}`,
      );
      const logPath = NodePath.join(temporary, "check.log");
      // The page's own errors go to the run's stderr, everything else to its stdout.
      const lines: Array<{ readonly text: string; readonly error: boolean }> = [];
      const log = (text: string, error = false): void => {
        lines.push({ text, error });
      };
      // A crashed page never reports ready: the crash is its issue, not a second one.
      let crashed = false;
      const issues: GameCheckIssue[] = [];
      const reached: string[] = [];
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(temporary, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({
            operation: "three-check",
            path: temporary,
            reason: "io",
            cause,
          }),
      });
      const runtimeFolder = yield* runtimeOf(ctx, "three-check");
      const browser = yield* gameBrowser("three-check", ctx.projectDir);
      const server = yield* Effect.tryPromise({
        try: () => serveGameDirectory(ctx.root, ctx.projectName, { runtimes: runtimeFolder }),
        catch: (cause) =>
          new GameOperationError({
            operation: "three-check",
            path: NodePath.join(ctx.root, ctx.projectName),
            reason: "io",
            detail: "The static project could not be served.",
            cause,
          }),
      });
      const origin = new URL(server.url).origin;
      // What the check's own plays threw: the other screen sizes report only what is new there.
      const thrown = new Set<string>();
      const onPageEvent = (event: WebPageEvent): void => {
        if (
          event.kind !== "script-failed" &&
          (event.kind === "pageerror" || event.level === "error")
        )
          thrown.add(event.text.slice(0, 200));
        if (event.kind === "script-failed") {
          log(`script failed to load: ${event.url} (${event.status})`);
          return;
        }
        if (event.kind === "pageerror") {
          const text = event.text.slice(0, 500);
          log(`pageerror: ${text}`, true);
          issues.push({
            file: stackToGameFile(event.stack, origin),
            message: `Page error: ${text}`,
          });
          return;
        }
        // The shell's animate line says which clip plays each state: the check shows it too.
        const shellLine = event.level === "info" && event.text.startsWith("animate: ");
        if (event.level !== "error" && event.level !== "warning" && !shellLine) return;
        const text = event.text.slice(0, 500);
        // The browser's own chrome, not the game: a missing favicon is not
        // a game failure (the starter links a data-URI icon so it never fires).
        if (/favicon\.ico/i.test(text)) return;
        log(`console ${event.level}: ${text}`, event.level === "error");
        if (event.level === "error")
          issues.push({
            file: stackToGameFile(event.url, origin),
            message: `Console error: ${text}`,
          });
      };
      // The page's events go to whichever play is on it now: the check's own, the first minute
      // (heard by nobody, as on a player's page), the QA play, then the other screen sizes.
      let listen = onPageEvent;
      // The page as the player opens it, then the gameplay entry the template
      // names (the starter's shell boots straight into play with "?play"), so a
      // failure in gameplay start cannot hide behind the title screen.
      // A quick look boots once: the page as the player opens it, then play started on that
      // same page (the bridge's "play"), so every look shows the agent its opening too. A game
      // that refuses "play" there gets the gameplay entry of its own.
      // A build's measure boots each entry once too: the first minute plays on the boot page
      // once it is checked, the QA play and the other screen sizes on the gameplay page once its
      // play is read. A 3D game's start costs seconds a page in software, so this is four boots
      // fewer; what each play reads is taken before the next begins.
      const gameplayUrl =
        input.gameplayScene === "" ? null : new URL(input.gameplayScene, server.url).href;
      const entries: Array<readonly [GameCheckView["entry"], string]> = [["boot", server.url]];
      if (gameplayUrl !== null && !input.look) entries.push(["gameplay", gameplayUrl]);
      // The entry whose page booting is the game booting.
      const bootEntry = entries[0]![0];
      // The gameplay entry's play, measured by the shell's scene report: what it left, and how long it took.
      let scenePlay: { readonly page: PageScene; readonly ms: number } | null = null;
      // What each entry looked like as the check left it: the agent judges its game from these.
      const views: Array<GameCheckView> = [];
      let playPerf: unknown = null;
      // The QA play's report, on the gameplay page after the measured play.
      let qaPlay: { readonly raw: unknown; readonly ms: number } | null = null;
      // The other screen sizes, played after the QA play.
      let screens: GameCheckScreens | undefined;
      // The first minute as a player meets it, on the boot page (playerProbe.ts).
      let player: GameCheckResult["player"];
      // The agent waits on this play: it goes first in the play lane and is never interrupted.
      const played = yield* playLane
        .hold(
          "agent",
          Effect.tryPromise({
            try: async (signal) => {
              let timedOut = false;
              for (const [entry, entryUrl] of entries) {
                const measure = input.scene && entry === "gameplay";
                listen = onPageEvent;
                const session = await openWebPlaySession({
                  browser,
                  url: entryUrl,
                  ...THREE_VIEWPORT,
                  bootTimeoutMs: BOOT_TIMEOUT_MS,
                  signal,
                  onPageEvent: (event) => listen(event),
                  stopOnPageError: true,
                  sceneReport: measure,
                  ...(input.qa
                    ? entry === "boot"
                      ? { initScript: PLAYER_PROBE }
                      : { qa: true, countBytes: true }
                    : {}),
                }).catch((cause: unknown) => {
                  // The game's page crashing is what the check measures; our browser
                  // going away is not, and fails the check below.
                  if (cause instanceof WebPageCrashed) {
                    log(`page crashed: ${cause.message}`);
                    crashed = true;
                    issues.push({
                      file: `${ctx.projectName}/${entry === "boot" ? "index.html" : input.gameplayScene.split("?")[0]}`,
                      message: `The page crashed while it ${entry === "boot" ? "booted" : "started gameplay"} (${cause.message.slice(0, 300)}).`,
                    });
                    return null;
                  }
                  if (!(cause instanceof WebPageNotReady)) throw cause;
                  if (cause.navigation !== null) log(`navigation failed: ${cause.navigation}`);
                  timedOut = cause.timedOut;
                  return null;
                });
                if (session !== null) {
                  let looking = input.look && entry === "gameplay";
                  // Closed even when a play is stopped part way: the session owns a browser.
                  try {
                    const started = Date.now();
                    // A short random-input play the scene report watches; without one (or with a
                    // shell that has none, where nothing would watch it), one extra beat. Either
                    // way late module errors still land in the listeners above.
                    if (measure && session.scene() !== "no-shell")
                      await playRandomly(session.input, SCENE_CHECK_PLAY_MS, signal);
                    else if (looking) await playRandomly(session.input, LOOK_PLAY_MS, signal);
                    else await new Promise((resolve) => setTimeout(resolve, 2000));
                    const view = NodePath.join(temporary, `view-${entry}.png`);
                    if (await session.still(view, true))
                      views.push({ entry, path: NodePath.relative(ctx.root, view) });
                    if (input.look && entry === "boot" && gameplayUrl !== null) {
                      const refusedBefore = session.refusedStates().length;
                      await session.setState("play", {});
                      if (session.refusedStates().length > refusedBefore)
                        entries.push(["gameplay", gameplayUrl]);
                      else {
                        await playRandomly(session.input, LOOK_PLAY_MS, signal);
                        const played = NodePath.join(temporary, "view-gameplay.png");
                        if (await session.still(played, true))
                          views.push({
                            entry: "gameplay",
                            path: NodePath.relative(ctx.root, played),
                          });
                        looking = true;
                      }
                    }
                    await session.settle();
                    if (measure) scenePlay = { page: session.scene(), ms: Date.now() - started };
                    if (measure || looking) playPerf = session.perf();
                    if (input.qa && entry === "boot") {
                      listen = () => undefined;
                      const probed = Date.now();
                      const report = await measurePlayer(session, temporary, browser.software);
                      player = {
                        status: "measured",
                        lines: gamePlayerLines(report),
                        report,
                        ms: Date.now() - probed,
                      };
                    }
                    // The QA play: every control, Retry and the HUD. It restarts the run, after
                    // the play above was read. Errors after Retry are its own finding, not an issue.
                    if (input.qa && entry === "gameplay") {
                      listen = (event) => {
                        if (event.kind !== "pageerror") return;
                        thrown.add(event.text.slice(0, 200));
                        log(`QA play pageerror: ${event.text.slice(0, 300)}`);
                      };
                      const qaStarted = Date.now();
                      qaPlay = { raw: await session.qa(), ms: Date.now() - qaStarted };
                      screens = await playScreens(session, {
                        root: ctx.root,
                        folder: temporary,
                        signal,
                        known: thrown,
                        listen: (listener) => {
                          listen = listener;
                        },
                      });
                    }
                  } finally {
                    await session.close();
                  }
                  if (screens?.status === "measured")
                    screens = {
                      ...screens,
                      report: { ...screens.report, bytes: session.loadedBytes() },
                    };
                  reached.push(entry);
                  // A look's play started on the boot page reached gameplay there.
                  if (looking && entry === "boot") reached.push("gameplay");
                } else if (input.qa && entry === bootEntry)
                  player = {
                    status: "not-measured",
                    why: "the page as a player opens it did not boot",
                  };
                else if (entry !== bootEntry && !crashed)
                  issues.push({
                    file: `${ctx.projectName}/${input.gameplayScene.split("?")[0]}`,
                    message: `The gameplay entry ${input.gameplayScene} never reported ready (window.__studio.ready stayed false).`,
                  });
                if (timedOut) break;
              }
              return { timedOut };
            },
            // A browser that would not start, or that went away, says nothing
            // about the build: the check could not be made.
            catch: (cause) =>
              cause instanceof WebBrowserLaunchFailed
                ? new GameOperationError({
                    operation: "three-check",
                    path: ctx.projectDir,
                    reason: "tool-missing",
                    detail: cause.message,
                    cause,
                  })
                : new GameOperationError({
                    operation: "three-check",
                    path: ctx.projectDir,
                    reason: "tool-failed",
                    detail: `${cause instanceof WebBrowserGone ? "Headless Chromium went away" : "Headless Chromium failed"} during the check: ${
                      cause instanceof Error
                        ? cause.message.slice(0, 500)
                        : String(cause).slice(0, 500)
                    }`,
                    cause,
                  }),
          }),
        )
        .pipe(Effect.ensuring(Effect.promise(() => server.close().catch(() => undefined))));
      const { timedOut } = played;
      const booted = reached.includes(bootEntry);
      if (!booted)
        issues.unshift({
          file: `${ctx.projectName}/index.html`,
          message: timedOut
            ? `The page never reported ready (window.__studio.ready stayed false past ${BOOT_TIMEOUT_MS / 1000}s).`
            : "The page did not boot: window.__studio had not appeared when the page errored. Fix the errors this check lists, and keep the studio bridge from the starter.",
        });
      const scene = input.scene
        ? yield* Effect.promise(() =>
            sceneOf(scenePlay, temporary, NodePath.relative(ctx.root, temporary), browser),
          )
        : undefined;
      const qa = qaPlay === null ? undefined : qaOf(qaPlay);
      // The log is for people; the verdict above does not depend on it.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(logPath, `${lines.map((line) => line.text).join("\n")}\n`).catch(
          () => undefined,
        ),
      );
      const run: GameProcessResult = {
        pid: 0,
        exitCode: issues.length === 0 && booted ? 0 : 1,
        signal: null,
        timedOut,
        stdout: lines
          .flatMap((line) => (line.error ? [] : [line.text]))
          .join("\n")
          .slice(-4000),
        stderr: lines
          .flatMap((line) => (line.error ? [line.text] : []))
          .join("\n")
          .slice(-4000),
        logPath,
      };
      return {
        reported: {
          entries: reached,
          errors: issues,
          warnings: [],
        },
        issues: [...issues],
        run,
        ...(scene === undefined ? {} : { scene }),
        views,
        ...((input.scene || input.look) && reached.includes("gameplay")
          ? { performance: checkPerformance(playPerf, browser) }
          : {}),
        ...(qa === undefined ? {} : { qa }),
        ...(screens === undefined ? {} : { screens }),
        ...(player === undefined ? {} : { player }),
      };
    });
  return {
    profile: THREE_PROFILE,
    resolveProject: (root, manifest) =>
      Effect.map(inGame(root, manifest.project), (projectDir) => ({
        binary: {
          path: NodePath.join(manifest.project, "vendor", "three.module.js"),
          version: THREE_PINNED_VERSION,
          templates: null,
        },
        projectName: manifest.project,
        projectDir,
      })),
    // three.js is vendored in the game or loads from Kurambit's runtime: nothing to install.
    toolStatus: () => Effect.succeed(null),
    viewport: () => Effect.succeed({ ...THREE_VIEWPORT }),
    projectSettingsFile: "index.html",
    // A static copy needs no export templates and no preset.
    exportReady: () => Effect.void,
    exportPreset: (_ctx, target) => Effect.succeed({ name: target, added: false }),
    importProject: (ctx) =>
      Effect.succeed({
        result: response(
          {
            pid: 0,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "No import step: the static folder is the game.",
            stderr: "",
            logPath: NodePath.join(ctx.root, "builds/logs"),
          },
          null,
        ),
        issues: [],
      }),
    runCheck,
    // The web release is a static copy of the project, with the runtime it loads beside it, which
    // the core then hashes, moves and selects.
    release: (ctx, input) =>
      Effect.gen(function* () {
        const runtimeFolder = yield* runtimeOf(ctx, input.operation);
        const look = yield* gameLookJson(ctx.root);
        yield* Effect.tryPromise({
          try: async (signal) => {
            await copyTree(ctx.projectDir, input.staging, signal);
            if (runtimeFolder !== null && ctx.runtime !== null) {
              await copyRuntimeInto(runtimeFolder, "three", ctx.runtime, input.staging, signal);
              // The release has no Kurambit to ask for the look, so it carries it as a file.
              await NodeFSP.writeFile(NodePath.join(input.staging, ...LOOK_ROUTE.split("/")), look);
            }
          },
          catch: (cause) =>
            new GameOperationError({
              operation: input.operation,
              path: input.staging,
              reason: "io",
              detail: "The static project could not be staged for export.",
              cause,
            }),
        });
        const run: GameProcessResult = {
          pid: 0,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: `Copied ${ctx.projectName}/${ctx.runtime === null ? "" : ` and Kurambit's three.js runtime ${ctx.runtime}`} to the web staging directory.`,
          stderr: "",
          logPath: NodePath.join(ctx.root, "builds/logs"),
        };
        return {
          result: response(run, NodePath.join(input.staging, "index.html")),
          artifact: "index.html",
          notes: [],
        };
      }),
    replay: (ctx, input) =>
      Effect.gen(function* () {
        const runtimeFolder = yield* runtimeOf(ctx, "three-replay");
        const browser = yield* gameBrowser("three-replay", ctx.projectDir);
        const failed = (detail: string, cause?: unknown) =>
          new GameOperationError({
            operation: "three-replay",
            path: ctx.projectDir,
            reason: "tool-failed",
            detail,
            cause,
          });
        // A person waits on it: it goes before builds being measured, never beside them.
        const raw = yield* playLane.hold(
          "person",
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => serveGameDirectory(ctx.root, ctx.projectName, { runtimes: runtimeFolder }),
              catch: (cause) => failed("The static project could not be served.", cause),
            }),
            (server) =>
              Effect.tryPromise({
                try: async (signal) => {
                  const session = await openWebPlaySession({
                    browser,
                    url: new URL(input.gameplayScene || "index.html", server.url).href,
                    // At the shape it was played at: its mouse aim lands where it did.
                    ...(input.play.viewport ?? THREE_VIEWPORT),
                    bootTimeoutMs: BOOT_TIMEOUT_MS,
                    signal,
                  });
                  try {
                    const answered = await session.replay(input.play, {
                      drawEvery: REPLAY_DRAW_EVERY,
                      ...(input.moment === undefined ? {} : { at: input.moment.at }),
                    });
                    // The page holds the moment's frame once it answers.
                    if (input.moment !== undefined && answered !== null && answered !== "no-replay")
                      await session.still(input.moment.image);
                    return answered;
                  } finally {
                    await session.close();
                  }
                },
                catch: (cause) =>
                  cause instanceof WebPageNotReady || cause instanceof WebPageCrashed
                    ? failed(`The game did not start, so the play could not run: ${cause.message}`)
                    : failed(
                        `Headless Chromium failed during the replay: ${cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500)}`,
                        cause,
                      ),
              }),
            (server) => Effect.promise(() => server.close().catch(() => undefined)),
          ),
        );
        if (raw === "no-replay") return "no-replay" as const;
        const run = decodeReplay(raw);
        if (Option.isNone(run)) return yield* failed("The game did not answer the replay in time.");
        return run.value;
      }),
    modelSheet: (ctx, input) =>
      Effect.gen(function* () {
        const runtimeFolder = yield* runtimeOf(ctx, "model-sheet");
        const browser = yield* gameBrowser("model-sheet", ctx.projectDir);
        const failed = (detail: string, cause?: unknown) =>
          new GameOperationError({
            operation: "model-sheet",
            path: ctx.projectDir,
            reason: "tool-failed",
            detail,
            cause,
          });
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(input.folder, { recursive: true }),
          catch: (cause) => failed("The sheet's folder could not be made.", cause),
        });
        // The agent waits on it, as on its check.
        return yield* playLane.hold(
          "agent",
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => serveGameDirectory(ctx.root, ctx.projectName, { runtimes: runtimeFolder }),
              catch: (cause) => failed("The static project could not be served.", cause),
            }),
            (server) =>
              Effect.tryPromise({
                try: async (signal) => {
                  const session = await openWebPlaySession({
                    browser,
                    url: new URL(input.gameplayScene || "index.html?play", server.url).href,
                    ...THREE_VIEWPORT,
                    bootTimeoutMs: BOOT_TIMEOUT_MS,
                    signal,
                  });
                  try {
                    // A beat of play, so what start() builds and the first clips are in place.
                    await new Promise((resolve) => setTimeout(resolve, SHEET_SETTLE_MS));
                    return await drawSheets(session, input, ctx.root);
                  } finally {
                    await session.close();
                  }
                },
                catch: (cause) =>
                  cause instanceof WebPageNotReady || cause instanceof WebPageCrashed
                    ? failed(`The game did not start, so nothing could be drawn: ${cause.message}`)
                    : failed(
                        `Headless Chromium failed during the sheet: ${cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500)}`,
                        cause,
                      ),
              }),
            (server) => Effect.promise(() => server.close().catch(() => undefined)),
          ),
        );
      }),
  };
};
