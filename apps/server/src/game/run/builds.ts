// The run's builds are T3 checkpoints under the run's own refs
// (checkpointRefForGameRun): the run never commits, checks out, merges or
// writes the user's index, HEAD or branches. A build is its commit oid.
import { CheckpointRef } from "@kurambit/contracts";
import * as Effect from "effect/Effect";

import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import type * as GameService from "../GameService.ts";
import { restoredPaths } from "./buildNames.ts";
import type { BuildOutcome } from "./policy.ts";
import type { BuildOp } from "./state.ts";

type Checkpoints = CheckpointStore.CheckpointStore["Service"];

/** What a blind player must not see: files that differ by round, not by game. */
export const NOT_IN_SAMPLE = [".studio", "NOTES.md"];

/** Game code: the engine project, without what an engine import rewrites on its own. */
export const isGameCode = (lane: string) => (path: string) =>
  path.startsWith(`${lane}/`) &&
  !path.startsWith(`${lane}/.godot/`) &&
  !path.endsWith(".import") &&
  !path.endsWith(".uid");

/** What a restore covers. */
export const isRestored = (lane: string) => (path: string) =>
  restoredPaths(lane).some((root) => path === root || path.startsWith(`${root}/`));

const revision = (oid: string) => CheckpointRef.make(oid);

/**
 * How much of `within` changed between two builds. A diff that cannot be read
 * (a build gone, a diff too large) counts as a change, so nothing that may
 * have changed is ever taken as unchanged.
 */
export const measureChange = (
  checkpoints: Checkpoints,
  root: string,
  within: (path: string) => boolean,
  from: string,
  to: string,
): Effect.Effect<{ readonly changed: boolean; readonly lines: number }> =>
  from.length === 0 || to.length === 0
    ? Effect.succeed({ changed: true, lines: 0 })
    : checkpoints
        .diffCheckpoints({
          cwd: root,
          fromCheckpointRef: revision(from),
          toCheckpointRef: revision(to),
          ignoreWhitespace: false,
          format: "numstat",
          // A game in a subfolder of a bigger repository: its own paths only.
          relative: true,
        })
        .pipe(
          Effect.map((numstat) => {
            const files = parseTurnDiffFilesFromNumstat(numstat).filter((file) =>
              within(file.path),
            );
            return {
              changed: files.length > 0,
              lines: files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
            };
          }),
          Effect.orElseSucceed(() => ({ changed: true, lines: 0 })),
        );

/** The folder as the build `name`, under the workspace lock T3's own captures take. */
export const captureBuild = (checkpoints: Checkpoints, root: string, runId: string, name: string) =>
  checkpoints.withWorkspaceLock(
    root,
    checkpoints.captureCheckpoint({
      cwd: root,
      checkpointRef: checkpointRefForGameRun(runId, name),
    }),
  );

/**
 * One build op on the game folder. It always finishes: a stop waits for it
 * rather than leaving a half-restored folder. A restore first closes the
 * root's live editors, so a Unity scene held in memory is never saved over
 * the restored files.
 */
export const buildStep = (
  deps: { readonly game: GameService.GameService["Service"]; readonly checkpoints: Checkpoints },
  ctx: { readonly root: string; readonly runId: string; readonly lane: string },
  op: BuildOp,
) => {
  const { checkpoints } = deps;
  const { root, runId, lane } = ctx;
  const outcome = (patch: Partial<BuildOutcome>): { kind: "build"; build: BuildOutcome } => ({
    kind: "build",
    build: { ok: true, sha: "", changed: false, lines: 0, detail: "", ...patch },
  });
  // Points each name at the build; false when the build no longer exists.
  const keep = (names: ReadonlyArray<string>, sha: string) =>
    Effect.forEach(
      names,
      (name) =>
        checkpoints.updateCheckpointRef({
          cwd: root,
          checkpointRef: checkpointRefForGameRun(runId, name),
          oid: sha,
        }),
      { concurrency: 1 },
    ).pipe(Effect.map((done) => done.every(Boolean)));
  const run = Effect.gen(function* () {
    switch (op._tag) {
      case "capture": {
        const sha = yield* captureBuild(checkpoints, root, runId, op.name);
        const change =
          op.base.length === 0
            ? { changed: true, lines: 0 }
            : yield* measureChange(checkpoints, root, isGameCode(lane), op.base, sha);
        return outcome({ sha, ...change });
      }
      case "restore": {
        yield* deps.game.closeLiveEditors(root);
        const restored = yield* checkpoints.withWorkspaceLock(
          root,
          checkpoints.restoreCheckpoint({
            cwd: root,
            checkpointRef: revision(op.sha),
            filePaths: restoredPaths(lane),
          }),
        );
        if (!restored) return outcome({ ok: false, sha: op.sha, detail: "the build is gone" });
        if (op.keep.length > 0 && !(yield* keep(op.keep, op.sha)))
          return outcome({ ok: false, sha: op.sha, detail: "the build could not be kept" });
        return outcome({ sha: op.sha });
      }
      case "keep":
        return (yield* keep(op.names, op.sha))
          ? outcome({ sha: op.sha })
          : outcome({ ok: false, sha: op.sha, detail: "the build is gone" });
    }
  });
  return run.pipe(Effect.uninterruptible);
};
