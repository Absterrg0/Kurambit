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
  parseAcceptance,
  unmetRevisionObligations,
  validateDesignDocument,
  type GameRevisionObligation,
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
    // Verifier-directed extra playtest: a JSON array of GamePlaytestStep the agent must replay.
    "extra-playtest-steps": { type: "string" },
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
let extraPlaytestSteps: ReadonlyArray<Record<string, unknown>> | undefined;
if (values["extra-playtest-steps"]) {
  const raw = JSON.parse(
    await NodeFSP.readFile(NodePath.resolve(values["extra-playtest-steps"]), "utf8"),
  ) as unknown;
  assert(
    Array.isArray(raw) && raw.length > 0,
    "--extra-playtest-steps must be a JSON array of playtest steps",
  );
  extraPlaytestSteps = raw as ReadonlyArray<Record<string, unknown>>;
}
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
interface TurnToolCall {
  readonly name: string;
}

/**
 * Every tool item in one turn. The live projection is a bounded window, so a
 * long turn's early calls can fall out of it; `observed` keeps the items as the
 * thread stream delivered them while the turn ran.
 */
const collectTurnTools = (
  client: Client,
  threadId: ThreadId,
  runId: RunId,
  observed?: ReadonlyMap<string, OrchestrationV2TurnItem>,
): Effect.Effect<ReadonlyArray<TurnToolCall>, HarnessError> =>
  Effect.gen(function* () {
    const projection = yield* client[O.getThreadProjection]({ threadId });
    const items = new Map<string, OrchestrationV2TurnItem>(observed);
    for (const item of projection.turnItems) items.set(item.id, item);
    const calls: TurnToolCall[] = [];
    for (const item of items.values()) {
      if (item.runId !== runId) continue;
      if (item.type !== "dynamic_tool" && item.type !== "command_execution") continue;
      calls.push({ name: toolNameOf(item) });
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
const stageSummary = (status: GameStatus) =>
  status.qualification.stages.map((stage) => `${stage.stage}=${stage.status}`).join(", ");
/** The independent judge's score table, printed so a run's PASS can be read honestly. */
const visualTable = (status: GameStatus) => {
  const stage = status.qualification.stages.find((entry) => entry.stage === "visual");
  const judgement = stage?.visual;
  if (judgement === undefined) return `${stage?.status ?? "missing"} (no judgement)`;
  return `${judgement.status} (${stage?.status ?? "missing"}) — ${judgement.dimensions
    .map((score) => `${score.dimension}=${score.score}`)
    .join(", ")}`;
};
/** PASS follows the server's own qualification read, never an agent's summary. */
const assertQualified = (label: string, status: GameStatus) => {
  assert(
    status.qualification.state === "qualified",
    `${label}: the game is ${status.qualification.state} (${stageSummary(status)}; visual ${visualTable(status)})`,
  );
  timeline(`${label}: visual ${visualTable(status)}`);
};

const waitForTurn = (
  client: Client,
  threadId: ThreadId,
  previous: ReadonlySet<RunId>,
  options: {
    cancel?: boolean;
    observed?: Map<string, OrchestrationV2TurnItem>;
    observedRuns?: Set<RunId>;
    onReady?: () => Effect.Effect<unknown, Error>;
  } = {},
) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<OrchestrationV2Run, HarnessError>();
    const seen = new Map<string, string>();
    let target: RunId | undefined;
    let interrupted = false;
    const observeRun = (run: OrchestrationV2Run) =>
      Effect.gen(function* () {
        options.observedRuns?.add(run.id);
        if (previous.has(run.id)) return;
        target ??= run.id;
        if (run.id !== target) return;
        if (terminal.has(run.status)) yield* Deferred.succeed(done, run);
      });
    const observeTool = (item: OrchestrationV2TurnItem) =>
      Effect.gen(function* () {
        if (item.runId && previous.has(item.runId)) return;
        options.observed?.set(item.id, item);
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
/** The design turn's bar, shared with the server so both agree on approvability. */
const assertDesignFilled = (skeleton: string, design: string) => {
  const validation = validateDesignDocument({ design, skeleton });
  assert(
    validation.issues.length === 0,
    `DESIGN.md is not approvable:\n${validation.issues.join("\n")}`,
  );
  const parsed = parseAcceptance(design);
  assert(parsed.ok, "DESIGN.md's acceptance block did not parse");
  assert(
    parsed.ok && parsed.criteria.length >= 5,
    `DESIGN.md bound only ${parsed.ok ? parsed.criteria.length : 0} acceptance criteria`,
  );
  assert(
    parsed.ok && parsed.criteria.some((criterion) => criterion.kind === "win"),
    "DESIGN.md's acceptance has no end criterion",
  );
  assert(
    parsed.ok && parsed.criteria.some((criterion) => criterion.kind === "mechanic"),
    "DESIGN.md's acceptance has no mechanic criterion",
  );
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
  // The live projection only keeps a bounded recent window; keep every item the
  // thread stream reports so long turns still have a complete tool timeline.
  const observedTurnItems = new Map<string, OrchestrationV2TurnItem>();
  const observedRunIds = new Set<RunId>();
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
    const designRun = yield* waitForTurn(client, created.threadId, new Set(), {
      observed: observedTurnItems,
      observedRuns: observedRunIds,
    });
    logTurnTools(
      "design",
      yield* collectTurnTools(client, created.threadId, designRun.id, observedTurnItems),
    );
    const design = yield* promise(() =>
      NodeFSP.readFile(NodePath.join(created.root, "DESIGN.md"), "utf8"),
    );
    yield* promise(async () => assertDesignFilled(designSkeleton, design));
    const designStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      designStatus.design.state === "draft",
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
    // The draft stage's contract is one file: DESIGN.md. The server gate refuses
    // staging tools, but files under godot/ and art/ are written by the agent
    // directly, so diff-only-DESIGN.md is what proves the turn kept its stage.
    assert(
      designChanges.split("\n").every((line) => line === "M DESIGN.md" || line === ""),
      `Design turn touched files beyond DESIGN.md:\n${designChanges}`,
    );
    // Approve through the same RPC the Design tab calls, with the hash the
    // status read returned, then wait for the build turn.
    const designHash = designStatus.design.currentHash;
    assert(designHash !== null, "Status reported no DESIGN.md hash for the draft");
    const approval = yield* client[WS_METHODS.gameApproveDesign]({
      threadId: created.threadId,
      expectedDesignHash: designHash,
    });
    assert(approval.approvedAt.length > 0, "Approval returned no timestamp");
    assert(approval.designHash === designHash, "Approval recorded a different design hash");
    timeline(`Design approved at ${approval.approvedAt}`);
    const approvedStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      approvedStatus.design.state === "approved",
      `The server did not record the approved design (${JSON.stringify(approvedStatus.design)})`,
    );
    assert(
      approvedStatus.design.acceptance.length >= 5,
      `Approval bound only ${approvedStatus.design.acceptance.length} acceptance criteria`,
    );
    assert(
      approvedStatus.design.acceptance.some((criterion) => criterion.kind === "win") &&
        approvedStatus.design.acceptance.some((criterion) => criterion.kind === "mechanic"),
      "Approved acceptance is missing an end or mechanic criterion",
    );
    buildRun = yield* waitForTurn(client, created.threadId, new Set(observedRunIds), {
      observed: observedTurnItems,
      observedRuns: observedRunIds,
    });
  } else {
    buildRun = yield* waitForTurn(client, created.threadId, new Set(), {
      observed: observedTurnItems,
      observedRuns: observedRunIds,
    });
  }
  const buildCalls = yield* collectTurnTools(
    client,
    created.threadId,
    buildRun.id,
    observedTurnItems,
  );
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
  assert(
    status.builds.some((build) => build.target === "Web"),
    "No web build exists after the build turn",
  );
  assertQualified("after the build turn", status);
  timeline(`Qualification: ${stageSummary(status)}`);
  assert(status.lastPlaytest !== null, "Game status reports no playtest evidence");
  assert(status.lastPlaytest.responded, "Playtest did not prove that the game responded to input");
  timeline(
    `Playtest evidence: ${status.lastPlaytest.directory} (${status.lastPlaytest.frames.length} frames, ${status.lastPlaytest.changedPercent.toFixed(1)}% changed${
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
      return yield* waitForTurn(client, created.threadId, new Set(observedRunIds), {
        cancel,
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () => send(text),
      });
    });
  // `game_web_playtest` exists only on the agent's MCP surface, so the verifier's
  // extra playtest is a turn the agent drives with the exact steps it is given.
  if (extraPlaytestSteps) {
    const beforeExtra = status.lastPlaytest;
    const extraRun = yield* followup(
      `Run game_web_playtest now with exactly these steps: ${JSON.stringify(
        extraPlaytestSteps,
      )}. The web build is current; do not change any game files. Report the playtest result.`,
    );
    logTurnTools(
      "extra-playtest",
      yield* collectTurnTools(client, created.threadId, extraRun.id, observedTurnItems),
    );
    const extraStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      extraStatus.lastPlaytest !== null &&
        extraStatus.lastPlaytest.directory !== beforeExtra?.directory,
      "Extra playtest wrote no new evidence folder",
    );
    assert(
      extraStatus.lastPlaytest.responded,
      "Extra playtest did not prove that the game responded to input",
    );
    // The verifier's playtest is deliberately weaker (generic steps), so it cannot
    // re-gate a game that already qualified after the build turn (:591).
    timeline(
      `Extra playtest: ${extraStatus.lastPlaytest.directory} (${extraStatus.lastPlaytest.frames.length} frames, ${extraStatus.lastPlaytest.changedPercent.toFixed(1)}% changed)`,
    );
  }
  if (values.revise) {
    // The request is a server RPC, not a chat line, and its review is data: the
    // server keeps a pending revision record with the approved hash it amends,
    // the Design tab reads a criteria diff against it, and only a decision
    // through the revisions flow reaches the sources (review-r2 finding F16).
    const reviseText = values.revise;
    // Obligations this revision may never drop, frozen before the agent works.
    // The double jump is only real when a mechanic criterion still observes it.
    const reviseObligations: ReadonlyArray<GameRevisionObligation> = [
      { kind: "mechanic", key: "air_jumps", expect: ">=1" },
    ];
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
    const requestChangeRun = yield* waitForTurn(client, created.threadId, new Set(observedRunIds), {
      observed: observedTurnItems,
      observedRuns: observedRunIds,
      onReady: () =>
        client[WS_METHODS.gameRequestChange]({
          threadId: created.threadId,
          text: reviseText,
        }),
    });
    logTurnTools(
      "revise-request",
      yield* collectTurnTools(client, created.threadId, requestChangeRun.id, observedTurnItems),
    );
    let reviseStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(
      reviseStatus.design.state === "revision-pending",
      `The change request left the design ${reviseStatus.design.state} instead of revision-pending`,
    );
    assert(
      reviseStatus.design.pendingRevision?.text === reviseText,
      "The pending revision did not carry the requested change",
    );
    assert(
      reviseStatus.design.approvedHash !== null &&
        reviseStatus.design.pendingRevision?.baseHash === reviseStatus.design.approvedHash,
      "The request is not pinned to the approved revision",
    );
    // The document diff a reviewer reads. The agent has not asked to remove
    // anything in this flow, but the harness shows what actually changed.
    const revisionDiff = reviseStatus.design.revisionDiff;
    assert(revisionDiff !== null, "The pending revision carries no criteria diff for review");
    assert(
      revisionDiff.added.length + revisionDiff.changed.length + revisionDiff.removed.length > 0,
      "The revised design shows no criteria diff; the request turned into no contract change",
    );
    // The design stage cannot call this game buildable while the request pends.
    assert(
      reviseStatus.qualification.stages.find((stage) => stage.stage === "design")?.status ===
        "failed",
      "The change request left the design stage qualified",
    );
    timeline(
      `Revision review: ${revisionDiff.added.length} added, ${revisionDiff.changed.length} changed, ${revisionDiff.removed.length} removed criteria`,
    );
    // Approve only a revision that kept every frozen proof.
    const unmet = unmetRevisionObligations(reviseStatus.design.acceptance, reviseObligations);
    assert(
      unmet.length === 0,
      `The revised design dropped required proof: ${JSON.stringify(unmet)}`,
    );
    const revisedHash = reviseStatus.design.currentHash;
    assert(revisedHash !== null, "The revised design has no hash to approve");
    // Approving the revision both records it and dispatches the revision's own
    // build turn, so the harness observes that turn from subscription time.
    const approveRevisionRun = yield* waitForTurn(
      client,
      created.threadId,
      new Set(observedRunIds),
      {
        observed: observedTurnItems,
        observedRuns: observedRunIds,
        onReady: () =>
          client[WS_METHODS.gameApproveRevision]({
            threadId: created.threadId,
            expectedDesignHash: revisedHash,
          }),
      },
    );
    logTurnTools(
      "revise-build",
      yield* collectTurnTools(client, created.threadId, approveRevisionRun.id, observedTurnItems),
    );
    reviseStatus = yield* client[WS_METHODS.gameStatus]({ threadId: created.threadId });
    assert(reviseStatus.design.state === "approved", "The approved revision did not take");
    assert(reviseStatus.design.pendingRevision === null, "The approved revision is still pending");
    assert(
      reviseStatus.design.acceptance.length >= 5,
      `The revised design bound only ${reviseStatus.design.acceptance.length} acceptance criteria`,
    );
    const after = yield* promise(() => revisionSnapshot(created.root));
    console.log("Revision assets before/after:", JSON.stringify({ before, after }, null, 2));
    const revised = yield* snapshotTree();
    const changedPaths = yield* promise(async () => {
      const result = await exec("git", ["diff", "--name-only", baseline, revised], {
        cwd: created.root,
      });
      return result.stdout.trim().split("\n").filter(Boolean);
    });
    const diff = yield* promise(() =>
      exec("git", ["diff", "--stat", baseline, revised], { cwd: created.root }),
    );
    console.log("Changed files:\n" + diff.stdout);
    assert(diff.stdout.trim() !== "", "Revision turn changed no files");
    // The contract itself is the first thing a change touches: a revision that
    // ships bytecode without its DESIGN.md source edit is not a reviewed change.
    assert(
      changedPaths.includes("DESIGN.md"),
      "Revision turn shipped changes without a DESIGN.md source diff",
    );
    // The design mirror in game.json changes on approval; neither is the game.
    // The revision has to reach real sources.
    assert(
      changedPaths.some((path) => path !== "DESIGN.md" && path !== "game.json"),
      "Revision turn changed only design files, not the game",
    );
    assert(
      reviseStatus.design.state === "approved",
      "Revision turn changed the approved design without re-approval",
    );
    assertQualified("after the revision turn", reviseStatus);
    timeline(
      `After revise: webBuildStale=${String(reviseStatus.webBuildStale)}, newest playtest=${
        reviseStatus.lastPlaytest?.directory ?? "none"
      }, ${stageSummary(reviseStatus)}`,
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
