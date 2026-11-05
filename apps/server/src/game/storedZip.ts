// @effect-diagnostics nodeBuiltinImport:off -- The ZIP writer streams archive entries from the native filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";
import * as DateTime from "effect/DateTime";

const ZIP_CHUNK_BYTES = 1024 * 1024;
const ZIP32_MAX = 0xffffffff;

/** One file to store, addressed by its path inside the archive. */
export interface StoredZipEntry {
  readonly name: string;
  /** Source path, used only to name the file that failed. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** When set, a changed source file is rejected instead of archived. */
  readonly sha256?: string | undefined;
  readonly read: (offset: number, length: number) => Promise<Buffer>;
}

export interface StoredZipFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class StoredZipError extends Error {
  readonly path: string;
  readonly kind: "invalid" | "changed";
  constructor(path: string, kind: "invalid" | "changed", message: string) {
    super(message);
    this.name = "StoredZipError";
    this.path = path;
    this.kind = kind;
  }
}

export const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted === true) throw new DOMException("The package was cancelled.", "AbortError");
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

interface EntryDigest {
  readonly crc: number;
  readonly sha256: string;
  readonly bytes: number;
}

const digestEntry = async (entry: StoredZipEntry, signal: AbortSignal | undefined) => {
  const hash = NodeCrypto.createHash("sha256");
  // zlib keeps the pre- and post-inversion itself: each call continues the last.
  let crc = 0;
  let offset = 0;
  while (offset < entry.size) {
    throwIfAborted(signal);
    const wanted = Math.min(ZIP_CHUNK_BYTES, entry.size - offset);
    const chunk = await entry.read(offset, wanted);
    if (chunk.byteLength === 0)
      throw new StoredZipError(
        entry.path,
        "changed",
        "The file changed while it was being read, so no package was written.",
      );
    crc = NodeZlib.crc32(chunk, crc);
    hash.update(chunk);
    offset += chunk.byteLength;
  }
  const sha256 = hash.digest("hex");
  if (entry.sha256 !== undefined && entry.sha256 !== sha256)
    throw new StoredZipError(
      entry.path,
      "changed",
      "The file changed while it was being packaged, so no package was written.",
    );
  return { crc, sha256, bytes: offset };
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

/**
 * Writes a classic stored ZIP without loading entry bytes into memory. The
 * caller supplies an already isolated staging path; this function never
 * publishes it. Limits that a classic ZIP cannot represent fail explicitly.
 */
export const writeStoredZip = async (input: {
  readonly path: string;
  readonly entries: readonly StoredZipEntry[];
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly bytes: number;
  readonly sha256: string;
  readonly files: readonly StoredZipFile[];
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
        throw new StoredZipError(
          entry.path,
          "invalid",
          "The build is too large for a standard ZIP archive.",
        );
      const name = Buffer.from(entry.name, "utf8");
      const dates = dosDateTime(entry.mtimeMs);
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
      const hash = NodeCrypto.createHash("sha256");
      let offset = 0;
      while (offset < digest.bytes) {
        throwIfAborted(input.signal);
        const wanted = Math.min(ZIP_CHUNK_BYTES, digest.bytes - offset);
        const chunk = await entry.read(offset, wanted);
        if (chunk.byteLength === 0)
          throw new StoredZipError(
            entry.path,
            "changed",
            "The file changed while it was being packaged, so no package was written.",
          );
        hash.update(chunk);
        await write(chunk);
        offset += chunk.byteLength;
      }
      if (offset !== digest.bytes || hash.digest("hex") !== digest.sha256)
        throw new StoredZipError(
          entry.path,
          "changed",
          "The file changed while it was being packaged, so no package was written.",
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
      throw new StoredZipError(
        input.path,
        "invalid",
        "The build is too large for a standard ZIP archive.",
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
