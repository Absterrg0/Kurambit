// @effect-diagnostics nodeBuiltinImport:off -- This helper performs the native file exchange for a checked Windows export.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

export interface WindowsPublicationFileSystem {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { readonly force?: boolean }): Promise<void>;
}

export interface PublishWindowsBuildInput {
  /** The checked staged executable. */
  readonly stagedExecutable: string;
  /** The checked staged sidecar, or null when the pack is embedded in the exe. */
  readonly stagedPck: string | null;
  readonly executable: string;
  readonly pck: string;
}

export interface WindowsPublicationResult {
  /** Non-fatal cleanup notes, e.g. an old build file that could not be removed. */
  readonly notes: readonly string[];
}

const nativeFileSystem: WindowsPublicationFileSystem = {
  rename: (from, to) => NodeFSP.rename(from, to),
  rm: (path, options) => NodeFSP.rm(path, options),
};

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Moves an existing final file aside; a missing file simply has no backup. */
const moveIfPresent = async (
  fileSystem: WindowsPublicationFileSystem,
  from: string,
  to: string,
) => {
  try {
    await fileSystem.rename(from, to);
    return true;
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
};

/**
 * Publishes a checked Windows build. The engine writes both formats beside the
 * final paths, so the only failure this can see is on our own rename or stale
 * sidecar cleanup. Those must not leave the creator with a new executable and
 * an old pack, or a new pack and no executable.
 *
 * The previous pair is moved to unique backups first and restored over whatever
 * the new build published. Rename is the commit point; this is not a crash-
 * atomic two-file exchange, and a backup whose restore fails is deliberately
 * kept and named in the error instead of being deleted.
 */
export const publishWindowsBuild = async (
  input: PublishWindowsBuildInput,
  fileSystem: WindowsPublicationFileSystem = nativeFileSystem,
): Promise<WindowsPublicationResult> => {
  const token = NodeCrypto.randomUUID();
  const executableBackup = `${input.executable}.${token}.backup`;
  const pckBackup = `${input.pck}.${token}.backup`;
  let executableBackedUp = false;
  let pckBackedUp = false;
  let pckPublished = false;
  let executablePublished = false;
  try {
    executableBackedUp = await moveIfPresent(fileSystem, input.executable, executableBackup);
    pckBackedUp = await moveIfPresent(fileSystem, input.pck, pckBackup);
    if (input.stagedPck !== null) {
      await fileSystem.rename(input.stagedPck, input.pck);
      pckPublished = true;
    }
    await fileSystem.rename(input.stagedExecutable, input.executable);
    executablePublished = true;
  } catch (cause) {
    const kept: Array<{ readonly backup: string; readonly destination: string }> = [];
    const problems: string[] = [];
    if (executableBackedUp) {
      try {
        await fileSystem.rename(executableBackup, input.executable);
      } catch (error) {
        kept.push({ backup: executableBackup, destination: input.executable });
        problems.push(`game.exe could not be restored (${describe(error)})`);
      }
    } else if (executablePublished) {
      try {
        await fileSystem.rm(input.executable, { force: true });
      } catch (error) {
        problems.push(`the new game.exe could not be removed (${describe(error)})`);
      }
    }
    if (pckBackedUp) {
      try {
        await fileSystem.rename(pckBackup, input.pck);
      } catch (error) {
        kept.push({ backup: pckBackup, destination: input.pck });
        problems.push(`game.pck could not be restored (${describe(error)})`);
      }
    } else if (pckPublished) {
      try {
        await fileSystem.rm(input.pck, { force: true });
      } catch (error) {
        problems.push(`the new game.pck could not be removed (${describe(error)})`);
      }
    }
    const recovered = executableBackedUp || pckBackedUp;
    const message =
      kept.length === 0
        ? `The checked Windows build could not be moved into place. ${recovered ? "The previous Windows build was kept." : "No previous Windows build was changed."}${problems.length === 0 ? "" : ` ${problems.join(" ")}.`} Reason: ${describe(cause)}`
        : `The checked Windows build could not be moved into place, and the previous Windows build could not be fully restored. ${kept
            .map(
              (entry) =>
                `The only preserved copy for ${entry.destination} remains at ${entry.backup}; move it back before exporting again.`,
            )
            .join(" ")} ${problems.join(" ")}. Reason: ${describe(cause)}`;
    throw new Error(message, { cause });
  }
  const notes: string[] = [];
  for (const [backup, backedUp] of [
    [executableBackup, executableBackedUp],
    [pckBackup, pckBackedUp],
  ] as const) {
    if (!backedUp) continue;
    try {
      await fileSystem.rm(backup, { force: true });
    } catch {
      notes.push(`An older build file remains at ${backup} because it could not be removed.`);
    }
  }
  return { notes };
};
