// PURE. The names a production run keeps its builds under (refs below
// checkpointRefForGameRun). Git stores refs as files, so a name can never be
// both a build and a folder of builds: every top-level name here is one or the
// other, and a build's own name never has anything below it. Every part is
// reduced to characters a ref name may hold.
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";

/** A ref name component from anything (an ISO time, a step id). */
const part = (text: string) => text.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";

export const BuildName = {
  /** The folder as the run found it. */
  base: "base",
  best: "best",
  stage: (stage: string) => `stage-${part(stage)}`,
  proto: (i: number) => `proto-${i}`,
  /** A round's builds sit in the round's own folder (`round-3/…`), which is never a build. */
  candidate: (label: string) => `${part(label)}/candidate`,
  kept: (label: string) => `${part(label)}/kept`,
  unfinished: (label: string) => `${part(label)}/unfinished`,
  /** One role turn's work, for its change against the build before it. */
  turn: (stepId: string, attempt: number) => `turns/${part(stepId)}-${attempt}`,
  /** The work an ending found in the folder, kept once per ending. */
  ending: (endedAt: string) => `endings/${part(endedAt)}`,
  /** The folder before and after a creator's restore. */
  restoreBefore: (requestId: string) => `restores/${part(requestId)}-before`,
  restoreAfter: (requestId: string) => `restores/${part(requestId)}-after`,
} as const;

/**
 * What a restore brings back: the engine project and the art sources with
 * their map, so built assets and the .blend files they came from stay
 * together. Notes, plans, bots and `.studio` stay as they are, and ignored
 * engine caches (`.godot`, `Library`) are never touched.
 */
export const restoredPaths = (lane: string) => [lane, "art", "ASSETS.md"];

/**
 * How a person puts a kept build's engine project and art back, run in the
 * game folder. It names only the paths the build holds, since git refuses a
 * restore naming any it lacks.
 */
export const wayBack = (runId: string, name: string, lane: string) => {
  const ref = checkpointRefForGameRun(runId, name);
  return `git restore --source ${ref} -- $(git ls-tree --name-only ${ref} -- ${restoredPaths(lane).join(" ")})`;
};

/** A kept build as a person can find it: its name, its commit and the way back. */
export const keptBuild = (runId: string, name: string, lane: string, sha: string) =>
  `build ${name}${sha.length > 0 ? ` (${sha.slice(0, 8)})` : ""}; to bring it back, run in the game folder: ${wayBack(runId, name, lane)}`;
