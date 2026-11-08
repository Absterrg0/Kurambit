#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off globalFetch:off -- Maintainer CLI: owns a private server, polls it, and writes a report to disk.
/**
 * The first-ten-minutes benchmark: fixed briefs in, a scored game out of each,
 * through the same WebSocket RPC the client uses. One private server per run, on
 * a dev home (never an installed one); runs are kept by date so two compare.
 *
 *   vp run bench [--briefs N] [--only <id>] [--out <dir>] [--home <dir>] [--model <instance>/<model>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type GameBuildFacts,
  type GameCheckResult,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "../../packages/contracts/src/index.ts";
import { startBenchmarkServer, type BenchmarkServer } from "../lib/benchmark-server.ts";
import { prepareDisplaySandbox } from "../lib/display-sandbox.ts";
import { observationProtocolLayer } from "../lib/observation-transport.ts";
import { writeReport, type BenchGame, type BenchRun } from "./report.ts";
import { SCORE_VERSION, scoreGame } from "./score.ts";

const checkout = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

/** How long to wait on each stage before recording it as not done; generous, never a score. */
const WAIT = {
  turnMinutes: 60,
  factsMinutes: 25,
  /** A turn that changed files has its build listed within moments of ending. */
  buildSeconds: 90,
  /** Facts a turn build owes start by themselves; past this the runner asks for them. */
  factsStartSeconds: 120,
  pollSeconds: 10,
} as const;

interface Brief {
  readonly id: string;
  readonly genre: string;
  readonly name: string;
  readonly brief: string;
}

const { values: args } = NodeUtil.parseArgs({
  options: {
    briefs: { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    home: { type: "string" },
    model: { type: "string" },
  },
});

const home = NodePath.resolve(args.home ?? NodePath.join(checkout, ".kurambit"));
if (home === NodePath.join(NodeOS.homedir(), ".kurambit"))
  throw new Error(`Refusing to benchmark against ${home}: it belongs to an installed Kurambit.`);

const briefFile = JSON.parse(
  NodeFS.readFileSync(NodePath.join(checkout, "scripts/bench/briefs.json"), "utf8"),
) as { readonly version: number; readonly briefs: ReadonlyArray<Brief> };
const briefs = briefFile.briefs
  .filter((brief) => args.only === undefined || brief.id === args.only)
  .slice(0, args.briefs === undefined ? undefined : Number(args.briefs));
if (briefs.length === 0) throw new Error(`No brief matches --only ${args.only}.`);

const outRoot = NodePath.resolve(args.out ?? NodePath.join(home, "bench"));
const startedAt = new Date();
const stamp = startedAt.toISOString().slice(0, 16).replace(":", "-");
const runDir = NodePath.join(outRoot, stamp);
const gamesDir = NodePath.join(runDir, "games");

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const log = (line: string) =>
  console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${line}`);

/** A browser session for the run: the pairing credential is spent once, the cookie lasts. */
async function openSession(server: BenchmarkServer): Promise<string> {
  const response = await fetch(`${server.url}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: server.credential }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!response.ok || cookie === "")
    throw new Error(`Pairing with the bench server failed (${response.status}).`);
  return cookie;
}

const makeClient = RpcClient.make(WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;

/**
 * One call on a fresh socket. A run lasts hours; a socket per call means a
 * dropped connection costs one poll, never the run.
 */
async function call<A, E>(
  server: BenchmarkServer,
  cookie: string,
  use: (client: Client) => Effect.Effect<A, E>,
): Promise<A> {
  const response = await fetch(`${server.url}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { cookie },
  });
  if (!response.ok)
    throw new Error(
      `A WebSocket ticket was refused (${response.status}: ${await response.text()}).`,
    );
  const ticket = (await response.json()) as { ticket: string };
  const wsUrl = new URL("/ws", server.url.replace(/^http/, "ws"));
  wsUrl.searchParams.set("wsTicket", ticket.ticket);
  wsUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(observationProtocolLayer(wsUrl.toString()));
        const client = yield* makeClient.pipe(Effect.provide(context));
        return yield* use(client);
      }),
    ),
  );
}

const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const FACTS_SETTLED = new Set(["measured", "incomplete"]);

type Instant = Date | DateTime.DateTime;
const millis = (at: Instant) => (at instanceof Date ? at.getTime() : DateTime.toEpochMillis(at));
const seconds = (from: Instant, to: Instant) => (millis(to) - millis(from)) / 1000;

/** Token totals across the turn's provider turns, as the server recorded them. */
function usageOf(projection: OrchestrationV2ThreadProjection) {
  let input = 0;
  let cached = 0;
  let output = 0;
  let partial = 0;
  for (const turn of projection.providerTurns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus !== "complete") partial += 1;
    input += usage?.inputTokens ?? 0;
    cached += usage?.cachedInputTokens ?? 0;
    output += usage?.outputTokens ?? 0;
  }
  return { input, cached, output, providerTurns: projection.providerTurns.length, partial };
}

/** How the agent closed its turn: the plainest account of a turn that built nothing. */
function lastMessageOf(projection: OrchestrationV2ThreadProjection): string | null {
  const last = projection.turnItems.findLast((item) => item.type === "assistant_message");
  return last?.type === "assistant_message" ? last.text.slice(0, 1200) : null;
}

/** The last `game_check` the agent ran in its turn, as the agent saw it. */
async function lastCheck(
  server: BenchmarkServer,
  cookie: string,
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
): Promise<{ readonly calls: number; readonly result: unknown }> {
  const checks = projection.turnItems.filter(
    (item) =>
      item.type === "dynamic_tool" &&
      typeof item.toolName === "string" &&
      item.toolName.endsWith("game_check"),
  );
  const last = checks.at(-1);
  if (last === undefined || last.type !== "dynamic_tool") return { calls: 0, result: null };
  if (last.output !== undefined && last.outputOmitted !== true)
    return { calls: checks.length, result: last.output };
  const full = await call(server, cookie, (client) =>
    client[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({ threadId, itemId: last.id }),
  );
  return {
    calls: checks.length,
    result: full.item?.type === "dynamic_tool" ? (full.item.output ?? null) : null,
  };
}

/**
 * A tool's MCP result, as providers record it: the typed value as structured
 * content, or JSON text in content blocks (a bare array of them, as Codex keeps
 * it). A refusal is the tool's error value, carried the same way.
 */
function readCheck(output: unknown): {
  readonly result: GameCheckResult | null;
  readonly refused: string | null;
} {
  const record = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const blocks = Array.isArray(output) ? output : record(output)?.content;
  const text = Array.isArray(blocks)
    ? blocks.map(record).find((block) => block?.type === "text")?.text
    : typeof output === "string"
      ? output
      : undefined;
  let value = record(record(output)?.structuredContent) ?? record(output);
  if (typeof text === "string") {
    try {
      value = record(JSON.parse(text)) ?? value;
    } catch {
      // Plain text: nothing typed to read.
    }
  }
  if (value !== null && typeof value.ok === "boolean")
    return { result: value as unknown as GameCheckResult, refused: null };
  if (value !== null && typeof value._tag === "string")
    return {
      result: null,
      refused: `${value.reason ?? value._tag}: ${String(value.detail ?? value.message ?? "")}`,
    };
  return { result: null, refused: typeof text === "string" ? text.slice(0, 400) : null };
}

const runFile = (command: string, argv: ReadonlyArray<string>) =>
  new Promise<string>((resolve, reject) =>
    NodeChildProcess.execFile(command, [...argv], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

/**
 * Three pictures of play from the facts' own plays: the random-input run first
 * (it moves), then no input, then the tester's bot. Early, middle and late.
 */
async function screenshots(root: string, facts: GameBuildFacts, id: string) {
  const tiers = [facts.masher, facts.idle, facts.skilled];
  const shotsDir = NodePath.join(runDir, "shots");
  await NodeFSP.mkdir(shotsDir, { recursive: true });
  for (const tier of tiers) {
    if (tier.status !== "measured" || tier.value.evidence === null) continue;
    const video = NodePath.join(root, tier.value.evidence, "run.mp4");
    if (!NodeFS.existsSync(video)) continue;
    const duration = Number(
      await runFile("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        video,
      ]).catch(() => "0"),
    );
    if (!(duration > 0)) continue;
    const shots: Array<string> = [];
    for (const [index, share] of [0.2, 0.55, 0.92].entries()) {
      const file = `${id}-${index + 1}.jpg`;
      await runFile("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        (duration * share).toFixed(2),
        "-i",
        video,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        NodePath.join(shotsDir, file),
      ]).then(
        () => shots.push(`shots/${file}`),
        () => undefined,
      );
    }
    if (shots.length > 0) return { shots, from: tier.value.evidence };
  }
  return { shots: [], from: null };
}

async function runBrief(
  server: BenchmarkServer,
  cookie: string,
  modelSelection: ModelSelection,
  brief: Brief,
): Promise<BenchGame> {
  const sentAt = new Date();
  log(`${brief.id}: creating`);
  const game = await call(server, cookie, (client) =>
    client[WS_METHODS.gameCreate]({
      name: brief.name,
      parentDirectory: gamesDir,
      brief: brief.brief,
      engine: "three",
      modelSelection,
    }),
  );
  const projectionOf = () =>
    call(server, cookie, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: game.threadId }),
    );

  let projection = await projectionOf();
  const turnDeadline = Date.now() + WAIT.turnMinutes * 60_000;
  while (true) {
    const run = projection.runs[0];
    if (run !== undefined && TERMINAL_RUN.has(run.status)) break;
    if (Date.now() > turnDeadline) break;
    await sleep(WAIT.pollSeconds);
    projection = await projectionOf();
  }
  const run = projection.runs[0];
  const turnEnded = run !== undefined && TERMINAL_RUN.has(run.status);
  const turnEndedAt = turnEnded ? (run.completedAt ?? new Date()) : null;
  log(
    `${brief.id}: turn ${turnEnded ? run.status : `still ${run?.status ?? "missing"} after ${WAIT.turnMinutes} min`}`,
  );

  const check = await lastCheck(server, cookie, game.threadId, projection);

  // The turn's checkpoint, which is its build, is captured just after the run ends.
  const turnBuild = async () =>
    (
      await call(server, cookie, (client) =>
        client[WS_METHODS.gameBuilds]({ threadId: game.threadId }),
      )
    ).builds.find(
      (candidate) =>
        candidate.source._tag === "turn" && candidate.source.threadId === game.threadId,
    );
  let build = await turnBuild();
  const buildDeadline = Date.now() + (turnEnded ? WAIT.buildSeconds * 1000 : 0);
  while (build === undefined && Date.now() < buildDeadline) {
    await sleep(WAIT.pollSeconds);
    build = await turnBuild();
  }

  let facts: GameBuildFacts | null = null;
  let missing = turnEnded ? "the turn made no build" : "the turn did not end";
  if (build !== undefined) {
    const ref = { threadId: game.threadId, build: { _tag: "build" as const, build: build.id } };
    const factsDeadline = Date.now() + WAIT.factsMinutes * 60_000;
    const askedAt = Date.now();
    let asked = false;
    while (true) {
      facts = await call(server, cookie, (client) => client[WS_METHODS.gameBuildFacts](ref));
      if (FACTS_SETTLED.has(facts.state) || Date.now() > factsDeadline) break;
      if (
        !asked &&
        facts.state === "never" &&
        Date.now() - askedAt > WAIT.factsStartSeconds * 1000
      ) {
        asked = true;
        log(`${brief.id}: facts never started; asking for them`);
        await call(server, cookie, (client) => client[WS_METHODS.gameBuildMeasure](ref));
      }
      await sleep(WAIT.pollSeconds);
    }
    log(`${brief.id}: facts ${facts.state}`);
    if (!FACTS_SETTLED.has(facts.state)) {
      missing = `facts still ${facts.state} after ${WAIT.factsMinutes} min`;
      facts = null;
    }
  }

  const pictures =
    facts === null ? { shots: [], from: null } : await screenshots(game.root, facts, brief.id);
  // The game's live serve and watch are not needed once its evidence is in.
  await call(server, cookie, (client) =>
    client[WS_METHODS.gameAction]({ threadId: game.threadId, action: "stop" }),
  ).catch(() => undefined);

  const turnSeconds =
    run?.startedAt && run.completedAt ? seconds(run.startedAt, run.completedAt) : null;
  const sinceBrief = turnEndedAt === null ? null : seconds(sentAt, turnEndedAt);
  return {
    id: brief.id,
    genre: brief.genre,
    name: brief.name,
    brief: brief.brief,
    root: game.root,
    threadId: game.threadId,
    turn: {
      status: run?.status ?? "missing",
      seconds: turnSeconds,
      sinceBriefSeconds: sinceBrief,
      usage: usageOf(projection),
      lastMessage: lastMessageOf(projection),
    },
    build:
      build === undefined
        ? null
        : { id: build.id, summary: build.summary, files: build.files.map((file) => file.path) },
    facts,
    check: { calls: check.calls, ...readCheck(check.result), raw: check.result },
    shots: pictures.shots,
    shotsFrom: pictures.from,
    score: scoreGame({
      facts,
      files: build === undefined ? null : build.files.map((file) => file.path),
      complete: build === undefined || build.files.length === build.fileCount,
      turnSeconds: sinceBrief,
      missing,
    }),
  };
}

async function main() {
  await NodeFSP.mkdir(gamesDir, { recursive: true });
  log(`run ${stamp}: ${briefs.length} brief(s), home ${home}, out ${runDir}`);
  const sandbox = await prepareDisplaySandbox(runDir);
  const [instance, ...modelParts] = (args.model ?? "").split("/");
  const provider = args.model === undefined ? "codex" : (instance ?? "codex");
  const server = await startBenchmarkServer({
    checkout,
    homeDir: home,
    sandbox,
    logPath: NodePath.join(runDir, "server.log"),
    provider,
  });
  log(`server ${server.url} (pid ${server.pid})`);
  const games: Array<BenchGame> = [];
  let modelSelection: ModelSelection | null = null;
  try {
    const cookie = await openSession(server);
    const config = await call(server, cookie, (client) => client[WS_METHODS.serverGetConfig]({}));
    // The app's default for a new game: the configured text-generation model.
    modelSelection =
      args.model === undefined
        ? config.settings.textGenerationModelSelection
        : {
            instanceId: ProviderInstanceId.make(provider),
            model: modelParts.join("/"),
          };
    log(`model ${modelSelection.instanceId}/${modelSelection.model}`);
    for (const brief of briefs) {
      try {
        games.push(await runBrief(server, cookie, modelSelection, brief));
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        log(`${brief.id}: failed: ${why}`);
        games.push({
          id: brief.id,
          genre: brief.genre,
          name: brief.name,
          brief: brief.brief,
          root: null,
          threadId: null,
          turn: {
            status: "error",
            seconds: null,
            sinceBriefSeconds: null,
            usage: null,
            lastMessage: null,
          },
          build: null,
          facts: null,
          check: { calls: 0, result: null, refused: null, raw: null },
          shots: [],
          shotsFrom: null,
          score: scoreGame({
            facts: null,
            files: null,
            complete: true,
            turnSeconds: null,
            missing: `runner error: ${why}`,
          }),
          error: why,
        });
      }
      // Each game is written as it lands, so a run cut short keeps what it measured.
      await NodeFSP.writeFile(
        NodePath.join(runDir, "partial.json"),
        `${JSON.stringify(games, null, 2)}\n`,
      );
    }
  } finally {
    await server.stop();
    log("server stopped");
  }
  const result: BenchRun = {
    stamp,
    startedAt: startedAt.toISOString(),
    seconds: seconds(startedAt, new Date()),
    commit: (await runFile("git", ["-C", checkout, "rev-parse", "--short=9", "HEAD"])).trim(),
    briefsVersion: briefFile.version,
    scoreVersion: SCORE_VERSION,
    model: modelSelection,
    games,
  };
  await NodeFSP.writeFile(
    NodePath.join(runDir, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await NodeFSP.rm(NodePath.join(runDir, "partial.json"), { force: true });
  const report = await writeReport(outRoot, runDir, result);
  log(`report ${report.html}`);
  log(`summary ${report.markdown}`);
}

await main();
