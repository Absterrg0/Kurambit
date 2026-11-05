// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Shared memory, launch-record, sweep and MCP helpers for the live editors' native boundary (GameBlender, GameUnity).
// A live editor runs in a window host's window, records each launch on disk as
// it starts, and is reaped only through launches that still verify as ours.
import * as NodeFSP from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
): Promise<string | null> =>
  shortfallDetail(what, neededMb, process.env[env], await memoryAvailable());

/**
 * Below this much available memory an idle live editor is closed. The kernel
 * starts reclaiming hard and the OOM killer is close; an idle editor is the
 * cheapest memory Kurambit can give back, since the next call reopens it
 * (or refuses honestly). An editor in a call is never closed.
 */
const IDLE_MEMORY_FLOOR = 1024 * MB;

/** Available memory in MB while it is under the idle floor, else null. */
export const underIdleMemoryFloor = async (): Promise<number | null> => {
  const available = await memoryAvailable();
  return available < IDLE_MEMORY_FLOOR ? Math.round(available / MB) : null;
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

/** How long a live editor sits unused before its sweep closes it. */
export const LIVE_IDLE_MS = 10 * 60_000;
/** How often the Scheduler runs a live editor's idle sweep. */
export const LIVE_SWEEP_MS = 15_000;

/**
 * One idle sweep of a live editor's sessions, so one forgotten game cannot
 * hold an editor and its display forever: an idle session past LIVE_IDLE_MS
 * closes, and every idle one closes early when the machine runs short of
 * memory. Each `close` re-checks that its session is still idle in the step
 * that ends it, since a call may have taken it meanwhile.
 */
export const sweepIdle = (input: {
  readonly what: string;
  readonly idle: () => ReadonlyArray<{
    readonly root: string;
    readonly lastActive: number;
    readonly close: Effect.Effect<void>;
  }>;
}) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const idle = input.idle();
    const shortMb = idle.length === 0 ? null : yield* Effect.promise(underIdleMemoryFloor);
    for (const session of idle) {
      const expired = now - session.lastActive > LIVE_IDLE_MS;
      if (!expired && shortMb === null) continue;
      if (!expired)
        yield* Effect.logWarning(`closing an idle ${input.what}: memory is short`, {
          root: session.root,
          availableMb: shortMb,
        });
      yield* session.close;
    }
  });

/** An MCP tool result, as the editors' MCP servers return it. */
export type McpContent = {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly isError?: boolean;
};

export const textOf = (result: McpContent): string =>
  (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");

/** Plain record for an MCP stdio transport: no undefined entries. */
export const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
};
