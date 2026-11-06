// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Publication renames staged files and folders into their final native paths.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HOST_OS } from "./processHost.ts";

export interface ArchiveFileSystem {
  rename(from: string, to: string): Promise<void>;
  rm(
    path: string,
    options?: { readonly force?: boolean; readonly recursive?: boolean },
  ): Promise<void>;
}

const nativeFileSystem: ArchiveFileSystem = {
  rename: (from, to) => NodeFSP.rename(from, to),
  rm: (path, options) => NodeFSP.rm(path, options),
};

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : "";
const isNotFound = (cause: unknown) => codeOf(cause) === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** What rename answers when the destination exists, or (Windows) is open. */
const OCCUPIED = new Set(["EEXIST", "EPERM", "EACCES", "ENOTEMPTY", "EBUSY", "EISDIR", "ENOTDIR"]);

export class ArchivePublishError extends Error {
  readonly path: string;
  constructor(path: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ArchivePublishError";
    this.path = path;
  }
}

/**
 * Windows refuses a rename while a scanner (Defender) briefly holds a file
 * that was just written; a few short retries clear that, as graceful-fs does.
 * Unverified on Windows: the retry count is a guess from that library.
 */
const renameSettled = async (fileSystem: ArchiveFileSystem, from: string, to: string) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fileSystem.rename(from, to);
      return;
    } catch (cause) {
      if (
        HOST_OS !== "win32" ||
        attempt >= 3 ||
        !["EPERM", "EBUSY", "EACCES"].includes(codeOf(cause))
      )
        throw cause;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
};

/** The name a published file or folder is moved aside to; the leftover sweep knows it. */
const retiredName = (final: string, token: string) =>
  NodePath.join(NodePath.dirname(final), `.${NodePath.basename(final)}.${token}.retired`);
const RETIRED = /^\.(.+)\.[0-9a-f-]{36}\.retired$/;

export interface StagedEntry {
  /** The checked staged file or folder; null when the new release no longer has this one. */
  readonly staged: string | null;
  readonly final: string;
}

/**
 * Publishes staged files or folders over their finals as one step as far as
 * the filesystem allows: each existing final is moved aside, every staged
 * entry is renamed into place, and only then are the old ones removed. Any
 * failure puts the previous finals back. Rename is the commit point; this is
 * not a crash-atomic exchange, and a crash between the two renames leaves a
 * `.retired` copy with no final, which `sweepPublished` puts back.
 */
export const publishStaged = async (
  entries: ReadonlyArray<StagedEntry>,
  fileSystem: ArchiveFileSystem = nativeFileSystem,
): Promise<{ readonly notes: readonly string[] }> => {
  const token = NodeCrypto.randomUUID();
  const moved: Array<{ readonly final: string; readonly retired: string }> = [];
  const published: string[] = [];
  try {
    for (const entry of entries) {
      const retired = retiredName(entry.final, token);
      try {
        await renameSettled(fileSystem, entry.final, retired);
        moved.push({ final: entry.final, retired });
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
      }
    }
    for (const entry of entries) {
      if (entry.staged === null) continue;
      await renameSettled(fileSystem, entry.staged, entry.final);
      published.push(entry.final);
    }
  } catch (cause) {
    const kept: string[] = [];
    for (const final of published)
      await fileSystem.rm(final, { recursive: true, force: true }).catch(() => undefined);
    for (const { final, retired } of moved)
      await renameSettled(fileSystem, retired, final).catch(() => {
        kept.push(`The previous ${final} could not be restored; it is preserved at ${retired}.`);
      });
    throw new ArchivePublishError(
      entries[0]?.final ?? "",
      kept.length === 0
        ? `The checked release could not be moved into place; the previous one was kept. Reason: ${describe(cause)}`
        : `The checked release could not be moved into place, and the previous one could not be fully restored. ${kept.join(" ")} Reason: ${describe(cause)}`,
      { cause },
    );
  }
  const notes: string[] = [];
  for (const { retired } of moved)
    await fileSystem.rm(retired, { recursive: true, force: true }).catch(() => {
      notes.push(`An older release remains at ${retired} because it could not be removed.`);
    });
  return { notes };
};

/**
 * Rename is the commit point. POSIX replaces the incumbent in one step; where
 * rename refuses an existing destination, the incumbent is moved aside first
 * and restored if the new archive cannot take its place.
 */
export const publishArchive = async (
  input: { readonly stagedArchive: string; readonly archive: string },
  fileSystem: ArchiveFileSystem = nativeFileSystem,
): Promise<{ readonly notes: readonly string[] }> => {
  try {
    await fileSystem.rename(input.stagedArchive, input.archive);
    return { notes: [] };
  } catch (cause) {
    if (!OCCUPIED.has(codeOf(cause))) throw cause;
    return publishStaged([{ staged: input.stagedArchive, final: input.archive }], fileSystem);
  }
};

/**
 * Cleans what a crash or a cut-short publication left in one folder: a
 * `.retired` copy whose final is missing is put back (the newest one), and one
 * whose final exists is removed. Entries `isStaging` names (a release's
 * staging folder, a partial archive) are removed. Runs only while nothing
 * else publishes into the folder (under the game's operation lock).
 */
export const sweepPublished = async (
  directory: string,
  isStaging: (name: string) => boolean,
): Promise<void> => {
  let names: string[];
  try {
    names = await NodeFSP.readdir(directory);
  } catch {
    return;
  }
  const retired = new Map<string, Array<{ name: string; mtimeMs: number }>>();
  for (const name of names) {
    const match = RETIRED.exec(name);
    if (match?.[1] !== undefined) {
      const stat = await NodeFSP.lstat(NodePath.join(directory, name)).catch(() => null);
      if (stat === null) continue;
      retired.set(match[1], [...(retired.get(match[1]) ?? []), { name, mtimeMs: stat.mtimeMs }]);
    } else if (isStaging(name))
      await NodeFSP.rm(NodePath.join(directory, name), { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
  for (const [final, copies] of retired) {
    const finalPath = NodePath.join(directory, final);
    const present = await NodeFSP.lstat(finalPath).then(
      () => true,
      () => false,
    );
    const ordered = copies.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    const restore = present ? null : ordered[0];
    if (restore !== undefined && restore !== null)
      await NodeFSP.rename(NodePath.join(directory, restore.name), finalPath).catch(
        () => undefined,
      );
    for (const copy of ordered)
      if (copy !== restore)
        await NodeFSP.rm(NodePath.join(directory, copy.name), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
  }
};
