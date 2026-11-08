// @effect-diagnostics nodeBuiltinImport:off -- Evidence records and their frame copies are files the server owns.
// A thread's explore play across its sessions survives a server restart, so
// the input it reads as used is never under-counted. Each thread's record
// lives under the server state dir, outside every game folder. Sessions are
// keyed by id and totals are always summed from them, so a session written
// after every act and again at close counts once. Records an earlier server
// wrote may carry a blind sample's input cap, memory marks and kept frames:
// they decode with those keys ignored, and the age bound prunes the frames.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";

const SessionEvidence = Schema.Struct({
  id: Schema.String,
  actions: Schema.Number,
  executedInputSteps: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
  closed: Schema.Boolean,
  closeReason: Schema.NullOr(Schema.String),
});
export type SessionEvidence = typeof SessionEvidence.Type;
const ThreadEvidence = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  root: Schema.String,
  sessions: Schema.Array(SessionEvidence),
  /**
   * The thread's earlier record could not be decoded and was set aside: what
   * it counted is lost, so its totals are not to be trusted until the
   * thread's next explore start begins a fresh count.
   */
  damaged: Schema.optionalKey(Schema.Boolean),
});
export type ThreadEvidence = typeof ThreadEvidence.Type;
const ThreadEvidenceJson = Schema.fromJsonString(ThreadEvidence);
const decode = Schema.decodeUnknownOption(ThreadEvidenceJson);
const encode = Schema.encodeSync(ThreadEvidenceJson);

/** Records untouched this long belong to runs long finished. */
const RETAIN_MS = 14 * 24 * 60 * 60_000;

export const empty = (threadId: string, root: string): ThreadEvidence => ({
  version: 1,
  threadId,
  root,
  sessions: [],
});

/** Replaces the session with the same id, or appends it as the newest. */
export const upsert = (record: ThreadEvidence, session: SessionEvidence): ThreadEvidence => {
  const at = record.sessions.findIndex((s) => s.id === session.id);
  return {
    ...record,
    sessions:
      at === -1
        ? [...record.sessions, session]
        : record.sessions.map((s, i) => (i === at ? session : s)),
  };
};

/**
 * A session left open by an earlier server process lost its player with that
 * process; it keeps what it recorded and is closed as server-restarted.
 */
export const closeOrphans = (
  record: ThreadEvidence,
  liveIds: ReadonlySet<string>,
): ThreadEvidence => ({
  ...record,
  sessions: record.sessions.map((s) =>
    s.closed || liveIds.has(s.id) ? s : { ...s, closed: true, closeReason: "server-restarted" },
  ),
});

export const totals = (record: ThreadEvidence, exceptSessionId?: string) => {
  const counted = record.sessions.filter((s) => s.id !== exceptSessionId);
  const sum = (pick: (s: SessionEvidence) => number) =>
    counted.reduce((total, s) => total + pick(s), 0);
  return {
    sessions: counted.length,
    actions: sum((s) => s.actions),
    executedInputSteps: sum((s) => s.executedInputSteps),
    nominalMs: sum((s) => s.nominalMs),
    images: sum((s) => s.images),
  };
};

/** One readable, collision-free file stem per thread id. */
export const keyOf = (threadId: string) =>
  `${threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${NodeCrypto.createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, 12)}`;

export const recordPath = (dir: string, threadId: string) =>
  NodePath.join(dir, `${keyOf(threadId)}.json`);

/**
 * The record on disk: null when there is none. A record that does not decode,
 * or is another thread's, no server write made: it reads as `damaged`. Any
 * other read failure is thrown, so it is never taken for "no play".
 */
export const read = async (
  dir: string,
  threadId: string,
): Promise<ThreadEvidence | null | "damaged"> => {
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
 * Moves a damaged record aside before a fresh one replaces it, so what it
 * held is never silently lost and can be inspected. It keeps a `.json` name,
 * so the same age bound prunes it.
 */
export const setAside = async (dir: string, threadId: string, nowMs: number) => {
  const aside = NodePath.join(dir, `${keyOf(threadId)}.damaged-${nowMs}.json`);
  await NodeFSP.rename(recordPath(dir, threadId), aside);
  return aside;
};

/** Written whole to a fresh name then renamed, so a crash mid-write leaves the previous record whole. */
export const write = (dir: string, record: ThreadEvidence) =>
  writeFileStringAtomically({
    filePath: recordPath(dir, record.threadId),
    contents: encode(record),
  });

/** Removes records, and their frame copies, untouched for `RETAIN_MS`. */
export const prune = async (dir: string, nowMs: number) => {
  const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const file = NodePath.join(dir, name);
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null || nowMs - stat.mtimeMs < RETAIN_MS) continue;
    // A write cut short by a crash leaves its temporary name behind: a file
    // from older servers, a directory from the atomic writer.
    if (name.endsWith(".tmp") || (stat.isDirectory() && /\.json\.[^.]+$/.test(name)))
      await NodeFSP.rm(file, { recursive: true, force: true });
    if (!name.endsWith(".json")) continue;
    await NodeFSP.rm(NodePath.join(dir, name.slice(0, -".json".length)), {
      recursive: true,
      force: true,
    });
    await NodeFSP.rm(file, { force: true });
    removed += 1;
  }
  return removed;
};
