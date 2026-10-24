/**
 * What a Windows release export must prove before it replaces an earlier one:
 * a 64-bit PE executable, and a Godot pack that still contains the project.
 * This reads only the structures Godot's own loader reads. It says nothing
 * about whether Windows can start the game, which needs a Windows host.
 */
export interface WindowsBuildInspection {
  readonly embeddedPck: boolean;
  readonly executableBytes: number;
  readonly pckBytes: number;
  readonly pckFileCount: number;
  readonly issues: readonly string[];
}

const PCK_MAGIC = 0x43504447; // "GDPC" little-endian.
const PE_HEADER_MAGIC = 0x00004550;
const PE32_PLUS_MAGIC = 0x020b;
const X86_64_MACHINE = 0x8664;

interface ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
}

const readerFor = (bytes: Uint8Array): ByteReader => ({
  bytes,
  view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
});
const u16 = (reader: ByteReader, offset: number) => reader.view.getUint16(offset, true);
const u32 = (reader: ByteReader, offset: number) => reader.view.getUint32(offset, true);
const u64 = (reader: ByteReader, offset: number) => reader.view.getBigUint64(offset, true);

interface PeHeader {
  readonly peOffset: number;
  readonly machine: number;
  readonly optionalMagic: number;
  readonly sectionCount: number;
  readonly sectionTable: number;
}

const readPeHeader = (reader: ByteReader): PeHeader | null => {
  if (reader.bytes.length < 0x40 || reader.bytes[0] !== 0x4d || reader.bytes[1] !== 0x5a)
    return null;
  const peOffset = u32(reader, 0x3c);
  if (peOffset + 24 > reader.bytes.length || u32(reader, peOffset) !== PE_HEADER_MAGIC) return null;
  const sectionCount = u16(reader, peOffset + 6);
  const optionalSize = u16(reader, peOffset + 20);
  const sectionTable = peOffset + 24 + optionalSize;
  if (sectionCount === 0 || sectionTable + sectionCount * 40 > reader.bytes.length) return null;
  return {
    peOffset,
    machine: u16(reader, peOffset + 4),
    optionalMagic: u16(reader, peOffset + 24),
    sectionCount,
    sectionTable,
  };
};

const peSection = (
  reader: ByteReader,
  header: PeHeader,
  name: string,
): { readonly offset: number; readonly size: number } | null => {
  for (let index = 0; index < header.sectionCount; index++) {
    const section = header.sectionTable + index * 40;
    const sectionName = new TextDecoder()
      .decode(reader.bytes.subarray(section, section + 8))
      .replace(/\0.*$/, "");
    if (sectionName !== name) continue;
    const size = u32(reader, section + 16);
    const offset = u32(reader, section + 20);
    if (offset + size > reader.bytes.length) return null;
    return { offset, size };
  }
  return null;
};

/** Returns the pack's file paths, or a reason the pack cannot be trusted. */
const readPckDirectory = (
  bytes: Uint8Array,
  start: number,
): { readonly files: string[] } | { readonly issue: string } => {
  const reader = readerFor(bytes);
  if (start + 40 > bytes.length) return { issue: "The Godot pack header is truncated." };
  if (u32(reader, start) !== PCK_MAGIC)
    return { issue: "The Godot pack header is missing from the embedded data." };
  const version = u32(reader, start + 4);
  if (version < 2 || version > 4) return { issue: `Unsupported Godot pack version ${version}.` };
  const flags = u32(reader, start + 20);
  if ((flags & 1) !== 0) return { issue: "The pack directory is encrypted and cannot be checked." };
  const fileBase =
    Number(u64(reader, start + 24)) + (version >= 3 || (flags & 2) !== 0 ? start : 0);
  const directory =
    version >= 3 ? start + Number(u64(reader, start + 32)) : start + 24 + 8 + 16 * 4;
  if (directory + 4 > bytes.length) return { issue: "The Godot pack directory is truncated." };
  const count = u32(reader, directory);
  if (count === 0 || count > 200_000) return { issue: `The Godot pack lists ${count} files.` };
  const files: string[] = [];
  let cursor = directory + 4;
  for (let index = 0; index < count; index++) {
    if (cursor + 4 > bytes.length) return { issue: "The Godot pack directory is truncated." };
    const length = u32(reader, cursor);
    cursor += 4;
    if (length > 4096 || cursor + length + 8 + 8 + 16 + 4 > bytes.length)
      return { issue: "The Godot pack directory is truncated." };
    const path = new TextDecoder().decode(bytes.subarray(cursor, cursor + length));
    cursor += length;
    const offset = Number(u64(reader, cursor));
    const size = Number(u64(reader, cursor + 8));
    cursor += 8 + 8 + 16;
    const entryFlags = u32(reader, cursor);
    cursor += 4;
    if ((entryFlags & 1) === 0 && fileBase + offset + size > bytes.length)
      return { issue: `The Godot pack entry ${path} is truncated.` };
    files.push(path.replace(/\0+$/, ""));
  }
  return { files };
};

/**
 * `pck` is the sidecar a non-embedded export writes. The standard preset embeds
 * the pack so one .exe is enough; a custom non-embedded preset needs both files
 * kept together.
 */
export const inspectWindowsBuild = (input: {
  readonly executable: Uint8Array;
  readonly pck: Uint8Array | null;
}): WindowsBuildInspection => {
  const issues: string[] = [];
  const reader = readerFor(input.executable);
  const pe = readPeHeader(reader);
  if (pe === null) issues.push("The Windows artifact is not a PE executable.");
  else {
    if (pe.machine !== X86_64_MACHINE)
      issues.push("The Windows artifact is not an x86_64 executable.");
    if (pe.optionalMagic !== PE32_PLUS_MAGIC)
      issues.push("The Windows artifact is not a 64-bit Windows executable.");
  }
  const section = pe === null ? null : peSection(reader, pe, "pck");
  let embeddedPck = false;
  let pckBytes = 0;
  let pckFileCount = 0;
  let pckDirectory: { readonly files: string[] } | { readonly issue: string } | null = null;
  if (section !== null) {
    // The section is aligned; Godot itself searches the first few bytes for the magic.
    let start = -1;
    for (let offset = 0; offset < 8; offset++)
      if (
        section.offset + offset + 4 <= input.executable.length &&
        u32(reader, section.offset + offset) === PCK_MAGIC
      ) {
        start = section.offset + offset;
        break;
      }
    if (start === -1) issues.push("The executable's pck section has no Godot pack header.");
    else {
      embeddedPck = true;
      pckBytes = section.size;
      pckDirectory = readPckDirectory(input.executable, start);
    }
  } else if (input.pck === null) {
    issues.push("The Windows build has no embedded pack and no .pck file next to it.");
  } else {
    pckBytes = input.pck.length;
    pckDirectory = readPckDirectory(input.pck, 0);
  }
  if (pckDirectory !== null && "issue" in pckDirectory) issues.push(pckDirectory.issue);
  if (pckDirectory !== null && "files" in pckDirectory) {
    pckFileCount = pckDirectory.files.length;
    if (!pckDirectory.files.includes("project.binary"))
      issues.push("The Godot pack does not contain project.binary, so it is not this game.");
  }
  return {
    embeddedPck,
    executableBytes: input.executable.length,
    pckBytes,
    pckFileCount,
    issues,
  };
};
