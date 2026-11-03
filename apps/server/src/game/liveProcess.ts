// @effect-diagnostics globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- Shared /proc, signal and pid-record helpers for the live editors' native boundary (GameBlender, GameUnity).
// A live editor runs on a private Xvfb display, writes its pids to a record on
// disk as they appear, and is reaped only through pids that still verify as ours.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import { findExecutable } from "./GameProcesses.ts";

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const readCmdline = async (pid: number): Promise<string[] | null> => {
  try {
    const raw = await NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((part) => part !== "");
    return argv.length === 0 ? null : argv;
  } catch {
    return null;
  }
};

/** The running executable of a pid, from /proc; null when unreadable or gone. */
export const readExe = (pid: number): Promise<string | null> =>
  NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => null);

/** MemAvailable from /proc/meminfo text, in bytes; null when the line is missing. */
export const parseMemAvailable = (meminfo: string): number | null => {
  const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
  return kb === undefined ? null : Number(kb) * 1024;
};

/**
 * The kernel's estimate of memory new work can take without swapping. Null
 * without /proc (off Linux) or when unreadable, which turns the memory
 * guards off.
 */
export const memAvailable = async (): Promise<number | null> =>
  parseMemAvailable(await NodeFSP.readFile("/proc/meminfo", "utf8").catch(() => ""));

const MB = 1024 * 1024;
const gb = (bytes: number) => (bytes / 1024 / MB).toFixed(1);

/**
 * Null when there is room to open `editor`, else the detail of a
 * `low-memory` refusal. An editor started short of memory gets OOM-killed
 * mid-build once other processes grow, or the machine hangs on full swap;
 * a refusal up front is the honest answer. `env` (whole MB, 0 turns the
 * check off) overrides `neededMb` for machines that know better.
 */
export const memoryShortfall = async (
  editor: string,
  neededMb: number,
  env: string,
): Promise<string | null> => {
  const override = process.env[env];
  const needed =
    (override !== undefined && /^\d+$/.test(override) ? Number(override) : neededMb) * MB;
  const available = await memAvailable();
  if (available === null || available >= needed) return null;
  return `The ${editor} needs about ${gb(needed)} GB of free memory to open safely and this machine has ${gb(available)} GB available. Opening it now risks the system killing it mid-work, or the whole machine hanging on swap.`;
};

/**
 * Below this much available memory an idle live editor is closed. The kernel
 * starts reclaiming hard and the OOM killer is close; an idle editor is the
 * cheapest memory Kurambit can give back, since the next call reopens it
 * (or refuses honestly). An editor in a call is never closed.
 */
const IDLE_MEMORY_FLOOR = 1024 * MB;

/** Available memory in MB while it is under the idle floor, else null (always null off Linux). */
export const underIdleMemoryFloor = async (): Promise<number | null> => {
  const available = await memAvailable();
  return available !== null && available < IDLE_MEMORY_FLOOR ? Math.round(available / MB) : null;
};

/** The Xvfb every live editor launches, and the only Xvfb its records may name. */
export const findXvfb = (): Promise<string | null> =>
  findExecutable("Xvfb", { pathEnv: process.env.PATH, override: process.env.KURAMBIT_XVFB });

/** The first display in [first, last] with neither an X lock file nor a listener. */
export const pickDisplay = async (first: number, last: number): Promise<number | null> => {
  for (let n = first; n <= last; n++) {
    try {
      await NodeFSP.access(`/tmp/.X${n}-lock`);
      continue;
    } catch {
      /* candidate */
    }
    const taken = await new Promise<boolean>((resolve) => {
      const s = NodeNet.connect(6000 + n, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => {
        s.destroy();
        resolve(false);
      });
    });
    if (!taken) return n;
  }
  return null;
};

/** `:N` inside the range this service picks its displays from. */
export const displayInRange = (display: unknown, first: number, last: number): boolean => {
  if (typeof display !== "string") return false;
  const n = /^:(\d+)$/.exec(display)?.[1];
  return n !== undefined && Number(n) >= first && Number(n) <= last;
};

export const readRecord = async <T>(file: string): Promise<Partial<T> | null> => {
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<T>) : null;
  } catch {
    return null;
  }
};

/** A pid from a record, kept only while its live argv matches what this server launched. */
export interface RecordedPid {
  readonly pid: number | undefined;
  readonly owns: (argv: ReadonlyArray<string>) => boolean;
}

/**
 * A process's start time (clock ticks since boot) and executable, from /proc;
 * a reused pid never matches both. Null when unreadable or gone.
 */
const identityOf = async (pid: number): Promise<string | null> => {
  const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  const exe = await readExe(pid);
  if (stat === null || exe === null) return null;
  // Field 22 (starttime); fields after the parenthesized name start at field 3.
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return start === undefined ? null : `${start} ${exe}`;
};

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {
    /* gone */
  }
};

/**
 * SIGTERM the recorded pids that verify as ours plus the extra pids `tree`
 * names (taken once, while the owners still live), wait up to `waitMs`, then
 * SIGKILL stragglers that are still the same process (start time and
 * executable as signalled). Without /proc nothing verifies, so nothing is
 * signalled.
 */
export const reapVerified = async (
  recorded: ReadonlyArray<RecordedPid>,
  options: {
    readonly waitMs: number;
    readonly pollMs: number;
    readonly tree?: (owned: ReadonlyArray<number>) => Promise<ReadonlyArray<number>>;
  },
): Promise<void> => {
  const owned = async () => {
    const live: number[] = [];
    for (const { pid, owns } of recorded) {
      if (pid === undefined || !Number.isInteger(pid) || pid <= 1) continue;
      const argv = await readCmdline(pid);
      if (argv !== null && owns(argv)) live.push(pid);
    }
    return live;
  };
  let live = await owned();
  const tree = live.length > 0 && options.tree !== undefined ? await options.tree(live) : [];
  const signalled = new Map<number, string | null>();
  for (const pid of [...live, ...tree]) {
    signalled.set(pid, await identityOf(pid));
    signal(pid, "SIGTERM");
  }
  for (let waited = 0; live.length > 0 && waited < options.waitMs; waited += options.pollMs) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    live = await owned();
  }
  for (const pid of new Set([...live, ...tree])) {
    const identity = signalled.get(pid);
    if (
      identity !== undefined &&
      identity !== null &&
      alive(pid) &&
      (await identityOf(pid)) === identity
    )
      signal(pid, "SIGKILL");
  }
  // A memory check right after a reap must see the memory given back: wait
  // (briefly) for every signalled process, workers included, to be gone.
  for (let waited = 0; waited < 3_000; waited += 100) {
    let left = false;
    for (const [pid, identity] of signalled)
      if (alive(pid) && identity !== null && (await identityOf(pid)) === identity) left = true;
    if (!left) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/**
 * Every process below `root` or in its process group, read from /proc.
 * Unity's import workers start their own sessions, so a group signal alone
 * misses them; walking parent links from a pid we spawned does, without
 * matching any name. `keep` decides, by executable, which of them may be
 * signalled at all.
 */
export const processTreeOf = async (
  root: number,
  keep: (exe: string) => boolean,
): Promise<number[]> => {
  const children = new Map<number, number[]>();
  const grouped: number[] = [];
  for (const entry of await NodeFSP.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await NodeFSP.readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    if (stat === null) continue;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    const pid = Number(entry);
    if (Number.isFinite(ppid)) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    if (pgrp === root && pid !== root) grouped.push(pid);
  }
  const found = new Set<number>(grouped);
  const visited = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0)
    for (const child of children.get(queue.shift()!) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      found.add(child);
      queue.push(child);
    }
  const out: number[] = [];
  for (const pid of found) {
    const exe = await readExe(pid);
    if (exe !== null && keep(exe)) out.push(pid);
  }
  return out;
};
