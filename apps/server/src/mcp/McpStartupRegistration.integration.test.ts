// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This guard owns a disposable production server process and speaks MCP to its loopback port.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

import { startBenchmarkServer } from "../../../../scripts/lib/benchmark-server.ts";
import { prepareDisplaySandbox } from "../../../../scripts/lib/display-sandbox.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);

interface AdvertisedTool {
  readonly name: string;
  readonly inputSchema: {
    readonly type?: string;
    readonly anyOf?: unknown;
    readonly oneOf?: unknown;
  };
}

interface JsonRpcReply {
  readonly result?: {
    readonly tools?: ReadonlyArray<AdvertisedTool>;
    readonly isError?: boolean;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  };
  readonly error?: { readonly message?: string };
}

const freeLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("The loopback port probe did not report an IP address."));
        return;
      }
      probe.close((cause) => (cause ? reject(cause) : resolve(address.port)));
    });
  });

const issueMcpClientToken = (input: {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
}) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      process.execPath,
      [
        NodePath.join(repoRoot, "apps/server/src/bin.ts"),
        "auth",
        "session",
        "issue",
        "--base-dir",
        input.homeDir,
        "--subject",
        "mcp-client",
        "--token-only",
      ],
      {
        cwd: repoRoot,
        env: input.env,
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Never put stdout in the failure: it carries the credential on success paths.
          reject(
            new Error(`Could not issue an MCP client session.\n${stderr.trim() || error.message}`),
          );
          return;
        }
        const token = stdout
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        if (token === undefined) {
          reject(new Error("The auth command printed no MCP client token."));
          return;
        }
        resolve(token);
      },
    );
  });

const postMcp = async (input: {
  readonly origin: string;
  readonly token: string;
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}): Promise<{ readonly reply: JsonRpcReply; readonly sessionId: string | null }> => {
  const response = await fetch(`${input.origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      ...(input.method === "initialize" ? {} : { "mcp-protocol-version": "2025-06-18" }),
      ...(input.sessionId === undefined ? {} : { "mcp-session-id": input.sessionId }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.method,
      method: input.method,
      params: input.params,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `MCP ${input.method} returned HTTP ${response.status}.\n${text.slice(0, 1_000)}`,
    );
  }
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  const payloadText =
    response.headers.get("content-type")?.includes("text/event-stream") === true
      ? (dataLine?.slice("data:".length).trim() ?? "")
      : text;
  if (payloadText.length === 0) {
    throw new Error(`MCP ${input.method} returned an empty response.`);
  }
  const reply = JSON.parse(payloadText) as JsonRpcReply;
  if (reply.error !== undefined) {
    throw new Error(`MCP ${input.method} failed: ${reply.error.message ?? "unknown error"}`);
  }
  return { reply, sessionId: response.headers.get("mcp-session-id") };
};

it(
  "starts the production server and registers the package tools with object inputs",
  { timeout: 45_000 },
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-startup-"));
    const homeDir = NodePath.join(root, "home");
    const logPath = NodePath.join(root, "server.log");
    await NodeFSP.mkdir(homeDir, { recursive: true });
    const sandbox = await prepareDisplaySandbox(root);
    let server: Awaited<ReturnType<typeof startBenchmarkServer>> | undefined;

    try {
      const token = await issueMcpClientToken({ homeDir, env: sandbox.environment });
      const port = await freeLoopbackPort();
      server = await startBenchmarkServer({
        checkout: repoRoot,
        homeDir,
        sandbox,
        logPath,
        port,
        provider: "codex",
        startTimeoutMs: 30_000,
      });

      const initialized = await postMcp({
        origin: server.url,
        token,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "startup-registration-guard", version: "1.0.0" },
        },
      });

      const listed = await postMcp({
        origin: server.url,
        token,
        method: "tools/list",
        params: {},
        ...(initialized.sessionId === null ? {} : { sessionId: initialized.sessionId }),
      });
      const tools = listed.reply.result?.tools ?? [];
      const names = tools.map((tool) => tool.name);

      // A toolkit that failed to register usually leaves its names out entirely.
      for (const name of [
        "t3_worktree_status",
        "preview_status",
        "game_status",
        "game_package_windows",
        "game_package_web",
      ]) {
        expect(names, name).toContain(name);
      }

      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
      for (const name of ["game_package_windows", "game_package_web"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeDefined();
        expect(tool?.inputSchema.anyOf, `${name} must not export a root anyOf`).toBeUndefined();
        expect(tool?.inputSchema.oneOf, `${name} must not export a root oneOf`).toBeUndefined();
      }

      // Empty arguments must reach the handler and its normal access boundary,
      // never a parameter decode or registration failure. A signed-in client
      // has no calling thread, so the service gate is the expected stop here.
      const called = await postMcp({
        origin: server.url,
        token,
        method: "tools/call",
        params: { name: "game_package_windows", arguments: {} },
        ...(initialized.sessionId === null ? {} : { sessionId: initialized.sessionId }),
      });
      expect(called.reply.result?.isError).toBe(true);
      const text = called.reply.result?.content?.find((part) => part.type === "text")?.text ?? "";
      expect(JSON.parse(text)).toMatchObject({ code: "thread_credential_required" });
    } finally {
      try {
        if (server !== undefined) await server.stop();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  },
);
