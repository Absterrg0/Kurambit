// @effect-diagnostics nodeBuiltinImport:off -- Reads an exported executable and pack through file handles.
import * as NodeFSP from "node:fs/promises";
/**
 * What a Windows release export must prove before it replaces an earlier one:
 * a 64-bit PE executable, and a Godot pack that still contains the project.
 * This reads only the structures Godot's own loader reads. It says nothing
 * about whether Windows can start the game, which needs a Windows host.
 *
 * Reads are sequential over a source so packaging can check a large release
 * from disk without holding the whole executable or pack in memory.
 */
export interface WindowsBuildInspection {
  readonly embeddedPck: boolean;
  readonly executableBytes: number;
  readonly pckBytes: number;
  readonly pckFileCount: number;
  readonly issues: readonly string[];
}

/** A random-access byte source: a checked artifact in memory, or a file on disk. */
export interface WindowsBuildSource {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Uint8Array>;
}

const PCK_MAGIC = 0x43504447; // "GDPC" little-endian.
const PE_HEADER_MAGIC = 0x00004550;
const PE32_PLUS_MAGIC = 0x020b;
const X86_64_MACHINE = 0x8664;

const u16 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
const u32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
const u64 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);

const readAt = async (
  source: WindowsBuildSource,
  offset: number,
  length: number,
): Promise<Uint8Array | null> => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > source.size
  )
    return null;
  const bytes = await source.read(offset, length);
  return bytes.byteLength === length ? bytes : null;
};

interface PeHeader {
  readonly peOffset: number;
  readonly machine: number;
  readonly optionalMagic: number;
  readonly sectionCount: number;
  readonly sectionTable: number;
}

const readPeHeader = async (source: WindowsBuildSource): Promise<PeHeader | null> => {
  const dos = await readAt(source, 0, 0x40);
  if (dos === null || dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
  const peOffset = u32(dos, 0x3c);
  const pe = await readAt(source, peOffset, 26);
  if (pe === null || u32(pe, 0) !== PE_HEADER_MAGIC) return null;
  const sectionCount = u16(pe, 6);
  const optionalSize = u16(pe, 20);
  const sectionTable = peOffset + 24 + optionalSize;
  if (sectionCount === 0 || sectionTable + sectionCount * 40 > source.size) return null;
  return {
    peOffset,
    machine: u16(pe, 4),
    optionalMagic: u16(pe, 24),
    sectionCount,
    sectionTable,
  };
};

const peSection = async (
  source: WindowsBuildSource,
  header: PeHeader,
  name: string,
): Promise<{ readonly offset: number; readonly size: number } | null> => {
  for (let index = 0; index < header.sectionCount; index++) {
    const section = await readAt(source, header.sectionTable + index * 40, 40);
    if (section === null) return null;
    const sectionName = new TextDecoder().decode(section.subarray(0, 8)).replace(/\0.*$/, "");
    if (sectionName !== name) continue;
    const size = u32(section, 16);
    const offset = u32(section, 20);
    if (offset + size > source.size) return null;
    return { offset, size };
  }
  return null;
};

/** Returns what the pack directory proves, or a reason the pack cannot be trusted. */
const readPckDirectory = async (
  source: WindowsBuildSource,
  start: number,
): Promise<
  { readonly fileCount: number; readonly hasProjectBinary: boolean } | { readonly issue: string }
> => {
  const header = await readAt(source, start, 40);
  if (header === null) return { issue: "The Godot pack header is truncated." };
  if (u32(header, 0) !== PCK_MAGIC)
    return { issue: "The Godot pack header is missing from the embedded data." };
  const version = u32(header, 4);
  if (version < 2 || version > 4) return { issue: `Unsupported Godot pack version ${version}.` };
  const flags = u32(header, 20);
  if ((flags & 1) !== 0) return { issue: "The pack directory is encrypted and cannot be checked." };
  const fileBase = Number(u64(header, 24)) + (version >= 3 || (flags & 2) !== 0 ? start : 0);
  const directory = version >= 3 ? start + Number(u64(header, 32)) : start + 24 + 8 + 16 * 4;
  const countBytes = await readAt(source, directory, 4);
  if (countBytes === null) return { issue: "The Godot pack directory is truncated." };
  const count = u32(countBytes, 0);
  if (count === 0 || count > 200_000) return { issue: `The Godot pack lists ${count} files.` };
  let cursor = directory + 4;
  let hasProjectBinary = false;
  for (let index = 0; index < count; index++) {
    const lengthBytes = await readAt(source, cursor, 4);
    if (lengthBytes === null) return { issue: "The Godot pack directory is truncated." };
    const length = u32(lengthBytes, 0);
    cursor += 4;
    if (length > 4096) return { issue: "The Godot pack directory is truncated." };
    const pathBytes = await readAt(source, cursor, length);
    if (pathBytes === null) return { issue: "The Godot pack directory is truncated." };
    const path = new TextDecoder().decode(pathBytes);
    cursor += length;
    const entry = await readAt(source, cursor, 36);
    if (entry === null) return { issue: "The Godot pack directory is truncated." };
    const offset = Number(u64(entry, 0));
    const size = Number(u64(entry, 8));
    const entryFlags = u32(entry, 32);
    cursor += 36;
    if (!Number.isSafeInteger(fileBase + offset + size))
      return { issue: "The Godot pack directory is truncated." };
    if ((entryFlags & 1) === 0 && fileBase + offset + size > source.size)
      return { issue: `The Godot pack entry ${path} is truncated.` };
    if (path.replace(/\0+$/, "") === "project.binary") hasProjectBinary = true;
  }
  return { fileCount: count, hasProjectBinary };
};

export const inspectWindowsBuildSource = async (input: {
  readonly executable: WindowsBuildSource;
  readonly pck: WindowsBuildSource | null;
}): Promise<WindowsBuildInspection> => {
  const issues: string[] = [];
  try {
    const pe = await readPeHeader(input.executable);
    if (pe === null) issues.push("The Windows artifact is not a PE executable.");
    else {
      if (pe.machine !== X86_64_MACHINE)
        issues.push("The Windows artifact is not an x86_64 executable.");
      if (pe.optionalMagic !== PE32_PLUS_MAGIC)
        issues.push("The Windows artifact is not a 64-bit Windows executable.");
    }
    const section = pe === null ? null : await peSection(input.executable, pe, "pck");
    let embeddedPck = false;
    let pckBytes = 0;
    let pckFileCount = 0;
    let pckDirectory: Awaited<ReturnType<typeof readPckDirectory>> | null = null;
    if (section !== null) {
      // The section is aligned; Godot itself searches the first few bytes for the magic.
      const head = await readAt(
        input.executable,
        section.offset,
        Math.min(8, section.size, input.executable.size - section.offset),
      );
      let start = -1;
      if (head !== null)
        for (let offset = 0; offset + 4 <= head.byteLength; offset++)
          if (u32(head, offset) === PCK_MAGIC) {
            start = section.offset + offset;
            break;
          }
      if (start === -1) issues.push("The executable's pck section has no Godot pack header.");
      else {
        embeddedPck = true;
        pckBytes = section.size;
        pckDirectory = await readPckDirectory(input.executable, start);
      }
    } else if (input.pck === null) {
      issues.push("The Windows build has no embedded pack and no .pck file next to it.");
    } else {
      pckBytes = input.pck.size;
      pckDirectory = await readPckDirectory(input.pck, 0);
    }
    if (pckDirectory !== null && "issue" in pckDirectory) issues.push(pckDirectory.issue);
    if (pckDirectory !== null && "fileCount" in pckDirectory) {
      pckFileCount = pckDirectory.fileCount;
      if (!pckDirectory.hasProjectBinary)
        issues.push("The Godot pack does not contain project.binary, so it is not this game.");
    }
    return {
      embeddedPck,
      executableBytes: input.executable.size,
      pckBytes,
      pckFileCount,
      issues,
    };
  } catch (cause) {
    return {
      embeddedPck: false,
      executableBytes: input.executable.size,
      pckBytes: input.pck?.size ?? 0,
      pckFileCount: 0,
      issues: [cause instanceof Error ? cause.message : "The Windows artifact could not be read."],
    };
  }
};

/**
 * Inspects an exported executable and its optional `.pck` sidecar through file
 * handles, a chunk at a time: an embedded pack makes the executable as large
 * as the game, so it is never read whole. A missing sidecar reads as none.
 * The standard preset embeds the pack so one .exe is enough; a custom
 * non-embedded preset needs both files kept together.
 */
export const inspectWindowsBuildFiles = async (input: {
  readonly executable: string;
  readonly pck: string;
}): Promise<WindowsBuildInspection> => {
  const open = async (path: string) => {
    const handle = await NodeFSP.open(path, "r");
    const size = (await handle.stat()).size;
    const source: WindowsBuildSource = {
      size,
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      },
    };
    return { handle, source };
  };
  const executable = await open(input.executable);
  const pck = await open(input.pck).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  try {
    return await inspectWindowsBuildSource({
      executable: executable.source,
      pck: pck?.source ?? null,
    });
  } finally {
    await executable.handle.close().catch(() => undefined);
    await pck?.handle.close().catch(() => undefined);
  }
};
