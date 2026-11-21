// @effect-diagnostics nodeBuiltinImport:off -- Reads and copies a game's sheet files on disk.
// Hero sheets: a character's or creature's review picture, kept in art/sheets/ so Art shows it
// beside the model. The tools keep them (the Blender export, the code model sheet).
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { gameHeroSheetName, type GameHeroSheet } from "@kurambit/contracts";
import { walkFiles } from "./walkFiles.ts";

const HERO_SHEET_DIR = "art/sheets";
/** Thing kinds whose model sheet is kept as a hero sheet. */
export const HERO_KINDS: ReadonlySet<string> = new Set(["character", "creature"]);
const MAX_SHEETS = 200;

/** Copies a sheet picture to art/sheets/<name>.png; returns the sheet game-relative. */
export const keepHeroSheet = async (root: string, name: string, image: string) => {
  const folder = NodePath.join(root, HERO_SHEET_DIR);
  await NodeFSP.mkdir(folder, { recursive: true });
  const stem = gameHeroSheetName(name);
  await NodeFSP.copyFile(image, NodePath.join(folder, `${stem}.png`));
  return `${HERO_SHEET_DIR}/${stem}.png`;
};

/** Every kept sheet, for Art. */
export const listHeroSheets = async (root: string): Promise<ReadonlyArray<GameHeroSheet>> =>
  (
    await walkFiles(NodePath.join(root, HERO_SHEET_DIR), {
      match: (name) => name.endsWith(".png"),
      maxDepth: 0,
      limit: MAX_SHEETS,
    })
  ).map((full) => {
    const image = NodePath.relative(root, full).split(NodePath.sep).join("/");
    return { name: NodePath.posix.basename(image, ".png"), image };
  });
