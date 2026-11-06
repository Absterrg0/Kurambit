// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off -- The game layer's one native process boundary: spawn, tree stops, OS process facts and launch records.
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
 *   them with it (unless it is a live editor reaped by its record); a tree
 *   stop ends the root and its descendants pid by pid, so a `keep` filter
 *   can spare what is the user's.
 * - Free memory is `os.freemem()`: libuv reads MemAvailable on Linux.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

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

/** The CIM query for one process or all, as one JSON array; the job helper runs the same. */
const cimQuery = (filter: string) =>
  `@(Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ ` +
  `pid = $_.ProcessId; ppid = $_.ParentProcessId; ` +
  `start = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; ` +
  `exe = $_.ExecutablePath; command = $_.CommandLine } })`;

/**
 * The server's resident job helper answering process queries, once it runs:
 * a PowerShell start costs 0.3-1 s, and a stop polls facts many times. Set by
 * the one process host the server holds; null runs a one-shot PowerShell.
 */
let residentFacts: ((filter: string) => Promise<string | null>) | null = null;

const windowsList = async (pid?: number): Promise<ProcessFacts[]> => {
  const filter = pid === undefined ? "" : ` -Filter 'ProcessId=${pid}'`;
  const resident = residentFacts === null ? null : await residentFacts(filter);
  const stdout =
    resident ??
    (await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `ConvertTo-Json -InputObject ${cimQuery(filter)} -Compress`,
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    ).then(
      (result) => result.stdout.trim(),
      () => "",
    ));
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

/**
 * A Windows tree's members: descendants by parent link. Windows reuses pids
 * and never reparents, so a process whose parent pid names a root is a
 * member only if it started no earlier than that root (CIM's start is an
 * ISO time, so its order is the string order).
 */
export const windowsDescendants = (
  all: ReadonlyArray<ProcessFacts>,
  roots: ReadonlyArray<ProcessFacts>,
): ProcessFacts[] => {
  const children = new Map<number, ProcessFacts[]>();
  for (const facts of all) children.set(facts.ppid, [...(children.get(facts.ppid) ?? []), facts]);
  const out: ProcessFacts[] = [];
  const seen = new Set(roots.map((root) => root.pid));
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || child.start < parent.start) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
};

const taskkill = (pid: number): void => {
  NodeChildProcess.execFile("taskkill", ["/PID", String(pid), "/F"], {
    windowsHide: true,
  }).on("error", () => undefined);
};

/** Ends a Windows tree pid by pid, sparing what `keep` refuses; never `taskkill /T`. */
const windowsTreeKill = async (
  pid: number,
  keep: ((facts: ProcessFacts) => boolean) | undefined,
): Promise<void> => {
  const all = await listProcesses();
  const root = all.find((facts) => facts.pid === pid);
  const members = root === undefined ? [] : windowsDescendants(all, [root]);
  taskkill(pid);
  for (const member of members) if (keep?.(member) !== false) taskkill(member.pid);
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
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  static IntPtr job;
  public static void Create() {
    job = CreateJobObject(IntPtr.Zero, null);
    var info = new Extended();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Exception("CreateJobObject failed");
  }
  // notAfter: the spawn's FILETIME. A process created later holds a reused pid
  // (the child already exited) and must never join a kill-on-close job.
  public static bool Assign(uint pid, long notAfter) {
    var process = OpenProcess(0x0501, false, pid); // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION
    if (process == IntPtr.Zero) return false;
    long created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created > notAfter) {
      CloseHandle(process);
      return false;
    }
    var ok = AssignProcessToJobObject(job, process);
    CloseHandle(process);
    return ok;
  }
}
'@
[KurambitJob]::Create()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ')
  if ($parts.Length -ge 2 -and $parts[0] -eq 'facts') {
    $filter = if ($parts.Length -eq 3) { " -Filter 'ProcessId=$([uint32]$parts[2])'" } else { '' }
    $json = try { ConvertTo-Json -InputObject (Invoke-Expression ('__CIM_QUERY__'.Replace('#FILTER#', $filter))) -Compress } catch { '[]' }
    [Console]::Out.WriteLine("$($parts[1]) $json")
    [Console]::Out.Flush()
    continue
  }
  $id = [uint32]0
  $notAfter = [int64]0
  if ($parts.Length -eq 2 -and [uint32]::TryParse($parts[0], [ref]$id) -and [int64]::TryParse($parts[1], [ref]$notAfter)) { [void][KurambitJob]::Assign($id, $notAfter) }
}
`.replace("__CIM_QUERY__", cimQuery("#FILTER#").replaceAll("'", "''"));

/**
 * What one server's launches share: the Windows kill-on-close job its owned
 * children join. The server holds one
 * for its life; closing it ends the job helper, which takes the job's
 * children with it.
 */
export interface ProcessHostState {
  readonly joinJob: (pid: number) => void;
}

export const makeProcessHost = (
  /** Told once, with why, when the Windows job helper cannot run: owned children then outlive a crash. */
  onHelperFailed: (reason: string) => void = () => undefined,
): {
  readonly host: ProcessHostState;
  readonly close: () => void;
} => {
  let jobHelper: NodeChildProcess.ChildProcess | null = null;
  // One try: a helper that cannot run (Constrained Language Mode, an antivirus
  // that blocks the script) is said once, never respawned for every child.
  let failed = false;
  let ready = false;
  let nextQuery = 0;
  const pending = new Map<number, (json: string | null) => void>();
  const helper = (): NodeChildProcess.ChildProcess | null => {
    if (!isWindows || failed) return null;
    if (jobHelper !== null) return jobHelper;
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(JOB_HELPER, "utf16le").toString("base64"),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    NodeReadline.createInterface({ input: child.stdout! }).on("line", (line) => {
      if (line === "ready") {
        ready = true;
        return;
      }
      const space = line.indexOf(" ");
      const answer = pending.get(Number(line.slice(0, space)));
      if (answer === undefined) return;
      pending.delete(Number(line.slice(0, space)));
      answer(line.slice(space + 1));
    });
    const lost = (reason: string) => {
      if (jobHelper !== child) return;
      jobHelper = null;
      ready = false;
      for (const answer of pending.values()) answer(null);
      pending.clear();
      if (residentFacts === facts) residentFacts = null;
      if (!failed) {
        failed = true;
        onHelperFailed(reason);
      }
    };
    child.on("error", (error) => lost(error.message));
    child.on("exit", (code) =>
      lost(
        `the job helper exited with code ${code ?? "none"}${stderr === "" ? "" : `: ${stderr.trim()}`}`,
      ),
    );
    child.stdin?.on("error", () => undefined);
    // The helper must never keep the server alive; its pipe closing is its whole job.
    child.unref();
    for (const stream of [child.stdout, child.stderr])
      (stream as { unref?: () => void } | null)?.unref?.();
    jobHelper = child;
    return child;
  };
  const joinJob = (pid: number): void => {
    // FILETIME (100 ns since 1601) of now, just after the spawn returned, with a
    // little slack for clock granularity.
    const notAfter = (BigInt(Date.now() + 50) + 11_644_473_600_000n) * 10_000n;
    helper()?.stdin?.write(`${pid} ${notAfter}\n`);
  };
  /** One CIM query through the helper, bounded; null when it cannot answer. */
  const facts = (filter: string): Promise<string | null> => {
    const running = helper();
    if (running === null || !ready) return Promise.resolve(null);
    const pid = /ProcessId=(\d+)/.exec(filter)?.[1];
    const id = ++nextQuery;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 5_000);
      pending.set(id, (json) => {
        clearTimeout(timer);
        resolve(json);
      });
      running.stdin?.write(`facts ${id}${pid === undefined ? "" : ` ${pid}`}\n`);
    });
  };
  if (isWindows) residentFacts = facts;
  return {
    host: { joinJob },
    close: () => {
      if (residentFacts === facts) residentFacts = null;
      const child = jobHelper;
      jobHelper = null;
      child?.stdin?.end();
    },
  };
};

export class ProcessHost extends Context.Service<ProcessHost, ProcessHostState>()(
  "kurambit/game/processHost",
) {}

export const layer = Layer.effect(
  ProcessHost,
  Effect.gen(function* () {
    // The helper fails in a native callback; the server's log hears of it once.
    const failures = yield* Queue.unbounded<string>();
    yield* Queue.take(failures).pipe(
      Effect.flatMap((reason) =>
        Effect.logWarning(
          "The Windows job helper cannot run, so games and tools Kurambit starts may outlive a crashed server.",
          { reason },
        ),
      ),
      Effect.forkScoped,
    );
    const made = yield* Effect.acquireRelease(
      Effect.sync(() => makeProcessHost((reason) => Queue.offerUnsafe(failures, reason))),
      (made) => Effect.sync(made.close),
    );
    return made.host;
  }),
);

export interface SpawnOwnedOptions {
  /** The whole child environment; the launch token is added to it. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly stdio: NodeChildProcess.StdioOptions;
  /**
   * Own the child's whole tree, so a stop takes whatever it started (a
   * display server, workers): a process-group leader on POSIX; on Windows the
   * child and its descendants, each ended by pid.
   */
  readonly tree: boolean;
  /**
   * Which of a Windows tree's descendants a stop may end; all when omitted.
   * A Unity Licensing Client the editor started is the user's, never ours.
   */
  readonly keep?: ((facts: ProcessFacts) => boolean) | undefined;
  /**
   * Whether the child joins the kill-on-close job (Windows), dying with the
   * server however it exits. False for a child whose launch record is reaped
   * at the next start instead (the live Unity editor): the job is inherited,
   * and a Licensing Client the editor starts must outlive us.
   */
  readonly joinsJob?: boolean | undefined;
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
  host: ProcessHostState,
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
  // Once the leader has exited and its group is empty, the group's number is
  // free to name someone else's group: never signal or probe it again.
  let groupGone = false;
  const alive = () =>
    child.pid !== undefined &&
    (options.tree && !isWindows ? !groupGone && pidAlive(-child.pid) : !exited());
  const record = new Promise<LaunchRecord | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return resolve(null);
      if (options.joinsJob !== false) host.joinJob(pid);
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
      void windowsTreeKill(pid, options.keep);
      return true;
    }
    if (options.tree) {
      if (groupGone) return false;
      const sent = signalPid(-pid, name);
      if (!sent && exited()) groupGone = true;
      return sent;
    }
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
export const adoptLaunch = async (
  host: ProcessHostState,
  pid: number,
  token: string,
): Promise<LaunchRecord | null> => {
  const facts = await processFacts(pid);
  if (facts === null) return null;
  host.joinJob(pid);
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
  if (isWindows) {
    for (const facts of windowsDescendants(
      await listProcesses(),
      roots.map((root) => root.facts),
    ))
      if (options.keep?.(facts) !== false) members.set(facts.pid, facts);
  } else {
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
  // Windows has no SIGTERM: process.kill ends the pid (TerminateProcess), one by one.
  for (const { facts } of roots) {
    signalled.set(facts.pid, facts.start);
    signalPid(facts.pid, "SIGTERM");
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

/**
 * Runs a short tool child (ffmpeg on finished files) to its end, killed past
 * `timeoutMs`; resolves with its exit code, null when it never ran or was killed.
 */
export const runOwned = (
  host: ProcessHostState,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<number | null> =>
  new Promise((resolve) => {
    const owned = spawnOwned(host, command, args, {
      env: options.env,
      stdio: "ignore",
      tree: false,
    });
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
