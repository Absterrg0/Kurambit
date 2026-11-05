// The run's builds are T3 checkpoints under the run's own refs
// (checkpointRefForGameRun): the run never commits, checks out, merges or
// writes the user's index, HEAD or branches. A build is its commit oid.
import { CheckpointRef } from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";

import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { checkpointRefForGameRun, gameRunRefsFolder } from "../../checkpointing/Utils.ts";
import type * as GameOperations from "../GameOperations.ts";
import type * as GameService from "../GameService.ts";
import { restoredPaths } from "./buildNames.ts";
import { type BuildOutcome, classifyComparePair } from "./policy.ts";
import type { BuildOp, RunState } from "./state.ts";

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

/**
 * A finished run's transient builds go: every turn's, and the candidate of
 * each round recorded as kept (its kept build holds it), abandoned by a
 * restore (the restore's before build holds its work) or beaten in both
 * orders. Every other build stays: the run log tells a person it keeps a
 * round's candidate (unjudged, inconclusive, failed checks, a failed merge,
 * a budget leave, a round never recorded), its unfinished work and the work
 * each ending found, and gives the command that brings it back. A build the
 * run still holds (its best, a pending candidate, the round or block a resume
 * continues) stays whatever its name. Round records are history (each names
 * its candidate), so only the rest of the state counts as held.
 */
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Every build the state names, wherever it names one: records hold builds by oid.
const oidsIn = (value: unknown, into: Set<string>): void => {
  if (typeof value === "string") {
    if (OID.test(value)) into.add(value);
  } else if (Array.isArray(value)) for (const each of value) oidsIn(each, into);
  else if (typeof value === "object" && value !== null)
    for (const each of Object.values(value)) oidsIn(each, into);
};

export const pruneBuilds = (checkpoints: Checkpoints, root: string, state: RunState) =>
  Effect.gen(function* () {
    const folder = gameRunRefsFolder(state.runId);
    const entries = yield* checkpoints.listCheckpointRefs({ cwd: root, prefix: folder });
    const held = new Set<string>();
    oidsIn({ ...state, rounds: [] }, held);
    // The latest record of each round label decides its candidate.
    const recorded = new Map(state.rounds.map((r) => [r.branch, r]));
    const spent = (label: string) => {
      const r = recorded.get(label);
      if (r === undefined) return false;
      const [o1, o2] = r.verdicts;
      return (
        r.kept ||
        r.abandoned === true ||
        (r.unjudged !== true &&
          r.inconclusive !== true &&
          classifyComparePair(o1?.verdict ?? "NONE", o2?.verdict ?? "NONE") === "best-wins")
      );
    };
    const transient = entries
      .map((entry) => ({ ...entry, name: entry.checkpointRef.slice(folder.length) }))
      .filter(
        ({ name, oid }) =>
          !held.has(oid) &&
          (name.startsWith("turns/") ||
            (name.endsWith("/candidate") && spent(name.slice(0, -"/candidate".length)))),
      );
    if (transient.length > 0)
      yield* checkpoints.deleteCheckpointRefs({
        cwd: root,
        checkpointRefs: transient.map((entry) => entry.checkpointRef),
      });
    return transient.length;
  });

/**
 * How the run takes the game folder for one of its own moves (a capture, a
 * restore, a kept name): as one operation of the game, owned by the run, so
 * no export, check or Play of another owner reads a half-moved folder. With
 * `waitUntil` (epoch ms) a move queues behind another owner's operation until
 * then; without it a busy game fails `busy`, which a step hands back to its
 * durable timer.
 *
 * Lock order: the game's operation lock, then the checkpoint workspace lock
 * inside it. T3's per-turn captures take only the workspace lock, and nothing
 * that holds the workspace lock asks for the operation lock, so the two never
 * wait on each other.
 */
export interface FolderLock {
  readonly operations: GameOperations.GameOperations["Service"];
  readonly owner: string;
  readonly waitUntil: number | null;
}

// The end of a run, a restore and a turn's capture wait out a creator's Play
// or an operation begun before the run, all of their moves within this one
// bound; past it they fail as they found the game.
const FREE_WAIT_MS = 10 * 60_000;
/** The one deadline every wait of a finish, restore or landing shares. */
export const freeBy = Effect.map(Clock.currentTimeMillis, (now) => now + FREE_WAIT_MS);

const asRunOperation = <A, E extends { readonly message: string }>(
  lock: FolderLock,
  root: string,
  name: string,
  work: Effect.Effect<A, E>,
) =>
  lock.operations.exclusive(
    root,
    name,
    work,
    lock.owner,
    lock.waitUntil === null ? undefined : { waitUntil: lock.waitUntil },
  );

const capture = (checkpoints: Checkpoints, root: string, runId: string, name: string) =>
  checkpoints.withWorkspaceLock(
    root,
    checkpoints.captureCheckpoint({
      cwd: root,
      checkpointRef: checkpointRefForGameRun(runId, name),
    }),
  );

/** The folder as the build `name`. */
export const captureBuild = (
  deps: { readonly checkpoints: Checkpoints; readonly lock: FolderLock },
  root: string,
  runId: string,
  name: string,
) => asRunOperation(deps.lock, root, "Run capture", capture(deps.checkpoints, root, runId, name));

/**
 * One build op on the game folder. It always finishes: a stop waits for it
 * rather than leaving a half-restored folder. A restore first closes the
 * root's live editors, so a Unity scene held in memory is never saved over
 * the restored files.
 */
export const buildStep = (
  deps: {
    readonly game: GameService.GameService["Service"];
    readonly checkpoints: Checkpoints;
    readonly lock: FolderLock;
  },
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
        const sha = yield* capture(checkpoints, root, runId, op.name);
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
  return asRunOperation(deps.lock, root, `Run build ${op._tag}`, run.pipe(Effect.uninterruptible));
};
