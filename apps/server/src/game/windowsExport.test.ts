import { it, expect } from "@effect/vitest";
import { inspectWindowsBuild } from "./windowsExport.ts";

const pckHeaderSize = 96;
const pck = (paths: readonly string[]): Uint8Array => {
  const encoded = paths.map((path) => {
    const bytes = new TextEncoder().encode(path);
    return { bytes, padded: Math.ceil(bytes.length / 4) * 4 };
  });
  const directorySize =
    4 + encoded.reduce((size, entry) => size + 4 + entry.padded + 8 + 8 + 16 + 4, 0);
  const bytes = new Uint8Array(pckHeaderSize + directorySize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x43504447, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 4, true);
  view.setUint32(12, 7, true);
  view.setUint32(16, 2, true);
  view.setUint32(20, 2, true); // PACK_REL_FILEBASE
  view.setBigUint64(24, BigInt(pckHeaderSize), true);
  view.setBigUint64(32, BigInt(pckHeaderSize), true);
  view.setUint32(pckHeaderSize, paths.length, true);
  let cursor = pckHeaderSize + 4;
  for (const entry of encoded) {
    view.setUint32(cursor, entry.padded, true);
    cursor += 4;
    bytes.set(entry.bytes, cursor);
    cursor += entry.padded;
    view.setBigUint64(cursor, 0n, true);
    view.setBigUint64(cursor + 8, BigInt(entry.bytes.length), true);
    cursor += 8 + 8 + 16;
    view.setUint32(cursor, 0, true);
    cursor += 4;
  }
  return bytes;
};

const pe = (embed: Uint8Array | null, machine = 0x8664): Uint8Array => {
  const sectionOffset = 0x200;
  const bytes = new Uint8Array(sectionOffset + (embed?.length ?? 0));
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x00004550, true);
  view.setUint16(0x84, machine, true);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xf0, true);
  view.setUint16(0x98, 0x020b, true);
  const section = 0x80 + 24 + 0xf0;
  bytes.set(new TextEncoder().encode(embed === null ? "text" : "pck"), section);
  view.setUint32(section + 16, embed?.length ?? 0, true);
  view.setUint32(section + 20, embed === null ? 0 : sectionOffset, true);
  if (embed !== null) bytes.set(embed, sectionOffset);
  return bytes;
};

it("accepts an x86_64 executable whose embedded pack still has the project", () => {
  const inspection = inspectWindowsBuild({
    executable: pe(pck(["project.binary", "scenes/main.tscn"])),
    pck: null,
  });
  expect(inspection.issues).toEqual([]);
  expect(inspection.embeddedPck).toBe(true);
  expect(inspection.pckFileCount).toBe(2);
});

it("rejects a pack that no longer contains project.binary", () => {
  const inspection = inspectWindowsBuild({
    executable: pe(pck(["scenes/main.tscn"])),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("project.binary");
});

it("rejects a 32-bit executable", () => {
  const inspection = inspectWindowsBuild({
    executable: pe(pck(["project.binary"]), 0x014c),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("x86_64");
});

it("rejects a truncated embedded pack", () => {
  const complete = pe(pck(["project.binary"]));
  const inspection = inspectWindowsBuild({
    executable: complete.subarray(0, complete.length - 8),
    pck: null,
  });
  expect(inspection.issues.length).toBeGreaterThan(0);
});

it("accepts a non-embedded build only when its .pck sidecar is present", () => {
  const executable = pe(null);
  const withSidecar = inspectWindowsBuild({
    executable,
    pck: pck(["project.binary"]),
  });
  expect(withSidecar.issues).toEqual([]);
  expect(withSidecar.embeddedPck).toBe(false);
  expect(inspectWindowsBuild({ executable, pck: null }).issues.join(" ")).toContain(".pck");
});

it("rejects an executable whose pck section is not a Godot pack", () => {
  const inspection = inspectWindowsBuild({
    executable: pe(new Uint8Array(32)),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("Godot pack header");
});
