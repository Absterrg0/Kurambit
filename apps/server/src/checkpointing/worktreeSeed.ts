// @effect-diagnostics nodeBuiltinImport:off -- A thread id goes into a ref name as base64url.
// A worktree seated on its source's working tree (the `worktreeSeed` project setting) starts
// from a capture of that checkout, uncommitted work included, never only from `HEAD`. The capture
// is kept as the thread's seed ref: what its files were seated on, which a game's copy merges
// back against (and which only that copy's Update moves).
import { CheckpointRef, type ThreadId } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import type * as CheckpointStore from "./CheckpointStore.ts";

const SEEDS = "refs/kurambit/worktree-seeds/";

export const worktreeSeedRef = (threadId: ThreadId) =>
  CheckpointRef.make(`${SEEDS}${Buffer.from(threadId, "utf8").toString("base64url")}`);

/** Captures `source` as `threadId`'s seed and answers the commit its worktree is created at. */
export const seedWorktree = (
  checkpoints: CheckpointStore.CheckpointStore["Service"],
  source: string,
  threadId: ThreadId,
) =>
  checkpoints.withWorkspaceLock(
    source,
    checkpoints.captureCheckpoint({ cwd: source, checkpointRef: worktreeSeedRef(threadId) }),
  );

/** The commit a thread's worktree was seated on, or null when it was not seated on a capture. */
export const worktreeSeedOf = (
  checkpoints: CheckpointStore.CheckpointStore["Service"],
  cwd: string,
  threadId: ThreadId,
) =>
  checkpoints
    .listCheckpointRefs({ cwd, prefix: worktreeSeedRef(threadId) })
    .pipe(
      Effect.map(
        (refs) =>
          refs.find((each) => each.checkpointRef === worktreeSeedRef(threadId))?.oid ?? null,
      ),
    );
