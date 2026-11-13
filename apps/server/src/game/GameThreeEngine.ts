// @effect-diagnostics globalDate:off globalTimers:off globalDateInEffect:off nodeBuiltinImport:off -- This backend owns the headless-Chromium boundary for the three.js lane: wall-clock boot polling, real sleeps and loopback serving.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  THREE_PINNED_VERSION,
  THREE_VIEWPORT,
  GameOperationError,
  type GameActionResult,
  type GameCheckIssue,
  type GameCheckScene,
  type GameCheckView,
  type GameProcessResult,
  sceneLines,
  manifestProject,
} from "@kurambit/contracts";
import { inGame } from "./gamePath.ts";
import { commandDetail } from "./commandDetail.ts";
import { stackToGameFile, type GameBrowser } from "./gameChromium.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import {
  openWebPlaySession,
  WebBrowserGone,
  WebBrowserLaunchFailed,
  WebPageCrashed,
  WebPageNotReady,
  type WebPageEvent,
} from "./webPlaySession.ts";
import type { GameEngineBackend, GameEngineContext } from "./GameEngine.ts";
import { copyRuntimeInto, hasRuntime } from "./gameRuntime.ts";
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

const BOOT_TIMEOUT_MS = 60_000;

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
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
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
      const onPageEvent = (event: WebPageEvent): void => {
        if (event.kind === "script-failed") {
          log(`script failed to load: ${event.url} (${event.status})`);
          return;
        }
        if (event.kind === "pageerror") {
          const text = event.text.slice(0, 500);
          log(`pageerror: ${text}`);
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
        log(`console ${event.level}: ${text}`);
        if (event.level === "error")
          issues.push({
            file: stackToGameFile(event.url, origin),
            message: `Console error: ${text}`,
          });
      };
      // The page as the player opens it, then the gameplay entry the template
      // names (the starter's shell boots straight into play with "?play"), so a
      // failure in gameplay start cannot hide behind the title screen.
      const entries: Array<readonly [GameCheckView["entry"], string]> = [["boot", server.url]];
      if (input.gameplayScene !== "")
        entries.push(["gameplay", new URL(input.gameplayScene, server.url).href]);
      // The gameplay entry's play, measured by the shell's scene report: what it left, and how long it took.
      let scenePlay: { readonly page: PageScene; readonly ms: number } | null = null;
      // What each entry looked like as the check left it: the agent judges its game from these.
      const views: Array<GameCheckView> = [];
      let playPerf: unknown = null;
      const played = yield* Effect.tryPromise({
        try: async (signal) => {
          let timedOut = false;
          for (const [entry, entryUrl] of entries) {
            const measure = input.scene && entry === "gameplay";
            const session = await openWebPlaySession({
              browser,
              url: entryUrl,
              ...THREE_VIEWPORT,
              bootTimeoutMs: BOOT_TIMEOUT_MS,
              signal,
              onPageEvent,
              stopOnPageError: true,
              sceneReport: measure,
            }).catch((cause: unknown) => {
              // The game's page crashing is what the check measures; our browser
              // going away is not, and fails the check below.
              if (cause instanceof WebPageCrashed) {
                log(`page crashed: ${cause.message}`);
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
              const started = Date.now();
              // A short random-input play the scene report watches; without one (or with a
              // shell that has none, where nothing would watch it), one extra beat. Either
              // way late module errors still land in the listeners above.
              if (measure && session.scene() !== "no-shell")
                await playRandomly(session.input, SCENE_CHECK_PLAY_MS, signal);
              else await new Promise((resolve) => setTimeout(resolve, 2000));
              const view = NodePath.join(temporary, `view-${entry}.png`);
              if (await session.still(view))
                views.push({ entry, path: NodePath.relative(ctx.root, view) });
              await session.close();
              if (measure) {
                scenePlay = { page: session.scene(), ms: Date.now() - started };
                playPerf = session.perf();
              }
              reached.push(entry);
            } else if (
              entry !== "boot" &&
              !issues.some((issue) => issue.message.startsWith("The page crashed"))
            )
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
                  cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500)
                }`,
                cause,
              }),
      }).pipe(Effect.ensuring(Effect.promise(() => server.close().catch(() => undefined))));
      const { timedOut } = played;
      const booted = reached.includes("boot");
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
      // The log is for people; the verdict above does not depend on it.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(logPath, `${lines.join("\n")}\n`).catch(() => undefined),
      );
      const run: GameProcessResult = {
        pid: 0,
        exitCode: issues.length === 0 && booted ? 0 : 1,
        signal: null,
        timedOut,
        stdout: lines
          .filter((line) => !line.startsWith("console error") && !line.startsWith("pageerror"))
          .join("\n")
          .slice(-4000),
        stderr: lines
          .filter((line) => line.startsWith("console error") || line.startsWith("pageerror"))
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
        ...(input.scene && reached.includes("gameplay")
          ? { performance: checkPerformance(playPerf, browser) }
          : {}),
      };
    });
  return {
    profile: THREE_PROFILE,
    resolveProject: (root, manifest) =>
      Effect.map(inGame(root, manifestProject(manifest)), (projectDir) => ({
        binary: {
          path: NodePath.join(manifestProject(manifest), "vendor", "three.module.js"),
          version: THREE_PINNED_VERSION,
          templates: null,
        },
        projectName: manifestProject(manifest),
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
        yield* Effect.tryPromise({
          try: async (signal) => {
            await copyTree(ctx.projectDir, input.staging, signal);
            if (runtimeFolder !== null && ctx.runtime !== null)
              await copyRuntimeInto(runtimeFolder, "three", ctx.runtime, input.staging, signal);
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
    // The browser host opens the page itself: there is no runner process.
    playProcess: null,
    editor: null,
    player: null,
  };
};
