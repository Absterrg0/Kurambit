// @effect-diagnostics globalDate:off globalTimers:off globalDateInEffect:off nodeBuiltinImport:off -- This backend owns the headless-Chromium boundary for the three.js lane: wall-clock boot polling, real sleeps and loopback serving.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
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
import {
  READ_STUDIO_READY,
  chromiumLaunchArgs,
  requireChromium,
  stackToGameFile,
} from "./gameChromium.ts";
import { chromiumChildEnv, serveGameDirectory } from "./gameWebServer.ts";
import type { GameEngineBackend } from "./GameEngine.ts";
import { THREE_PROFILE } from "./threeProfile.ts";

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

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
export const makeThreeBackend = (): GameEngineBackend => {
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
      let server: { url: string; close: () => Promise<void> } | null = null;
      let browser: { close: () => Promise<void> } | null = null;
      let booted = false;
      let timedOut = false;
      const reached: string[] = [];
      try {
        yield* Effect.promise(() => NodeFSP.mkdir(temporary, { recursive: true }));
        server = yield* Effect.promise(() => serveGameDirectory(ctx.root, ctx.projectName)).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "three-check",
                path: NodePath.join(ctx.root, ctx.projectName),
                reason: "io",
                detail: "The static project could not be served.",
                cause,
              }),
          ),
        );
        const served = server;
        const origin = new URL(served.url).origin;
        const executable = yield* requireChromium("three-check", ctx.projectDir);
        const { chromium } = loadPlaywright();
        const launched = yield* Effect.promise(() =>
          chromium.launch({
            executablePath: executable,
            headless: true,
            args: [...chromiumLaunchArgs()],
            env: chromiumChildEnv(),
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GameOperationError({
                operation: "three-check",
                path: ctx.projectDir,
                reason: "command-failed",
                detail: "Headless Chromium would not start.",
                cause,
              }),
          ),
        );
        browser = launched;
        // The page as the player opens it, then the gameplay entry the template
        // names (the starter's shell boots straight into play with "?play"), so a
        // failure in gameplay start cannot hide behind the title screen.
        const entries: Array<readonly [string, string]> = [["boot", served.url]];
        if (input.gameplayScene !== "")
          entries.push(["gameplay", new URL(input.gameplayScene, served.url).href]);
        for (const [entry, entryUrl] of entries) {
          let entryBooted = false;
          // A page error or a script that failed to load: either can stop the
          // modules for good, so the bridge never appears.
          let pageErrored = false;
          const page = yield* Effect.promise(() =>
            launched.newPage({ viewport: { ...THREE_VIEWPORT } }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new GameOperationError({
                  operation: "three-check",
                  path: ctx.projectDir,
                  reason: "command-failed",
                  detail: "Headless Chromium would not open a page.",
                  cause,
                }),
            ),
          );
          page.on("console", (message) => {
            const type = message.type();
            if (type !== "error" && type !== "warning") return;
            const text = message.text().slice(0, 500);
            // The browser's own chrome, not the game: a missing favicon is not
            // a game failure (the starter links a data-URI icon so it never fires).
            if (/favicon\.ico/i.test(text)) return;
            log(`console ${type}: ${text}`);
            if (type === "error")
              issues.push({
                file: stackToGameFile(message.location()?.url, origin),
                message: `Console error: ${text}`,
              });
          });
          page.on("pageerror", (error) => {
            const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
            const stack = error instanceof Error ? error.stack : undefined;
            log(`pageerror: ${text}`);
            pageErrored = true;
            issues.push({
              file: stackToGameFile(stack, origin),
              message: `Page error: ${text}`,
            });
          });
          page.on("response", (response) => {
            if (response.status() < 400 || response.request().resourceType() !== "script") return;
            log(`script failed to load: ${response.url()} (${response.status()})`);
            pageErrored = true;
          });
          const bootTimeoutMs = 60_000;
          const started = Date.now();
          yield* Effect.promise(() =>
            page
              .goto(entryUrl, { timeout: bootTimeoutMs, waitUntil: "load" })
              .catch((cause: unknown) => {
                log(`navigation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
              }),
          );
          for (;;) {
            if (Date.now() - started > bootTimeoutMs) {
              timedOut = true;
              break;
            }
            try {
              const ready = yield* Effect.promise(() => page.evaluate(READ_STUDIO_READY));
              if (ready === true) {
                entryBooted = true;
                if (entry === "boot") booted = true;
                break;
              }
              // Top-level await can delay the bridge past load, so only an error
              // and no bridge together end the wait early.
              if (pageErrored && ready === null) break;
            } catch {
              // Evaluations race the page navigation; keep polling until the deadline.
            }
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)));
          }
          // One extra beat so late module errors still land in the listeners above.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2000)));
          yield* Effect.promise(() => page.close().catch(() => undefined));
          if (entryBooted) reached.push(entry);
          else if (entry !== "boot")
            issues.push({
              file: `${ctx.projectName}/${input.gameplayScene.split("?")[0]}`,
              message: `The gameplay entry ${input.gameplayScene} never reported ready (window.__studio.ready stayed false).`,
            });
          if (timedOut) break;
        }
      } finally {
        if (browser !== null) yield* Effect.promise(() => browser!.close().catch(() => undefined));
        if (server !== null) yield* Effect.promise(() => server!.close().catch(() => undefined));
      }
      if (!booted)
        issues.unshift({
          file: "web/index.html",
          message: timedOut
            ? "The page never reported ready (window.__studio.ready stayed false past 60s)."
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
    editor: null,
    player: null,
  };
};
