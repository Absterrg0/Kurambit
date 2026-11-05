// @effect-diagnostics nodeBuiltinImport:off -- Evidence records and their frame copies are files the server owns.
// A blind sample's play exposure must survive a server restart, or judges see
// under-counted, unequal evidence. Each thread's record lives under the server
// state dir, outside every game folder and worktree a role agent works in;
// an agent with an unrestricted shell running as the same user could still
// edit it, as it could the server database, so it is server-owned, not sealed.
// Sessions are keyed by id and totals are always summed from them, so a
// session written after every act and again at close counts once.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const Frame = Schema.Struct({ step: Schema.Number, path: Schema.String });
const SessionEvidence = Schema.Struct({
  id: Schema.String,
  actions: Schema.Number,
  executedInputSteps: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
  frames: Schema.Array(Frame),
  closed: Schema.Boolean,
  closeReason: Schema.NullOr(Schema.String),
});
export type SessionEvidence = typeof SessionEvidence.Type;
const ThreadEvidence = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  root: Schema.String,
  // In start order; a session's 1-based position is its label on the frame sheet.
  sessions: Schema.Array(SessionEvidence),
  /** The input this thread may use across its sessions (a blind sample's), set by the run. */
  inputCapMs: Schema.optionalKey(Schema.Number),
  /**
   * Since the thread's last finish: how long its starts waited for memory (the
   * run gives that time back to its cap), how many were refused, and whether
   * the latest was.
   */
  memory: Schema.optionalKey(
    Schema.Struct({ waitedMs: Schema.Number, refusals: Schema.Number, refused: Schema.Boolean }),
  ),
});
export type ThreadEvidence = typeof ThreadEvidence.Type;
const ThreadEvidenceJson = Schema.fromJsonString(ThreadEvidence);
const decode = Schema.decodeUnknownOption(ThreadEvidenceJson);
const encode = Schema.encodeSync(ThreadEvidenceJson);

/** Records untouched this long belong to runs long finished. */
export const RETAIN_MS = 14 * 24 * 60 * 60_000;

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

/** Every kept frame in play order, labelled with its session's position. */
export const frames = (record: ThreadEvidence) =>
  record.sessions.flatMap((s, i) =>
    s.frames.map((frame) => ({ session: i + 1, step: frame.step, path: frame.path })),
  );

/** One readable, collision-free file stem per thread id. */
export const keyOf = (threadId: string) =>
  `${threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${NodeCrypto.createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, 12)}`;

export const recordPath = (dir: string, threadId: string) =>
  NodePath.join(dir, `${keyOf(threadId)}.json`);
export const framesDir = (dir: string, threadId: string) => NodePath.join(dir, keyOf(threadId));

/** The record on disk, or null when it is missing, unreadable or another thread's. */
export const read = async (dir: string, threadId: string): Promise<ThreadEvidence | null> => {
  const text = await NodeFSP.readFile(recordPath(dir, threadId), "utf8").catch(() => null);
  if (text === null) return null;
  const decoded = decode(text);
  return decoded._tag === "Some" && decoded.value.threadId === threadId ? decoded.value : null;
};

/**
 * A thread's record file under `dir`, written to a fresh name then renamed, so
 * a crash mid-write leaves the previous record whole. Bot evidence keeps its
 * records the same way.
 */
export const writeRecordFile = async (dir: string, threadId: string, text: string) => {
  await NodeFSP.mkdir(dir, { recursive: true });
  const target = recordPath(dir, threadId);
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text);
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
};

export const write = (dir: string, record: ThreadEvidence) =>
  writeRecordFile(dir, record.threadId, encode(record));

/**
 * Copies a kept frame next to the record; explore scratch sits in the temp
 * dir, which a reboot can clear. Returns the copy, or the original when the
 * copy fails (the sheet then draws only frames still on disk).
 */
export const keepFrame = async (dir: string, threadId: string, sessionId: string, file: string) => {
  const target = NodePath.join(
    framesDir(dir, threadId),
    `${sessionId.slice(0, 8)}-${NodePath.basename(file)}`,
  );
  try {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.copyFile(file, target);
    return target;
  } catch {
    return file;
  }
};

/** Removes records, and their frame copies, untouched for `RETAIN_MS`. */
export const prune = async (dir: string, nowMs: number) => {
  const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const file = NodePath.join(dir, name);
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null || nowMs - stat.mtimeMs < RETAIN_MS) continue;
    // A write cut short by a crash leaves its temporary name behind.
    if (name.endsWith(".tmp")) await NodeFSP.rm(file, { force: true });
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
