import * as HostProcess from "@kurambit/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { GameOperationError } from "@kurambit/contracts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

export interface GameBrowser {
  readonly executable: string;
  /** Chrome's sandbox, on unless the operator turned it off (KURAMBIT_SERVER_BROWSER_SANDBOX=0). */
  readonly sandbox: boolean;
  /** What on this host kept the browser from starting, when that is known. */
  readonly diagnose: (cause: unknown) => Promise<Error | undefined>;
}

/**
 * Kurambit's own headless browser for game pages: T3's pinned, verified
 * headless shell (PreviewBrowser), installed on first use, so a three.js game
 * needs nothing installed on the machine. Built once per service; the result
 * asks for it per launch.
 */
export const makeGameBrowser = Effect.gen(function* () {
  const preview = yield* PreviewBrowser.PreviewBrowser;
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);
  const sandbox = !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment);
  return (operation: string, path: string): Effect.Effect<GameBrowser, GameOperationError> =>
    preview.executable.pipe(
      Effect.mapError(
        (error) =>
          new GameOperationError({
            operation,
            path,
            reason:
              error._tag === "PreviewBrowserInstallingError"
                ? "busy"
                : error._tag === "PreviewBrowserUnsupportedError"
                  ? "unsupported-platform"
                  : "download",
            detail: error.message,
            cause: error,
          }),
      ),
      Effect.map((executable) => ({
        executable,
        sandbox,
        // Playwright's launch error drops Chrome's own output; its sandbox note survives.
        diagnose: (cause) =>
          Effect.runPromiseWith(services)(
            PreviewBrowserHost.diagnoseLaunchFailure({
              executable,
              setupCommand,
              output: /sandboxing failed/i.test(String(cause))
                ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
                : "",
            }),
          ).catch(() => undefined),
      })),
    );
});

export const chromiumLaunchArgs = (): readonly string[] => [
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--hide-scrollbars",
  "--disable-dev-shm-usage",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

/**
 * The `window.__studio` probe every three.js game ships. Reads the ready
 * flag: true once the first frame rendered. Null when the bridge is missing.
 */
export const READ_STUDIO_READY = `(() => {
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return null;
  return studio.ready === true;
})()`;

/** Reads `window.__studio.getState()`; null when the bridge is missing or throws. */
export const READ_STUDIO_STATE = `(() => {
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return null;
  if (typeof studio.getState !== "function") return null;
  try {
    return JSON.stringify(studio.getState());
  } catch {
    return null;
  }
})()`;

/**
 * Reaches named late content through the game's own setState. Function text,
 * not a call: the caller applies it to one JSON input. Returns the game's
 * boolean: a refusal is not an error.
 */
export const STUDIO_SET_STATE = `(input) => {
  const target = input?.target;
  const values = input?.values ?? {};
  const studio = window.__studio;
  if (studio === null || typeof studio !== "object") return false;
  if (typeof studio.setState !== "function") return false;
  try {
    return studio.setState(target, values) === true;
  } catch {
    return false;
  }
}`;

/** The route vocabulary uses "Space"; Playwright and DOM key values want " ". */
export const toPlaywrightKey = (key: string): string => (key === "Space" ? " " : key);

/** Maps a page error's stack URL back to the game file it came from. */
export const stackToGameFile = (stack: string | undefined, origin: string): string => {
  if (stack === undefined || stack === "") return "web/main.js";
  const match = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^:),\\s]+)`).exec(
    stack,
  );
  return match?.[1] === undefined ? "web/main.js" : `web/${match[1]}`;
};
