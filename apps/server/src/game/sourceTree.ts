// @effect-diagnostics nodeBuiltinImport:off -- Hashes a derived input's normalised text and passes git its environment.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { CheckpointRef, GameOperationError } from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { GameDerivedInput } from "./engineProfile.ts";

/**
 * The engine folder's content identity is git's: the tree id of the folder in
 * a capture of the working tree, as builds and facts already key it. Untracked
 * files count and ignored ones do not, exactly as a turn's checkpoint sees them.
 */
export type SourceIdentity =
  | { readonly kind: "known"; readonly sourceId: string }
  | {
      readonly kind: "unknown";
      readonly reason: "io" | "symlink";
      /** The path that made the tree unknowable, when one names it. */
      readonly detail?: string;
    };

/** The folder as an identity read last captured it; no build of its own. */
const SOURCE_REF = CheckpointRef.make("refs/kurambit/game-source");
const OPERATION = "game-source-identity";
const LINK_MODE = "120000";
/** A listing of a game at the file limit is a few MB; past this it is not read whole. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

const unknownIo = (detail: string): SourceIdentity => ({ kind: "unknown", reason: "io", detail });

/** `(root, lane, derived) => identity`, over T3's checkpoint capture and git driver. */
export const makeSourceIdentity = Effect.gen(function* () {
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  /** Git's stdout, or a failure naming the command; `exits` lists the codes that are answers. */
  const run = (
    root: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv | undefined;
      readonly stdin?: string;
      readonly exits?: ReadonlyArray<number>;
    } = {},
  ) =>
    git
      .execute({
        operation: OPERATION,
        cwd: root,
        args,
        allowNonZeroExit: true,
        timeoutMs: 120_000,
        maxOutputBytes: MAX_LISTING_BYTES,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
        Effect.filterOrFail(
          (result) => (options.exits ?? [0]).includes(result.exitCode) && !result.stdoutTruncated,
          (result) =>
            new GameOperationError({
              operation: OPERATION,
              path: root,
              reason: "io",
              detail: `git ${args[0]} failed: ${result.stderr.trim().slice(0, 300)}`,
            }),
        ),
      );

  /** The lane's tree in a capture of the repository's working tree: T3's checkpoint, whose kept index is git's own stat cache. */
  const capturedTree = (root: string, lane: string) =>
    Effect.gen(function* () {
      const capture = yield* checkpoints.withWorkspaceLock(
        root,
        checkpoints.captureCheckpoint({ cwd: root, checkpointRef: SOURCE_REF }),
      );
      const [tree] = yield* checkpoints.resolveTrees({
        cwd: root,
        revisions: [capture],
        path: lane,
      });
      return tree ?? null;
    });

  /**
   * The lane's tree in a folder that is no repository (a build's copy): a
   * throwaway object store and index over it, so equal files give the tree id
   * the game folder's capture gives. Blobs are written only when they are read.
   */
  const scratchTree = (root: string, lane: string, blobs: boolean) =>
    Effect.gen(function* () {
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kurambit-source-" });
      yield* run(dir, ["init", "-q", "--bare", dir]);
      const env = {
        ...process.env,
        GIT_DIR: dir,
        GIT_WORK_TREE: root,
        GIT_INDEX_FILE: NodePath.join(dir, "index"),
      };
      const scope = lane.length === 0 ? "." : lane;
      if (blobs) yield* run(root, ["add", "-A", "--", scope], { env });
      else {
        const files = yield* run(
          root,
          ["ls-files", "-z", "--others", "--exclude-standard", "--", scope],
          { env },
        );
        yield* run(root, ["update-index", "--add", "--info-only", "-z", "--stdin"], {
          env,
          stdin: files.stdout,
        });
      }
      const written = yield* run(
        root,
        ["write-tree", "--missing-ok", ...(lane.length === 0 ? [] : [`--prefix=${lane}/`])],
        { env },
      );
      return { tree: written.stdout.trim(), env };
    });

  /** The lane's identity from its tree: a link refuses it, a derived file counts by its normalised text. */
  const identityOf = (
    root: string,
    lane: string,
    tree: string,
    derived: GameDerivedInput | null,
    env: NodeJS.ProcessEnv | undefined,
  ) =>
    Effect.gen(function* () {
      // `<mode> <type> <oid>\t<path>`, one per NUL.
      const listed = yield* run(root, ["ls-tree", "-r", "-z", tree], { env });
      const entries = listed.stdout.split("\0").filter((line) => line.length > 0);
      // Git records a link, never what it points at: content behind it could
      // change with the identity unmoved, so a build never follows one.
      const link = entries.find((line) => line.startsWith(`${LINK_MODE} `));
      if (link !== undefined)
        return {
          kind: "unknown",
          reason: "symlink",
          detail: NodePath.posix.join(lane, link.slice(link.indexOf("\t") + 1)),
        } as const;
      if (derived === null) return { kind: "known", sourceId: tree } as const;
      // git grep exits 1 when nothing matches.
      const found = yield* run(
        root,
        ["grep", "-l", "-z", "-F", derived.marker, tree, "--", derived.glob],
        {
          env,
          exits: [0, 1],
        },
      );
      const paths = found.stdout
        .split("\0")
        .filter((name) => name.length > 0)
        .map((name) => name.slice(tree.length + 1));
      if (paths.length === 0) return { kind: "known", sourceId: tree } as const;
      const normalised = new Map<string, string>();
      for (const path of paths) {
        const blob = yield* run(root, ["cat-file", "blob", `${tree}:${path}`], { env });
        normalised.set(
          path,
          NodeCrypto.createHash("sha256").update(derived.normalise(blob.stdout)).digest("hex"),
        );
      }
      // The listing again, with each derived file counted by its normalised text.
      const hash = NodeCrypto.createHash("sha256");
      for (const line of entries) {
        const path = line.slice(line.indexOf("\t") + 1);
        hash.update(`${path}\0${normalised.get(path) ?? line.slice(0, line.indexOf("\t"))}\n`);
      }
      return { kind: "known", sourceId: hash.digest("hex") } as const;
    });

  return (
    root: string,
    lane: string,
    derived: GameDerivedInput | null,
  ): Effect.Effect<SourceIdentity> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { tree, env } = (yield* checkpoints.isGitRepository(root))
          ? { tree: yield* capturedTree(root, lane), env: undefined }
          : yield* scratchTree(root, lane, derived !== null);
        if (tree === null || tree.length === 0)
          return unknownIo(`${lane}/ holds no files git keeps`);
        return yield* identityOf(root, lane, tree, derived, env);
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed(unknownIo(`git could not read the game folder: ${error.message}`)),
      ),
    );
});

export type SourceComparison =
  | { readonly kind: "current"; readonly sourceId: string }
  | { readonly kind: "changed"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describeUnknown = (identity: Extract<SourceIdentity, { kind: "unknown" }>): string =>
  identity.reason === "symlink"
    ? `a symlink is not followed (${identity.detail ?? "unknown path"})`
    : "the source tree could not be read";

/**
 * The one rule every executing stage shares: an operation only covers sources
 * it saw before and after itself, and only when both reads are known and equal.
 * A mixed or unreadable input cannot be called current, so the caller records
 * `unknown` and says why instead of attaching the result to sources it may not
 * have executed.
 */
export const comparedSource = (
  before: SourceIdentity,
  after: SourceIdentity,
  operation: string,
): SourceComparison => {
  if (before.kind === "unknown")
    return {
      kind: "unknown",
      detail: `The game sources could not be identified before the ${operation} ran (${describeUnknown(before)}); the result is not current.`,
    };
  if (after.kind === "unknown")
    return {
      kind: "unknown",
      detail: `The game sources could not be identified after the ${operation} ran (${describeUnknown(after)}); the result is not current.`,
    };
  if (before.sourceId !== after.sourceId)
    return {
      kind: "changed",
      detail: `The game sources changed while the ${operation} ran; the result is not current.`,
    };
  return { kind: "current", sourceId: after.sourceId };
};

/**
 * Why an operation's sources could not be identified, as the one error every
 * consumer raises, so every operation refuses alike: a link in the project is the game's
 * (`symlink`); a tree that changed while it was read is transient
 * (`tool-failed`); an unreadable one is ours (`io`). Never `invalid-input`,
 * which a run reads as its own bad request.
 */
export const sourceIdentityError = (
  operation: string,
  root: string,
  project: string,
  why:
    | Extract<SourceIdentity, { kind: "unknown" }>
    | { readonly kind: "changed"; readonly detail: string },
): GameOperationError =>
  why.kind === "changed"
    ? new GameOperationError({
        operation,
        path: NodePath.join(root, project),
        reason: "tool-failed",
        detail: `${why.detail} Something else wrote the game's files meanwhile; run it again once that work ends.`,
      })
    : why.reason === "symlink"
      ? new GameOperationError({
          operation,
          path: NodePath.join(root, project),
          reason: "symlink",
          detail: `A symbolic link is in the game's sources (${why.detail ?? "unknown path"}); a build never follows one. Replace it with the real file or folder.`,
        })
      : new GameOperationError({
          operation,
          path: NodePath.join(root, project),
          reason: "io",
          detail: `The game's sources could not be read (${why.detail ?? "a filesystem error"}).`,
        });
