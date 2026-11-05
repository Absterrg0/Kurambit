// @effect-diagnostics nodeBuiltinImport:off -- The workspace lock keys a folder by its real path on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { VcsUnsupportedOperationError, type CheckpointRef } from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /**
   * Restores only these paths, relative to `cwd` (a directory covers its
   * contents), writing only the files that differ and never the index.
   */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface UpdateCheckpointRefInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit an earlier capture returned. */
  readonly oid: string;
}

export interface MaterializeCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A folder outside the repository; it is replaced, and gets no git metadata. */
  readonly destination: string;
  /** Paths relative to `cwd` left out; the copy holds only `cwd`'s subtree. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Only what changed below `cwd`, with paths relative to it. */
  readonly relative?: boolean;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /** The commit oid of the checkpoint it wrote. */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Returns null when HEAD did not move or a checkpoint does not record HEAD.
     * Then every changed path belongs to the turn.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Points a ref at a commit an earlier capture returned; false when it is gone. */
    readonly updateCheckpointRef: (
      input: UpdateCheckpointRefInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /** Writes a checkpoint's files into a folder of their own; false when it is gone. */
    readonly materializeCheckpoint: (
      input: MaterializeCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Holds one workspace while `effect` captures or restores it, so a capture
     * never reads a tree another caller is restoring. Callers that combine
     * several operations take it around all of them; the operations themselves
     * do not take it.
     */
    readonly withWorkspaceLock: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("kurambit/checkpointing/CheckpointStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const workspaceLocks = yield* KeyedLock.make<string>();

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.listAuthoredPaths", input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  const updateCheckpointRef: CheckpointStore["Service"]["updateCheckpointRef"] = Effect.fn(
    "updateCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.updateCheckpointRef", input.cwd);
    return yield* checkpoints.updateCheckpointRef(input);
  });

  const materializeCheckpoint: CheckpointStore["Service"]["materializeCheckpoint"] = Effect.fn(
    "materializeCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.materializeCheckpoint",
      input.cwd,
    );
    return yield* checkpoints.materializeCheckpoint(input);
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
    updateCheckpointRef,
    materializeCheckpoint,
    // One folder reached through a symlink or a relative path is still one workspace.
    withWorkspaceLock: (cwd, effect) =>
      Effect.promise(() => NodeFSP.realpath(cwd).catch(() => NodePath.resolve(cwd))).pipe(
        Effect.flatMap((key) => workspaceLocks.withLock(key, effect)),
      ),
  });
});

export const layer = Layer.effect(CheckpointStore, make);
