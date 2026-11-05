import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsRepositoryIdentity,
} from "@kurambit/contracts";
import { CheckpointRef } from "@kurambit/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /**
   * Restores only these paths, relative to `cwd` (a directory covers its
   * contents), writing only the files that differ and never the index; nothing
   * outside `cwd` is touched. Without it the whole workspace is restored and
   * its index reset.
   */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface VcsUpdateCheckpointRefInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit an earlier capture returned; false when it no longer exists. */
  readonly oid: string;
}

export interface VcsMaterializeCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A folder outside the repository; it is replaced, and gets no git metadata. */
  readonly destination: string;
  /** Paths relative to `cwd` left out of the copy, which holds only `cwd`'s subtree. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Only what changed below `cwd`, with paths relative to it (`git diff --relative`). */
  readonly relative?: boolean;
}

export interface VcsListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsListCheckpointRefsInput {
  readonly cwd: string;
  /** A ref folder, such as one run's `refs/kurambit/game-runs/<id>/`. */
  readonly prefix: string;
}

export interface VcsCheckpointRefEntry {
  readonly checkpointRef: CheckpointRef;
  readonly oid: string;
  /** The commit's time, in unix seconds. */
  readonly committedAt: number;
}

export interface VcsCheckpointOps {
  /** The commit oid of the checkpoint it wrote. */
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<string, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listAuthoredPaths: (
    input: VcsListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
  readonly listCheckpointRefs: (
    input: VcsListCheckpointRefsInput,
  ) => Effect.Effect<ReadonlyArray<VcsCheckpointRefEntry>, VcsError>;
  readonly updateCheckpointRef: (
    input: VcsUpdateCheckpointRefInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly materializeCheckpoint: (
    input: VcsMaterializeCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly capabilities: VcsDriverCapabilities;
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints?: VcsCheckpointOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
    readonly getDiffPreview?: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>;
  }
>()("kurambit/vcs/VcsDriver") {}
