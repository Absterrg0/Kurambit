// @effect-diagnostics nodeBuiltinImport:off -- This helper owns the filesystem boundary of a game's saved media.
// A creator's copy of a video or image Kurambit generated, kept in the game's
// own saved/ folder where the storage cleanup never looks. Only media in the
// game's generated folders can be saved, and nothing in saved/ is overwritten.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import { GAME_SAVED_MEDIA_EVENT, type GameSavedMedia } from "@kurambit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isPathInside } from "./gameNativeUserDir.ts";

/** Game-relative; the scaffold's .gitignore ignores it, so saves stay out of commits and checkpoints. */
export const SAVED_DIR = "saved";
/** The game event a save or delete pushes; clients reread the Saved list on it. */
export const SAVED_EVENT = GAME_SAVED_MEDIA_EVENT;

/**
 * Where Kurambit writes the media it generates: bot runs, explore sessions and
 * sprite renders under builds/logs, the blind players' frame sheets under
 * .studio/comparisons, and the prototype sheets and final run video directly in .studio.
 */
const GENERATED_DIRS = ["builds/logs", ".studio/comparisons"] as const;
const GENERATED_STUDIO_FILE = /^(?:final\.mp4|proto-\d+-frames\.jpg)$/;
const TEMP_PREFIX = ".saving-";
const TEMP_STALE_MS = 60 * 60 * 1000;
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
const savedDir = async (root: string, create: boolean, now: number): Promise<string | null> => {
  const realRoot = await NodeFSP.realpath(root);
  const dir = NodePath.join(realRoot, SAVED_DIR);
  if (!(await exists(dir))) {
    if (!create) return null;
    await NodeFSP.mkdir(dir, { recursive: true });
  }
  if ((await NodeFSP.realpath(dir)) !== dir)
    throw new SavedMediaError(
      "symlink",
      `${dir} is a link; saved media is not written through it.`,
    );
  // Ignored however old the game's own .gitignore is, so a checkpoint's
  // `add -A` never takes a video; written again whenever someone removed it.
  const ignore = NodePath.join(dir, ".gitignore");
  if (!(await exists(ignore)))
    await NodeFSP.writeFile(ignore, "*\n", { flag: "wx" }).catch(() => {});
  // A save a crash or a kill cut short leaves its temp copy; one this old is no live save's.
  const stale = now - TEMP_STALE_MS;
  for (const name of await NodeFSP.readdir(dir)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const temp = NodePath.join(dir, name);
    const info = await NodeFSP.lstat(temp).catch(() => null);
    if (info?.isFile() === true && info.mtimeMs < stale)
      await NodeFSP.rm(temp, { force: true }).catch(() => {});
  }
  return dir;
};

/** The source as a real file inside one of the game's generated folders, or a refusal. */
const generatedSource = async (
  root: string,
  source: string,
): Promise<{ readonly real: string; readonly dev: number; readonly ino: number }> => {
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
  return { real, dev: info.dev, ino: info.ino };
};

/**
 * Copies the checked file through a handle opened without following a final
 * link and proven by fstat to be the same file, so a folder swapped for a link
 * after the check cannot copy a file from outside the game.
 */
const copyChecked = async (
  checked: { readonly real: string; readonly dev: number; readonly ino: number },
  source: string,
  temp: string,
) => {
  // Windows has no O_NOFOLLOW; the fstat identity check still holds there.
  const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0;
  const handle = await NodeFSP.open(checked.real, NodeFS.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino)
      throw new SavedMediaError("symlink", `${source} changed while it was being saved.`);
    await NodeStreamPromises.pipeline(
      handle.createReadStream({ autoClose: false }),
      NodeFS.createWriteStream(temp, { flags: "wx" }),
    );
  } finally {
    await handle.close();
  }
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

// What a saved file was saved from, beside it, so a Save button knows its file is saved.
const Provenance = Schema.Struct({
  source: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
});
const decodeProvenance = Schema.decodeUnknownOption(Schema.fromJsonString(Provenance));
const provenanceFile = (dir: string, name: string) => NodePath.join(dir, `.source-${name}.json`);
const readProvenance = async (dir: string, name: string) =>
  Option.getOrElse(
    decodeProvenance(await NodeFSP.readFile(provenanceFile(dir, name), "utf8").catch(() => "")),
    () => ({ source: null, label: null }),
  );

const savedEntry = (
  dir: string,
  name: string,
  info: { size: number; mtime: Date },
  from: typeof Provenance.Type,
): GameSavedMedia => ({
  name,
  path: NodePath.join(dir, name),
  bytes: info.size,
  savedAt: info.mtime.toISOString(),
  ...from,
});

/**
 * Copies one generated video or image into saved/. The copy is written beside
 * its final name, which is reserved by creating it exclusively and then
 * renamed over; a taken name gets the next " (n)", so nothing is replaced.
 */
export const saveMedia = async (
  root: string,
  source: string,
  label: string | undefined,
  /** The creator's calendar day the name starts with ("2026-11-05"). */
  day: string,
  now: number,
): Promise<GameSavedMedia> => {
  const checked = await generatedSource(root, source);
  const real = checked.real;
  const dir = (await savedDir(root, true, now))!;
  const ext = NodePath.extname(real).toLowerCase();
  const given = label?.trim() ?? "";
  const realRoot = await NodeFSP.realpath(root);
  const stem = savedStem(given.length > 0 ? given : defaultLabel(realRoot, real), day);
  const temp = NodePath.join(dir, `${TEMP_PREFIX}${NodeCrypto.randomUUID()}${ext}`);
  try {
    await copyChecked(checked, source, temp);
    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? "" : ` (${n})`}${ext}`;
      const target = NodePath.join(dir, name);
      // Creating the name exclusively reserves it on every OS and file system;
      // the rename then replaces only this save's own empty placeholder.
      const placeholder = await NodeFSP.open(target, "wx").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
        throw error;
      });
      if (placeholder === null) continue;
      await placeholder.close();
      try {
        await NodeFSP.rename(temp, target);
      } catch (error) {
        await NodeFSP.rm(target, { force: true });
        throw error;
      }
      const from = {
        source: NodePath.relative(realRoot, real).split(NodePath.sep).join("/"),
        label: given.length > 0 ? given : null,
      };
      await NodeFSP.writeFile(provenanceFile(dir, name), JSON.stringify(from));
      return savedEntry(dir, name, await NodeFSP.stat(target), from);
    }
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
};

/** What saved/ holds, newest first; links, folders and the save's own temp files are left out. */
export const listSaved = async (
  root: string,
  now: number,
): Promise<ReadonlyArray<GameSavedMedia>> => {
  const dir = await savedDir(root, false, now);
  if (dir === null) return [];
  const rows: GameSavedMedia[] = [];
  for (const name of await NodeFSP.readdir(dir)) {
    if (name.startsWith(".")) continue;
    const info = await NodeFSP.lstat(NodePath.join(dir, name)).catch(() => null);
    if (info?.isFile() === true)
      rows.push(savedEntry(dir, name, info, await readProvenance(dir, name)));
  }
  return rows.toSorted((a, b) => b.savedAt.localeCompare(a.savedAt));
};

/** Removes one file directly inside saved/; any other name is refused. */
export const deleteSaved = async (root: string, name: string, now: number): Promise<void> => {
  if (
    name.length === 0 ||
    name.startsWith(".") ||
    NodePath.basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\")
  )
    throw new SavedMediaError("invalid-path", `${name} is not a saved file's name.`);
  const dir = await savedDir(root, false, now);
  const target = dir === null ? null : NodePath.join(dir, name);
  const info = target === null ? null : await NodeFSP.lstat(target).catch(() => null);
  if (target === null || info?.isFile() !== true)
    throw new SavedMediaError("invalid-path", `saved/${name} is not a saved file.`);
  await NodeFSP.rm(target);
  await NodeFSP.rm(provenanceFile(NodePath.dirname(target), name), { force: true });
};
