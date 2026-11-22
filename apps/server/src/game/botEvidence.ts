// @effect-diagnostics nodeBuiltinImport:off -- Bot evidence records are files the server owns.
// The play bot's runs per thread: the skilled fact plays the game's latest one
// (`latestPlay`). The bot service records each run here, under the server state
// dir and outside every game folder; the game's .studio/bot-results.jsonl is a
// copy for people and decides nothing.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";

const BotRun = Schema.Struct({
  runId: Schema.String,
  /** The bot file, relative to the game folder it ran in. */
  file: Schema.String,
  /** "play"; runs recorded before exploration bots were removed may say "explore". */
  mode: Schema.String,
  won: Schema.Boolean,
  /** How the run ended, in the bot's words (a timeout, an error); absent on runs recorded before. */
  ending: Schema.optionalKey(Schema.String),
  seconds: Schema.Number,
  findings: Schema.Number,
  at: Schema.String,
});
export type BotRun = typeof BotRun.Type;
const ThreadBots = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  /** The game folder the thread's runs played in; their videos are under its builds/logs. */
  root: Schema.String,
  /** Every run the thread made, including those no longer kept in `runs`. */
  count: Schema.Number,
  /** The latest runs, oldest first. */
  runs: Schema.Array(BotRun),
  /** The latest play-mode run, kept however many runs came after it. */
  play: Schema.NullOr(BotRun),
});
export type ThreadBots = typeof ThreadBots.Type;
const ThreadBotsJson = Schema.fromJsonString(ThreadBots);
const decode = Schema.decodeUnknownOption(ThreadBotsJson);
const encode = Schema.encodeSync(ThreadBotsJson);

/** A call makes up to ten runs; far more than a turn's worth stays. */
export const KEPT_RUNS = 100;

/** Records untouched this long belong to runs long finished. */
const RETAIN_MS = 14 * 24 * 60 * 60_000;

/** One readable, collision-free file stem per thread id. */
const keyOf = (threadId: string) =>
  `${threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${NodeCrypto.createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, 12)}`;

export const recordPath = (dir: string, threadId: string) =>
  NodePath.join(dir, `${keyOf(threadId)}.json`);

export const empty = (threadId: string, root: string): ThreadBots => ({
  version: 1,
  threadId,
  root,
  count: 0,
  runs: [],
  play: null,
});

export const add = (record: ThreadBots, root: string, run: BotRun): ThreadBots => ({
  ...record,
  root,
  count: record.count + 1,
  runs: [...record.runs, run].slice(-KEPT_RUNS),
  play: run,
});

/**
 * The record on disk: null when there is none. A record that does not decode,
 * or is another thread's, no server write made: it reads as `damaged`. Any
 * other read failure is thrown, so it is never taken for "no bot ran".
 */
export const read = async (
  dir: string,
  threadId: string,
): Promise<ThreadBots | null | "damaged"> => {
  const text = await NodeFSP.readFile(recordPath(dir, threadId), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (text === null) return null;
  const decoded = decode(text);
  return decoded._tag === "Some" && decoded.value.threadId === threadId ? decoded.value : "damaged";
};

/**
 * The latest play-mode run any thread's record holds for the game folder
 * `root`: the bot a build's skilled tier replays. Records that do not decode
 * (damaged, set aside) are skipped; a folder that cannot be listed has none.
 */
export const latestPlay = async (dir: string, root: string): Promise<BotRun | null> => {
  const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  let latest: BotRun | null = null;
  for (const name of names) {
    if (!/^[\w-]+\.json$/.test(name)) continue;
    const text = await NodeFSP.readFile(NodePath.join(dir, name), "utf8").catch(() => null);
    if (text === null) continue;
    const decoded = decode(text);
    if (decoded._tag !== "Some" || decoded.value.root !== root) continue;
    const play = decoded.value.play;
    if (play !== null && (latest === null || play.at > latest.at)) latest = play;
  }
  return latest;
};

/**
 * Moves a damaged record aside before a fresh one replaces it, so the count it
 * held is never silently lost and can be inspected. It keeps a `.json` name,
 * so the same age bound prunes it.
 */
export const setAside = async (dir: string, threadId: string, nowMs: number) => {
  const aside = NodePath.join(dir, `${keyOf(threadId)}.damaged-${nowMs}.json`);
  await NodeFSP.rename(recordPath(dir, threadId), aside);
  return aside;
};

export const write = (dir: string, record: ThreadBots) =>
  writeFileStringAtomically({
    filePath: recordPath(dir, record.threadId),
    contents: encode(record),
  });

/** Removes records untouched for `RETAIN_MS`, and writes a crash cut short. */
export const prune = async (dir: string, nowMs: number) => {
  const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const file = NodePath.join(dir, name);
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null || nowMs - stat.mtimeMs < RETAIN_MS) continue;
    // A write cut short leaves a `.tmp` file (older servers) or the atomic writer's directory.
    if (/\.(?:json|tmp)$/.test(name) || (stat.isDirectory() && /\.json\.[^.]+$/.test(name)))
      await NodeFSP.rm(file, { recursive: true, force: true });
  }
};
