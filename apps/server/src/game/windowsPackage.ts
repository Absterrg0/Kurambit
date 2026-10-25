// @effect-diagnostics nodeBuiltinImport:off -- Packaging streams the exported release files from disk into an archive next to them.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import {
  inspectWindowsBuildSource,
  type WindowsBuildInspection,
  type WindowsBuildSource,
} from "./windowsExport.ts";

export const WINDOWS_PACKAGE_FILE = "game-windows.zip";
const ZIP_CHUNK_BYTES = 1024 * 1024;
const ZIP32_MAX = 0xffffffff;

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

const fileSource = (file: OpenedFile): WindowsBuildSource => ({
  size: file.size,
  read: async (offset, length) => {
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
  },
});

const fingerprint = (stat: OpenedFile["stat"]) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted === true)
    throw new DOMException("The Windows package was cancelled.", "AbortError");
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array, crc = 0xffffffff) => {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
};

const dosDateTime = (mtimeMs: number) => {
  const safe = DateTime.toDate(
    DateTime.makeUnsafe(Number.isFinite(mtimeMs) ? mtimeMs : "1980-01-01T00:00:00.000Z"),
  );
  const year = Math.min(2107, Math.max(1980, safe.getFullYear()));
  return {
    time: (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate(),
  };
};

interface ArchiveEntry {
  readonly name: string;
  readonly file: OpenedFile;
}

interface EntryDigest {
  readonly crc: number;
  readonly sha256: string;
  readonly bytes: number;
}

const digestEntry = async (entry: ArchiveEntry, signal: AbortSignal | undefined) => {
  const buffer = Buffer.allocUnsafe(ZIP_CHUNK_BYTES);
  const hash = NodeCrypto.createHash("sha256");
  let crc = 0xffffffff;
  let offset = 0;
  while (offset < entry.file.size) {
    throwIfAborted(signal);
    const wanted = Math.min(ZIP_CHUNK_BYTES, entry.file.size - offset);
    const result = await entry.file.handle.read(buffer, 0, wanted, offset);
    if (result.bytesRead === 0)
      throw new WindowsPackageError(
        entry.file.path,
        "changed",
        "The Windows release file changed while it was being packaged. Export Windows again and retry.",
      );
    const chunk = buffer.subarray(0, result.bytesRead);
    crc = crc32(chunk, crc);
    hash.update(chunk);
    offset += result.bytesRead;
  }
  if (offset !== entry.file.size)
    throw new WindowsPackageError(
      entry.file.path,
      "changed",
      "The Windows release file changed while it was being packaged. Export Windows again and retry.",
    );
  return { crc: (crc ^ 0xffffffff) >>> 0, sha256: hash.digest("hex"), bytes: offset };
};

const writeAll = async (handle: NodeFSP.FileHandle, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += result.bytesWritten;
  }
};

const zipEntryHeader = (input: {
  readonly name: Buffer;
  readonly crc: number;
  readonly bytes: number;
  readonly time: number;
  readonly date: number;
}) => {
  const header = Buffer.alloc(30 + input.name.byteLength);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names, sizes are in the header.
  header.writeUInt16LE(0, 8); // Stored, not deflated: engine artifacts are already compressed.
  header.writeUInt16LE(input.time, 10);
  header.writeUInt16LE(input.date, 12);
  header.writeUInt32LE(input.crc, 14);
  header.writeUInt32LE(input.bytes, 18);
  header.writeUInt32LE(input.bytes, 22);
  header.writeUInt16LE(input.name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  input.name.copy(header, 30);
  return header;
};

const zipCentralHeader = (input: {
  readonly name: Buffer;
  readonly crc: number;
  readonly bytes: number;
  readonly time: number;
  readonly date: number;
  readonly localOffset: number;
}) => {
  const header = Buffer.alloc(46 + input.name.byteLength);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(input.time, 12);
  header.writeUInt16LE(input.date, 14);
  header.writeUInt32LE(input.crc, 16);
  header.writeUInt32LE(input.bytes, 20);
  header.writeUInt32LE(input.bytes, 24);
  header.writeUInt16LE(input.name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(input.localOffset, 42);
  input.name.copy(header, 46);
  return header;
};

const zipEnd = (entries: number, centralBytes: number, centralOffset: number) => {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
};

const writeArchive = async (input: {
  readonly path: string;
  readonly entries: readonly ArchiveEntry[];
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly WindowsPackageFile[];
}> => {
  const digests = new Map<string, EntryDigest>();
  for (const entry of input.entries) {
    throwIfAborted(input.signal);
    digests.set(entry.name, await digestEntry(entry, input.signal));
  }
  const handle = await NodeFSP.open(input.path, "wx", 0o600);
  const archiveHash = NodeCrypto.createHash("sha256");
  const central: Buffer[] = [];
  let archiveBytes = 0;
  let centralBytes = 0;
  let centralOffset = 0;
  try {
    const write = async (bytes: Uint8Array) => {
      await writeAll(handle, bytes);
      archiveHash.update(bytes);
      archiveBytes += bytes.byteLength;
    };
    for (const entry of input.entries) {
      throwIfAborted(input.signal);
      const digest = digests.get(entry.name)!;
      if (digest.bytes > ZIP32_MAX || archiveBytes > ZIP32_MAX)
        throw new WindowsPackageError(
          entry.file.path,
          "invalid",
          "The Windows release is too large for a standard ZIP archive.",
        );
      const name = Buffer.from(entry.name, "utf8");
      const dates = dosDateTime(Number(entry.file.stat.mtimeMs));
      const localOffset = archiveBytes;
      await write(
        zipEntryHeader({
          name,
          crc: digest.crc,
          bytes: digest.bytes,
          time: dates.time,
          date: dates.date,
        }),
      );
      const buffer = Buffer.allocUnsafe(ZIP_CHUNK_BYTES);
      const hash = NodeCrypto.createHash("sha256");
      let offset = 0;
      while (offset < digest.bytes) {
        throwIfAborted(input.signal);
        const wanted = Math.min(ZIP_CHUNK_BYTES, digest.bytes - offset);
        const result = await entry.file.handle.read(buffer, 0, wanted, offset);
        if (result.bytesRead === 0)
          throw new WindowsPackageError(
            entry.file.path,
            "changed",
            "The Windows release file changed while it was being packaged. Export Windows again and retry.",
          );
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        await write(chunk);
        offset += result.bytesRead;
      }
      if (offset !== digest.bytes || hash.digest("hex") !== digest.sha256)
        throw new WindowsPackageError(
          entry.file.path,
          "changed",
          "The Windows release file changed while it was being packaged. Export Windows again and retry.",
        );
      central.push(
        zipCentralHeader({
          name,
          crc: digest.crc,
          bytes: digest.bytes,
          time: dates.time,
          date: dates.date,
          localOffset,
        }),
      );
    }
    centralOffset = archiveBytes;
    for (const header of central) {
      await write(header);
      centralBytes += header.byteLength;
    }
    if (input.entries.length > 0xffff || archiveBytes > ZIP32_MAX || centralBytes > ZIP32_MAX)
      throw new WindowsPackageError(
        input.path,
        "invalid",
        "The Windows release is too large for a standard ZIP archive.",
      );
    await write(zipEnd(input.entries.length, centralBytes, centralOffset));
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  throwIfAborted(input.signal);
  return {
    bytes: archiveBytes,
    sha256: archiveHash.digest("hex"),
    files: input.entries.map((entry) => {
      const digest = digests.get(entry.name)!;
      return { name: entry.name, bytes: digest.bytes, sha256: digest.sha256 };
    }),
  };
};

export interface WindowsPackageFileSystem {
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { readonly force?: boolean }): Promise<void>;
}

const nativeFileSystem: WindowsPackageFileSystem = {
  rename: (from, to) => NodeFSP.rename(from, to),
  rm: (path, options) => NodeFSP.rm(path, options),
};

/**
 * Rename is the commit point. POSIX replaces the incumbent in one step; where
 * rename refuses an existing destination, the incumbent is moved aside first
 * and restored if the new archive cannot take its place.
 */
export const publishWindowsArchive = async (
  input: { readonly stagedArchive: string; readonly archive: string },
  fileSystem: WindowsPackageFileSystem = nativeFileSystem,
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
        throw new WindowsPackageError(
          input.archive,
          "io",
          `The previous Windows package could not be moved aside, so the new one was not published: ${describe(error)}`,
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
          throw new WindowsPackageError(
            backup,
            "io",
            `The new Windows package could not be moved into place, and the previous package is preserved at ${backup} instead of ${input.archive}: ${describe(restoreError)}`,
            { cause: restoreError },
          );
        }
      }
      throw new WindowsPackageError(
        input.archive,
        "io",
        "The new Windows package could not be moved into place. The previous package was kept if one existed.",
        { cause: error },
      );
    }
    const notes: string[] = [];
    if (backedUp)
      await fileSystem.rm(backup, { force: true }).catch(() => {
        notes.push(`An older Windows package remains at ${backup}.`);
      });
    return { notes };
  }
};

export interface WindowsArchiveRetirement {
  readonly backup: string;
  /** Puts the incumbent archive back after a publication that did not commit. */
  restore(): Promise<void>;
  /** Removes the retired incumbent after the new release committed. */
  discard(): Promise<readonly string[]>;
}

/**
 * Moves the incumbent package out of its download path before a new Windows
 * release is published. A publication failure restores it; a success discards
 * it, so the package URL can never resolve to bytes from the previous release.
 */
export const retireWindowsArchive = async (
  input: { readonly archive: string },
  fileSystem: WindowsPackageFileSystem = nativeFileSystem,
): Promise<WindowsArchiveRetirement | null> => {
  const backup = `${input.archive}.${NodeCrypto.randomUUID()}.retired`;
  try {
    await fileSystem.rename(input.archive, backup);
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw new WindowsPackageError(
      input.archive,
      "io",
      `The previous Windows package could not be moved aside, so the new release was not published: ${describe(cause)}`,
      { cause },
    );
  }
  return {
    backup,
    async restore() {
      try {
        await fileSystem.rename(backup, input.archive);
      } catch (cause) {
        throw new WindowsPackageError(
          backup,
          "io",
          `The previous Windows package is preserved at ${backup} but could not be restored to ${input.archive}: ${describe(cause)}`,
          { cause },
        );
      }
    },
    async discard() {
      try {
        await fileSystem.rm(backup, { force: true });
        return [];
      } catch {
        return [`An older Windows package remains at ${backup} because it could not be removed.`];
      }
    },
  };
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
