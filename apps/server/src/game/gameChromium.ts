// @effect-diagnostics nodeBuiltinImport:off -- This module owns the headless-Chromium boundary for the three.js lane.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError, THREE_VIEWPORT } from "@t3tools/contracts";
import { findExecutable } from "./GameProcesses.ts";

export const GAME_STUDIO_CHROME_OVERRIDE = "GAME_STUDIO_CHROME";

/** Headless Chromium for the three.js lane: explicit override first, then the host install. */
export const findChromium = async (): Promise<string | null> => {
  const pathEnv = process.env.PATH ?? "";
  const override = process.env[GAME_STUDIO_CHROME_OVERRIDE];
  if (override !== undefined && override.trim() !== "") {
    const hit = await findExecutable(NodePath.basename(override.trim()), {
      pathEnv: NodePath.dirname(override.trim()) + NodePath.delimiter + pathEnv,
      override: override.trim(),
    });
    if (hit !== null) return hit;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const hit = await findExecutable(name, { pathEnv });
    if (hit !== null) return hit;
  }
  return null;
};

export const chromiumLaunchArgs = (): readonly string[] => [
  "--no-sandbox",
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
 * Reaches named late content through the game's own setState. The input is
 * one object because Playwright's evaluate takes a single argument. Returns
 * the game's boolean: a refusal is not an error.
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

export const requireChromium = (operation: string, path: string) =>
  Effect.gen(function* () {
    const executable = yield* Effect.promise(() => findChromium());
    if (executable === null)
      return yield* new GameOperationError({
        operation,
        path,
        reason: "tool-missing",
        detail:
          "Headless Chromium is needed to play this three.js game, and none was found. Install Google Chrome (or Chromium), or point GAME_STUDIO_CHROME at its executable.",
      });
    return executable;
  });

/** Scratch profile beside the run: Chromium stays out of the game's folder. */
export const chromiumProfileDir = async (runDir: string): Promise<string> => {
  const dir = NodePath.join(runDir, "chrome-profile");
  await NodeFSP.mkdir(dir, { recursive: true });
  return dir;
};

export const threeViewport = (): { width: number; height: number } => ({ ...THREE_VIEWPORT });

export const chromiumTmpEnv = (): NodeJS.ProcessEnv => ({
  TMPDIR: NodePath.join(NodeOS.homedir(), ".gs-tmp"),
});
