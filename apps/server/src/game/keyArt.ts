// @effect-diagnostics nodeBuiltinImport:off -- Finds one image file inside a game folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isAvailableEngine, type GameEngineName } from "@kurambit/contracts";
import { gamePaths } from "./engineProfile.ts";

const IMAGE = /\.(png|jpe?g|webp)$/i;

/**
 * The game's key art as a game-relative path: the 16:9 title art the art step
 * saves, only when it resolves to a non-empty file inside the game's real
 * root. A link leading out of the game is refused. A game in an engine this
 * version does not have has no known layout, so none.
 */
export const findKeyArt = async (
  root: string,
  lane: string,
  engine: GameEngineName,
): Promise<string | null> => {
  if (!isAvailableEngine(engine)) return null;
  const base = await NodeFSP.realpath(root).catch(() => null);
  if (base === null) return null;
  const candidate = `${gamePaths(engine, lane).ui}/title_bg.png`;
  const real = await NodeFSP.realpath(NodePath.join(base, candidate)).catch(() => null);
  if (real === null || !IMAGE.test(real)) return null;
  const relative = NodePath.relative(base, real);
  if (relative.length === 0 || relative.startsWith("..") || NodePath.isAbsolute(relative))
    return null;
  const info = await NodeFSP.stat(real).catch(() => null);
  return info?.isFile() === true && info.size > 0 ? relative.split(NodePath.sep).join("/") : null;
};
