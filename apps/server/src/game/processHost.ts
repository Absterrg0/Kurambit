// @effect-diagnostics globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- The game layer's one native process boundary: spawn, tree stops, OS process facts and launch records.
/**
 * Every process the game layer starts goes through here, on every OS.
 *
 * - A child carries a fresh launch token in its environment (and on its
 *   command line where the caller can place one). Its launch record is pid,
 *   OS start time and token. A record is acted on only while the live
 *   process still has that start time and carries that token, so a reused
 *   pid, or a record an agent wrote, never names anything else.
 * - A child that owns a tree leads its own process group on Linux and macOS
 *   and is stopped by group, as Playwright and execa do. Windows has no
 *   groups: every owned child joins one kill-on-close Job Object held by a
 *   helper whose stdin is this server's pipe, so a server that dies takes
 *   them with it; a tree stop is `taskkill /T /F` while the root lives.
 * - Free memory is `os.freemem()`: libuv reads MemAvailable on Linux.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
/**
 * The OS this server runs on. The process boundary is plain async code used
 * from many services' native callbacks, so it reads the platform once here.
 */
// oxlint-disable-next-line kurambit/no-global-process-runtime -- The one OS switch of the native process boundary; every per-OS branch below keys off it.
export const HOST_OS: NodeJS.Platform = process.platform;
const isWindows = HOST_OS === "win32";

/** The environment variable every launched child (and whatever it starts) carries its token in. */
export const LAUNCH_ENV = "KURAMBIT_LAUNCH";
const TOKEN = /^kurambit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const launchToken = (): string => `kurambit-${NodeCrypto.randomUUID()}`;

/** One launch as recorded: what proves a live process is still the one this server started. */
export interface LaunchRecord {
  readonly pid: number;
  /** The OS start time as {@link processFacts} reads it. */
  readonly start: string;
  readonly token: string;
}

export const isLaunchRecord = (value: unknown): value is LaunchRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<LaunchRecord>;
  return (
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 1 &&
    typeof record.start === "string" &&
    record.start !== "" &&
    typeof record.token === "string" &&
    TOKEN.test(record.token)
  );
};

export interface ProcessFacts {
  readonly pid: number;
  readonly ppid: number;
  /** The process group; null where the OS has none (Windows). */
  readonly pgid: number | null;
  /** Opaque and stable for the process's life: clock ticks since boot, or a timestamp. */
  readonly start: string;
  /** The running executable's path, when the OS reports one. */
  readonly exe: string | null;
  /** The exact argv where the OS keeps it (Linux); elsewhere null and `command` holds the line. */
  readonly argv: ReadonlyArray<string> | null;
  readonly command: string;
}

const linuxFacts = async (pid: number): Promise<ProcessFacts | null> => {
  const [stat, cmdline, exe] = await Promise.all([
    NodeFSP.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null),
    NodeFSP.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null),
    NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => null),
  ]);
  if (stat === null) return null;
  // The name in field 2 may hold spaces and parentheses; the fields after it start at field 3.
  const rest = stat.slice(stat.lastIndexOf(")") + 2);
  const fields = rest.split(" ");
  const start = fields[19];
  // A zombie is already dead; only its parent's wait is missing.
  if (start === undefined || fields[0] === "Z") return null;
  const argv = (cmdline ?? "").split("\0").filter((part) => part !== "");
  return {
    pid,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    start,
    exe,
    argv,
    command: argv.join(" "),
  };
};

const linuxList = async (): Promise<ProcessFacts[]> => {
  const out: ProcessFacts[] = [];
  for (const entry of await NodeFSP.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const facts = await linuxFacts(Number(entry));
    if (facts !== null) out.push(facts);
  }
  return out;
};

// In the C locale lstart is five words ("Wed Nov  4 10:00:00 2026"); ps pads its columns.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S.*)$/;

/** macOS and other POSIX systems without /proc: ps(1), which every one ships. */
const psList = async (pids?: ReadonlyArray<number>): Promise<ProcessFacts[]> => {
  const select = pids === undefined ? ["-ax"] : ["-p", pids.join(",")];
  const run = (columns: string) =>
    execFile("ps", ["-ww", "-o", columns, ...select], {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 64 * 1024 * 1024,
    }).then(
      (result) => result.stdout.split("\n"),
      // ps exits 1 when no listed pid exists.
      () => [] as string[],
    );
  const [lines, comms] = await Promise.all([
    run("pid=,ppid=,pgid=,lstart=,command="),
    run("pid=,comm="),
  ]);
  const exes = new Map<number, string>();
  for (const line of comms) {
    const found = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (found !== null) exes.set(Number(found[1]), found[2]!.trim());
  }
  const out: ProcessFacts[] = [];
  for (const line of lines) {
    const found = PS_LINE.exec(line);
    if (found === null) continue;
    const pid = Number(found[1]);
    out.push({
      pid,
      ppid: Number(found[2]),
      pgid: Number(found[3]),
      start: found[4]!.replace(/\s+/g, " "),
      exe: exes.get(pid) ?? null,
      argv: null,
      command: found[5]!.trim(),
    });
  }
  return out;
};

const windowsList = async (pid?: number): Promise<ProcessFacts[]> => {
  const filter = pid === undefined ? "" : ` -Filter 'ProcessId=${pid}'`;
  const script =
    `Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ ` +
    `pid = $_.ProcessId; ppid = $_.ParentProcessId; ` +
    `start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; ` +
    `exe = $_.ExecutablePath; command = $_.CommandLine } } | ConvertTo-Json -Compress`;
  const stdout = await execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  ).then(
    (result) => result.stdout.trim(),
    () => "",
  );
  if (stdout === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: ProcessFacts[] = [];
  for (const row of (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<
    string,
    unknown
  > | null>) {
    if (typeof row?.["pid"] !== "number" || typeof row["start"] !== "string" || row["start"] === "")
      continue;
    out.push({
      pid: row["pid"],
      ppid: typeof row["ppid"] === "number" ? row["ppid"] : 0,
      pgid: null,
      start: row["start"],
      exe: typeof row["exe"] === "string" ? row["exe"] : null,
      argv: null,
      command: typeof row["command"] === "string" ? row["command"] : "",
    });
  }
  return out;
};

/** What the OS reports about one live process; null when it is gone or unreadable. */
export const processFacts = async (pid: number): Promise<ProcessFacts | null> => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (HOST_OS === "linux") return linuxFacts(pid);
  const found = isWindows ? await windowsList(pid) : await psList([pid]);
  return found.find((facts) => facts.pid === pid) ?? null;
};

/** Every process the OS lets this user see. */
export const listProcesses = (): Promise<ProcessFacts[]> =>
  HOST_OS === "linux" ? linuxList() : isWindows ? windowsList() : psList();

/** A process's working directory; only Linux exposes another process's without a native helper. */
export const processCwd = (pid: number): Promise<string | null> =>
  HOST_OS === "linux"
    ? NodeFSP.readlink(`/proc/${pid}/cwd`).catch(() => null)
    : Promise.resolve(null);

/** The launch tokens in a process's environment, where the OS shows it to its user (Linux). */
const environTokens = async (pid: number): Promise<ReadonlyArray<string>> => {
  if (HOST_OS !== "linux") return [];
  const environ = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
  const prefix = `${LAUNCH_ENV}=`;
  return environ
    .split("\0")
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
};

/**
 * Whether the live process `facts` describes is the launch `record` names:
 * the same pid and start time, carrying the record's token on its command
 * line or in its environment (`environ`, where the OS shows it). Pure, so
 * the data-safety rule has one place.
 */
export const isOurLaunch = (
  record: unknown,
  facts: ProcessFacts | null,
  environ: ReadonlyArray<string>,
): boolean => {
  if (!isLaunchRecord(record) || facts === null) return false;
  if (facts.pid !== record.pid || facts.start !== record.start) return false;
  const onCommandLine =
    facts.argv !== null
      ? facts.argv.some((arg) => arg.includes(record.token))
      : facts.command.includes(record.token);
  return onCommandLine || environ.includes(record.token);
};

const verified = async (record: unknown): Promise<ProcessFacts | null> => {
  if (!isLaunchRecord(record)) return null;
  const facts = await processFacts(record.pid);
  return facts !== null && isOurLaunch(record, facts, await environTokens(record.pid))
    ? facts
    : null;
};

/** Signals one pid, or a whole process group by its negated id; false when it is gone or not ours to signal. */
const signalPid = (pid: number, signal: NodeJS.Signals): boolean => {
  // 0, -1 and 1 would reach this server's own group, every process, or init.
  if (!Number.isInteger(pid) || Math.abs(pid) <= 1) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but this signal is not permitted, which still counts as alive.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
};

const taskkillTree = (pid: number): void => {
  NodeChildProcess.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
  }).on("error", () => undefined);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The kill-on-close Job Object every owned Windows child joins. The helper
 * holds the job's only handle and reads pids from a pipe this server keeps
 * open: when the server exits, however it exits, the pipe closes, the
 * helper ends, the handle closes and Windows ends every process in the job
 * (nested jobs included, Windows 8 and later). A child is assigned right
 * after it spawns, so whatever it starts before that is not in the job; a
 * tree stop's taskkill /T still reaches those while the root lives.
 */
const JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KurambitJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job;
  public static void Create() {
    job = CreateJobObject(IntPtr.Zero, null);
    var info = new Extended();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Exception("CreateJobObject failed");
  }
  public static bool Assign(uint pid) {
    var process = OpenProcess(0x0101, false, pid); // PROCESS_TERMINATE | PROCESS_SET_QUOTA
    if (process == IntPtr.Zero) return false;
    var ok = AssignProcessToJobObject(job, process);
    CloseHandle(process);
    return ok;
  }
}
'@
[KurambitJob]::Create()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = [uint32]0
  if ([uint32]::TryParse($line, [ref]$id)) { [void][KurambitJob]::Assign($id) }
}
`;

let jobHelper: NodeChildProcess.ChildProcess | null = null;
const joinWindowsJob = (pid: number): void => {
  if (jobHelper === null || jobHelper.exitCode !== null || jobHelper.stdin?.destroyed !== false) {
    const helper = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(JOB_HELPER, "utf16le").toString("base64"),
      ],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    helper.on("error", () => undefined);
    helper.stdin?.on("error", () => undefined);
    // The helper must never keep the server alive; its pipe closing is its whole job.
    helper.unref();
    jobHelper = helper;
  }
  jobHelper.stdin?.write(`${pid}\n`);
};

export interface SpawnOwnedOptions {
  /** The whole child environment; the launch token is added to it. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly stdio: NodeChildProcess.StdioOptions;
  /**
   * Own the child's whole tree, so a stop takes whatever it started (a
   * display server, workers): a process-group leader on POSIX, a taskkill
   * /T root on Windows.
   */
  readonly tree: boolean;
  /**
   * The child opens a window of its own (an engine or editor). Windows only:
   * such a child is not started hidden, since a hidden first show would keep
   * its window from ever drawing; tool children get no console window.
   */
  readonly window?: boolean | undefined;
  /** The launch token; a fresh one when omitted. Pass one to also place it on the command line. */
  readonly token?: string | undefined;
}

export interface OwnedProcess {
  readonly child: NodeChildProcess.ChildProcess;
  readonly token: string;
  /** The launch as recorded; null when the child never started or was gone before it could be read. */
  readonly record: Promise<LaunchRecord | null>;
  /** Whether the child itself has not exited yet. */
  readonly running: () => boolean;
  /** Whether the child, or anything left in its owned tree, still runs. */
  readonly alive: () => boolean;
  /** Signals the child, or its whole tree when it owns one; false when nothing was there. */
  readonly signal: (signal: NodeJS.Signals) => boolean;
  /**
   * `first` (SIGTERM by default) now, SIGKILL once `graceMs` passes with
   * anything still alive; resolves once it is gone or a second after the kill.
   */
  readonly stop: (options?: {
    readonly first?: NodeJS.Signals;
    readonly graceMs?: number;
  }) => Promise<void>;
}

/** Starts a child this server owns. */
export const spawnOwned = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOwnedOptions,
): OwnedProcess => {
  const token = options.token ?? launchToken();
  const child = NodeChildProcess.spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options.env, [LAUNCH_ENV]: token },
    stdio: options.stdio,
    detached: options.tree && !isWindows,
    windowsHide: options.window !== true,
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const running = () => child.pid !== undefined && !exited();
  const alive = () =>
    child.pid !== undefined && (options.tree && !isWindows ? pidAlive(-child.pid) : !exited());
  const record = new Promise<LaunchRecord | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return resolve(null);
      if (isWindows) joinWindowsJob(pid);
      void processFacts(pid).then(
        (facts) => resolve(facts === null ? null : { pid, start: facts.start, token }),
        () => resolve(null),
      );
    });
  });
  const signal = (name: NodeJS.Signals): boolean => {
    const pid = child.pid;
    if (pid === undefined) return false;
    if (options.tree && isWindows) {
      if (!running()) return false;
      taskkillTree(pid);
      return true;
    }
    if (options.tree) return signalPid(-pid, name);
    if (exited()) return false;
    return child.kill(name);
  };
  const stop: OwnedProcess["stop"] = async (stopOptions) => {
    const grace = stopOptions?.graceMs ?? 2_000;
    if (!signal(stopOptions?.first ?? "SIGTERM")) return;
    for (let waited = 0; alive() && waited < grace; waited += 100) await sleep(100);
    if (!alive()) return;
    signal("SIGKILL");
    for (let waited = 0; alive() && waited < 1_000; waited += 100) await sleep(100);
  };
  return { child, token, record, running, alive, signal, stop };
};

/** Records a child another library spawned (an MCP stdio client's) under the token its environment carries. */
export const adoptLaunch = async (pid: number, token: string): Promise<LaunchRecord | null> => {
  const facts = await processFacts(pid);
  if (facts === null) return null;
  if (isWindows) joinWindowsJob(pid);
  return { pid, start: facts.start, token };
};

/** Whether a recorded launch still runs as the process it named. */
export const launchAlive = async (record: unknown): Promise<boolean> =>
  (await verified(record)) !== null;

/**
 * Stops recorded launches that still verify as ours, with the rest of their
 * trees: descendants by parent link, members of their process groups and,
 * where the OS shows environments, any process carrying a recorded token
 * (helpers that left the group, such as Unity's import workers). `keep`
 * decides which of those tree members may be signalled at all; the recorded
 * roots always are. SIGTERM (Windows: forced termination of the tree), a
 * wait of up to `waitMs` for the roots, then SIGKILL for whatever is still
 * the same process, then a short wait so memory checks after a stop see
 * the memory back. Nothing that does not verify is ever signalled.
 */
export const stopRecorded = async (
  records: ReadonlyArray<unknown>,
  options: {
    readonly waitMs: number;
    /** A further check on each verified root (what it runs, for which project); all pass when omitted. */
    readonly owns?: (facts: ProcessFacts) => boolean;
    readonly keep?: (facts: ProcessFacts) => boolean;
  },
): Promise<void> => {
  const roots: Array<{ readonly record: LaunchRecord; readonly facts: ProcessFacts }> = [];
  for (const record of records) {
    const facts = await verified(record);
    if (facts !== null && isLaunchRecord(record) && options.owns?.(facts) !== false)
      roots.push({ record, facts });
  }
  if (roots.length === 0) return;
  const members = new Map<number, ProcessFacts>();
  if (!isWindows) {
    const all = await listProcesses();
    const rootPids = new Set(roots.map((root) => root.facts.pid));
    const tokens = new Set(roots.map((root) => root.record.token));
    const children = new Map<number, ProcessFacts[]>();
    for (const facts of all) children.set(facts.ppid, [...(children.get(facts.ppid) ?? []), facts]);
    for (const facts of all) {
      if (rootPids.has(facts.pid)) continue;
      if (facts.pgid !== null && rootPids.has(facts.pgid)) members.set(facts.pid, facts);
      else if ((await environTokens(facts.pid)).some((token) => tokens.has(token)))
        members.set(facts.pid, facts);
    }
    const queue = [...rootPids];
    const visited = new Set(queue);
    while (queue.length > 0)
      for (const child of children.get(queue.shift()!) ?? []) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        members.set(child.pid, child);
        queue.push(child.pid);
      }
    for (const [pid, facts] of members) if (options.keep?.(facts) === false) members.delete(pid);
  }
  const signalled = new Map<number, string>();
  for (const { facts } of roots) {
    signalled.set(facts.pid, facts.start);
    if (isWindows) taskkillTree(facts.pid);
    else signalPid(facts.pid, "SIGTERM");
  }
  for (const facts of members.values()) {
    signalled.set(facts.pid, facts.start);
    signalPid(facts.pid, "SIGTERM");
  }
  const same = async (pid: number, start: string) => (await processFacts(pid))?.start === start;
  const anyRootLeft = async () => {
    for (const { facts } of roots) if (await same(facts.pid, facts.start)) return true;
    return false;
  };
  for (let waited = 0; waited < options.waitMs && (await anyRootLeft()); waited += 200)
    await sleep(200);
  for (const [pid, start] of signalled)
    if (await same(pid, start)) signalPid(pid, isWindows ? "SIGTERM" : "SIGKILL");
  for (let waited = 0; waited < 3_000; waited += 100) {
    let left = false;
    for (const [pid, start] of signalled) if (await same(pid, start)) left = true;
    if (!left) break;
    await sleep(100);
  }
};

/** Memory new work can take, in bytes: libuv's MemAvailable on Linux, the OS's own figure elsewhere. */
export const memoryAvailable = (): number => NodeOS.freemem();

/**
 * Runs a short tool child (ffmpeg on finished files) to its end, killed past
 * `timeoutMs`; resolves with its exit code, null when it never ran or was killed.
 */
export const runOwned = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<number | null> =>
  new Promise((resolve) => {
    const owned = spawnOwned(command, args, { env: options.env, stdio: "ignore", tree: false });
    const timer = setTimeout(() => {
      owned.signal("SIGKILL");
      resolve(null);
    }, options.timeoutMs);
    owned.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    owned.child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
