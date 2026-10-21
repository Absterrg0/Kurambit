// @effect-diagnostics nodeBuiltinImport:off -- Game records live on the native filesystem outside the game workspace.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * A server-owned record file for one game. Paths are keyed by the game root's
 * realpath so a symlinked alias cannot mint a second record, lock or cache for
 * the same game. `legacyFile` is the old lexical-key path, when it differs;
 * reads migrate it before using the record.
 */
export interface GameRecordLocation {
  readonly canonicalRoot: string;
  readonly file: string;
  readonly legacyFile: string | null;
}

const digest = (root: string) =>
  NodeCrypto.createHash("sha256").update(NodePath.resolve(root)).digest("hex").slice(0, 32);

export const gameRecordFile = (stateDir: string, kind: string, root: string, extension = ".json") =>
  NodePath.join(stateDir, kind, `${digest(root)}${extension}`);

/** The realpath of an existing game root; the caller decides how to report a failure. */
export const realGameRoot = (root: string) => NodeFSP.realpath(NodePath.resolve(root));

export const gameRecordLocation = async (
  stateDir: string,
  kind: string,
  root: string,
  extension = ".json",
): Promise<GameRecordLocation> => {
  const lexicalRoot = NodePath.resolve(root);
  // A record for a root that vanished is still read under its lexical key so a
  // diagnostic read does not fail; registration and resolution require realpath.
  const canonicalRoot = await realGameRoot(lexicalRoot).catch(() => lexicalRoot);
  return {
    canonicalRoot,
    file: gameRecordFile(stateDir, kind, canonicalRoot, extension),
    legacyFile:
      canonicalRoot === lexicalRoot ? null : gameRecordFile(stateDir, kind, lexicalRoot, extension),
  };
};

/**
 * Renames a pre-realpath record to its canonical key. Returns whether anything
 * moved. An existing canonical record always wins; a failed rename is reported
 * to the caller rather than silently leaving two keys in play.
 */
export const migrateGameRecord = async (location: GameRecordLocation): Promise<boolean> => {
  if (location.legacyFile === null) return false;
  const [canonical, legacy] = await Promise.all([
    NodeFSP.stat(location.file).then(
      () => true,
      () => false,
    ),
    NodeFSP.stat(location.legacyFile).then(
      () => true,
      () => false,
    ),
  ]);
  if (canonical || !legacy) return false;
  await NodeFSP.mkdir(NodePath.dirname(location.file), { recursive: true });
  await NodeFSP.rename(location.legacyFile, location.file);
  return true;
};

/**
 * Reads a record file, treating only "not there" as absent. Decode and I/O
 * failures propagate: an unreadable required record must not read as legacy.
 */
export const readRecordText = async (file: string): Promise<string | null> => {
  try {
    return await NodeFSP.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
};
