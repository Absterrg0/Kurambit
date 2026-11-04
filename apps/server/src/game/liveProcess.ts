// @effect-diagnostics globalTimers:off nodeBuiltinImport:off preferSchemaOverJson:off -- Shared memory, display and launch-record helpers for the live editors' native boundary (GameBlender, GameUnity).
// A live editor runs on a private display, records each launch on disk as it
// starts, and is reaped only through launches that still verify as ours.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import { findExecutable } from "./GameProcesses.ts";
import { memoryAvailable, type ProcessFacts } from "./processHost.ts";

const MB = 1024 * 1024;
const gb = (bytes: number) => (bytes / 1024 / MB).toFixed(1);

/**
 * The pure half of {@link memoryShortfall}: null when `available` bytes
 * cover the need (or are unknown), else the refusal detail. `override` is
 * the env value; whole MB replace `neededMb`, and 0 turns the check off.
 */
export const shortfallDetail = (
  what: string,
  neededMb: number,
  override: string | undefined,
  available: number | null,
): string | null => {
  const needed =
    (override !== undefined && /^\d+$/.test(override) ? Number(override) : neededMb) * MB;
  if (available === null || available >= needed) return null;
  return `The ${what} needs about ${gb(needed)} GB of free memory to open safely and this machine has ${gb(available)} GB available. Opening it now risks the system killing it mid-work, or the whole machine hanging on swap.`;
};

/**
 * Null when there is room to open `what`, else the detail of a `low-memory`
 * refusal. Work started short of memory gets OOM-killed mid-way once other
 * processes grow, or the machine hangs on full swap; a refusal up front is
 * the honest answer. `env` (whole MB, 0 turns the check off) overrides
 * `neededMb` for machines that know better.
 */
export const memoryShortfall = async (
  what: string,
  neededMb: number,
  env: string,
): Promise<string | null> => shortfallDetail(what, neededMb, process.env[env], memoryAvailable());

/**
 * Below this much available memory an idle live editor is closed. The kernel
 * starts reclaiming hard and the OOM killer is close; an idle editor is the
 * cheapest memory Kurambit can give back, since the next call reopens it
 * (or refuses honestly). An editor in a call is never closed.
 */
const IDLE_MEMORY_FLOOR = 1024 * MB;

/** Available memory in MB while it is under the idle floor, else null. */
export const underIdleMemoryFloor = async (): Promise<number | null> => {
  const available = memoryAvailable();
  return available < IDLE_MEMORY_FLOOR ? Math.round(available / MB) : null;
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

/**
 * Command-line checks on a verified launch, for a record's own fields (its
 * project, port or boot script). Linux keeps the exact argv; elsewhere only
 * the joined command line is known, so a value is looked for in it.
 */
export const commandHas = (facts: ProcessFacts, value: string): boolean =>
  facts.argv !== null ? facts.argv.includes(value) : facts.command.includes(value);

export const commandFlag = (facts: ProcessFacts, flag: string, value: string): boolean =>
  facts.argv !== null
    ? facts.argv[facts.argv.indexOf(flag) + 1] === value && facts.argv.includes(flag)
    : facts.command.includes(`${flag} ${value}`) || facts.command.includes(`${flag} "${value}"`);
