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
    expect(await heroSheetProblems(root, paths)).toHaveLength(1);
    await NodeFSP.writeFile(NodePath.join(root, "art/sheets/Bram.md"), CRITIQUE);
    expect(await heroSheetProblems(root, paths)).toEqual([]);
    // The export keeps the review it shipped: the same picture, so the critique still answers it.
    await keepHeroSheet(root, "Bram", review);
    expect(await heroSheetProblems(root, paths)).toEqual([]);
    // A changed model's sheet needs a new critique; the old one is kept beside it.
    await NodeFSP.writeFile(review, "second");
    await keepHeroSheet(root, "Bram", review);
    expect(await heroSheetProblems(root, paths)).toHaveLength(1);
    expect(await NodeFSP.readFile(NodePath.join(root, "art/sheets/Bram.previous.md"), "utf8")).toBe(
      CRITIQUE,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
