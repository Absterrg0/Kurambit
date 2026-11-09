// PURE. The names a restore keeps its builds under (refs below
// checkpointRefForGameRun). Git stores refs as files, so a name can never be
// both a build and a folder of builds: every top-level name here is one or the
// other, and a build's own name never has anything below it. Every part is
// reduced to characters a ref name may hold.

/** A ref name component from anything (a request id). */
const part = (text: string) => text.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";

export const BuildName = {
  /** The folder before and after a restore. */
  restoreBefore: (requestId: string) => `restores/${part(requestId)}-before`,
  restoreAfter: (requestId: string) => `restores/${part(requestId)}-after`,
  /** The folder once a keep-going run's setup wrote its play bot, and the build it was written on. */
  botSetup: (runId: string) => `bots/${part(runId)}`,
  botSetupFrom: (runId: string) => `bots/${part(runId)}-from`,
} as const;

/** The play bot: the measuring instrument the skilled fact plays with. */
export const BOT_DIR = ".studio/bot";

/**
 * What a restore brings back, and so what a build is: the engine project and
 * the art sources with their map, so built assets and the .blend files they
 * came from stay together, and the play bot, so an undo is exactly as before
 * and a build's skilled fact is measured with the bot it was made with. Notes,
 * plans and the rest of `.studio` stay as they are, and ignored engine caches
 * (`.godot`, `Library`) are never touched.
 */
export const restoredPaths = (lane: string) => [lane, "art", "ASSETS.md", "STYLE.json", BOT_DIR];

/**
 * Inside `restoredPaths` but never restored: the bot kits Kurambit writes from
 * its own templates. A new run refreshes the game's kit, which must not read
 * as the folder edited, and the harness's kit exists only in measuring copies.
 */
export const unrestoredPaths = [`${BOT_DIR}/kit`, `${BOT_DIR}/harness-kit`];
