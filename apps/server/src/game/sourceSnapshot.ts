// @effect-diagnostics nodeBuiltinImport:off -- This helper reads the game's source tree on the native filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * A walked-entry bound, not a game-size limit. A tree larger than this cannot be
 * identified, so callers must treat the result as unknown (and therefore stale)
 * rather than guessing that it did not change.
 */
const DEFAULT_MAX_SOURCE_ENTRIES = 10_000;

/** Directories Unity generates at its project root; see snapshotBuildSource. */
const UNITY_OUTPUT_DIRECTORIES = new Set([
  "Library",
  "Temp",
  "Logs",
  "UserSettings",
  "obj",
  "Build",
  "Builds",
]);

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
 * Hashes the exact bytes read, streaming so a large imported asset never sits
 * whole in memory. The handle closes on every path; an abort destroys the
 * stream so the read does not outlive cancellation.
 */
const hashFileContent = async (
  absolute: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly size: number; readonly sha256: string }> => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(absolute, READ_FLAGS);
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    throw cause;
  }
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  try {
    signal?.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: false, signal });
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const buffer = chunk as Buffer;
        size += buffer.length;
        hash.update(buffer);
      }
    } finally {
      stream.destroy();
    }
    signal?.throwIfAborted();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { size, sha256: hash.digest("hex") };
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
    readonly maxEntries?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<SourceSnapshot> => {
  const limit = options.maxEntries ?? DEFAULT_MAX_SOURCE_ENTRIES;
  const signal = options.signal;
  const engineRoot = NodePath.join(root, godotProject);
  // A Unity project's own caches sit at its root beside Assets/ and are
  // rewritten by every editor start; they are output, never build input.
  const unityProject = await NodeFSP.stat(
    NodePath.join(engineRoot, "ProjectSettings/ProjectVersion.txt"),
  ).then(
    (stat) => stat.isFile(),
    () => false,
  );
  const lines: string[] = [];
  const files = new Map<string, string>();
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
        if (visited > limit) return { kind: "unknown", reason: "entry-limit" };
        const absolute = NodePath.join(directory, name);
        const relative = NodePath.relative(engineRoot, absolute).split(NodePath.sep).join("/");
        let entry: NodeFS.Stats;
        try {
          // Recheck the path rather than trusting earlier directory metadata.
          entry = await NodeFSP.lstat(absolute);
        } catch (cause) {
          if (signal?.aborted) signal.throwIfAborted();
          throw cause;
        }
        if (entry.isSymbolicLink())
          return { kind: "unknown", reason: "symlink", detail: `${godotProject}/${relative}` };
        if (entry.isDirectory()) {
          if (name === ".godot") continue;
          if (unityProject && directory === engineRoot && UNITY_OUTPUT_DIRECTORIES.has(name))
            continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        // Sidecars the engine generates beside real sources. An import rewrites
        // them, so they can never be part of whether the build still matches.
        if (name.endsWith(".import") || name.endsWith(".uid")) continue;
        if (
          unityProject &&
          directory === engineRoot &&
          (name.endsWith(".csproj") || name.endsWith(".sln"))
        )
          continue;
        let hashed: { readonly size: number; readonly sha256: string };
        try {
          hashed = await hashFileContent(absolute, signal);
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
  lines.sort();
  const hash = NodeCrypto.createHash("sha256");
  for (const line of lines) hash.update(line);
  return { kind: "known", sourceId: hash.digest("hex"), entries: lines.length, files };
};

/** Paths (relative to the engine directory) added, removed or changed between two reads. */
export const changedFiles = (
  before: Extract<SourceSnapshot, { kind: "known" }>,
  after: Extract<SourceSnapshot, { kind: "known" }>,
): string[] => {
  const changed = new Set<string>();
  for (const [path, content] of before.files)
    if (after.files.get(path) !== content) changed.add(path);
  for (const path of after.files.keys()) if (!before.files.has(path)) changed.add(path);
  return [...changed].sort();
};

const gitEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

const gitOut = (root: string, args: ReadonlyArray<string>): Promise<Buffer | null> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      [...args],
      { cwd: root, env: gitEnv(), timeout: 30_000, maxBuffer: 64 << 20, encoding: "buffer" },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });

/** The game repository's HEAD commit, or null when it has none or git fails. */
export const headCommit = async (root: string): Promise<string | null> => {
  const out = await gitOut(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const head = out?.toString("utf8").trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
};

/**
 * The one change a Unity build may make and still have built its sources: the
 * first build after a fresh import has URP re-save its pipeline `.asset`
 * files, putting back the committed bytes the import had rewritten. True only
 * when HEAD did not move during the build, and every changed path (relative to
 * `engineDir`) is a Unity `.asset` file present before and after, whose bytes
 * differed from HEAD's before the build and equal HEAD's after it. An edit, a
 * new or deleted file, a commit, a revert of anything else, or any git failure
 * answers false.
 */
export const restoredToCommit = async (
  root: string,
  engineDir: string,
  before: Extract<SourceSnapshot, { kind: "known" }>,
  after: Extract<SourceSnapshot, { kind: "known" }>,
  headBefore: string | null,
): Promise<boolean> => {
  const changed = changedFiles(before, after);
  if (changed.length === 0) return true;
  if (headBefore === null || (await headCommit(root)) !== headBefore) return false;
  for (const path of changed) {
    const was = before.files.get(path);
    const now = after.files.get(path);
    if (was === undefined || now === undefined || !path.endsWith(".asset")) return false;
    const blob = await gitOut(root, ["cat-file", "blob", `${headBefore}:${engineDir}/${path}`]);
    if (blob === null) return false;
    const committed = `${blob.length}:${NodeCrypto.createHash("sha256").update(blob).digest("hex")}`;
    if (now !== committed || was === committed) return false;
  }
  return true;
};

export type SourceComparison =
  | { readonly kind: "current"; readonly sourceId: string }
  | { readonly kind: "changed"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describeUnknown = (snapshot: Extract<SourceSnapshot, { kind: "unknown" }>): string =>
  snapshot.reason === "symlink"
    ? `a symlink is not followed (${snapshot.detail ?? "unknown path"})`
    : snapshot.reason === "entry-limit"
      ? "the source tree is past the scan bound"
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
