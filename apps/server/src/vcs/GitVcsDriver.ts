// @effect-diagnostics nodeBuiltinImport:off -- lstat and ctime, which the Effect FileSystem does not report.
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  CheckpointRef,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@kurambit/contracts";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import * as HostProcess from "@kurambit/shared/HostProcess";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /**
   * With `appendTruncationMarker`, keep invoking the line callbacks after the
   * buffered copy is full. For long-running commands whose output is only
   * consumed through `progress`.
   */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  branchChanges?: VcsStatusResult["branchChanges"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitLocalStatusOptions {
  readonly includeDivergence?: boolean;
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeProgress {
  /**
   * Git refuses an existing path, so a path reported here belongs to this call and is safe to
   * remove on cancel.
   */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "kurambit.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /**
   * Null (or omitted, for callers without settings access) defers to the
   * checkout's own kurambit.json.
   */
  readonly submodules?: WorktreeSubmodules | null;
  readonly worktreesDirectory?: string;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
  readonly stage?: { readonly filePaths?: readonly string[] };
}

export interface GitDeleteLocalBranchInput {
  readonly cwd: string;
  readonly refName: string;
  readonly force?: boolean;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  exactName?: boolean;
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestHeadCommitInput {
  cwd: string;
  prNumber: number;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /**
   * Commit the checkout is allowed to be hard-reset away from: the upstream commit read before
   * the fetch. HEAD sitting there means the checkout holds no work of its own.
   */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (
      cwd: string,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly resolveBranchName: (
      cwd: string,
      refName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchPullRequestHeadCommit: (
      input: GitFetchPullRequestHeadCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly listWorktreePaths: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("kurambit/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

// A capture's listings name every changed or new file; they stay in memory.
const CAPTURE_LISTING_MAX_BYTES = 128 * 1024 * 1024;
// Pre-writing pays off only when much changed: below this total a capture only
// stages. Files below the floor are left to add, where they cost next to nothing.
const PRE_WRITE_MIN_FILE_BYTES = 64 * 1024;
const PRE_WRITE_MIN_TOTAL_BYTES = 64 * 1024 * 1024;
const SLOW_CAPTURE_MS = 2_000;
// Longer than any capture runs, so a temp file this old belongs to no running capture.
const STRAY_CAPTURE_INDEX_MS = 2 * 60 * 60_000;
const CAPTURE_INDEX_FILE = /^capture-index-[0-9a-f]{16}-[0-9a-f]{16}$/;
const CAPTURE_INDEX_REFS = "refs/kurambit/capture-index/";
const CAPTURE_INDEX_TEMP =
  /^capture-index-[0-9a-f]{16}-[0-9a-f]{16}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.lock)?$/;

const splitNul = (output: string) => output.split("\0").filter((entry) => entry.length > 0);

/** `git config -z --list` as each key's last value; a key without a value is null (true). */
function parseGitConfigList(output: string): Map<string, string | null> {
  const settings = new Map<string, string | null>();
  for (const entry of splitNul(output)) {
    const newline = entry.indexOf("\n");
    if (newline < 0) settings.set(entry, null);
    else settings.set(entry.slice(0, newline), entry.slice(newline + 1));
  }
  return settings;
}

const gitConfigTrue = (value: string | null | undefined) =>
  value === null || (value !== undefined && /^\s*(?:true|yes|on|1)\s*$/i.test(value));

interface RawDiffRecord {
  readonly srcMode: string;
  readonly dstMode: string;
  readonly srcOid: string;
  readonly status: string;
  readonly path: string;
}

/** `git diff-index --raw -z --no-renames` records; null when one does not parse. */
function parseRawDiff(output: string): RawDiffRecord[] | null {
  const tokens = output.split("\0");
  const records: RawDiffRecord[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) [0-9a-f]+ ([A-Z])\d*$/.exec(tokens[index]!);
    const path = tokens[index + 1]!;
    if (match === null || path.length === 0) return null;
    records.push({
      srcMode: match[1]!,
      dstMode: match[2]!,
      srcOid: match[3]!,
      status: match[4]!,
      path,
    });
  }
  return records;
}

/**
 * Directory and file names (lowercased) that the index spells more than one
 * way. On a case-insensitive disk git folds such names into one, so an entry
 * under one cannot be vouched for.
 */
function caseConflicts(paths: Iterable<string>): Set<string> {
  const spellings = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const file of paths) {
    const parts = file.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const spelled = parts.slice(0, depth).join("/");
      const folded = spelled.toLowerCase();
      const seen = spellings.get(folded);
      if (seen === undefined) spellings.set(folded, spelled);
      else if (seen !== spelled) conflicted.add(folded);
    }
  }
  return conflicted;
}

/** The files over `count` groups of near-equal bytes: largest first, each to the lightest group. */
function balanceBySize<A extends { readonly size: number }>(
  files: ReadonlyArray<A>,
  count: number,
) {
  const groups = Array.from({ length: count }, () => ({ bytes: 0, files: [] as A[] }));
  for (const file of [...files].sort((left, right) => right.size - left.size)) {
    const lightest = groups.reduce((min, group) => (group.bytes < min.bytes ? group : min));
    lightest.files.push(file);
    lightest.bytes += file.size;
  }
  return groups.map((group) => group.files).filter((group) => group.length > 0);
}

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    readonly appendTruncationMarker?: boolean;
    readonly lowPriority?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
    ...(options?.lowPriority !== undefined ? { lowPriority: options.lowPriority } : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
      ...(input.lowPriority !== undefined ? { lowPriority: input.lowPriority } : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  // Git renames loose objects and refs into place without fsync by default, so
  // an unclean restart can leave 0-byte files under refs/kurambit/** that break every
  // later fetch and push. Checkpoint writes flush before they are published;
  // macOS defaults to writeout-only, which does not reach the disk either.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
  ] as const;

  // A private index for work on a checkpoint's tree: the user's index, HEAD and
  // branches are never written, and its unique name never waits on another's lock.
  const withTempIndex = <A, E, R>(
    cwd: string,
    work: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const gitCommonDir = yield* resolveGitCommonDir(cwd);
      const indexId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const tempIndexPath = path.join(gitCommonDir, `kurambit-checkpoint-index-${indexId}`);
      const cleanup = Effect.forEach(
        [tempIndexPath, `${tempIndexPath}.lock`],
        (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
        { discard: true },
      );
      return yield* work({ ...process.env, GIT_INDEX_FILE: tempIndexPath }).pipe(
        Effect.ensuring(cleanup),
      );
    });

  // A path with its symlinks resolved, for one that may not exist yet: the
  // nearest existing folder above it is resolved and the rest kept.
  const resolvedPath = (target: string): Effect.Effect<string> =>
    fileSystem
      .realPath(target)
      .pipe(
        Effect.catch(() =>
          path.dirname(target) === target
            ? Effect.succeed(target)
            : resolvedPath(path.dirname(target)).pipe(
                Effect.map((parent) => path.join(parent, path.basename(target))),
              ),
        ),
      );

  // The repository's top and where `cwd` sits in it ("" at the top, else "game/"):
  // scoped work names paths relative to `cwd` and never reaches past it.
  const resolveTopLevel = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveTopLevel",
      cwd,
      args: ["rev-parse", "--show-toplevel", "--show-prefix"],
    }).pipe(
      Effect.map((result) => {
        const [top = "", prefix = ""] = result.stdout.split("\n");
        return { top: top.trim(), prefix: prefix.trim() };
      }),
    );

  // Checkpoint index work never reads an fsmonitor's cached answer, which can
  // say a file is unchanged when it is not.
  const checkpointIndexConfig = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "sparse.expectFilesOutsideOfPatterns=false",
  ];

  /**
   * Seeds the private index at `env.GIT_INDEX_FILE` from a copy of the user's
   * index read over `tree`, so entries the tree shares keep their stat data and
   * only files that may differ are hashed. The copy keeps a timestamp below the
   * user index's, preserving git's racy check. False when the user's index
   * holds flags that would hide a change (skip-worktree outside a sparse cone,
   * assume-unchanged): the caller then reads the tree plainly and hashes all.
   */
  const seedFromUserIndex = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly tree: string;
    readonly sparseCheckout: boolean;
  }) => {
    const { operation, cwd, env, tree, sparseCheckout } = input;
    const indexFile = env.GIT_INDEX_FILE!;
    const indexConfig = checkpointIndexConfig;
    return Effect.gen(function* () {
      const indexPath = yield* execute({
        operation,
        cwd: cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      });
      const { mtime } = yield* fileSystem.stat(indexPath.stdout.trim());
      if (Option.isNone(mtime)) return false;
      // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
      const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
      if (indexTime <= 0) return false;
      yield* fileSystem.copyFile(indexPath.stdout.trim(), indexFile);
      yield* execute({
        operation,
        cwd: cwd,
        args: [...indexConfig, "read-tree", "--reset", tree],
        env: env,
      });
      // read-tree can rewrite the index, so restore its racy timestamp afterward.
      yield* fileSystem.utimes(indexFile, indexTime, indexTime);
      let specialFlags = false;
      let recordStart = true;
      let skipped = false;
      let skippedRecord: number[] = [];
      const skippedPaths: string[] = [];
      yield* vcsProcess.run({
        operation,
        command: "git",
        cwd: cwd,
        args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
        env: env,
        maxOutputBytes: 4_096,
        outputMode: "truncate",
        onStdoutChunk: (chunk) => {
          for (const byte of chunk) {
            if (recordStart) skipped = byte === 83;
            if (skipped && sparseCheckout) {
              if (byte !== 0) skippedRecord.push(byte);
              else {
                if (skippedRecord.at(-1) !== 47) {
                  const name = Buffer.from(skippedRecord).subarray(2);
                  if (!NodeBuffer.isUtf8(name)) specialFlags = true;
                  else skippedPaths.push(name.toString("utf8"));
                }
                skippedRecord = [];
              }
            }
            if (recordStart && ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))) {
              specialFlags = true;
            }
            recordStart = byte === 0;
          }
        },
      });
      if (skippedPaths.length > 0 && !specialFlags) {
        const selected = yield* execute({
          operation,
          cwd: cwd,
          args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
          stdin: skippedPaths.join("\0") + "\0",
          env: env,
          maxOutputBytes: 1,
          outputMode: "truncate",
        });
        specialFlags = selected.stdout.length > 0 || selected.stdoutTruncated;
      }
      // Sparse Git clears skip-worktree for present files. Manual flags still need a reset.
      return !specialFlags;
    }).pipe(Effect.orElseSucceed(() => false));
  };

  // Large trees: these walk and write every file in scope.
  const TREE_TIMEOUT_MS = 10 * 60_000;
  const scopeSpecs = (prefix: string, filePaths: ReadonlyArray<string>) =>
    filePaths.map((file) => `:(top,literal)${prefix}${file}`);

  /**
   * The checkpoint's files under `filePaths`, back in the worktree: only files
   * that differ are written (an unchanged file keeps its mtime, so an engine
   * watching the folder sees nothing), files the checkpoint lacks that are not
   * ignored go, and nothing outside the scope, nor the user's index, changes.
   */
  const restoreScoped = (cwd: string, commitOid: string, filePaths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";
      if (filePaths.length === 0) return;
      const { top, prefix } = yield* resolveTopLevel(cwd);
      const specs = scopeSpecs(prefix, filePaths);
      yield* withTempIndex(top, (env) =>
        Effect.gen(function* () {
          // A seeded copy of the user's index hashes only the files that may
          // differ. When its flags could hide a change, every file is hashed:
          // a restore converges or fails, it never skips a differing file.
          const seeded = yield* seedFromUserIndex({
            operation,
            cwd: top,
            env,
            tree: commitOid,
            sparseCheckout: false,
          });
          if (!seeded) {
            yield* Effect.forEach(
              [env.GIT_INDEX_FILE!, `${env.GIT_INDEX_FILE!}.lock`],
              (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
              { discard: true },
            );
            yield* execute({
              operation,
              cwd: top,
              args: [...checkpointIndexConfig, "read-tree", commitOid],
              env,
            });
          }
          yield* execute({
            operation,
            cwd: top,
            args: [...checkpointIndexConfig, "update-index", "-q", "--refresh"],
            env,
            allowNonZeroExit: true,
            timeoutMs: TREE_TIMEOUT_MS,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "truncate",
          });
          const differing = yield* execute({
            operation,
            cwd: top,
            args: [...checkpointIndexConfig, "diff-files", "--name-only", "-z", "--", ...specs],
            env,
            timeoutMs: TREE_TIMEOUT_MS,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
          const extra = yield* execute({
            operation,
            cwd: top,
            args: [
              ...checkpointIndexConfig,
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
              "--",
              ...specs,
            ],
            env,
            timeoutMs: TREE_TIMEOUT_MS,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            outputMode: "error",
          });
          const extraPaths = splitNullSeparatedGitStdoutPaths(extra);
          // git lists a nested repository it will not look into as "dir/". It is
          // someone's own repository, not a file the checkpoint lacks: it stays.
          const nested = extraPaths.filter((file) => file.endsWith("/"));
          if (nested.length > 0)
            yield* Effect.logWarning("A scoped restore left nested repositories in place", {
              cwd,
              nested,
            });
          for (const file of extraPaths.filter((entry) => !entry.endsWith("/")))
            yield* fileSystem.remove(path.join(top, file), { force: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new VcsProcessExitError({
                    operation,
                    command: "rm",
                    cwd: top,
                    exitCode: 1,
                    detail: `Could not remove ${file}: ${cause.message}`,
                  }),
              ),
            );
          const write = splitNullSeparatedGitStdoutPaths(differing);
          if (write.length > 0)
            yield* execute({
              operation,
              cwd: top,
              args: [
                ...checkpointIndexConfig,
                "-c",
                "core.longpaths=true",
                "checkout-index",
                "-f",
                "-z",
                "--stdin",
              ],
              stdin: `${write.join("\0")}\0`,
              env,
              timeoutMs: TREE_TIMEOUT_MS,
            });
        }),
      );
    });

  // On macOS and Windows capture writes flush loose objects once per process
  // (core.fsyncMethod=batch) instead of once per object; refs stay fully
  // synced. Git documents batch as durable only on APFS/HFS+ and NTFS/ReFS: on
  // Linux it issues sync_file_range writeout for each object and one fsync of a
  // dummy file, which btrfs and XFS do not extend to the other objects, so a
  // power loss after update-ref could leave a ref to missing objects. Linux
  // keeps fsync per object: durability over speed, though many new small files
  // pay for it there (20k new files took 26 s per-object, 0.9 s batched).
  const hostPlatform = yield* HostProcess.Platform;
  const captureWrite =
    hostPlatform === "darwin" || hostPlatform === "win32"
      ? (["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=batch"] as const)
      : durableWrite;

  const captureFileError = (file: string) => (cause: PlatformError.PlatformError) =>
    new VcsProcessExitError({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      command: "fs",
      cwd: file,
      exitCode: 1,
      detail: cause.message,
    });

  type CaptureRun = (
    args: ReadonlyArray<string>,
    options?: Partial<Omit<VcsProcess.VcsProcessInput, "args" | "command">>,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;

  /**
   * Where one working tree keeps its capture index for captures of one folder.
   * The index is valid only for the inputs `add` reads besides the files
   * themselves (HEAD, the config, the attribute files), so they are its name:
   * when any of them changes the index is missing and is seeded afresh.
   */
  const capturePlace = (operation: string, cwd: string) =>
    Effect.gen(function* () {
      const located = yield* execute({
        operation,
        cwd,
        args: [
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
          "--show-toplevel",
          "--git-path",
          "info/attributes",
          "--show-prefix",
          "HEAD",
        ],
      });
      const [gitDir = "", top = "", infoAttributes = "", prefix = "", head = ""] = located.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""));
      if (gitDir === "" || top === "" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) return null;
      const config = yield* execute({
        operation,
        cwd,
        args: ["config", "-z", "--list"],
        allowNonZeroExit: true,
        maxOutputBytes: CAPTURE_LISTING_MAX_BYTES,
        outputMode: "error",
      });
      if (config.exitCode !== 0) return null;
      const settings = parseGitConfigList(config.stdout);
      const listAttributes = (selection: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd,
          args: [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            "ls-files",
            "-z",
            ...selection,
            "--exclude-standard",
            "--full-name",
            "--",
            ":(glob)**/.gitattributes",
          ],
          timeoutMs: TREE_TIMEOUT_MS,
          maxOutputBytes: CAPTURE_LISTING_MAX_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => splitNul(result.stdout)));
      // Git applies a .gitattributes in the working tree even when it is ignored.
      const listed = [
        ...(yield* listAttributes(["-c", "-o"])),
        ...(yield* listAttributes(["-o", "-i"])),
      ];
      // Git 2.42 names the files it reads; older git gets the global one
      // resolved by hand and no system one.
      const gitVar = (name: string) =>
        execute({ operation, cwd, args: ["var", name], allowNonZeroExit: true }).pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
        );
      const systemAttributes = yield* gitVar("GIT_ATTR_SYSTEM");
      const home = process.env.HOME || NodeOS.homedir();
      const configured = settings.get("core.attributesfile");
      const globalAttributes =
        (yield* gitVar("GIT_ATTR_GLOBAL")) ||
        (typeof configured === "string" && configured.length > 0
          ? configured.startsWith("~/")
            ? path.join(home, configured.slice(2))
            : path.resolve(cwd, configured)
          : path.join(
              process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
              "git",
              "attributes",
            ));
      const folders = prefix.split("/").filter((part) => part.length > 0);
      const attributeFiles = [
        infoAttributes,
        // Empty when git reads none (GIT_ATTR_NOSYSTEM, or git before 2.42).
        systemAttributes,
        globalAttributes,
        ...folders.map((_, depth) => path.join(top, ...folders.slice(0, depth), ".gitattributes")),
        ...listed.map((file) => path.join(top, file)),
      ];
      const encoder = new TextEncoder();
      const parts: Uint8Array[] = [encoder.encode(`v1\0${prefix}\0${head}\0${config.stdout}\0`)];
      for (const file of attributeFiles) {
        const contents = yield* fileSystem
          .readFile(file)
          .pipe(Effect.orElseSucceed(() => encoder.encode("\0missing")));
        parts.push(encoder.encode(`\0${file}\0${contents.length}\0`), contents);
      }
      const hex = (bytes: Uint8Array) => NodeBuffer.Buffer.from(bytes).toString("hex").slice(0, 16);
      const id = hex(
        yield* crypto.digest("SHA-256", encoder.encode(`${path.resolve(gitDir)}\0${prefix}`)),
      );
      const key = hex(yield* crypto.digest("SHA-256", NodeBuffer.Buffer.concat(parts)));
      const dir = path.join(gitDir, "kurambit");
      return {
        id,
        top,
        dir,
        file: path.join(dir, `capture-index-${id}-${key}`),
        // Keeps every object the index names reachable, so git's gc never prunes one.
        ref: `${CAPTURE_INDEX_REFS}${id}`,
        /** HEAD as read for the key: the capture lines up with, seeds from and parents this. */
        head,
        ignoreCase: gitConfigTrue(settings.get("core.ignorecase")),
        precomposeUnicode: gitConfigTrue(settings.get("core.precomposeunicode")),
      };
    });
  type CapturePlace = NonNullable<Effect.Success<ReturnType<typeof capturePlace>>>;

  // The index this place kept under other inputs is stale, and a temp file left
  // by a capture that was killed is garbage. Only Kurambit's own names match.
  const sweepCaptureIndexes = (place: CapturePlace) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const names = yield* fileSystem.readDirectory(place.dir);
      for (const name of names) {
        const file = path.join(place.dir, name);
        const stale =
          CAPTURE_INDEX_FILE.test(name) &&
          name.startsWith(`capture-index-${place.id}-`) &&
          file !== place.file;
        const stray =
          CAPTURE_INDEX_TEMP.test(name) &&
          (yield* Effect.promise(() =>
            NodeFSP.stat(file).then(
              (info) => now - info.ctimeMs > STRAY_CAPTURE_INDEX_MS,
              () => false,
            ),
          ));
        if (stale || stray) yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.ignore);

  interface CaptureIndexLineUp {
    /** Tracked files whose stat data no longer matches the disk. */
    readonly dirty: ReadonlyArray<string>;
    /** Paths given HEAD's entry back, to be hashed again. */
    readonly realigned: ReadonlyArray<string>;
  }

  /**
   * Copies the kept index to `tempIndexPath` and lines it up with HEAD, so that
   * `add -A` over it gives the tree it gives over a fresh seed. Null when there
   * is no index to use.
   */
  const reuseCaptureIndex = (place: CapturePlace, tempIndexPath: string, run: CaptureRun) =>
    Effect.gen(function* () {
      const info = yield* fileSystem.stat(place.file).pipe(Effect.option);
      if (Option.isNone(info) || Option.isNone(info.value.mtime)) return null;
      const kept = yield* run(["rev-parse", "--verify", "--quiet", `${place.ref}^{commit}`], {
        allowNonZeroExit: true,
      });
      if (kept.exitCode !== 0) {
        // Without its ref, objects only this index names may have been pruned.
        yield* fileSystem.remove(place.file, { force: true }).pipe(Effect.ignore);
        return null;
      }
      const indexTime = Math.floor((info.value.mtime.value.getTime() - 1) / 1000);
      if (indexTime <= 0) return null;
      yield* fileSystem
        .copyFile(place.file, tempIndexPath)
        .pipe(Effect.mapError(captureFileError(place.file)));
      // The copy keeps a time no later than the index's own, so git's racy
      // check still re-reads every file written in the second it was written.
      yield* fileSystem
        .utimes(tempIndexPath, indexTime, indexTime)
        .pipe(Effect.mapError(captureFileError(tempIndexPath)));
      return yield* lineUpCaptureIndex(place, run);
    });

  const captureListing = (run: CaptureRun, args: ReadonlyArray<string>) =>
    run(args, { maxOutputBytes: CAPTURE_LISTING_MAX_BYTES, outputMode: "error" }).pipe(
      Effect.flatMap((result) =>
        result.stdoutInvalidUtf8
          ? Effect.fail(
              new VcsProcessExitError({
                operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
                command: `git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""}`,
                cwd: "",
                exitCode: 0,
                detail: "A path name is not UTF-8.",
              }),
            )
          : Effect.succeed(result.stdout),
      ),
    );

  /**
   * After a fresh seed every path HEAD has holds HEAD's entry and no other path
   * has one, and `add` reads an existing entry's mode, name case and line
   * endings. So: a path HEAD has gets HEAD's entry back unless the kept entry is
   * unchanged on disk (then it was hashed over HEAD's entry, as `add` would);
   * a path HEAD lacks keeps its entry only while it is unchanged on disk, not
   * ignored, not a nested repository nor inside one and, on a case-insensitive disk, spelled
   * as on disk and nowhere else in the index. `add -A` meets every dropped path
   * as new, as after a seed.
   *
   * This widens one trust: a file HEAD lacks is taken as unchanged on the
   * stat data an earlier capture recorded, where a fresh seed hashed it
   * every time. A rewrite that keeps its size, mtime and (where git checks
   * them) ctime and inode is missed, exactly as `git status` misses it for a
   * tracked file; git's racy check still re-reads files written in the
   * second the index was.
   */
  const lineUpCaptureIndex = (place: CapturePlace, run: CaptureRun) =>
    Effect.gen(function* () {
      const raw = yield* captureListing(run, [
        ...checkpointIndexConfig,
        "diff-index",
        "--cached",
        "-z",
        "--raw",
        "--no-renames",
        "--ignore-submodules=none",
        place.head,
        "--",
        ".",
      ]);
      const dirtyPaths = splitNul(
        yield* captureListing(run, [
          ...checkpointIndexConfig,
          "diff-files",
          "-z",
          "--name-only",
          "--ignore-submodules=none",
          "--",
          ".",
        ]),
      );
      const dirty = new Set(dirtyPaths);
      const ignored = new Set(
        splitNul(
          yield* captureListing(run, [
            ...checkpointIndexConfig,
            "ls-files",
            "-z",
            "-c",
            "-i",
            "--exclude-standard",
            "--full-name",
            "--",
            ".",
          ]),
        ),
      );
      const records = parseRawDiff(raw);
      if (records === null)
        return yield* new VcsProcessExitError({
          operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
          command: "git diff-index",
          cwd: place.top,
          exitCode: 0,
          detail: "Unexpected diff-index output.",
        });
      // A gitlink always gets HEAD's entry back: when the submodule's checkout
      // is gone, diff-files cannot resolve it and calls it unchanged, so the
      // kept commit would stand where a seed records HEAD's. It costs no hashing.
      const realign = records.filter(
        (record) =>
          record.status === "D" ||
          record.status === "T" ||
          (record.status === "M" &&
            (dirty.has(record.path) || record.srcMode === "160000" || record.dstMode === "160000")),
      );
      const added = records.filter((record) => record.status === "A");
      // An added entry must be spelled as on disk, and alone in its folder
      // once names are folded (lowercase, NFC where git precomposes), whatever
      // core.ignorecase says: a case-insensitive disk with core.ignorecase=false
      // keeps the old spelling after a case-only rename, and core.ignorecase=true
      // on a case-sensitive disk (a project copied from one) would fold a second
      // spelling into the kept one where a seed refuses it. With
      // core.ignorecase=true, git also folds names spelled two ways in the index.
      const fold = (name: string) =>
        (place.precomposeUnicode ? name.normalize("NFC") : name).toLowerCase();
      let conflicted: ReadonlySet<string> = new Set();
      if (place.ignoreCase && added.length > 0)
        conflicted = caseConflicts([
          ...splitNul(
            yield* captureListing(run, [
              ...checkpointIndexConfig,
              "ls-files",
              "-z",
              "--full-name",
              "--",
              ".",
            ]),
          ),
          ...records.filter((record) => record.status === "D").map((record) => record.path),
        ]);
      const listedFolders = [
        ...new Set(
          added.flatMap((record) => {
            const parts = record.path.split("/");
            return parts.map((_, depth) => parts.slice(0, depth).join("/"));
          }),
        ),
      ];
      const listings = new Map(
        yield* Effect.forEach(
          listedFolders,
          (folder) =>
            fileSystem.readDirectory(path.join(place.top, folder)).pipe(
              Effect.map((names) => {
                const spelled = place.precomposeUnicode
                  ? names.map((name) => name.normalize("NFC"))
                  : names;
                const folds = new Map<string, number>();
                for (const name of spelled) folds.set(fold(name), (folds.get(fold(name)) ?? 0) + 1);
                return [folder, { names: new Set(spelled), folds }] as const;
              }),
              Effect.orElseSucceed(() => [folder, null] as const),
            ),
          { concurrency: 32 },
        ),
      );
      const foreignCase = (file: string) => {
        const parts = file.split("/");
        return parts.some((part, depth) => {
          if (
            conflicted.has(
              parts
                .slice(0, depth + 1)
                .join("/")
                .toLowerCase(),
            )
          )
            return true;
          const listing = listings.get(parts.slice(0, depth).join("/"));
          return (
            listing === undefined ||
            listing === null ||
            !listing.names.has(part) ||
            (listing.folds.get(fold(part)) ?? 0) > 1
          );
        });
      };
      // A folder that became a repository since its files were added (a
      // `.git` file or folder, as in a worktree or a submodule) is a gitlink or
      // left out after a seed, never its files: one lstat per folder.
      const folderChains = (file: string) => {
        const parts = file.split("/");
        return parts.slice(1).map((_, depth) => parts.slice(0, depth + 1).join("/"));
      };
      const folders = new Set(added.flatMap((record) => folderChains(record.path)));
      const repositoryFolders = new Set(
        yield* Effect.forEach(
          [...folders],
          (folder) =>
            Effect.promise(() =>
              NodeFSP.lstat(path.join(place.top, folder, ".git")).then(
                () => folder,
                () => null,
              ),
            ),
          { concurrency: 32 },
        ),
      );
      const insideRepository = (file: string) =>
        folderChains(file).some((folder) => repositoryFolders.has(folder));
      const lines: string[] = realign.map(
        (record) => `${record.srcMode} ${record.srcOid}\t${record.path}`,
      );
      for (const record of added) {
        const drop =
          record.dstMode === "160000" ||
          dirty.has(record.path) ||
          ignored.has(record.path) ||
          insideRepository(record.path) ||
          foreignCase(record.path);
        if (drop) lines.push(`0 ${"0".repeat(record.srcOid.length)}\t${record.path}`);
      }
      if (lines.length > 0)
        yield* run([...checkpointIndexConfig, "update-index", "-z", "--index-info"], {
          stdin: `${lines.join("\0")}\0`,
        });
      return {
        dirty: dirtyPaths,
        realigned: realign.map((record) => record.path),
      } satisfies CaptureIndexLineUp;
    });

  /**
   * A cache warm, only when much changed: the large changed files are written
   * as objects by parallel `hash-object` processes at lowered priority, then
   * `add -A` finds each object stored and makes every decision itself (modes,
   * symlinks, filters, line endings). A wrong guess leaves an orphan object.
   */
  const preWriteChanged = (
    top: string,
    run: CaptureRun,
    lined: CaptureIndexLineUp | null,
    report: { files: number; bytes: number; processes: number },
  ) =>
    Effect.gen(function* () {
      const tracked =
        lined === null
          ? splitNul(
              yield* captureListing(run, [
                ...checkpointIndexConfig,
                "diff-files",
                "-z",
                "--name-only",
                "--",
                ".",
              ]),
            )
          : [...lined.dirty, ...lined.realigned];
      const untracked = splitNul(
        yield* captureListing(run, [
          ...checkpointIndexConfig,
          "ls-files",
          "-z",
          "-o",
          "--exclude-standard",
          "--full-name",
          "--",
          ".",
        ]),
      ).filter((file) => !file.endsWith("/"));
      const changed = yield* Effect.forEach(
        [...new Set([...tracked, ...untracked])],
        (file) =>
          Effect.promise(() =>
            NodeFSP.lstat(path.join(top, file)).then(
              (info) => ({ path: file, size: info.isFile() ? info.size : -1 }),
              () => ({ path: file, size: -1 }),
            ),
          ),
        { concurrency: 64 },
      );
      const files = changed.filter((file) => file.size >= 0);
      report.files = files.length;
      report.bytes = files.reduce((sum, file) => sum + file.size, 0);
      // --stdin-paths reads lines and unquotes a leading quote: such names are left to add.
      const large = files.filter(
        (file) => file.size >= PRE_WRITE_MIN_FILE_BYTES && !/[\n\r]|^"/.test(file.path),
      );
      if (large.reduce((sum, file) => sum + file.size, 0) < PRE_WRITE_MIN_TOTAL_BYTES) return;
      // Two process slots stay free for the app's other git work.
      const count = Math.min(
        NodeOS.availableParallelism() - 1,
        VcsProcess.VCS_PROCESS_CONCURRENCY - 2,
      );
      // One process would only hash the files a second time, in series.
      if (count < 2) return;
      const groups = balanceBySize(large, count);
      report.processes = groups.length;
      yield* Effect.forEach(
        groups,
        (group) =>
          run(
            ["-c", "core.longpaths=true", ...captureWrite, "hash-object", "-w", "--stdin-paths"],
            {
              cwd: top,
              stdin: `${group.map((file) => file.path).join("\n")}\n`,
              maxOutputBytes: 1,
              outputMode: "truncate",
              lowPriority: true,
            },
          ),
        { concurrency: "unbounded", discard: true },
      );
    });

  /** The capture's index becomes the kept one, under a ref to the commit made from it. */
  const keepCaptureIndex = (
    place: CapturePlace,
    cwd: string,
    tempIndexPath: string,
    commitOid: string,
  ) =>
    Effect.gen(function* () {
      yield* execute({
        operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
        cwd,
        args: [...captureWrite, "update-ref", place.ref, commitOid],
      });
      // A replace-rename; on Windows a scanner holding the old file can refuse it for a moment.
      yield* fileSystem
        .rename(tempIndexPath, place.file)
        .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced(Duration.millis(100)) }));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("checkpoint capture index not kept", { cwd, error: error.message }),
      ),
    );

  /**
   * A capture-index ref names its folder's last capture, a commit that
   * capture's own checkpoint ref names too. Once no other Kurambit ref names
   * it, the capture-index ref alone would pin a folder state nobody keeps, so
   * it goes, with this working tree's index for it (another working tree's
   * goes at its next capture, which finds the ref missing and seeds afresh).
   * The ref therefore never pins an object no checkpoint pins. Deleting only
   * while it still names that commit leaves a capture that just moved it alone.
   */
  const releaseCaptureIndexes = (cwd: string) =>
    Effect.gen(function* () {
      const operation = "GitVcsDriver.checkpoints.releaseCaptureIndexes";
      const listed = yield* execute({
        operation,
        cwd,
        args: ["for-each-ref", "--format=%(objectname) %(refname)", "refs/kurambit/"],
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      const named = new Set<string>();
      const indexRefs: Array<{ readonly oid: string; readonly ref: string }> = [];
      for (const line of listed.stdout.split("\n")) {
        const space = line.indexOf(" ");
        if (space < 0) continue;
        const oid = line.slice(0, space);
        const ref = line.slice(space + 1);
        if (ref.startsWith(CAPTURE_INDEX_REFS)) indexRefs.push({ oid, ref });
        else named.add(oid);
      }
      const released: string[] = [];
      for (const { oid, ref } of indexRefs.filter((entry) => !named.has(entry.oid))) {
        const deleted = yield* execute({
          operation,
          cwd,
          args: [...durableWrite, "update-ref", "-d", ref, oid],
          allowNonZeroExit: true,
        });
        if (deleted.exitCode === 0) released.push(ref.slice(CAPTURE_INDEX_REFS.length));
      }
      if (released.length === 0) return;
      const gitDir = yield* execute({ operation, cwd, args: ["rev-parse", "--absolute-git-dir"] });
      const dir = path.join(gitDir.stdout.trim(), "kurambit");
      for (const name of yield* fileSystem.readDirectory(dir))
        if (
          CAPTURE_INDEX_FILE.test(name) &&
          released.some((id) => name.startsWith(`capture-index-${id}-`))
        )
          yield* fileSystem.remove(path.join(dir, name), { force: true });
    }).pipe(
      // Freeing space never fails the ref change that asked for it.
      Effect.catch((error) =>
        Effect.logWarning("capture index not released", { cwd, error: error.message }),
      ),
    );

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
      const indexConfig = checkpointIndexConfig;
      const startedAt = yield* Clock.currentTimeMillis;
      const headExists = yield* hasHeadCommit(input.cwd);
      const sparseConfig = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["config", "--bool", "core.sparseCheckout"],
        allowNonZeroExit: true,
      });
      let sparseCheckout = sparseConfig.stdout.trim() === "true";
      if (sparseCheckout) {
        const help = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-h"],
          allowNonZeroExit: true,
        });
        sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
      }
      // A sparse checkout's skip-worktree bits live in the user's index, so it
      // is always seeded from there; an unborn HEAD has nothing to seed from.
      const place =
        headExists && !sparseCheckout
          ? yield* capturePlace(operation, input.cwd).pipe(
              Effect.tap((found) => (found === null ? Effect.void : sweepCaptureIndexes(found))),
              // Without a place the capture seeds a fresh index, as it always did.
              Effect.orElseSucceed(() => null),
            )
          : null;
      // HEAD moving mid-capture must not mix two HEADs into one capture: with a
      // place, every step uses the commit its key was computed from.
      const headRef = place?.head ?? "HEAD";
      const { top } = place ?? (yield* resolveTopLevel(input.cwd));
      // Capture commands never write an index that points at a shared index
      // file git's own expiry could remove, nor read an untracked cache.
      const captureConfig: ReadonlyArray<readonly [string, string]> = [
        ["core.splitIndex", "false"],
        ["core.untrackedCache", "false"],
        // A checksum on every index write, so a torn kept index reads as corrupt.
        ["index.skipHash", "false"],
        ...(sparseCheckout ? [] : ([["index.sparse", "false"]] as const)),
      ];
      const report = { files: 0, bytes: 0, processes: 0, reused: false };

      const attempt = (reuse: boolean): Effect.Effect<string, VcsError> => {
        let reusing = false;
        return Effect.gen(function* () {
          const indexId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const tempIndexPath =
            place === null
              ? path.join(
                  yield* resolveGitCommonDir(input.cwd),
                  `kurambit-checkpoint-index-${indexId}`,
                )
              : `${place.file}.${indexId}`;
          const commitEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_INDEX_FILE: tempIndexPath,
            GIT_AUTHOR_NAME: "Kurambit",
            GIT_AUTHOR_EMAIL: "kurambit@users.noreply.github.com",
            GIT_COMMITTER_NAME: "Kurambit",
            GIT_COMMITTER_EMAIL: "kurambit@users.noreply.github.com",
          };
          for (const [key, value] of captureConfig)
            Object.assign(commitEnv, VcsProcess.gitConfigEnv(commitEnv, key, value, hostPlatform));
          const cleanupTempIndex = Effect.forEach(
            [tempIndexPath, `${tempIndexPath}.lock`],
            (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
            { discard: true },
          );
          const run = (
            args: ReadonlyArray<string>,
            options: Partial<Omit<VcsProcess.VcsProcessInput, "args" | "command">> = {},
          ) =>
            execute({
              operation,
              cwd: input.cwd,
              env: commitEnv,
              timeoutMs: TREE_TIMEOUT_MS,
              ...options,
              args,
            });

          return yield* Effect.gen(function* () {
            let lined: CaptureIndexLineUp | null = null;
            if (place !== null && reuse) {
              // From here until the tree is written, any failure reseeds.
              reusing = true;
              lined = yield* reuseCaptureIndex(place, tempIndexPath, run);
              reusing = lined !== null;
            }
            report.reused = lined !== null;
            if (lined === null && place !== null)
              yield* fileSystem
                .makeDirectory(place.dir, { recursive: true })
                .pipe(Effect.mapError(captureFileError(place.dir)));
            if (lined === null && headExists) {
              const reusedIndex = yield* seedFromUserIndex({
                operation,
                cwd: input.cwd,
                env: commitEnv,
                tree: headRef,
                sparseCheckout,
              });
              if (!reusedIndex) {
                if (sparseCheckout) {
                  const cone = yield* execute({
                    operation,
                    cwd: input.cwd,
                    args: ["config", "--bool", "core.sparseCheckoutCone"],
                    allowNonZeroExit: true,
                  });
                  // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
                  if (cone.stdout.trim() !== "true") {
                    return yield* new VcsProcessExitError({
                      operation,
                      command: "git read-tree",
                      cwd: input.cwd,
                      exitCode: 1,
                      detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                    });
                  }
                }
                yield* cleanupTempIndex;
                yield* run(
                  sparseCheckout
                    ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                    : ["read-tree", headRef],
                );
              }
            }

            yield* preWriteChanged(top, run, lined, report).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("checkpoint pre-write failed; staging hashes every file", {
                      cwd: input.cwd,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );

            const stageFiles = (exclusions: ReadonlyArray<string>) =>
              run([
                ...indexConfig,
                ...captureWrite,
                "add",
                ...(sparseCheckout ? ["--sparse"] : []),
                "-A",
                "--",
                ".",
                ...exclusions,
              ]);
            yield* stageFiles([]).pipe(
              Effect.catchTags({
                VcsProcessExitError: (error) =>
                  Effect.gen(function* () {
                    // Git cannot stage an embedded repository until it has a commit. Discover these
                    // only after staging fails so ordinary checkpoints do not need another file scan.
                    const untracked = yield* execute({
                      operation,
                      cwd: input.cwd,
                      args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                      env: commitEnv,
                      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                    });
                    if (untracked.stdoutTruncated) return yield* error;
                    const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                      entry.endsWith("/"),
                    );
                    if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                    const nestedRepoEnv: NodeJS.ProcessEnv = {
                      ...process.env,
                      GIT_DIR: undefined,
                      GIT_WORK_TREE: undefined,
                      GIT_COMMON_DIR: undefined,
                      GIT_INDEX_FILE: undefined,
                      GIT_OBJECT_DIRECTORY: undefined,
                      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                    };
                    const exclusions: Array<string> = [];
                    for (const entry of candidates) {
                      const nestedCwd = path.join(input.cwd, entry);
                      if (
                        (yield* fileSystem
                          .exists(path.join(nestedCwd, ".git"))
                          .pipe(Effect.mapError(() => error))) &&
                        !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                      ) {
                        exclusions.push(`:(exclude,literal)${entry}`);
                      }
                    }
                    if (exclusions.length === 0) return yield* error;
                    return yield* stageFiles(exclusions);
                  }).pipe(
                    Effect.timeoutOrElse({
                      duration: CHECKPOINT_RECOVERY_TIMEOUT,
                      orElse: () => Effect.fail(error),
                    }),
                  ),
              }),
            );

            // write-tree refuses an entry whose object is gone (never --missing-ok),
            // so an index naming a pruned blob fails here and is reseeded.
            const writeTreeResult = yield* run([...indexConfig, ...captureWrite, "write-tree"]);
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new VcsProcessExitError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                exitCode: 0,
                detail: "git write-tree returned an empty tree oid.",
              });
            }
            reusing = false;

            const message = `kurambit checkpoint ref=${input.checkpointRef}`;
            // HEAD is the parent so listAuthoredPaths can see how HEAD moved between checkpoints.
            const commitTreeResult = yield* run([
              ...captureWrite,
              "commit-tree",
              treeOid,
              ...(headExists ? ["-p", headRef] : []),
              "-m",
              message,
            ]);
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new VcsProcessExitError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                exitCode: 0,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* execute({
              operation,
              cwd: input.cwd,
              args: [...captureWrite, "update-ref", input.checkpointRef, commitOid],
            });
            if (place !== null) yield* keepCaptureIndex(place, input.cwd, tempIndexPath, commitOid);
            return commitOid;
          }).pipe(Effect.ensuring(cleanupTempIndex));
        }).pipe(
          Effect.catchCause((cause) => {
            // A timeout is reported, not retried: a reseed would double a 10-minute wait.
            const error = Cause.findErrorOption(cause);
            if (
              !reusing ||
              Cause.hasInterruptsOnly(cause) ||
              (Option.isSome(error) && error.value._tag === "VcsProcessTimeoutError")
            )
              return Effect.failCause(cause);
            // The kept index could not be used (corrupt, a foreign format, a
            // pruned object): it goes, and the capture starts from a fresh seed.
            return Effect.logWarning("checkpoint capture index reseeded", {
              cwd: input.cwd,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                place === null
                  ? Effect.void
                  : fileSystem.remove(place.file, { force: true }).pipe(Effect.ignore),
              ),
              Effect.andThen(attempt(false)),
            );
          }),
        );
      };

      const commitOid = yield* attempt(true);
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      if (elapsed > SLOW_CAPTURE_MS)
        yield* Effect.logInfo("checkpoint capture", {
          cwd: input.cwd,
          ms: elapsed,
          changedFiles: report.files,
          changedBytes: report.bytes,
          preWrote: report.processes > 0,
          processes: report.processes,
          reusedIndex: report.reused,
        });
      return commitOid;
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }
      if (input.filePaths !== undefined) {
        yield* restoreScoped(input.cwd, commitOid, input.filePaths);
        return true;
      }

      const tracked = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
      });
      // An empty index and checkpoint have nothing for git restore's pathspec to match.
      if (tracked.stdout.length > 0) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
        });
      }
      // Restoring away the last tracked file can remove a nested workspace directory.
      const recreateWorkspace = fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation,
              command: "git restore",
              cwd: input.cwd,
              exitCode: 0,
              detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
            }),
        ),
      );
      yield* recreateWorkspace;
      const cleaned = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
        allowNonZeroExit: true,
      });
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* fileSystem.readDirectory(input.cwd).pipe(
            Effect.map((entries) => entries.length === 0),
            Effect.orElseSucceed(() => false),
          ));
        if (!emptiedWorkspace)
          return yield* new VcsProcessExitError({
            operation,
            command: "git clean",
            cwd: input.cwd,
            exitCode: cleaned.exitCode,
            detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          });
      }
      // On Windows the same clean can remove './' and exit 0.
      yield* recreateWorkspace;

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      if (input.filePaths?.length === 0) return "";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.format": input.format ?? "patch",
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          ...(input.relative === true ? ["--relative"] : []),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    listAuthoredPaths: Effect.fn("GitVcsDriver.checkpoints.listAuthoredPaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.listAuthoredPaths";
      const heads = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%P %ct",
          `${input.fromCheckpointRef}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
      });
      const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
      const [startHead = "", capturedAt = ""] = fromLine.split(" ");
      const [endHead = ""] = toLine.split(" ");
      if (startHead === "" || endHead === "" || startHead === endHead) {
        return null;
      }

      const listPaths = (args: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [...args, "--name-only", "-z", "--no-renames", "--no-ext-diff"],
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "error",
        }).pipe(Effect.map((result) => result.stdout.split("\0")));
      // Remerge diff lists a merge's paths only where the result differs from Git's
      // automatic merge, so a merge keeps its conflict fixes and drops clean upstream changes.
      const pathLists = yield* Effect.all(
        [
          listPaths(["diff", startHead, `${input.fromCheckpointRef}^{commit}`]),
          listPaths(["diff", endHead, `${input.toCheckpointRef}^{commit}`]),
          listPaths(["log", "--format=", "--diff-merges=remerge", `${endHead}..${startHead}`]),
          listPaths([
            "log",
            "--format=",
            "--diff-merges=remerge",
            `--since=@${capturedAt}`,
            `${startHead}..${endHead}`,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      return new Set(pathLists.flat().filter((path) => path.length > 0));
    }),

    updateCheckpointRef: Effect.fn("GitVcsDriver.checkpoints.updateCheckpointRef")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.updateCheckpointRef";
        const commitOid = yield* resolveCheckpointCommit(input.cwd, input.oid);
        if (commitOid === null) return false;
        yield* execute({
          operation,
          cwd: input.cwd,
          args: [...durableWrite, "update-ref", input.checkpointRef, commitOid],
        });
        yield* releaseCaptureIndexes(input.cwd);
        return true;
      },
    ),

    materializeCheckpoint: Effect.fn("GitVcsDriver.checkpoints.materializeCheckpoint")(
      function* (input) {
        const operation = "GitVcsDriver.checkpoints.materializeCheckpoint";
        const commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (commitOid === null) return false;
        const { top, prefix } = yield* resolveTopLevel(input.cwd);
        const fail = (detail: string) =>
          new VcsProcessExitError({ operation, command: "mkdir", cwd: top, exitCode: 1, detail });
        // The copy's folder is removed whole below, so it must share no path
        // with the repository, its git dir or a folder holding either.
        const destination = yield* resolvedPath(path.resolve(input.destination));
        for (const guarded of [top, yield* resolveGitCommonDir(input.cwd)]) {
          const real = yield* resolvedPath(guarded);
          const within = (inner: string, outer: string) =>
            inner === outer || inner.startsWith(`${outer}${path.sep}`);
          if (within(destination, real) || within(real, destination))
            return yield* fail(`Refusing to replace ${input.destination}: it overlaps ${guarded}.`);
        }
        // A fresh folder every time, so a repeat writes the same copy and nothing older survives.
        yield* fileSystem
          .remove(input.destination, { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => fail(cause.message)));
        yield* fileSystem
          .makeDirectory(input.destination, { recursive: true })
          .pipe(Effect.mapError((cause) => fail(cause.message)));
        yield* withTempIndex(top, (env) =>
          Effect.gen(function* () {
            // Only `cwd`'s own subtree, read as the index's root, so the copy
            // holds the cwd's files at the paths they have below it.
            const tree =
              prefix.length === 0 ? commitOid : `${commitOid}:${prefix.replace(/\/$/, "")}`;
            yield* execute({ operation, cwd: top, args: ["read-tree", tree], env });
            const excluded = input.excludePaths ?? [];
            if (excluded.length > 0)
              yield* execute({
                operation,
                cwd: top,
                args: [
                  "rm",
                  "-r",
                  "-q",
                  "--cached",
                  "--ignore-unmatch",
                  "--",
                  ...scopeSpecs("", excluded),
                ],
                env,
              });
            yield* execute({
              operation,
              cwd: top,
              args: [
                "-c",
                "core.longpaths=true",
                "checkout-index",
                "-a",
                "-f",
                `--prefix=${input.destination.replace(/[\\/]*$/, "")}/`,
              ],
              env,
              timeoutMs: TREE_TIMEOUT_MS,
            });
          }),
        );
        return true;
      },
    ),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
        yield* releaseCaptureIndexes(input.cwd);
      },
    ),
    listCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.listCheckpointRefs")(function* (input) {
      const listed = yield* execute({
        operation: "GitVcsDriver.checkpoints.listCheckpointRefs",
        cwd: input.cwd,
        args: [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
          input.prefix,
        ],
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        outputMode: "error",
      });
      return listed.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [ref = "", oid = "", at = "0"] = line.split("\0");
          return {
            checkpointRef: CheckpointRef.make(ref),
            oid,
            committedAt: Number.parseInt(at, 10) || 0,
          };
        });
    }),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
