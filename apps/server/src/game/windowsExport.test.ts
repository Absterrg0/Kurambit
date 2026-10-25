import { it, expect } from "@effect/vitest";
import { inspectWindowsBuild } from "./windowsExport.ts";
import { windowsExecutable as pe, windowsPck as pck } from "./windowsExport.testkit.ts";

it("accepts an x86_64 executable whose embedded pack still has the project", async () => {
  const inspection = await inspectWindowsBuild({
    executable: pe(pck(["project.binary", "scenes/main.tscn"])),
    pck: null,
  });
  expect(inspection.issues).toEqual([]);
  expect(inspection.embeddedPck).toBe(true);
  expect(inspection.pckFileCount).toBe(2);
});

it("rejects a pack that no longer contains project.binary", async () => {
  const inspection = await inspectWindowsBuild({
    executable: pe(pck(["scenes/main.tscn"])),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("project.binary");
});

it("rejects a 32-bit executable", async () => {
  const inspection = await inspectWindowsBuild({
    executable: pe(pck(["project.binary"]), 0x014c),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("x86_64");
});

it("rejects a truncated embedded pack", async () => {
  const complete = pe(pck(["project.binary"]));
  const inspection = await inspectWindowsBuild({
    executable: complete.subarray(0, complete.length - 8),
    pck: null,
  });
  expect(inspection.issues.length).toBeGreaterThan(0);
});

it("accepts a non-embedded build only when its .pck sidecar is present", async () => {
  const executable = pe(null);
  const withSidecar = await inspectWindowsBuild({
    executable,
    pck: pck(["project.binary"]),
  });
  expect(withSidecar.issues).toEqual([]);
  expect(withSidecar.embeddedPck).toBe(false);
  expect((await inspectWindowsBuild({ executable, pck: null })).issues.join(" ")).toContain(".pck");
});

it("rejects an executable whose pck section is not a Godot pack", async () => {
  const inspection = await inspectWindowsBuild({
    executable: pe(new Uint8Array(32)),
    pck: null,
  });
  expect(inspection.issues.join(" ")).toContain("Godot pack header");
});
