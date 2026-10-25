// @effect-diagnostics nodeBuiltinImport:off -- Publication renames a staged archive into its final native path.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

export interface ArchiveFileSystem {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { readonly force?: boolean }): Promise<void>;
}

const nativeFileSystem: ArchiveFileSystem = {
  rename: (from, to) => NodeFSP.rename(from, to),
  rm: (path, options) => NodeFSP.rm(path, options),
};

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class ArchivePublishError extends Error {
  readonly path: string;
  constructor(path: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ArchivePublishError";
    this.path = path;
  }
}

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
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { readonly code?: unknown }).code)
        : "";
    if (!["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)) throw cause;
    const backup = `${input.archive}.${NodeCrypto.randomUUID()}.backup`;
    let backedUp = false;
    try {
      await fileSystem.rename(input.archive, backup);
      backedUp = true;
    } catch (error) {
      if (!isNotFound(error))
        throw new ArchivePublishError(
          input.archive,
          `The previous package could not be moved aside, so the new one was not published: ${describe(error)}`,
          { cause: error },
        );
    }
    try {
      await fileSystem.rename(input.stagedArchive, input.archive);
    } catch (error) {
      if (backedUp) {
        try {
          await fileSystem.rename(backup, input.archive);
        } catch (restoreError) {
          throw new ArchivePublishError(
            backup,
            `The new package could not be moved into place, and the previous package is preserved at ${backup} instead of ${input.archive}: ${describe(restoreError)}`,
            { cause: restoreError },
          );
        }
      }
      throw new ArchivePublishError(
        input.archive,
        "The new package could not be moved into place. The previous package was kept if one existed.",
        { cause: error },
      );
    }
    const notes: string[] = [];
    if (backedUp)
      await fileSystem.rm(backup, { force: true }).catch(() => {
        notes.push(`An older package remains at ${backup}.`);
      });
    return { notes };
  }
};
