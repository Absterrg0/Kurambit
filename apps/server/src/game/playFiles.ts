// @effect-diagnostics nodeBuiltinImport:off -- Plays are small JSON files in the game's folder.
// Where a game's plays live on disk. Kept runs: the newest few runs played to an end, by the
// person on the Stage or by the agent's game_play sessions, in the ignored builds/plays. Saved
// plays: runs someone named as tests, committed in .studio/plays, which every build's measure
// replays. Saved plays are outside what a restore puts back (restoredPaths), so an undo never
// takes a test away.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GameBuildId,
  GamePlay,
  SAVED_PLAYS_PER_BUILD,
  savedPlayReading,
  type GameOperationError,
  type GameReplayRun,
  type GameSavedPlaysReading,
} from "@kurambit/contracts";
import { ensureGameDir } from "./gameKeptSaves.ts";
import { insideGame } from "./gamePath.ts";

const KEPT_DIR = "builds/plays";
/** Kept runs per game: the newest, since a save or a replay takes the latest. */
const KEPT = 10;
export const SAVED_DIR = ".studio/plays";

export const KeptPlay = Schema.Struct({
  at: Schema.String,
  /** The build the folder held, unless it was edited since; null: the folder as it was. */
  build: Schema.NullOr(GameBuildId),
  play: GamePlay,
});
export type KeptPlay = typeof KeptPlay.Type;
const KeptJson = Schema.fromJsonString(KeptPlay);
const decodeKept = Schema.decodeUnknownOption(KeptJson);
const encodeKept = Schema.encodeSync(KeptJson);

const SavedPlay = Schema.Struct({ name: Schema.String, ...KeptPlay.fields });
export type SavedPlay = typeof SavedPlay.Type;
const SavedJson = Schema.fromJsonString(SavedPlay);
const decodeSaved = Schema.decodeUnknownOption(SavedJson);
const encodeSavedValue = Schema.encodeSync(SavedPlay);
// Indented: a saved play is committed with the game, so its diffs are read.
const encodeSaved = (saved: SavedPlay) => `${JSON.stringify(encodeSavedValue(saved), null, 2)}\n`;

const writeAtomically = async (dir: string, name: string, text: string) => {
  const temporary = NodePath.join(dir, `.${name}.tmp`);
  await NodeFSP.writeFile(temporary, text);
  await NodeFSP.rename(temporary, NodePath.join(dir, name));
};

/** Keeps a run played to its end; returns its id. Older runs past the newest few go. */
export const keepPlay = async (root: string, kept: KeptPlay): Promise<string> => {
  const dir = await ensureGameDir(root, KEPT_DIR);
  const id = `${kept.at.replace(/[:.]/g, "-")}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  await writeAtomically(dir, `${id}.json`, encodeKept(kept));
  const names = (await NodeFSP.readdir(dir)).filter((each) => each.endsWith(".json")).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEPT)))
    await NodeFSP.rm(NodePath.join(dir, old), { force: true });
  return id;
};

/** A kept run by its id, or the newest that still reads; null when there is none. */
export const keptPlay = async (
  root: string,
  id?: string,
): Promise<(KeptPlay & { readonly id: string }) | null> => {
  const dir = insideGame(root, KEPT_DIR, { root: "allowed" });
  const names = await NodeFSP.readdir(dir).catch(() => [] as Array<string>);
  const newestFirst = names
    .filter((each) => each.endsWith(".json") && (id === undefined || each === `${id}.json`))
    .toSorted()
    .toReversed();
  for (const name of newestFirst) {
    const kept = decodeKept(await NodeFSP.readFile(NodePath.join(dir, name), "utf8"));
    if (Option.isSome(kept)) return { ...kept.value, id: name.slice(0, -".json".length) };
  }
  return null;
};

/** A saved play's file name: its name lowercased, each run of other characters a dash. */
const savedPlayFile = (name: string) =>
  `${
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "play"
  }.json`;

/**
 * The game's saved plays, newest saved first, and a hash of them all (names and contents): a
 * build's Saved plays reading is measured again once it no longer matches. Empty: "".
 */
export const savedPlays = async (
  root: string,
): Promise<{ readonly plays: ReadonlyArray<SavedPlay>; readonly set: string }> => {
  const dir = insideGame(root, SAVED_DIR, { root: "allowed" });
  const names = (await NodeFSP.readdir(dir).catch(() => [] as Array<string>))
    .filter((each) => each.endsWith(".json"))
    .toSorted();
  const hash = NodeCrypto.createHash("sha256");
  const plays: Array<SavedPlay> = [];
  for (const name of names) {
    const text = await NodeFSP.readFile(NodePath.join(dir, name), "utf8").catch(() => null);
    const saved = text === null ? Option.none() : decodeSaved(text);
    if (Option.isNone(saved)) continue;
    hash.update(`${name}\0${text}\0`);
    plays.push(saved.value);
  }
  return {
    plays: plays.toSorted((a, b) => b.at.localeCompare(a.at)),
    set: plays.length === 0 ? "" : hash.digest("hex").slice(0, 16),
  };
};

export const writeSavedPlay = async (root: string, saved: SavedPlay) => {
  const dir = await ensureGameDir(root, SAVED_DIR);
  await writeAtomically(dir, savedPlayFile(saved.name), encodeSaved(saved));
};

/** Whether a saved play by that name was there to delete. */
export const deleteSavedPlay = async (root: string, name: string): Promise<boolean> => {
  const file = NodePath.join(insideGame(root, SAVED_DIR, { root: "allowed" }), savedPlayFile(name));
  return NodeFSP.rm(file).then(
    () => true,
    () => false,
  );
};

/**
 * The Saved plays reading: each saved play, newest first up to the per-build cap, replayed by
 * `replay` (on a build's copy, or the folder) and read against how it ended when saved.
 */
export const replaySavedPlays = <R>(
  saved: Awaited<ReturnType<typeof savedPlays>>,
  replay: (play: GamePlay) => Effect.Effect<GameReplayRun, GameOperationError, R>,
): Effect.Effect<GameSavedPlaysReading, GameOperationError, R> =>
  Effect.gen(function* () {
    const plays = [];
    for (const each of saved.plays.slice(0, SAVED_PLAYS_PER_BUILD))
      plays.push(savedPlayReading(each.name, each.play, yield* replay(each.play)));
    return {
      set: saved.set,
      plays,
      skipped: Math.max(0, saved.plays.length - SAVED_PLAYS_PER_BUILD),
    };
  });
