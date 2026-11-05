// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the filesystem boundary of a game's saved media.
// A creator's copy of a video or image Kurambit generated, kept in the game's
// own saved/ folder where the storage cleanup never looks. Only media in the
// game's generated folders can be saved, and nothing in saved/ is overwritten.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { GameSavedMedia } from "@kurambit/contracts";
import { isPathInside } from "./gameNativeUserDir.ts";

/** Game-relative; the scaffold's .gitignore ignores it, so saves stay out of commits and checkpoints. */
export const SAVED_DIR = "saved";

/**
 * Where Kurambit writes the media it generates: bot runs, explore sessions and
 * sprite renders under builds/logs, the blind players' frame sheets under
 * .studio/comparisons, and the prototype sheets and final run video directly in .studio.
 */
const GENERATED_DIRS = ["builds/logs", ".studio/comparisons"] as const;
const GENERATED_STUDIO_FILE = /^(?:final\.mp4|proto-\d+-frames\.jpg)$/;
const MEDIA = /\.(?:mp4|webm|png|jpe?g|webp|gif)$/i;

export class SavedMediaError extends Error {
  readonly reason: "invalid-path" | "symlink" | "io";
  constructor(reason: SavedMediaError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

/** The real saved/ folder, created when missing; one that is a link, or leads out of the game, is refused. */
const savedDir = async (root: string, create: boolean): Promise<string | null> => {
  const realRoot = await NodeFSP.realpath(root);
  const dir = NodePath.join(realRoot, SAVED_DIR);
  if (!(await exists(dir))) {
    if (!create) return null;
    await NodeFSP.mkdir(dir, { recursive: true });
    // Ignored however old the game's own .gitignore is, so a checkpoint's `add -A` never takes a video.
    await NodeFSP.writeFile(NodePath.join(dir, ".gitignore"), "*\n");
  }
  if ((await NodeFSP.realpath(dir)) !== dir)
    throw new SavedMediaError(
      "symlink",
      `${dir} is a link; saved media is not written through it.`,
    );
  return dir;
};

/** The source as a real file inside one of the game's generated folders, or a refusal. */
const generatedSource = async (root: string, source: string): Promise<string> => {
  const realRoot = await NodeFSP.realpath(root);
  // Relative to the root as the transports know it, which round evidence paths are relative to.
  const given = NodePath.resolve(root, source);
  const real = await NodeFSP.realpath(given).catch(() => null);
  if (real === null) throw new SavedMediaError("invalid-path", `${source} does not exist.`);
  if (!MEDIA.test(real))
    throw new SavedMediaError("invalid-path", `${source} is not a video or image Kurambit makes.`);
  const inDir = await Promise.all(
    GENERATED_DIRS.map(async (dir) => {
      const base = NodePath.join(realRoot, dir);
      // A generated folder that is itself a link leads out of the game.
      const realBase = await NodeFSP.realpath(base).catch(() => null);
      return realBase === base && isPathInside(real, base) && real !== base;
    }),
  );
  const inStudio =
    NodePath.dirname(real) === NodePath.join(realRoot, ".studio") &&
    GENERATED_STUDIO_FILE.test(NodePath.basename(real));
  if (!inDir.some(Boolean) && !inStudio)
    throw new SavedMediaError(
      "invalid-path",
      `${source} is not in this game's generated media (${GENERATED_DIRS.join(", ")}, .studio); only those can be saved.`,
    );
  const info = await NodeFSP.stat(real);
  if (!info.isFile()) throw new SavedMediaError("invalid-path", `${source} is not a file.`);
  return real;
};

/** A name a person reads, safe on every file system: "2026-11-05 round 2 bot run". */
const savedStem = (label: string, day: string) => {
  const words = label
    .replace(/[^\p{L}\p{N} ._,()-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 80)
    .trim();
  return words.length > 0 ? `${day} ${words}` : day;
};

// Without a label, the kind of evidence and the file's own name.
const defaultLabel = (root: string, real: string) => {
  const parts = NodePath.relative(root, real).split(NodePath.sep);
  const kind = parts.some((p) => p.startsWith("game-bot-"))
    ? "bot "
    : parts.some((p) => p.startsWith("game-explore-"))
      ? "explore "
      : parts.includes("comparisons")
        ? "comparison "
        : "";
  return `${kind}${NodePath.basename(real, NodePath.extname(real))}`;
};

const savedEntry = (dir: string, name: string, info: { size: number; mtime: Date }) => ({
  name,
  path: NodePath.join(dir, name),
  bytes: info.size,
  savedAt: info.mtime.toISOString(),
});

/**
 * Copies one generated video or image into saved/. The copy is written beside
 * its final name and then linked into place, which fails rather than replace
 * a file already there; a taken name gets the next " (n)".
 */
export const saveMedia = async (
  root: string,
  source: string,
  label: string | undefined,
  /** The creator's calendar day the name starts with ("2026-11-05"). */
  day: string,
): Promise<GameSavedMedia> => {
  const real = await generatedSource(root, source);
  const dir = (await savedDir(root, true))!;
  const ext = NodePath.extname(real).toLowerCase();
  const given = label?.trim() ?? "";
  const stem = savedStem(
    given.length > 0 ? given : defaultLabel(await NodeFSP.realpath(root), real),
    day,
  );
  const temp = NodePath.join(dir, `.saving-${NodeCrypto.randomUUID()}${ext}`);
  try {
    await NodeFSP.copyFile(real, temp);
    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? "" : ` (${n})`}${ext}`;
      const target = NodePath.join(dir, name);
      if (await exists(target)) continue;
      try {
        await NodeFSP.link(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        // A file system without hard links: the plain rename, checked free just above.
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw error;
        await NodeFSP.rename(temp, target);
      }
      return savedEntry(dir, name, await NodeFSP.stat(target));
    }
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
};

/** What saved/ holds, newest first; links, folders and the save's own temp files are left out. */
export const listSaved = async (root: string): Promise<ReadonlyArray<GameSavedMedia>> => {
  const dir = await savedDir(root, false);
  if (dir === null) return [];
  const rows: GameSavedMedia[] = [];
  for (const name of await NodeFSP.readdir(dir)) {
    if (name.startsWith(".")) continue;
    const info = await NodeFSP.lstat(NodePath.join(dir, name)).catch(() => null);
    if (info?.isFile() === true) rows.push(savedEntry(dir, name, info));
  }
  return rows.toSorted((a, b) => b.savedAt.localeCompare(a.savedAt));
};

/** Removes one file directly inside saved/; any other name is refused. */
export const deleteSaved = async (root: string, name: string): Promise<void> => {
  if (
    name.length === 0 ||
    name.startsWith(".") ||
    NodePath.basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\")
  )
    throw new SavedMediaError("invalid-path", `${name} is not a saved file's name.`);
  const dir = await savedDir(root, false);
  const target = dir === null ? null : NodePath.join(dir, name);
  const info = target === null ? null : await NodeFSP.lstat(target).catch(() => null);
  if (target === null || info?.isFile() !== true)
    throw new SavedMediaError("invalid-path", `saved/${name} is not a saved file.`);
  await NodeFSP.rm(target);
};
