// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This helper owns the dev server it starts for a benchmark run, including its startup and shutdown deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DisplaySandbox } from "./display-sandbox.ts";

/**
 * An operator-started server runs provider and game processes with the
 * operator's environment, so harness work against it can reach the display the
 * operator is using. Only an explicit opt-in may reuse one.
 */
export function externalServerOrigin(input: {
  readonly url: string | undefined;
  readonly allowExternalServer: boolean;
}): string | null {
  if (input.url === undefined) return null;
  if (!input.allowExternalServer)
    throw new Error(
      `Refusing to run harness work against the external server at ${input.url}: its game and provider processes inherit that server's environment, including the operator's display. Drop --url to start a private sandboxed server, or pass --allow-external-server when that isolation is understood.`,
    );
  return input.url;
}

export interface BenchmarkServerSpawn {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The server command a benchmark lane starts. The environment is the display
 * sandbox, never the caller's: every agent, tool and game child under this
 * server inherits it.
 */
export function benchmarkServerSpawn(input: {
  readonly checkout: string;
  readonly homeDir: string;
  readonly sandbox: DisplaySandbox;
}): BenchmarkServerSpawn {
  return {
    executable: process.execPath,
    args: [
      NodePath.join(input.checkout, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      input.homeDir,
    ],
    cwd: input.checkout,
    env: input.sandbox.environment,
  };
}

export interface BenchmarkServer {
  readonly url: string;
  readonly pid: number;
  stop: () => Promise<void>;
}

/** The startup line names the port the server actually bound; the token stays in the log. */
const PAIRING_LINE = /Pairing URL:\s*(https?:\/\/\S+)/;
const START_TIMEOUT_MS = 120_000;

/**
 * Starts a private server for one benchmark run, under the display sandbox.
 * The server is detached so stopping it takes exactly the group this call
 * spawned, never a process found by name.
 */
export async function startBenchmarkServer(input: {
  readonly checkout: string;
  readonly homeDir: string;
  readonly sandbox: DisplaySandbox;
  readonly logPath: string;
}): Promise<BenchmarkServer> {
  const spec = benchmarkServerSpawn(input);
  await NodeFSP.mkdir(NodePath.dirname(input.logPath), { recursive: true });
  const log = NodeFS.createWriteStream(input.logPath, { flags: "w" });
  const child = NodeChildProcess.spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const started = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `The benchmark server did not print a pairing URL within ${START_TIMEOUT_MS} ms.`,
        ),
      );
    }, START_TIMEOUT_MS);
    const consume = (chunk: Buffer) => {
      log.write(chunk);
      output = (output + chunk.toString()).slice(-64_000);
      const match = output.match(PAIRING_LINE);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(new URL(match[1]).origin);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`The benchmark server exited (${code ?? "signal"}) before it was ready.`));
    });
  });
  let url: string;
  try {
    url = await started;
  } catch (cause) {
    await stopServer(child.pid);
    log.end();
    throw cause;
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error("The benchmark server spawned without a PID.");
  return {
    url,
    pid,
    stop: async () => {
      await stopServer(pid);
      log.end();
    },
  };
}

/** Stops only the process group this helper started, and waits for it to exit. */
async function stopServer(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group already exited.
    }
  };
  signal("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal("SIGKILL");
      resolve();
    }, 10_000);
    const check = () => {
      try {
        process.kill(pid, 0);
      } catch {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}
