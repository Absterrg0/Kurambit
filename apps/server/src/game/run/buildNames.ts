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
  /**
   * A left round's work, by the step that kept it: a left round is never
   * recorded, so the next round reuses its label and must not take its name.
   */
  unfinished: (label: string, step: number) => `${part(label)}/unfinished-${step}`,
  /** One role turn's work, for its change against the build before it. */
  turn: (stepId: string, attempt: number) => `turns/${part(stepId)}-${attempt}`,
  /** The work an ending found in the folder, kept once per ending. */
  ending: (endedAt: string) => `endings/${part(endedAt)}`,
  /** The folder before and after a creator's restore. */
  restoreBefore: (requestId: string) => `restores/${part(requestId)}-before`,
  restoreAfter: (requestId: string) => `restores/${part(requestId)}-after`,
  /** The folder as a resume found it, kept by the run's next move of the folder; one per resume. */
  resumeBefore: (resumedAt: string) => `resumes/${part(resumedAt)}-before`,
} as const;

/**
 * A build an ended run keeps that a creator may restore by its name, beside
 * its kept rounds: the work an ending found, a left round's unfinished work,
 * the folder before a restore or a resume, and a round's candidate. Any other name (the
 * best, the base, a turn's, a kept round's) is none.
 */
export type SavedBuild =
  | { readonly kind: "ending" }
  | { readonly kind: "restore-before" }
  | { readonly kind: "resume-before" }
  | { readonly kind: "unfinished"; readonly round: number }
  | { readonly kind: "candidate"; readonly round: number };

export const savedBuildOf = (name: string): SavedBuild | null => {
  if (/^endings\/[0-9A-Za-z_-]+$/.test(name)) return { kind: "ending" };
  if (/^restores\/[0-9A-Za-z_-]+-before$/.test(name)) return { kind: "restore-before" };
  if (/^resumes\/[0-9A-Za-z_-]+-before$/.test(name)) return { kind: "resume-before" };
  const round = /^round-([1-9][0-9]*)\/(candidate|unfinished-[0-9]+)$/.exec(name);
  if (round === null) return null;
  const n = Number(round[1]);
  return round[2] === "candidate"
    ? { kind: "candidate", round: n }
    : { kind: "unfinished", round: n };
};

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

/**
 * A kept build as the run's log lines name it: the Run tab's saved builds bring it
 * back, and the git command is the fallback when the app cannot.
 */
export const keptBuild = (runId: string, name: string, lane: string, sha: string) =>
  `build ${name}${sha.length > 0 ? ` (${sha.slice(0, 8)})` : ""}; restore it from the Run tab's saved builds once the run is stopped, or run in the game folder: ${wayBack(runId, name, lane)}`;
