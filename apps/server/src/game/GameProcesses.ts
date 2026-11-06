// @effect-diagnostics globalTimers:off globalDate:off -- Native process callbacks need wall-clock log names and kill escalation after interruption.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError, type GameProcessResult, type GameViewport } from "@kurambit/contracts";
import { HOST_OS, ProcessHost, spawnOwned, type ProcessFacts } from "./processHost.ts";
import type { WindowCommand, WindowHost } from "./windowHost.ts";

interface Running {
  child: NodeChildProcess.ChildProcess;
  root: string;
  operation: string;
  logPath: string;
  done: Promise<GameProcessResult>;
  stop: () => Promise<void>;
}
/** A started process: its exit, and a stop that resolves once it has exited. */
export interface StartedProcess {
  readonly pid: number;
  readonly logPath: string;
  readonly exited: Promise<GameProcessResult>;
  readonly stop: () => Promise<void>;
}
/**
 * Every way a child process can reach a display server. A headless child keeps
 * none of them: the server may itself have been started by a desktop session,
 * and an agent's `godot --write-movie` must not open a window on that session.
 */
export const DISPLAY_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;
/**
 * PATH discovery for standard executables. Env overrides exist for configured
 * tools (for example KURAMBIT_FFMPEG) and for tests.
 */
export const findExecutable = async (
  name: string,
  options: { readonly pathEnv?: string | undefined; readonly override?: string | undefined },
): Promise<string | null> => {
  const candidates: string[] = [];
  if (options.override?.trim()) candidates.push(options.override.trim());
  // Windows finds programs by extension; PATH holds ffmpeg.exe, not ffmpeg.
  const names =
    HOST_OS === "win32" && NodePath.extname(name) === "" ? [`${name}.exe`, name] : [name];
  for (const entry of (options.pathEnv ?? "").split(NodePath.delimiter).filter(Boolean))
    for (const candidate of names) candidates.push(NodePath.join(entry, candidate));
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate, NodeFSP.constants.X_OK);
      if ((await NodeFSP.stat(candidate)).isFile()) return candidate;
    } catch {
      // Not usable; try the next candidate.
    }
  }
  return null;
};
/** The environment headless children get: the server's, minus every display route. */
export const headlessEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const headless: NodeJS.ProcessEnv = { ...environment };
  for (const name of DISPLAY_VARIABLES) delete headless[name];
  return headless;
};
/**
 * Allowlisted base environment for children that execute engine or game
 * code (native Godot explore/bot runs, live Blender, headless Chromium).
 * Only process lookup, home, scratch, locale and heap knobs cross the
 * boundary; server secrets, provider credentials and unrelated tool
 * configuration stay behind. Display routes never cross here: a caller adds
 * a DISPLAY only for the private display it owns. Callers add exactly what
 * their child owns on top: per-run XDG/HOME isolation, GL
 * software-rendering flags, or intentional addon keys. Tool/install children
 * that fetch over the network keep the broader headless environment instead,
 * where proxy/cert variables may be required.
 */
export const engineChildEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const source = process.env;
  const env: NodeJS.ProcessEnv = {};
  if (source.PATH !== undefined) env.PATH = source.PATH;
  if (source.HOME !== undefined) env.HOME = source.HOME;
  env.LANG = source.LANG ?? "C.UTF-8";
  if (source.LC_ALL !== undefined) env.LC_ALL = source.LC_ALL;
  if (source.NODE_OPTIONS !== undefined) env.NODE_OPTIONS = source.NODE_OPTIONS;
  // Windows process launch needs its own runtime knobs; never secrets.
  if (source.SYSTEMROOT !== undefined) env.SYSTEMROOT = source.SYSTEMROOT;
  if (source.WINDIR !== undefined) env.WINDIR = source.WINDIR;
  if (source.PATHEXT !== undefined) env.PATHEXT = source.PATHEXT;
  if (source.TEMP !== undefined) env.TEMP = source.TEMP;
  if (source.TMP !== undefined) env.TMP = source.TMP;
  if (source.TMPDIR !== undefined) env.TMPDIR = source.TMPDIR;
  // Godot on Windows finds its config, export templates and user:// through
  // these; without them it falls back to the working directory (the game root).
  if (HOST_OS === "win32")
    for (const key of ["APPDATA", "LOCALAPPDATA", "USERPROFILE"] as const)
      if (source[key] !== undefined) env[key] = source[key];
  if (extra !== undefined) for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
};
interface ProcessInput {
  root: string;
  executable: string;
  args: readonly string[];
  operation: string;
  timeoutMs?: number;
  cwd?: string;
  /** Extra variables merged over the base environment for this child only; never leaked globally. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Which base the child environment replaces. "inherit" (default) keeps the
   * existing behavior: the headless server environment with per-child
   * `env` overlaid, for generic tool/install/git children that may need
   * network, proxy, or cert configuration. "replace" starts from an empty
   * environment so `env` IS the child environment: omitted keys are absent,
   * not merely overlaid. Engine code-execution children must use "replace"
   * with an allowlisted env (see engineChildEnv); "replace" without an
   * explicit `env` leaves the child with nothing and fails loudly.
   */
  envMode?: "inherit" | "replace" | undefined;
  /**
   * Start the child in a window the user never sees (see windowHost); the
   * child then owns its tree, and stop, timeout and disposal also end what
   * the window needed. Without it the child is signalled directly; nothing
   * is ever matched by name.
   */
  window?: { readonly host: WindowHost; readonly viewport: GameViewport } | undefined;
  /**
   * False for a child whose launch record is reaped at the next start (the
   * live Unity editor): it stays out of the Windows kill-on-close job, so a
   * Licensing Client it starts is not ended with the server.
   */
  joinsJob?: boolean | undefined;
  /** Which of a Windows tree a stop may end (a Unity editor's Licensing Client never). */
  keep?: ((facts: ProcessFacts) => boolean) | undefined;
  /**
   * False keeps the output in memory only: a short probe (a tool's
   * --version) leaves no log file behind for every call.
   */
  log?: boolean | undefined;
}
export class GameProcesses extends Context.Service<
  GameProcesses,
  {
    readonly run: (input: ProcessInput) => Effect.Effect<GameProcessResult, GameOperationError>;
    readonly start: (input: ProcessInput) => Effect.Effect<StartedProcess, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    readonly list: (root: string) => readonly { pid: number; operation: string; logPath: string }[];
  }
>()("kurambit/game/GameProcesses") {}

const make = Effect.gen(function* () {
  const host = yield* ProcessHost;
  const running = new Map<number, Running>();
  const startProcess = async (
    input: Parameters<GameProcesses["Service"]["run"]>[0],
    signal?: AbortSignal,
  ) => {
    const keepsLog = input.log !== false;
    const logs = NodePath.join(input.root, "builds/logs");
    if (keepsLog) await NodeFSP.mkdir(logs, { recursive: true });
    signal?.throwIfAborted();
    const logPath = keepsLog
      ? NodePath.join(logs, `${Date.now()}-${input.operation}-${NodeCrypto.randomUUID()}.log`)
      : "";
    const log = keepsLog
      ? NodeFS.createWriteStream(logPath, { flags: "wx" })
      : new NodeStream.PassThrough().resume();
    // Spawn only after the log opens, so a failed log write cannot leave an untracked process.
    if (keepsLog)
      await new Promise<void>((resolve, reject) => {
        log.once("open", () => resolve());
        log.once("error", reject);
      });
    const command = {
      executable: input.executable,
      args: input.args,
      cwd: input.cwd ?? input.root,
      // "replace" starts from nothing so omitted keys are actually absent in
      // the spawned child; "inherit" keeps the headless server base for
      // generic tool/install/git children.
      env:
        input.envMode === "replace"
          ? { ...input.env }
          : { ...headlessEnvironment(process.env), ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      joinsJob: input.joinsJob,
      keep: input.keep,
    } satisfies WindowCommand;
    const hosted =
      input.window === undefined
        ? null
        : await input.window.host.launch(command, input.window.viewport).catch((error: unknown) => {
            log.end();
            throw error;
          });
    // Every child owns its tree: an engine's own children (an @tool script's
    // OS.execute, an export plugin's tools) end with it on a stop or timeout.
    const owned =
      hosted?.process ??
      spawnOwned(host, command.executable, command.args, {
        ...command,
        tree: true,
      });
    const { child } = owned;
    let stdout = "",
      stderr = "",
      timedOut = false;
    let stopping: Promise<void> | null = null;
    // Once the child closed, its pid and group may belong to another process:
    // the close handler's own stop is the last one that signals anything.
    let closed = false;
    const stop = () =>
      closed
        ? (stopping ?? Promise.resolve())
        : (stopping ??= (hosted?.stop() ?? owned.stop()).finally(() => {
            stopping = null;
          }));
    const abort = () => void stop();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) void stop();
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, input.timeoutMs ?? 120_000);
    const append = (chunk: Buffer, channel: "stdout" | "stderr") => {
      const value = chunk.toString();
      if (channel === "stdout") stdout = (stdout + value).slice(-64_000);
      else stderr = (stderr + value).slice(-64_000);
      // Keep disk output bounded too; noisy tools must not fill the user's disk.
      if (!("bytesWritten" in log) || log.bytesWritten < 16 * 1024 * 1024) log.write(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    const done = new Promise<GameProcessResult>((resolve, reject) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      log.on("error", () => void stop());
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        // The child closed, but its tree or window may still hold processes,
        // and the close removes this entry from the tracked map, so a later
        // stop() could not reach them.
        if (hosted !== null || owned.alive()) void stop();
        closed = true;
        signal?.removeEventListener("abort", abort);
        if (child.pid !== undefined) running.delete(child.pid);
        log.end(() => {
          if (spawnError) reject(spawnError);
          else
            resolve({
              pid: child.pid ?? -1,
              exitCode: code ?? -1,
              signal: exitSignal,
              timedOut,
              stdout,
              stderr,
              logPath,
            });
        });
      });
    });
    // A native process completes after its caller has returned.
    void done.catch(() => {});
    if (child.pid !== undefined)
      running.set(child.pid, {
        child,
        root: input.root,
        operation: input.operation,
        logPath,
        done,
        stop,
      });
    // A hosted child may have spawned already; its record settles either way.
    if (hosted !== null) {
      if ((await owned.record) === null) throw new Error(`${input.executable} did not start.`);
    } else
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    return {
      pid: child.pid!,
      logPath,
      exited: done,
      // Resolves once the child closed and what its window needed is gone.
      stop: async () => {
        await stop();
        await done.catch(() => {});
      },
    } satisfies StartedProcess;
  };
  const stop = (root?: string) =>
    Effect.promise(async () => {
      const owned = [...running.values()].filter(
        (entry) => root === undefined || entry.root === root,
      );
      for (const entry of owned) void entry.stop();
      await Promise.allSettled(owned.map((entry) => entry.done));
    });
  yield* Effect.addFinalizer(() => stop());
  return GameProcesses.of({
    run: (input) =>
      Effect.scoped(
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startProcess(input),
            catch: (cause) =>
              new GameOperationError({
                operation: input.operation,
                path: input.executable,
                reason: "io",
                cause,
              }),
          }),
          (handle) => Effect.promise(() => handle.stop()),
        ).pipe(Effect.flatMap((handle) => Effect.promise(() => handle.exited))),
      ),
    start: (input) =>
      Effect.tryPromise({
        try: (signal) => startProcess(input, signal),
        catch: (cause) =>
          new GameOperationError({
            operation: input.operation,
            path: input.executable,
            reason: "io",
            cause,
          }),
      }),
    stop: (root) => stop(root),
    list: (root) =>
      [...running.entries()]
        .filter(([, entry]) => entry.root === root)
        .map(([pid, entry]) => ({ pid, operation: entry.operation, logPath: entry.logPath })),
  });
});
export const layer = Layer.effect(GameProcesses, make);
