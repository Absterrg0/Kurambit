// @effect-diagnostics globalTimers:off globalDate:off -- Native process callbacks need wall-clock log names and kill escalation after interruption.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { GameOperationError, type GameProcessResult } from "@t3tools/contracts";

interface Running {
  child: NodeChildProcess.ChildProcess;
  root: string;
  operation: string;
  logPath: string;
  done: Promise<GameProcessResult>;
  stop: () => void;
}
/**
 * Every way a child process can reach a display server. A headless child keeps
 * none of them: the server may itself have been started by a desktop session,
 * and an agent's `godot --write-movie` must not open a window on that session.
 */
export const DISPLAY_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;
/**
 * PATH discovery for standard executables. Env overrides exist for configured
 * tools (for example GAME_STUDIO_FFMPEG) and for tests.
 */
export const findExecutable = async (
  name: string,
  options: { readonly pathEnv?: string | undefined; readonly override?: string | undefined },
): Promise<string | null> => {
  const candidates: string[] = [];
  if (options.override?.trim()) candidates.push(options.override.trim());
  for (const entry of (options.pathEnv ?? "").split(NodePath.delimiter).filter(Boolean))
    candidates.push(NodePath.join(entry, name));
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
  // Scratch stays on disk beside the other run evidence, never RAM-backed /tmp.
  env.TMPDIR = NodePath.join(NodeOS.homedir(), ".gs-tmp");
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
   * Linux only: spawn the child as a process-group leader and signal the whole
   * group on stop, timeout and disposal, so wrapper-spawned descendants (an
   * xvfb-run server plus its Godot child) die with it. Defaults to
   * direct-child signalling; never matches processes by name.
   */
  ownedProcessGroup?: boolean | undefined;
}
export class GameProcesses extends Context.Service<
  GameProcesses,
  {
    readonly run: (input: ProcessInput) => Effect.Effect<GameProcessResult, GameOperationError>;
    readonly start: (
      input: ProcessInput,
    ) => Effect.Effect<{ pid: number; logPath: string }, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    readonly list: (root: string) => readonly { pid: number; operation: string; logPath: string }[];
  }
>()("t3/game/GameProcesses") {}

const make = Effect.gen(function* () {
  const running = new Map<number, Running>();
  const platform = yield* HostProcess.Platform;
  const startProcess = async (
    input: Parameters<GameProcesses["Service"]["run"]>[0],
    signal?: AbortSignal,
  ) => {
    const logs = NodePath.join(input.root, "builds/logs");
    await NodeFSP.mkdir(logs, { recursive: true });
    signal?.throwIfAborted();
    const logPath = NodePath.join(
      logs,
      `${Date.now()}-${input.operation}-${NodeCrypto.randomUUID()}.log`,
    );
    const log = NodeFS.createWriteStream(logPath, { flags: "wx" });
    // Spawn only after the log opens, so a failed log write cannot leave an untracked process.
    await new Promise<void>((resolve, reject) => {
      log.once("open", () => resolve());
      log.once("error", reject);
    });
    const child = NodeChildProcess.spawn(input.executable, [...input.args], {
      cwd: input.cwd ?? input.root,
      // "replace" starts from nothing so omitted keys are actually absent in
      // the spawned child; "inherit" keeps the headless server base for
      // generic tool/install/git children.
      env:
        input.envMode === "replace"
          ? { ...input.env }
          : { ...headlessEnvironment(process.env), ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
      // A wrapper (xvfb-run) leaves its display server and engine child in the
      // group; group signalling is the only way to own all of them by PID.
      detached: input.ownedProcessGroup === true && platform === "linux" ? true : undefined,
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const ownsGroup = input.ownedProcessGroup === true && platform === "linux";
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        // Signal 0 probes the owned group by PGID only; never by name.
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        // ESRCH means the group is gone; EPERM means it exists but this
        // signal is not permitted, which still counts as alive for cleanup.
        return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
      }
    };
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    };
    const stop = () => {
      if (ownsGroup) {
        // The wrapper (xvfb-run) may already have exited while its display
        // server or engine child survives in the owned group. Signal the
        // group by captured PGID regardless of the leader's exit status, so a
        // wrapper that exits first cannot orphan a redirected child. (Once the
        // leader's close fires the entry leaves the tracked map, and the
        // close handler below TERMs the still-live group the same way.)
        // Never matches processes by name; only this spawn's group.
        if (signalGroup("SIGTERM")) {
          escalation ??= setTimeout(() => {
            if (groupAlive()) signalGroup("SIGKILL");
            else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 2_000);
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          escalation ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
        }
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs ?? 120_000);
    const append = (chunk: Buffer, channel: "stdout" | "stderr") => {
      const value = chunk.toString();
      if (channel === "stdout") stdout = (stdout + value).slice(-64_000);
      else stderr = (stderr + value).slice(-64_000);
      // Keep disk output bounded too; noisy tools must not fill the user's disk.
      if (log.bytesWritten < 16 * 1024 * 1024) log.write(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    const done = new Promise<GameProcessResult>((resolve, reject) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      log.on("error", () => stop());
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        if (ownsGroup) {
          // The leader closed, but the owned group may still hold the display
          // server or engine child: the close already removed this entry from
          // the tracked map, so a later stop() cannot reach it. TERM the
          // still-owned group now so a wrapper that exits first cannot orphan
          // a redirected descendant, and keep the SIGKILL escalation for a
          // group that ignores TERM. Only a confirmed-dead group clears it.
          if (groupAlive()) {
            signalGroup("SIGTERM");
            escalation ??= setTimeout(() => {
              signalGroup("SIGKILL");
            }, 2_000);
          } else if (escalation) {
            clearTimeout(escalation);
            escalation = undefined;
          }
        } else if (escalation) {
          clearTimeout(escalation);
          escalation = undefined;
        }
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
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return { pid: child.pid!, logPath, done };
  };
  const stop = (root?: string) =>
    Effect.promise(async () => {
      const owned = [...running.values()].filter(
        (entry) => root === undefined || entry.root === root,
      );
      for (const entry of owned) entry.stop();
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
          (handle) =>
            Effect.promise(async () => {
              running.get(handle.pid)?.stop();
              await handle.done.catch(() => {});
            }),
        ).pipe(Effect.flatMap((handle) => Effect.promise(() => handle.done))),
      ),
    start: (input) =>
      Effect.tryPromise({
        try: (signal) => startProcess(input, signal).then(({ pid, logPath }) => ({ pid, logPath })),
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
