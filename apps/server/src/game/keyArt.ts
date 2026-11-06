// @effect-diagnostics nodeBuiltinImport:off -- Finds one image file inside a game folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { GameEngineId } from "@kurambit/contracts";
import { gamePaths, legacyLaneEngine } from "./engineProfile.ts";

const IMAGE = /\.(png|jpe?g|webp)$/i;
// VISION.md names its key art in its own words: "Key art: `art/key-art.png`",
// "## Key art" with the path on a later line, or a markdown link.
const NAMED = /key[ -]?art\b[\s\S]{0,300}?[`(]([^`()\s]{1,200}\.(?:png|jpe?g|webp))[`)]/i;

/**
 * The game's key art as a game-relative path, only when it resolves to a
 * non-empty file inside the game's real root: the 16:9 title art the art step saves,
 * else the key art VISION.md names (that one first when `from` is "vision": the
 * title art is the template's placeholder until the art step). A link leading
 * out of the game is refused. `engine` is the game's (its manifest's); callers
 * that do not pass it yet get the one the project folder implies.
 */
export const findKeyArt = async (
  root: string,
  lane: string,
  from: "title" | "vision" = "title",
  engine: GameEngineId = legacyLaneEngine(lane),
): Promise<string | null> => {
  const base = await NodeFSP.realpath(root).catch(() => null);
  if (base === null) return null;
  const vision = await NodeFSP.readFile(NodePath.join(base, "VISION.md"), "utf8").catch(() => "");
  const named = NAMED.exec(vision.slice(0, 20_000))?.[1]?.trim() ?? "";
  const candidates = from === "title" ? [`${gamePaths(engine, lane).ui}/title_bg.png`] : [];
  if (IMAGE.test(named) && !NodePath.isAbsolute(named)) candidates.push(named);
  for (const candidate of candidates) {
    const real = await NodeFSP.realpath(NodePath.join(base, candidate)).catch(() => null);
    if (real === null || !IMAGE.test(real)) continue;
    const relative = NodePath.relative(base, real);
    if (relative.length === 0 || relative.startsWith("..") || NodePath.isAbsolute(relative))
      continue;
    const info = await NodeFSP.stat(real).catch(() => null);
    if (info?.isFile() === true && info.size > 0) return relative.split(NodePath.sep).join("/");
  }
  return null;
};
