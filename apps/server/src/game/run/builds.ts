// The run's builds are T3 checkpoints under the run's own refs
// (checkpointRefForGameRun): the run never commits, checks out, merges or
// writes the user's index, HEAD or branches. A build is its commit oid.
import { CheckpointRef } from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import type * as GameOperations from "../GameOperations.ts";
import type * as GameStage from "../GameStage.ts";
import { causeText } from "../runSetup.ts";
import { restoredPaths, unrestoredPaths } from "./buildNames.ts";

type Checkpoints = CheckpointStore.CheckpointStore["Service"];

/** A move of the game folder: a capture under a name, a build brought back, or names kept. */
type BuildOp =
  | { readonly _tag: "capture"; readonly name: string; readonly base: string }
  | { readonly _tag: "restore"; readonly sha: string; readonly keep: ReadonlyArray<string> }
  | { readonly _tag: "keep"; readonly names: ReadonlyArray<string>; readonly sha: string };

interface BuildOutcome {
  readonly ok: boolean;
  /** The build's commit oid. */
  readonly sha: string;
  readonly changed: boolean;
  readonly lines: number;
  readonly detail: string;
}

/** What a blind player must not see: files that differ by round, not by game. */
export const NOT_IN_SAMPLE = [".studio", "NOTES.md"];

/** Game code: the engine project, without what an engine import rewrites on its own. */
const isGameCode = (lane: string) => (path: string) =>
  path.startsWith(`${lane}/`) &&
  !path.startsWith(`${lane}/.godot/`) &&
  !path.endsWith(".import") &&
  !path.endsWith(".uid");

const under = (roots: ReadonlyArray<string>, path: string) =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

/** What a restore covers: the one rule for what it writes, what a build is and what "edited" means. */
export const isRestored = (lane: string) => (path: string) =>
  under(restoredPaths(lane), path) && !under(unrestoredPaths, path);

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
    readonly stage: Pick<GameStage.GameStage["Service"], "closeLiveEditors">;
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
        yield* deps.stage.closeLiveEditors(root);
        const restored = yield* checkpoints.withWorkspaceLock(
          root,
          checkpoints.restoreCheckpoint({
            cwd: root,
            checkpointRef: revision(op.sha),
            filePaths: restoredPaths(lane),
            excludePaths: unrestoredPaths,
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

/**
 * How a build's stay in the folder ended: `why` it did not come in or its
 * work broke there, if so. `parked` is the folder's work as kept now ("" when
 * an earlier try kept it). `back` is null when the folder holds what the
 * outcome says, else why putting the work back failed: it is still parked.
 */
export type InFolder<A> = { readonly parked: string; readonly back: string | null } & (
  | { readonly kind: "current" | "done"; readonly value: A }
  | {
      readonly kind: "refused";
      readonly why: "gone" | "incomplete" | "broke" | "moved-on";
      readonly detail: string;
    }
);

// A failure is an answer; an interrupt is left to the repeat.
const caught =
  <A>(onFailure: (detail: string) => A) =>
  <B, E, R>(self: Effect.Effect<B, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchCause(self, (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(onFailure(causeText(cause))),
    );

/**
 * The build `move.sha` in the game folder for `work` (a finish's exports, a
 * creator's restore), with the folder's own work kept first as `move.park`,
 * once: a repeat after a restart finds the name and never keeps the build or a
 * half-restored folder as the work. "Already in the folder" is measured from
 * the park, so a repeat answers as the first try did. A refusal or failure on
 * the way, or a work that asks, puts the work back; `keep` names follow the
 * build in, `back` names follow the work back, and `check` names the capture
 * each move is verified by. With `expect`, a folder whose work is not that
 * build (a turn or an edit since) is refused "moved-on" and nothing moves;
 * the park is what is compared, so a repeat answers as the first try did. An
 * interrupt leaves the rest to the repeat: every move is whole (buildStep).
 */
export const withBuildInFolder = <A, E>(
  deps: Parameters<typeof buildStep>[0],
  ctx: Parameters<typeof buildStep>[1],
  move: {
    readonly sha: string;
    readonly park: string;
    readonly keep?: ReadonlyArray<string>;
    readonly back?: { readonly names: ReadonlyArray<string>; readonly sha: string };
    readonly check?: string;
    readonly expect?: string;
  },
  work: (current: boolean) => Effect.Effect<{ readonly value: A; readonly putBack: boolean }, E>,
) =>
  Effect.gen(function* () {
    const { checkpoints } = deps;
    const { root, runId, lane } = ctx;
    const parkRef = checkpointRefForGameRun(runId, move.park);
    const parked = (yield* checkpoints.hasCheckpointRef({ cwd: root, checkpointRef: parkRef }))
      ? ""
      : yield* captureBuild(deps, root, runId, move.park);
    const restored = isRestored(lane);
    if (!(yield* measureChange(checkpoints, root, restored, parkRef, move.sha)).changed)
      return {
        parked,
        back: null,
        kind: "current",
        value: (yield* work(true)).value,
      } satisfies InFolder<A>;
    if (
      move.expect !== undefined &&
      (yield* measureChange(checkpoints, root, restored, parkRef, move.expect)).changed
    )
      return {
        parked,
        back: null,
        kind: "refused",
        why: "moved-on",
        detail: "the game changed after the build it was to undo",
      } satisfies InFolder<A>;
    // The folder holds `expected`, or says why it does not.
    const verify = (expected: string) =>
      move.check === undefined
        ? Effect.succeed(null)
        : Effect.flatMap(captureBuild(deps, root, runId, move.check), (now) =>
            Effect.map(measureChange(checkpoints, root, restored, expected, now), (change) =>
              change.changed ? "the folder still differs from it" : null,
            ),
          );
    const putBack = Effect.gen(function* () {
      const back = yield* buildStep(deps, ctx, { _tag: "restore", sha: parkRef, keep: [] });
      if (move.back !== undefined && move.back.sha.length > 0)
        yield* buildStep(deps, ctx, { _tag: "keep", names: move.back.names, sha: move.back.sha });
      return back.build.ok ? yield* verify(parkRef) : back.build.detail;
    }).pipe(caught((detail) => detail));
    const moved = yield* Effect.gen(function* () {
      const came = yield* buildStep(deps, ctx, {
        _tag: "restore",
        sha: move.sha,
        keep: move.keep ?? [],
      });
      if (!came.build.ok) return { why: "gone", detail: came.build.detail } as const;
      const differs = yield* verify(move.sha);
      if (differs !== null) return { why: "incomplete", detail: differs } as const;
      return yield* work(false);
    }).pipe(caught((detail) => ({ why: "broke", detail }) as const));
    const back = "why" in moved || moved.putBack ? yield* putBack : null;
    return (
      "why" in moved
        ? { parked, back, kind: "refused", ...moved }
        : { parked, back, kind: "done", value: moved.value }
    ) satisfies InFolder<A>;
  });
