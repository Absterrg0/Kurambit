// @effect-diagnostics nodeBuiltinImport:off -- Proves a critique always answers the sheet beside it.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { heroSheetProblems, keepHeroSheet } from "./heroSheets.ts";

const CRITIQUE = `Brief: a cozy fisherman.\n1. The beanie reads; the scarf is too thin at game distance: thickened.\n2. Nothing blocking left.\n`;

it("keeps a critique for the same sheet and moves it aside for a new one", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hero-sheets-"));
  try {
    const paths = { assets: "web/assets", library: "web/assets/library" };
    const review = NodePath.join(root, "review.png");
    await NodeFSP.writeFile(review, "first");
    const sheet = await keepHeroSheet(root, "Bram", review);
    expect(sheet).toBe("art/sheets/Bram.png");
    expect((await heroSheetProblems(root, paths)).problems).toHaveLength(1);
    await NodeFSP.writeFile(NodePath.join(root, "art/sheets/Bram.md"), CRITIQUE);
    expect((await heroSheetProblems(root, paths)).problems).toEqual([]);
    // The export keeps the review it shipped: the same picture, so the critique still answers it.
    await keepHeroSheet(root, "Bram", review);
    expect((await heroSheetProblems(root, paths)).problems).toEqual([]);
    // A changed model's sheet needs a new critique; the old one is kept beside it.
    await NodeFSP.writeFile(review, "second");
    await keepHeroSheet(root, "Bram", review);
    expect((await heroSheetProblems(root, paths)).problems).toHaveLength(1);
    expect(await NodeFSP.readFile(NodePath.join(root, "art/sheets/Bram.previous.md"), "utf8")).toBe(
      CRITIQUE,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("lists a hero's gates, holds a failing one open, and wants the critique to quote them", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hero-gates-"));
  try {
    const paths = { assets: "web/assets", library: "web/assets/library" };
    await NodeFSP.mkdir(NodePath.join(root, "web/assets/models"), { recursive: true });
    const gates = (heightPasses: boolean) => [
      {
        name: "height",
        pass: heightPasses,
        value: 2.634,
        text: "2.63 m tall, outside its 1.5-2 m range",
      },
      { name: "deformation", pass: true, value: 2.41, text: "edges stretch 2.41x" },
    ];
    const sidecar = (heightPasses: boolean) =>
      NodeFSP.writeFile(
        NodePath.join(root, "web/assets/models/bram.asset.json"),
        JSON.stringify({ kind: "character", gates: gates(heightPasses) }),
      );
    await sidecar(false);
    const review = NodePath.join(root, "review.png");
    await NodeFSP.writeFile(review, "sheet");
    await keepHeroSheet(root, "bram", review);
    await NodeFSP.writeFile(NodePath.join(root, "art/sheets/bram.md"), CRITIQUE);
    const failing = await heroSheetProblems(root, paths);
    expect(failing.gates).toHaveLength(2);
    expect(failing.problems.some((line) => line.includes("fails its height gate"))).toBe(true);
    expect(failing.problems.some((line) => line.includes("does not quote"))).toBe(true);
    await sidecar(true);
    await NodeFSP.writeFile(
      NodePath.join(root, "art/sheets/bram.md"),
      `${CRITIQUE}3. Gates: height 2.63 m, deformation 2.41x at the 99.9th percentile.\n`,
    );
    expect((await heroSheetProblems(root, paths)).problems).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
