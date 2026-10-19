#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off cryptoRandomUUID:off globalConsoleInEffect:off preferSchemaOverJson:off -- Maintainer CLI owns process, filesystem, logging, authentication, and HTTP boundaries.
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  WsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS as O,
  type ThreadId,
  type RunId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type GameStatus,
} from "../packages/contracts/src/index.ts";

const checkout = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    "home-dir": { type: "string", default: NodePath.join(checkout, ".t3") },
    name: { type: "string", default: `Tiny game ${Date.now()}` },
    "parent-dir": { type: "string", default: NodePath.join(checkout, ".t3/e2e-games") },
    brief: { type: "string" },
    "art-direction": { type: "string", default: "Simple low-poly clay" },
    provider: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "reasoning-effort": { type: "string", default: "medium" },
    revise: { type: "string" },
    "cancel-test": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "1200000" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.brief) {
  console.log(
    'Usage: node scripts/game-e2e.ts --brief "<game brief>" [--url http://localhost:PORT] [--home-dir .t3] [--name NAME] [--parent-dir DIR] [--provider codex] [--model gpt-6.1-sol] [--reasoning-effort medium] [--art-direction TEXT] [--revise TEXT] [--cancel-test] [--timeout-ms 1200000]',
  );
  process.exit(values.help ? 0 : 1);
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const started = Date.now();
const timeline = (message: string) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}
const toError = (cause: unknown) =>
  new HarnessError({ message: cause instanceof Error ? cause.message : String(cause), cause });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError });

const authenticate = async () => {
  // Mint a fresh, scoped client grant. Never print the credential or pairing URL.
  const { stdout } = await exec(
    process.execPath,
    ["apps/server/src/bin.ts", "pair", "--base-dir", NodePath.resolve(values["home-dir"])],
    { cwd: checkout, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const match = stdout.match(/Pairing URL:\s*(https?:\/\/\S+)/);
  assert(match?.[1], "pair did not return a pairing URL");
  const pairing = new URL(match[1]);
  const credential = new URLSearchParams(pairing.hash.slice(1)).get("token");
  assert(credential, "pair did not return a token");
  const origin = values.url ?? pairing.origin;
  const request = async (endpoint: string, init: RequestInit) => {
    const response = await fetch(new URL(endpoint, origin), {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`${endpoint}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  const access = await request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Game Studio e2e",
      client_device_type: "desktop",
    }),
  });
  const ticket = await request("/api/auth/websocket-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${access.access_token}` },
  });
  const socket = new URL("/ws", origin);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  socket.searchParams.set("wsTicket", ticket.ticket);
  timeline(`Authenticated at ${origin}`);
  return socket.toString();
};

const waitForTurn = (
  client: Client,
  threadId: ThreadId,
  previous: ReadonlySet<RunId>,
  options: { cancel?: boolean; onReady?: () => Effect.Effect<unknown, Error> } = {},
) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<OrchestrationV2Run, HarnessError>();
    const seen = new Map<string, string>();
    let target: RunId | undefined;
    let interrupted = false;
    const observeRun = (run: OrchestrationV2Run) =>
      Effect.gen(function* () {
        if (previous.has(run.id)) return;
        target ??= run.id;
        if (run.id !== target) return;
        if (terminal.has(run.status)) yield* Deferred.succeed(done, run);
      });
    const observeTool = (item: OrchestrationV2TurnItem) =>
      Effect.gen(function* () {
        if (item.runId && previous.has(item.runId)) return;
        if (item.type !== "dynamic_tool" && item.type !== "command_execution") return;
        const name =
          item.type === "dynamic_tool"
            ? (item.toolName ?? item.title ?? "tool")
            : (item.title ?? "command");
        if (seen.get(item.id) !== item.status) {
          seen.set(item.id, item.status);
          timeline(`${name}: ${item.status}`);
        }
        if (options.cancel && !interrupted && item.status === "running" && /game_/.test(name)) {
          assert(item.runId, "Game tool has no run ID");
          interrupted = true;
          timeline("Interrupting turn during game tool");
          yield* client[O.dispatchCommand]({
            type: "run.interrupt",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId,
            runId: item.runId,
            reason: "e2e cancellation test",
          });
        }
      });
    const ready = yield* Deferred.make<void>();
    const subscriber = yield* client[O.subscribeThread]({
      threadId,
      requestCompletionMarker: true,
    }).pipe(
      Stream.runForEach((entry) =>
        Effect.gen(function* () {
          if (entry.kind === "snapshot") {
            for (const item of entry.projection.turnItems) yield* observeTool(item);
            for (const run of entry.projection.runs) yield* observeRun(run);
            yield* Deferred.succeed(ready, undefined);
          } else if (entry.kind === "synchronized") yield* Deferred.succeed(ready, undefined);
          else if (entry.kind === "event") {
            if (entry.event.type === "turn-item.updated") yield* observeTool(entry.event.payload);
            else if (entry.event.type === "run.created" || entry.event.type === "run.updated")
              yield* observeRun(entry.event.payload);
          }
        }),
      ),
      Effect.catch((error) => Deferred.fail(done, toError(error))),
      Effect.forkChild,
    );
    try {
      yield* Deferred.await(ready);
      if (options.onReady) yield* options.onReady();
      const run = yield* Deferred.await(done);
      timeline(`Turn ${run.id}: ${run.status}`);
      assert(
        options.cancel ? interrupted && run.status === "interrupted" : run.status === "completed",
        `Turn ended ${run.status}${options.cancel && !interrupted ? " without exercising cancellation" : ""}`,
      );
      return run;
    } finally {
      yield* Fiber.interrupt(subscriber);
    }
  });

const printStatus = (status: GameStatus) => {
  console.log(
    JSON.stringify(
      {
        assets: status.assets,
        scenes: status.scenes,
        builds: status.builds,
        processes: status.processes,
      },
      null,
      2,
    ),
  );
};
const revisionSnapshot = async (root: string) => {
  const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "game.json"), "utf8"));
  // Read GLB POSITION accessor bounds so this works for assets produced outside the wrapper too.
  const assets = await Promise.all(
    manifest.assets.map(async (asset: { id: string; export: string; updatedAt: string }) => {
      const bytes = await NodeFSP.readFile(NodePath.join(root, asset.export));
      const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
      const positions =
        gltf.meshes?.flatMap((mesh: { primitives: { attributes: { POSITION: number } }[] }) =>
          mesh.primitives.map((primitive) => gltf.accessors[primitive.attributes.POSITION]),
        ) ?? [];
      return {
        id: asset.id,
        export: asset.export,
        updatedAt: asset.updatedAt,
        bounds: positions.map((accessor: { min: number[]; max: number[] }) => ({
          min: accessor.min,
          max: accessor.max,
          dimensions: accessor.max.map((value, i) => value - accessor.min[i]!),
        })),
      };
    }),
  );
  return assets;
};
let gameRoot: string | undefined;
const main = Effect.gen(function* () {
  const url = yield* promise(authenticate);
  const socket = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      pingTimeout: "30 seconds",
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(Layer.provide(Layer.merge(socket, RpcSerialization.layerJson)));
  const context = yield* Layer.build(protocol);
  const client = yield* makeClient.pipe(Effect.provide(context));
  const created = yield* client[WS_METHODS.gameCreate]({
    name: values.name,
    parentDirectory: NodePath.resolve(values["parent-dir"]),
    brief: values.brief!,
    artDirection: values["art-direction"],
    modelSelection: {
      instanceId: ProviderInstanceId.make(values.provider),
      model: values.model,
      // Each provider names its reasoning option differently.
      options: [
        {
          id:
            values.provider === "claudeAgent"
              ? "effort"
              : values.provider === "opencode"
                ? "variant"
                : "reasoningEffort",
          value: values["reasoning-effort"],
        },
      ],
    },
    runtimeMode: "full-access",
  });
  gameRoot = created.root;
  console.log(`Game root: ${created.root}`);
  console.log(`Thread: ${created.threadId}`);
  yield* Effect.addFinalizer(() =>
    client[WS_METHODS.gameAction]({ threadId: created.threadId, action: "stop" }).pipe(
      Effect.ignore,
    ),
  );
  yield* waitForTurn(client, created.threadId, new Set());
  const action = (operation: "preview" | "export-linux" | "native" | "stop") =>
    client[WS_METHODS.gameAction]({ threadId: created.threadId, action: operation }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert(result.success, result.message);
          timeline(`${operation}: ${result.message}`);
        }),
      ),
    );
  const status = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
  printStatus(status);
  assert(status.assets.length > 0, "Agent produced no Blender assets");
  assert(
    status.assets.some((asset) => asset.usedBy.length > 0),
    "No Blender asset is used by a Godot scene",
  );
  const preview = yield* action("preview");
  yield* promise(async () => {
    assert(preview.url, "Preview has no URL");
    const index = await fetch(preview.url, { signal: AbortSignal.timeout(30_000) });
    assert(
      index.ok && index.headers.get("content-type")?.startsWith("text/html"),
      "Preview index.html has wrong content type or status",
    );
    assert((await index.text()).length > 0, "Preview HTML is empty");
    const files = await NodeFSP.readdir(NodePath.join(created.root, "builds/web"));
    const wasmFile = files.find((file) => file.endsWith(".wasm"));
    assert(wasmFile, "Web export contains no wasm");
    const wasm = await fetch(new URL(wasmFile, preview.url), {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });
    assert(
      wasm.ok && wasm.headers.get("content-type") === "application/wasm",
      "Preview wasm has wrong content type or status",
    );
    timeline(`Preview HTTP: index.html text/html; ${wasmFile} application/wasm`);
  });
  yield* action("export-linux");
  try {
    yield* action("native");
    const running = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    const native = running.processes.find((entry) => entry.operation === "native");
    assert(native, "Native process exited before it could be stopped");
    yield* action("stop");
    yield* promise(async () => {
      try {
        process.kill(native.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          timeline(`Native PID ${native.pid} is gone`);
          return;
        }
        throw error;
      }
      throw new Error(`Native PID ${native.pid} survived Stop`);
    });
  } finally {
    yield* client[WS_METHODS.gameAction]({ threadId: created.threadId, action: "stop" });
  }
  const send = (text: string) =>
    client[O.dispatchCommand]({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: created.threadId,
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  const followup = (text: string, cancel = false) =>
    Effect.gen(function* () {
      const projection = yield* client[O.getThreadProjection]({ threadId: created.threadId });
      return yield* waitForTurn(
        client,
        created.threadId,
        new Set(projection.runs.map((run) => run.id)),
        { cancel, onReady: () => send(text) },
      );
    });
  if (values.revise) {
    const before = yield* promise(() => revisionSnapshot(created.root));
    // A throwaway index captures uncommitted agent work without touching the game's own index.
    const index = NodePath.join(created.root, "builds/logs/e2e-snapshot.index");
    const snapshotTree = () =>
      promise(async () => {
        const env = { ...process.env, GIT_INDEX_FILE: index };
        await exec("git", ["add", "-A"], { cwd: created.root, env });
        return (await exec("git", ["write-tree"], { cwd: created.root, env })).stdout.trim();
      });
    const baseline = yield* snapshotTree();
    yield* followup(values.revise);
    const after = yield* promise(() => revisionSnapshot(created.root));
    console.log("Revision assets before/after:", JSON.stringify({ before, after }, null, 2));
    const revised = yield* snapshotTree();
    const diff = yield* promise(() =>
      exec("git", ["diff", "--stat", baseline, revised], { cwd: created.root }),
    );
    console.log("Changed files:\n" + diff.stdout);
  }
  if (values["cancel-test"]) {
    yield* followup(
      "Use game_blender_run now with id cancellation_probe, reset=true, thumbnail=false, and Python script: import time; time.sleep(120). This is an intentional cancellation test. Do not use shell commands, do not build anything else.",
      true,
    );
    const cancelled = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      cancelled.processes.length === 0,
      `Cancellation leaked processes: ${JSON.stringify(cancelled.processes)}`,
    );
    timeline("Cancellation: no tracked processes remain");
  }
  timeline("PASS");
});
await Effect.runPromise(main.pipe(Effect.timeout(`${timeoutMs} millis`), Effect.scoped)).catch(
  (error: unknown) => {
    console.error("FAIL:", error);
    if (gameRoot) console.error(`Game root: ${gameRoot}`);
    process.exitCode = 1;
  },
);
