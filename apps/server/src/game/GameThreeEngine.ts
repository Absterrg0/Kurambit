// @effect-diagnostics globalDate:off globalTimers:off globalDateInEffect:off nodeBuiltinImport:off -- This backend owns the headless-Chromium boundary for the three.js lane: wall-clock boot polling, real sleeps and loopback serving.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  THREE_PINNED_VERSION,
  THREE_PROJECT_DIRECTORY,
  THREE_VIEWPORT,
  GameOperationError,
  type GameActionResult,
  type GameCheckIssue,
  type GameProcessResult,
} from "@kurambit/contracts";
import { insideGame } from "./GameProjectService.ts";
import { commandDetail } from "./commandDetail.ts";
import { stackToGameFile, type GameBrowser } from "./gameChromium.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import {
  openWebPlaySession,
  WebBrowserLaunchFailed,
  WebPageNotReady,
  type WebPageEvent,
} from "./webPlaySession.ts";
import type { GameEngineBackend } from "./GameEngine.ts";
import { THREE_PROFILE } from "./threeProfile.ts";

const BOOT_TIMEOUT_MS = 60_000;

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
): GameEngineBackend => {
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
      yield* Effect.promise(() => NodeFSP.mkdir(temporary, { recursive: true }));
      const browser = yield* gameBrowser("three-check", ctx.projectDir);
      const server = yield* Effect.tryPromise({
        try: () => serveGameDirectory(ctx.root, ctx.projectName),
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
        if (event.level !== "error" && event.level !== "warning") return;
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
      const entries: Array<readonly [string, string]> = [["boot", server.url]];
      if (input.gameplayScene !== "")
        entries.push(["gameplay", new URL(input.gameplayScene, server.url).href]);
      const played = yield* Effect.tryPromise({
        try: async (signal) => {
          let timedOut = false;
          for (const [entry, entryUrl] of entries) {
            const session = await openWebPlaySession({
              browser,
              url: entryUrl,
              ...THREE_VIEWPORT,
              bootTimeoutMs: BOOT_TIMEOUT_MS,
              signal,
              onPageEvent,
            }).catch((cause: unknown) => {
              if (!(cause instanceof WebPageNotReady)) throw cause;
              if (cause.navigation !== null) log(`navigation failed: ${cause.navigation}`);
              timedOut = cause.timedOut;
              return null;
            });
            if (session !== null) {
              // One extra beat so late module errors still land in the listeners above.
              await new Promise((resolve) => setTimeout(resolve, 2000));
              await session.close();
              reached.push(entry);
            } else if (entry !== "boot")
              issues.push({
                file: `${ctx.projectName}/${input.gameplayScene.split("?")[0]}`,
                message: `The gameplay entry ${input.gameplayScene} never reported ready (window.__studio.ready stayed false).`,
              });
            if (timedOut) break;
          }
          return { timedOut };
        },
        // A browser that would not start says nothing about the build.
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
                reason: "command-failed",
                detail: `Headless Chromium failed during the check: ${
                  cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500)
                }`,
                cause,
              }),
      }).pipe(Effect.ensuring(Effect.promise(() => server.close().catch(() => undefined))));
      const { timedOut } = played;
      const booted = reached.includes("boot");
      if (!booted)
        issues.unshift({
          file: "web/index.html",
          message: timedOut
            ? `The page never reported ready (window.__studio.ready stayed false past ${BOOT_TIMEOUT_MS / 1000}s).`
            : "The page did not boot: window.__studio had not appeared when the page errored. Fix the errors this check lists, and keep the studio bridge from the starter.",
        });
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
      };
    });
  return {
    profile: THREE_PROFILE,
    resolveProject: (root, manifest) =>
      Effect.gen(function* () {
        if (manifest.engine.name !== "three")
          return yield* new GameOperationError({
            operation: "resolve-engine",
            path: root,
            reason: "invalid-input",
            detail: "The three.js backend was asked to resolve a non-three.js game.",
          });
        return {
          binary: {
            path: NodePath.join(manifest.godotProject, "vendor", "three.module.js"),
            version: THREE_PINNED_VERSION,
            templates: null,
          },
          projectName: manifest.godotProject,
          projectDir: insideGame(root, manifest.godotProject),
        };
      }),
    projectSettingsFile: "index.html",
    projectDirectory: (manifest) => manifest.godotProject,
    projectSettings: () => ({ viewport: { ...THREE_VIEWPORT } }),
    // A static copy needs no export templates and no preset.
    exportReady: () => Effect.void,
    exportPreset: (_ctx, target) => Effect.succeed({ name: target, added: false }),
    parseDiagnostics: (output: string) => {
      const found: GameCheckIssue[] = [];
      for (const line of output.split("\n")) {
        const match = /^(pageerror|console error):\s*(.+)$/i.exec(line.trim());
        if (match?.[2] !== undefined)
          found.push({ file: THREE_PROJECT_DIRECTORY, message: match[2].slice(0, 500) });
      }
      return found.slice(0, 100);
    },
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
    runExportRelease: (ctx, input) =>
      Effect.gen(function* () {
        // The web sparkling: a static copy of the project into the staging
        // dir whose index.html the core then hashes, moves and selects.
        const stagingDir = NodePath.dirname(input.outputPath);
        yield* Effect.promise(() =>
          NodeFSP.cp(ctx.projectDir, stagingDir, { recursive: true }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: input.operation,
                path: stagingDir,
                reason: "io",
                detail: "The static project could not be staged for export.",
                cause,
              }),
          ),
        );
        const run: GameProcessResult = {
          pid: 0,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: `Copied ${ctx.projectName}/ to the web staging directory.`,
          stderr: "",
          logPath: NodePath.join(ctx.root, "builds/logs"),
        };
        return response(run, input.outputPath);
      }),
    // The browser host opens the page itself: there is no runner process.
    playProcess: null,
    editor: null,
    player: null,
  };
};
