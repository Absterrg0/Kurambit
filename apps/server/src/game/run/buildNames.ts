// PURE. The names a production run keeps its builds under (refs below
// checkpointRefForGameRun). Git stores refs as files, so a name can never be
// both a build and a folder of builds: every top-level name here is one or the
// other, and a build's own name never has anything below it. Every part is
// reduced to characters a ref name may hold.

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
