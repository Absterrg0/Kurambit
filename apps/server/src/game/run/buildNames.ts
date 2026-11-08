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
} as const;

/**
 * What a restore brings back: the engine project and the art sources with
 * their map, so built assets and the .blend files they came from stay
 * together. Notes, plans, bots and `.studio` stay as they are, and ignored
 * engine caches (`.godot`, `Library`) are never touched.
 */
export const restoredPaths = (lane: string) => [lane, "art", "ASSETS.md", "STYLE.json"];
