// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This helper reads the game's source tree on the native filesystem and compares file mtimes to the wall clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { GAME_SOURCE_FILE_LIMIT, GameOperationError, sourceLimitDetail } from "@kurambit/contracts";
import type { GameSourceRules } from "./engineProfile.ts";

/**
 * Skipped entries (engine output, sidecars) are walked but not counted toward
 * the file limit; this bounds the walk itself, so a tree of nothing but output
 * cannot keep it going.
 */
const WALK_FACTOR = 4;

/** Opening without following a link makes a swapped-in symlink fail closed. */
const READ_FLAGS = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW;

export type SourceSnapshot =
  | {
      readonly kind: "known";
      readonly sourceId: string;
      readonly entries: number;
      /** Each file's size and content hash, by path relative to the engine directory. */
      readonly files: ReadonlyMap<string, string>;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "entry-limit" | "io" | "symlink";
      /** The path that made the tree unknowable, when one names it. */
      readonly detail?: string;
    };

/**
 * SHA-256 and byte count of a file, streamed so a large build never sits whole
 * in memory: the game layer's one file hasher (snapshots, Web builds, library
 * packs). `noFollow` refuses a link at the path (O_NOFOLLOW, where it exists),
 * so a link swapped in fails closed; an abort stops the read.
 */
export const hashFile = async (
  path: string,
  options: { readonly signal?: AbortSignal | undefined; readonly noFollow?: boolean } = {},
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const { signal } = options;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      path,
      options.noFollow === true ? READ_FLAGS : NodeFS.constants.O_RDONLY,
    );
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    throw cause;
  }
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).byteLength;
      }
    } finally {
      stream.destroy();
    }
    signal?.throwIfAborted();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { sha256: hash.digest("hex"), bytes };
};

const hashFileContent = async (
  absolute: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly size: number; readonly sha256: string }> => {
  const hashed = await hashFile(absolute, { signal, noFollow: true });
  return { size: hashed.bytes, sha256: hashed.sha256 };
};

const MAX_DERIVED_ASSET_BYTES = 1 << 20;

/**
 * Hashes from earlier reads of the same tree, by absolute path. An entry is
 * reused only while the file's device, inode, size, mtime and ctime are all
 * unchanged, the way git's index skips unchanged files.
 */
export type SourceHashCache = Map<
  string,
  { readonly identity: string; readonly size: number; readonly sha256: string }
>;

/**
 * Git's racy-clean rule: a file written in the same timestamp tick as its hash
 * can change again without moving its mtime, so it is only cached once its
 * mtime is safely older than the read. Two seconds covers coarse filesystems.
 */
const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * URP keeps a list of the settings a player needs in `m_RuntimeSettings`. A
 * player build fills it from the rest of the file and an editor save empties
 * it again, so it flips on every warm-up and build without any source edit.
 * The build recomputes it either way: it is output kept inside an input file,
 * and the identity leaves it out.
 */
const RUNTIME_SETTINGS =
  /^( *)m_RuntimeSettings:\r?\n\1 {2}m_List:(?: \[\])?\r?\n(?:\1 {2}- rid: -?\d+\r?\n)*/m;

const hashUnityAsset = async (
  absolute: string,
): Promise<{ readonly size: number; readonly sha256: string }> => {
  const handle = await NodeFSP.open(absolute, READ_FLAGS);
  let bytes: Buffer;
  try {
    bytes = await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
  const text = bytes.toString("latin1");
  const kept = RUNTIME_SETTINGS.test(text)
    ? Buffer.from(text.replace(RUNTIME_SETTINGS, "$1m_RuntimeSettings: derived\n"), "latin1")
    : bytes;
  return { size: kept.length, sha256: NodeCrypto.createHash("sha256").update(kept).digest("hex") };
};

/**
 * The BUILD-source identity: what the engine export consumes, and nothing else.
 * It covers the Godot project directory by path, size and content hash, so
 * additions, deletions and edits to the build's inputs all change the hash.
 * Engine output (`godot/.godot/`, `*.import`, `*.uid`) is excluded because one
 * import can rewrite it without changing the export; design documents, briefs,
 * notes and art sources live outside `godot/` and are other identities' business.
 *
 * This BUILD-input identity covers only what the export reads; the selection
 * record's source id covers the same files by construction.
 *
 * Symlinks fail closed: following a linked script would let its content change
 * without changing the identity of the tree Godot loaded. Mtime is never part
 * of the identity, so a touch-only edit keeps it while any byte change moves it.
 */
export const snapshotBuildSource = async (
  root: string,
  godotProject: string,
  options: {
    /** The engine's build inputs (its profile's `buildInputs`): the engine is never guessed from files. */
    readonly rules: GameSourceRules;
    readonly maxEntries?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly cache?: SourceHashCache | undefined;
  },
): Promise<SourceSnapshot> => {
  const limit = options.maxEntries ?? GAME_SOURCE_FILE_LIMIT;
  const signal = options.signal;
  const cache = options.cache;
  const seen = new Set<string>();
  const engineRoot = NodePath.join(root, godotProject);
  const rules = options.rules;
  const lines: string[] = [];
  const files = new Map<string, string>();
  const tooMany = (): SourceSnapshot => ({
    kind: "unknown",
    reason: "entry-limit",
    detail: sourceLimitDetail(godotProject),
  });
  let counted = 0;
  let visited = 0;
  try {
    const stack = [engineRoot];
    while (stack.length > 0) {
      signal?.throwIfAborted();
      const directory = stack.pop()!;
      // Stream directory entries too: the entry limit must apply before a
      // large directory can allocate an unbounded array of names.
      for await (const item of await NodeFSP.opendir(directory)) {
        const name = item.name;
        signal?.throwIfAborted();
        visited += 1;
        if (visited > limit * WALK_FACTOR) return tooMany();
        const absolute = NodePath.join(directory, name);
        const relative = NodePath.relative(engineRoot, absolute).split(NodePath.sep).join("/");
        let entry: NodeFS.BigIntStats;
        try {
          // Recheck the path rather than trusting earlier directory metadata.
          entry = await NodeFSP.lstat(absolute, { bigint: true });
        } catch (cause) {
          if (signal?.aborted) signal.throwIfAborted();
          throw cause;
        }
        if (entry.isSymbolicLink())
          return { kind: "unknown", reason: "symlink", detail: `${godotProject}/${relative}` };
        if (entry.isDirectory()) {
          if (rules.skipDirs.includes(name)) continue;
          if (directory === engineRoot && rules.rootOutputDirs.includes(name)) continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        // Sidecars the engine generates beside real sources. An import rewrites
        // them, so they can never be part of whether the build still matches.
        if (rules.sidecarSuffixes.some((suffix) => name.endsWith(suffix))) continue;
        if (directory === engineRoot && rules.rootOutputFiles?.test(name) === true) continue;
        counted += 1;
        if (counted > limit) return tooMany();
        const derived =
          rules.derivedAssets && name.endsWith(".asset") && entry.size <= MAX_DERIVED_ASSET_BYTES;
        const identity = `${derived}:${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
        let hashed: { readonly size: number; readonly sha256: string };
        try {
          const cached = cache?.get(absolute);
          hashed =
            cached !== undefined && cached.identity === identity
              ? cached
              : derived
                ? await hashUnityAsset(absolute)
                : await hashFileContent(absolute, signal);
          seen.add(absolute);
          // Bytes that changed after this lstat move the mtime away from the
          // cached identity, unless they land in the same tick: hence the window.
          if (
            cache !== undefined &&
            hashed !== cached &&
            entry.mtimeNs < BigInt(Date.now()) * 1_000_000n - RACY_WINDOW_NS
          )
            cache.set(absolute, { identity, ...hashed });
        } catch (cause) {
          if (signal?.aborted) signal.throwIfAborted();
          // A link swapped in between lstat and open fails on O_NOFOLLOW: that
          // is a symlink, not a readable input.
          if ((cause as NodeJS.ErrnoException).code === "ELOOP")
            return { kind: "unknown", reason: "symlink", detail: `${godotProject}/${relative}` };
          throw cause;
        }
        lines.push(`${relative}\0${hashed.size}\0${hashed.sha256}\n`);
        files.set(relative, `${hashed.size}:${hashed.sha256}`);
      }
    }
  } catch {
    // Cancellation must propagate so an Effect fiber does not outlive the read.
    if (signal?.aborted) signal.throwIfAborted();
    return { kind: "unknown", reason: "io" };
  }
  if (cache !== undefined) for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  lines.sort();
  const hash = NodeCrypto.createHash("sha256");
  for (const line of lines) hash.update(line);
  return { kind: "known", sourceId: hash.digest("hex"), entries: lines.length, files };
};

export type SourceComparison =
  | { readonly kind: "current"; readonly sourceId: string }
  | { readonly kind: "changed"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describeUnknown = (snapshot: Extract<SourceSnapshot, { kind: "unknown" }>): string =>
  snapshot.reason === "symlink"
    ? `a symlink is not followed (${snapshot.detail ?? "unknown path"})`
    : snapshot.reason === "entry-limit"
      ? (snapshot.detail ?? `the game holds more than ${GAME_SOURCE_FILE_LIMIT} source files`)
      : "the source tree could not be read";

/**
 * The one rule every executing stage shares: an operation only covers sources
 * it saw before and after itself, and only when both reads are known and equal.
 * A mixed or unreadable input cannot be called current, so the caller records
 * `unknown` and says why instead of attaching the result to sources it may not
 * have executed.
 */
export const comparedSource = (
  before: SourceSnapshot,
  after: SourceSnapshot,
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
 * consumer raises (CONTRACT A7): a link in the project is the game's
 * (`symlink`); more files than a build reads is the game's (`command-failed`,
 * naming the limit); a tree that changed while it was read is transient
 * (`tool-failed`); an unreadable one is ours (`io`). Never `invalid-input`,
 * which a run reads as its own bad request.
 */
export const sourceIdentityError = (
  operation: string,
  root: string,
  project: string,
  why:
    | Extract<SourceSnapshot, { kind: "unknown" }>
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
      : why.reason === "entry-limit"
        ? new GameOperationError({
            operation,
            path: NodePath.join(root, project),
            reason: "command-failed",
            detail: why.detail ?? sourceLimitDetail(project),
          })
        : new GameOperationError({
            operation,
            path: NodePath.join(root, project),
            reason: "io",
            detail: `The game's sources could not be read (${why.detail ?? "a filesystem error"}).`,
          });
