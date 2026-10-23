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
  /** Tests pin a port; the harness lets the server pick its own. */
  readonly port?: number;
}): BenchmarkServerSpawn {
  return {
    executable: process.execPath,
    args: [
      NodePath.join(input.checkout, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      input.homeDir,
      ...(input.port === undefined ? [] : ["--port", String(input.port)]),
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

/**
 * A private benchmark home starts empty, and several provider drivers
 * (opencode, cursor, grok, ...) default to disabled. A benchmark that asks for
 * one of them would then fail before the first turn with a disabled-provider
 * error. Enable exactly the requested instance and copy nothing from the
 * operator's own home: the benchmark home's settings are its own.
 */
export async function seedBenchmarkProviderSettings(input: {
  readonly homeDir: string;
  readonly provider: string;
}): Promise<void> {
  const file = NodePath.join(input.homeDir, "userdata", "settings.json");
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const parsed = await NodeFSP.readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const settings = isRecord(parsed) ? parsed : {};
  const instances = isRecord(settings.providerInstances) ? settings.providerInstances : {};
  const existing = instances[input.provider];
  instances[input.provider] = {
    ...(isRecord(existing) ? existing : {}),
    // A custom instance id may not equal its driver; keep the configured one.
    driver:
      isRecord(existing) && typeof existing.driver === "string" ? existing.driver : input.provider,
    enabled: true,
  };
  settings.providerInstances = instances;
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
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
  readonly port?: number;
  /** The provider instance this benchmark asks its builder to use. */
  readonly provider: string;
}): Promise<BenchmarkServer> {
  await seedBenchmarkProviderSettings({ homeDir: input.homeDir, provider: input.provider });
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
  let pendingLine = "";
  const redact = (line: string) => line.replace(/^(Pairing URL:|Token:)\s*\S+/g, "$1 <redacted>");
  const started = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `The benchmark server did not print a pairing URL within ${START_TIMEOUT_MS} ms.`,
        ),
      );
    }, START_TIMEOUT_MS);
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      // The pairing URL and its token are one-time credentials; the log keeps
      // the port and the startup narrative, never the credential.
      output = (output + text).slice(-64_000);
      pendingLine += text;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) log.write(`${redact(line)}\n`);
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
