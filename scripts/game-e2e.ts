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
  DEFAULT_GAME_TEMPLATE,
  GAME_TEMPLATES,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
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
    template: { type: "string", default: DEFAULT_GAME_TEMPLATE },
    // `--plan-first false` skips the design turn for harness debugging; the product default is on.
    "plan-first": { type: "string", default: "true" },
    brief: { type: "string" },
    "art-direction": { type: "string", default: "Simple low-poly clay" },
    provider: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    "reasoning-effort": { type: "string", default: "medium" },
    revise: { type: "string" },
    "cancel-test": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "3600000" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.brief) {
  console.log(
    'Usage: node scripts/game-e2e.ts --brief "<game brief>" [--url http://localhost:PORT] [--home-dir .t3] [--name NAME] [--parent-dir DIR] [--template 3d-explorer|2d-platformer|blank] [--plan-first true|false] [--provider opencode] [--model opencode-go/deepseek-v4.1-flash] [--reasoning-effort high] [--art-direction TEXT] [--revise TEXT] [--cancel-test] [--timeout-ms 3600000]',
  );
  process.exit(values.help ? 0 : 1);
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
if (values["plan-first"] !== "true" && values["plan-first"] !== "false")
  throw new Error("--plan-first must be true or false");
const planFirst = values["plan-first"] === "true";
const template = GAME_TEMPLATES.find((entry) => entry.id === values.template)?.id;
if (template === undefined)
  throw new Error(
    `--template must be one of ${GAME_TEMPLATES.map((entry) => entry.id).join(", ")}`,
  );
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
  const request = async <T>(endpoint: string, init: RequestInit): Promise<T> => {
    const response = await fetch(new URL(endpoint, origin), {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`${endpoint}: HTTP ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const access = await request<{ access_token: string }>("/oauth/token", {
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
  const ticket = await request<{ ticket: string }>("/api/auth/websocket-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${access.access_token}` },
  });
  const socket = new URL("/ws", origin);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  socket.searchParams.set("wsTicket", ticket.ticket);
  socket.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  timeline(`Authenticated at ${origin}`);
  return socket.toString();
};

const normalizeToolOutput = (output: unknown): unknown => {
  if (typeof output !== "string") return output;
  const text = output.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
/**
 * Providers call MCP tools directly, or wrap them in a code-mode `execute`; a
 * wrapped call only names its tools inside the code. Keep the extracted name as
 * the harness's record of what ran in a turn.
 */
const toolNameOf = (item: OrchestrationV2TurnItem): string => {
  if (item.type !== "dynamic_tool") return item.title ?? "command";
  const code =
    item.toolName === "execute" &&
    typeof (item.input as { code?: unknown } | undefined)?.code === "string"
      ? (item.input as { code: string }).code
      : "";
  // `const G = tools["t3-code-…"]` aliases the MCP namespace before calling.
  const aliases = new Set<string>();
  for (const match of code.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=\s*tools(?:\s*\.\s*\w+|\s*\[[^\]]+\])/g,
  ))
    aliases.add(match[1]!);
  const namespace = `tools(?:\\s*\\.\\s*\\w+|\\s*\\[[^\\]]+\\])?${
    aliases.size > 0 ? `|\\b(?:${[...aliases].join("|")})\\b` : ""
  }`;
  const calls = new Set<string>();
  for (const match of code.matchAll(
    new RegExp(`(?:${namespace})\\s*(?:\\.\\s*\\w+\\s*)?\\.\\s*([A-Za-z]\\w*)\\s*\\(`, "g"),
  ))
    calls.add(match[1]!);
  for (const match of code.matchAll(
    new RegExp(
      `(?:${namespace})\\s*(?:\\.\\s*\\w+\\s*)?\\[\\s*["'\`]([\\w/:-]+)["'\`]\\s*\\]\\s*\\(`,
      "g",
    ),
  ))
    calls.add(match[1]!);
  return item.toolName !== null && item.toolName !== "execute"
    ? item.toolName
    : code === ""
      ? (item.title ?? "execute")
      : calls.size > 0
        ? [...calls].join(", ")
        : "execute";
};
const isDirectToolCall = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" && item.toolName !== null && item.toolName !== "execute";

interface TurnToolCall {
  readonly itemId: string;
  readonly name: string;
  readonly status: string;
  readonly direct: boolean;
  readonly output: unknown;
}

/** Every tool item in one turn, with its result when the server still has it. */
const collectTurnTools = (
  client: Client,
  threadId: ThreadId,
  runId: RunId,
): Effect.Effect<ReadonlyArray<TurnToolCall>, HarnessError> =>
  Effect.gen(function* () {
    const projection = yield* client[O.getThreadProjection]({ threadId });
    const calls: TurnToolCall[] = [];
    for (const item of projection.turnItems) {
      if (item.runId !== runId) continue;
      if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
      const name = toolNameOf(item);
      let output: unknown = item.output;
      // Large results are withheld on the wire; fetch only what assertions need.
      if (item.type === "dynamic_tool" && output === undefined && /game_/.test(name)) {
        const fetched = yield* client[O.getTurnItem]({ threadId, itemId: item.id }).pipe(
          Effect.orElseSucceed(() => ({ item: null })),
        );
        output = fetched.item?.type === "dynamic_tool" ? fetched.item.output : undefined;
      }
      calls.push({
        itemId: item.id,
        name,
        status: item.status,
        direct: isDirectToolCall(item),
        output: normalizeToolOutput(output),
      });
    }
    return calls;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

const logTurnTools = (label: string, calls: ReadonlyArray<TurnToolCall>) => {
  const counts = new Map<string, number>();
  for (const call of calls)
    for (const name of call.name
      .split(", ")
      .map((part) => part.trim())
      .filter(Boolean))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = [...counts].map(([name, count]) => `${name} x${count}`).join(", ");
  timeline(`${label} tools: ${summary === "" ? "none" : summary}`);
};
const findDeep = (
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDeep(entry, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const entry of Object.values(record)) {
    const found = findDeep(entry, predicate);
    if (found) return found;
  }
  return undefined;
};
const isCheckResult = (record: Record<string, unknown>) =>
  typeof record.ok === "boolean" && Array.isArray(record.errors) && Array.isArray(record.warnings);
/**
 * A code-mode `execute` returns the script's own object, not the raw MCP
 * result. Agents that call several tools in one script summarize them as
 * `{ check: true, errors: [] }`, which is still the tool's reported verdict.
 */
const isCheckSummary = (record: Record<string, unknown>) =>
  record.check === true && Array.isArray(record.errors) && record.errors.length === 0;
const isActionResult = (record: Record<string, unknown>) =>
  typeof record.success === "boolean" && typeof record.message === "string" && "process" in record;
const isTestSummary = (record: Record<string, unknown>) =>
  record.pass === true &&
  (record.test === true || record.exit === 0 || record.success === true) &&
  (!Array.isArray(record.failed) || record.failed.length === 0);

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
        const name = toolNameOf(item);
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
const designHeading = (line: string) => line.match(/^##\s+(.+?)\s*$/)?.[1];
const designSections = (markdown: string) => {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of markdown.split("\n")) {
    const heading = designHeading(line);
    if (heading !== undefined) {
      current = heading;
      sections.set(heading, []);
      continue;
    }
    if (current !== undefined) sections.get(current)!.push(line);
  }
  return new Map([...sections].map(([heading, lines]) => [heading, lines.join("\n").trim()]));
};
const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

/** The design turn's bar: the skeleton is gone and every heading has real decisions under it. */
const assertDesignFilled = (skeleton: string, design: string) => {
  const headings = skeleton
    .split("\n")
    .map(designHeading)
    .filter((heading): heading is string => heading !== undefined);
  assert(headings.length >= 5, "The scaffolded DESIGN.md has no section headings");
  const sections = designSections(design);
  for (const heading of headings) {
    assert(sections.has(heading), `DESIGN.md is missing the "${heading}" section`);
    const body = normalizeText(sections.get(heading)!);
    assert(body.length >= 40, `DESIGN.md's "${heading}" section is still empty`);
  }
  const normalizedDesign = normalizeText(design);
  assert(
    normalizedDesign.length >= 1_200,
    `DESIGN.md is too thin for a one-page design (${normalizedDesign.length} characters)`,
  );
  // Paragraph hints are copied verbatim only when the agent forgot to replace one.
  for (const paragraph of skeleton.split(/\n\s*\n/).map(normalizeText)) {
    if (paragraph === "" || paragraph.startsWith("#")) continue;
    if (/^(?:-|\d+\.)\s/.test(paragraph)) continue;
    assert(
      !normalizedDesign.includes(paragraph),
      `DESIGN.md still contains the skeleton hint "${paragraph.slice(0, 70)}..."`,
    );
  }
  for (const line of skeleton.split("\n")) {
    const hint = line.match(/^(?:-|\d+\.)\s+\*\*[^*]+\*\*\s+—\s+(.+)$/)?.[1];
    if (hint === undefined) continue;
    assert(
      !normalizedDesign.includes(normalizeText(hint)),
      `DESIGN.md still contains the skeleton hint "${normalizeText(hint).slice(0, 70)}..."`,
    );
  }
};

const filesUnder = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (current: string) => {
    const entries = await NodeFSP.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = NodePath.join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(NodePath.relative(directory, path));
    }
  };
  await walk(directory);
  return found;
};

interface PlaytestEvidence {
  readonly directory: string;
  readonly result: {
    readonly success: boolean;
    readonly responded: boolean;
    readonly changedPercent: number;
    readonly message: string;
    readonly frames: ReadonlyArray<{ label: string; file: string }>;
  };
}
/** The newest playtest evidence folder, read the same way the Game panel does. */
const latestPlaytest = async (root: string): Promise<PlaytestEvidence> => {
  const parent = NodePath.join(root, "builds/playtests");
  const directories = (await NodeFSP.readdir(parent).catch(() => []))
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .sort();
  const newest = directories.at(-1);
  assert(newest, "No playtest evidence folder was written");
  const result = JSON.parse(
    await NodeFSP.readFile(NodePath.join(parent, newest, "result.json"), "utf8"),
  ) as PlaytestEvidence["result"];
  for (const frame of result.frames)
    await NodeFSP.access(NodePath.join(parent, newest, frame.file)).catch(() => {
      throw new Error(`Playtest frame ${frame.file} referenced by result.json is missing`);
    });
  return { directory: `builds/playtests/${newest}`, result };
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
    template,
    brief: values.brief!,
    artDirection: values["art-direction"],
    planFirst,
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
  // The create commit holds the untouched skeleton; read it before the design
  // turn can edit or commit over the file it has to replace.
  const designSkeleton = planFirst
    ? yield* promise(async () => {
        try {
          return (await exec("git", ["show", "HEAD:DESIGN.md"], { cwd: created.root })).stdout;
        } catch {
          return NodeFSP.readFile(NodePath.join(created.root, "DESIGN.md"), "utf8");
        }
      })
    : "";
  let buildRun: OrchestrationV2Run;
  if (planFirst) {
    const designRun = yield* waitForTurn(client, created.threadId, new Set());
    logTurnTools("design", yield* collectTurnTools(client, created.threadId, designRun.id));
    const design = yield* promise(() =>
      NodeFSP.readFile(NodePath.join(created.root, "DESIGN.md"), "utf8"),
    );
    yield* promise(async () => assertDesignFilled(designSkeleton, design));
    const designStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      designStatus.design?.status === "draft",
      `Design turn did not leave the design in draft (${JSON.stringify(designStatus.design)})`,
    );
    assert(designStatus.assets.length === 0, "Design turn created Blender assets");
    assert(designStatus.builds.length === 0, "Design turn produced a build");
    assert(designStatus.lastPlaytest === null, "Design turn ran a playtest");
    const designArtifacts = yield* promise(async () => [
      ...(await filesUnder(NodePath.join(created.root, "builds/web"))),
      ...(await filesUnder(NodePath.join(created.root, "builds/linux"))),
      ...(await filesUnder(NodePath.join(created.root, "builds/playtests"))),
      ...(await filesUnder(NodePath.join(created.root, "art/blender"))),
      ...(await filesUnder(NodePath.join(created.root, "art/scripts"))),
      ...(await filesUnder(NodePath.join(created.root, "art/previews"))),
    ]);
    assert(
      designArtifacts.length === 0,
      `Design turn created build or art artifacts: ${designArtifacts.join(", ")}`,
    );
    const designChanges = yield* promise(async () => {
      const result = await exec("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: created.root,
      });
      return result.stdout.trim();
    });
    timeline(
      `Design turn changed paths: ${designChanges === "" ? "none" : designChanges.replace(/\n/g, ", ")}`,
    );
    // Approve through the same RPC the Design tab calls, then wait for the build turn.
    const projection = yield* client[O.getThreadProjection]({ threadId: created.threadId });
    const approval = yield* client[WS_METHODS.gameApproveDesign]({ threadId: created.threadId });
    assert(approval.approvedAt.length > 0, "Approval returned no timestamp");
    timeline(`Design approved at ${approval.approvedAt}`);
    const approvedStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      approvedStatus.design?.status === "approved",
      "game.json still reports a draft after approval",
    );
    buildRun = yield* waitForTurn(
      client,
      created.threadId,
      new Set(projection.runs.map((run) => run.id)),
    );
  } else {
    buildRun = yield* waitForTurn(client, created.threadId, new Set());
  }
  const buildCalls = yield* collectTurnTools(client, created.threadId, buildRun.id);
  logTurnTools("build", buildCalls);
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
  if (status.assets.length === 0) timeline("Build turn produced no Blender assets");
  else
    assert(
      status.assets.some((asset) => asset.usedBy.length > 0),
      "No Blender asset is used by a Godot scene",
    );
  const checkCalls = buildCalls.filter((call) => call.name.includes("game_godot_check"));
  assert(checkCalls.length > 0, "Build turn never called game_godot_check");
  const checkResults = checkCalls
    .map((call) =>
      call.output === undefined
        ? undefined
        : findDeep(call.output, (record) => isCheckResult(record) || isCheckSummary(record)),
    )
    .filter((result): result is Record<string, unknown> => result !== undefined);
  const passingCheck = checkResults.find((result) => result.ok === true || isCheckSummary(result));
  assert(
    passingCheck !== undefined,
    `game_godot_check did not report ok: ${JSON.stringify(
      checkResults.map((result) => ({ ok: result.ok, check: result.check, errors: result.errors })),
    )}`,
  );
  const checkSummary = Array.isArray(passingCheck.warnings)
    ? `${String((passingCheck.warnings as unknown[]).length)} warning(s)`
    : "summarized as ok";
  timeline(`game_godot_check ok (${checkSummary})`);
  const testCalls = buildCalls.filter((call) => call.name.includes("game_godot_test"));
  assert(testCalls.length > 0, "Build turn never ran a headless smoke test (game_godot_test)");
  const passingTest = testCalls
    .map((call) =>
      call.output === undefined
        ? undefined
        : findDeep(
            call.output,
            (record) =>
              (isActionResult(record) &&
                record.success === true &&
                (record.process as { exitCode?: unknown } | null | undefined)?.exitCode === 0) ||
              isTestSummary(record),
          ),
    )
    .find((result): result is Record<string, unknown> => result !== undefined);
  assert(
    passingTest !== undefined,
    `game_godot_test did not pass: ${JSON.stringify(
      testCalls.map((call) => call.output ?? null),
    ).slice(0, 2_000)}`,
  );
  timeline(
    `game_godot_test passed: ${String(passingTest.message ?? passingTest.summary ?? "smoke test reported pass")}`,
  );
  assert(
    status.builds.some((build) => build.target === "Web"),
    "No web build exists after the build turn",
  );
  const evidence = yield* promise(() => latestPlaytest(created.root));
  assert(evidence.result.success, `Newest playtest failed: ${evidence.result.message}`);
  assert(evidence.result.responded, "Playtest did not prove that the game responded to input");
  assert(status.lastPlaytest !== null, "Game status reports no playtest evidence");
  assert(
    status.lastPlaytest.directory === evidence.directory,
    `Status playtest ${status.lastPlaytest.directory} is not the newest evidence ${evidence.directory}`,
  );
  timeline(
    `Playtest evidence: ${evidence.directory} (${evidence.result.frames.length} frames, ${evidence.result.changedPercent.toFixed(1)}% changed${
      status.lastPlaytest.stale ? ", stale" : ""
    })`,
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
    const reviseRun = yield* followup(values.revise);
    logTurnTools("revise", yield* collectTurnTools(client, created.threadId, reviseRun.id));
    const after = yield* promise(() => revisionSnapshot(created.root));
    console.log("Revision assets before/after:", JSON.stringify({ before, after }, null, 2));
    const revised = yield* snapshotTree();
    const diff = yield* promise(() =>
      exec("git", ["diff", "--stat", baseline, revised], { cwd: created.root }),
    );
    console.log("Changed files:\n" + diff.stdout);
    assert(diff.stdout.trim() !== "", "Revision turn changed no files");
    const reviseStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      reviseStatus.design?.status === "approved",
      "Revision turn knocked the design back to draft",
    );
    timeline(
      `After revise: webBuildStale=${String(reviseStatus.webBuildStale)}, newest playtest=${
        reviseStatus.lastPlaytest?.directory ?? "none"
      }`,
    );
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
