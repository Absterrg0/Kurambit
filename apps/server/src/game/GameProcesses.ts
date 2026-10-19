// @effect-diagnostics globalTimers:off globalDate:off -- Native process callbacks need wall-clock log names and kill escalation after interruption.
// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native filesystem, process, or loopback HTTP boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GameOperationError, type GameProcessResult } from "@t3tools/contracts";

interface Running {
  child: NodeChildProcess.ChildProcess;
  root: string;
  operation: string;
  logPath: string;
  done: Promise<GameProcessResult>;
  stop: () => void;
}
export class GameProcesses extends Context.Service<
  GameProcesses,
  {
    readonly run: (input: {
      root: string;
      executable: string;
      args: readonly string[];
      operation: string;
      timeoutMs?: number;
      cwd?: string;
    }) => Effect.Effect<GameProcessResult, GameOperationError>;
    readonly start: (input: {
      root: string;
      executable: string;
      args: readonly string[];
      operation: string;
      timeoutMs?: number;
      cwd?: string;
    }) => Effect.Effect<{ pid: number; logPath: string }, GameOperationError>;
    readonly stop: (root: string) => Effect.Effect<void>;
    readonly list: (root: string) => readonly { pid: number; operation: string; logPath: string }[];
  }
>()("t3/game/GameProcesses") {}

const make = Effect.gen(function* () {
  const running = new Map<number, Running>();
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
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
        if (escalation) clearTimeout(escalation);
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
