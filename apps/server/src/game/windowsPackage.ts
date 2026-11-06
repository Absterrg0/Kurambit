// @effect-diagnostics nodeBuiltinImport:off -- Packaging streams the exported release files from disk into an archive next to them.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ArchivePublishError,
  publishArchive,
  type ArchiveFileSystem,
} from "./archivePublication.ts";
import { StoredZipError, throwIfAborted, writeStoredZip } from "./storedZip.ts";
import {
  inspectWindowsBuildSource,
  type WindowsBuildInspection,
  type WindowsBuildSource,
} from "./windowsExport.ts";

export const WINDOWS_PACKAGE_FILE = "game-windows.zip";

export class WindowsPackageError extends Error {
  readonly path: string;
  readonly kind: "missing" | "invalid" | "changed" | "io";
  constructor(
    path: string,
    kind: "missing" | "invalid" | "changed" | "io",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "WindowsPackageError";
    this.path = path;
    this.kind = kind;
  }
}

export interface WindowsPackageFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WindowsPackageResult {
  /** Absolute path of the complete archive. */
  readonly archivePath: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly WindowsPackageFile[];
  readonly embeddedPck: boolean;
  readonly executableBytes: number;
  readonly pckBytes: number;
  readonly pckFileCount: number;
  readonly notes: readonly string[];
}

export const windowsPackageArchivePath = (root: string) =>
  NodePath.join(root, "builds/windows", WINDOWS_PACKAGE_FILE);

const isNotFound = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

interface OpenedFile {
  readonly path: string;
  readonly handle: NodeFSP.FileHandle;
  readonly stat: Awaited<ReturnType<NodeFSP.FileHandle["stat"]>>;
  readonly size: number;
}

const openFile = async (path: string): Promise<OpenedFile> => {
  const handle = await NodeFSP.open(path, "r").catch((cause) => {
    throw new WindowsPackageError(
      path,
      isNotFound(cause) ? "missing" : "io",
      isNotFound(cause)
        ? "No Windows release executable exists. Export Windows first, then download the package."
        : `The Windows release file could not be opened: ${describe(cause)}`,
      { cause },
    );
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new WindowsPackageError(path, "invalid", "The Windows release path is not a file.");
    if (stat.size === 0)
      throw new WindowsPackageError(path, "invalid", "The Windows release file is empty.");
    return { path, handle, stat, size: Number(stat.size) };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
};

const openOptionalFile = async (path: string): Promise<OpenedFile | null> => {
  try {
    return await openFile(path);
  } catch (cause) {
    if (cause instanceof WindowsPackageError && cause.kind === "missing") return null;
    throw cause;
  }
};

const readFileRange = async (file: OpenedFile, offset: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await file.handle.read(buffer, read, length - read, offset + read);
    if (result.bytesRead === 0)
      throw new WindowsPackageError(
        file.path,
        "changed",
        "The Windows release file changed while it was being read. Export Windows again and retry.",
      );
    read += result.bytesRead;
  }
  return buffer;
};

const fileSource = (file: OpenedFile): WindowsBuildSource => ({
  size: file.size,
  read: (offset, length) => readFileRange(file, offset, length),
});

const fingerprint = (stat: OpenedFile["stat"]) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

const readSourceChunk = (file: OpenedFile, offset: number, length: number) =>
  readFileRange(file, offset, length);

interface ArchiveEntry {
  readonly name: string;
  readonly file: OpenedFile;
}

const writeArchive = async (input: {
  readonly path: string;
  readonly entries: readonly ArchiveEntry[];
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly WindowsPackageFile[];
}> => {
  try {
    return await writeStoredZip({
      path: input.path,
      signal: input.signal,
      entries: input.entries.map((entry) => ({
        name: entry.name,
        path: entry.file.path,
        size: entry.file.size,
        mtimeMs: Number(entry.file.stat.mtimeMs),
        read: (offset, length) => readSourceChunk(entry.file, offset, length),
      })),
    });
  } catch (cause) {
    if (cause instanceof StoredZipError)
      throw new WindowsPackageError(
        cause.path,
        cause.kind,
        cause.kind === "changed"
          ? "The Windows release file changed while it was being packaged. Export Windows again and retry."
          : "The Windows release is too large for a standard ZIP archive.",
        { cause },
      );
    throw cause;
  }
};

export type WindowsPackageFileSystem = ArchiveFileSystem;

const nativeFileSystem: ArchiveFileSystem = {
  rename: (from, to) => NodeFSP.rename(from, to),
  rm: (path, options) => NodeFSP.rm(path, options),
};

/** Windows-specific error shape around the shared atomic publish rename. */
export const publishWindowsArchive = async (
  input: { readonly stagedArchive: string; readonly archive: string },
  fileSystem: WindowsPackageFileSystem = nativeFileSystem,
): Promise<{ readonly notes: readonly string[] }> => {
  try {
    return await publishArchive(input, fileSystem);
  } catch (cause) {
    if (cause instanceof ArchivePublishError)
      throw new WindowsPackageError(cause.path, "io", cause.message, { cause });
    throw cause;
  }
};

export const packageWindowsRelease = async (input: {
  readonly root: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<WindowsPackageResult> => {
  throwIfAborted(input.signal);
  const directory = NodePath.join(input.root, "builds/windows");
  const executablePath = NodePath.join(directory, "game.exe");
  const pckPath = NodePath.join(directory, "game.pck");
  const archive = windowsPackageArchivePath(input.root);
  const executable = await openFile(executablePath);
  let pck: OpenedFile | null = null;
  let staged: string | null = null;
  try {
    pck = await openOptionalFile(pckPath);
    throwIfAborted(input.signal);
    const inspection: WindowsBuildInspection = await inspectWindowsBuildSource({
      executable: fileSource(executable),
      pck: pck === null ? null : fileSource(pck),
    });
    if (inspection.issues.length > 0)
      throw new WindowsPackageError(
        executablePath,
        "invalid",
        `The existing Windows release is not usable: ${inspection.issues.join(" ")} Export Windows again to replace it.`,
      );
    const entries: ArchiveEntry[] = [{ name: "game.exe", file: executable }];
    if (!inspection.embeddedPck && pck !== null) entries.push({ name: "game.pck", file: pck });
    const before = new Map(
      entries.map((entry) => [entry.name, fingerprint(entry.file.stat)] as const),
    );
    staged = NodePath.join(
      directory,
      `.${WINDOWS_PACKAGE_FILE}.${NodeCrypto.randomUUID()}.partial`,
    );
    const written = await writeArchive({
      path: staged,
      entries,
      signal: input.signal,
    });
    for (const entry of entries) {
      throwIfAborted(input.signal);
      const current = await entry.file.handle.stat();
      if (fingerprint(current) !== before.get(entry.name))
        throw new WindowsPackageError(
          entry.file.path,
          "changed",
          "The Windows release changed while it was being packaged. Export Windows again and retry.",
        );
      const atPath = await NodeFSP.stat(entry.file.path).catch(() => null);
      if (
        atPath === null ||
        !atPath.isFile() ||
        fingerprint(atPath) !== fingerprint(entry.file.stat)
      )
        throw new WindowsPackageError(
          entry.file.path,
          "changed",
          "The Windows release changed while it was being packaged. Export Windows again and retry.",
        );
    }
    throwIfAborted(input.signal);
    const stagedPath = staged;
    if (stagedPath === null)
      throw new WindowsPackageError(
        archive,
        "io",
        "The Windows package staging path was not created.",
      );
    const stagedStat = await NodeFSP.stat(stagedPath).catch((cause) => {
      throw new WindowsPackageError(
        stagedPath,
        "io",
        `The Windows package could not be read back before publication: ${describe(cause)}`,
        { cause },
      );
    });
    if (stagedStat.size !== written.bytes)
      throw new WindowsPackageError(
        stagedPath,
        "io",
        "The Windows package was not written completely. The previous package was kept; export Windows again and retry.",
      );
    const publication = await publishWindowsArchive({ stagedArchive: stagedPath, archive });
    staged = null;
    const archiveStat = await NodeFSP.stat(archive).catch((cause) => {
      throw new WindowsPackageError(
        archive,
        "io",
        `The Windows package was written but could not be read back: ${describe(cause)}`,
        { cause },
      );
    });
    const notes = [...publication.notes];
    if (archiveStat.size !== written.bytes)
      throw new WindowsPackageError(
        archive,
        "io",
        "The published Windows package size does not match the bytes written. Export Windows again and package it again.",
      );
    return {
      archivePath: archive,
      fileName: WINDOWS_PACKAGE_FILE,
      bytes: written.bytes,
      sha256: written.sha256,
      files: written.files,
      embeddedPck: inspection.embeddedPck,
      executableBytes: inspection.executableBytes,
      pckBytes: inspection.pckBytes,
      pckFileCount: inspection.pckFileCount,
      notes,
    };
  } finally {
    if (staged !== null) await NodeFSP.rm(staged, { force: true }).catch(() => undefined);
    await pck?.handle.close().catch(() => undefined);
    await executable.handle.close().catch(() => undefined);
  }
};
