// @effect-diagnostics nodeBuiltinImport:off -- Bot evidence records are files the server owns.
// A production run decides by a thread's bot runs: whether its tester ran a
// bot, which bot a blind comparison replays, and the final video. The bot
// service records each run here, under the server state dir and outside every
// folder a role agent works in, the way explore evidence is kept; the game's
// .studio/bot-results.jsonl is a copy for people and decides nothing.
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import { recordPath, writeRecordFile } from "./exploreEvidence.ts";

const BotRun = Schema.Struct({
  runId: Schema.String,
  /** The bot file, relative to the game folder it ran in. */
  file: Schema.String,
  mode: Schema.String,
  decider: Schema.String,
  won: Schema.Boolean,
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

/** A tester makes a few calls of up to ten runs each; far more than a turn's worth stays. */
export const KEPT_RUNS = 100;

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
  // An exploration bot wanders on purpose and says nothing about how far
  // scripted play gets, so a blind comparison never replays one.
  play: run.mode === "explore" ? record.play : run,
});

/** The bot a blind comparison replays: the thread's latest play-mode run. */
export const lastPlay = (record: ThreadBots) =>
  record.play === null
    ? null
    : {
        file: record.play.file,
        decider: record.play.decider === "jev" ? ("jev" as const) : ("policy" as const),
      };

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

export const write = (dir: string, record: ThreadBots) =>
  writeRecordFile(dir, record.threadId, encode(record));
