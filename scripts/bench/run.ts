#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off globalFetch:off -- Maintainer CLI: owns a private server, polls it, and writes a report to disk.
/**
 * The first-ten-minutes benchmark: fixed briefs in, a scored game out of each,
 * through the same WebSocket RPC the client uses. One private server per run, on
 * a dev home (never an installed one); runs are kept by date so two compare.
 *
 *   vp run bench [--briefs N] [--only <id>] [--out <dir>] [--home <dir>] [--model <instance>/<model>] [--steps N]
 *   vp run bench --remeasure <stamp> [--home <dir>] [--out <dir>]
 *
 * Phase 1 scores each brief's first turn. Phase 2 then runs keep going on the
 * game for `--steps` steps (default 3; 0 skips it) and records what each step
 * did to the measured facts, its cost, and a frame to look at: no score.
 * `--remeasure` measures an earlier run's first-turn builds again on this
 * checkout's server (a new harness measures them from nothing) and scores
 * them as phase 1 did, to compare harnesses on the same builds. It rewrites
 * those builds' facts in the home, so point it at a copy you can spare.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  GAME_FACTS_SKILLED_DEFERRED,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type GameBuildFacts,
  type GameCheckResult,
  type GameFactDelta,
  gameFactsView,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "../../packages/contracts/src/index.ts";
import { startBenchmarkServer, type BenchmarkServer } from "../lib/benchmark-server.ts";
import { prepareDisplaySandbox } from "../lib/display-sandbox.ts";
import { observationProtocolLayer } from "../lib/observation-transport.ts";
import {
  writeReport,
  type BenchGame,
  type BenchKeepGoing,
  type BenchRun,
  type BenchStep,
} from "./report.ts";
import { CRITERIA, SCORE_VERSION, scoreGame } from "./score.ts";

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
  /** Facts are timed from the moment they are seen measuring, so they are polled closely. */
  factsPollSeconds: 2,
  /** A keep-going step is a turn and its measure; past this per step the bench stops the run. */
  stepMinutes: 30,
  /** After the bench turns keep going off, the step turn it interrupted settles within this. */
  settleSeconds: 300,
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
    steps: { type: "string" },
    remeasure: { type: "string" },
  },
});
const STEPS = args.steps === undefined ? 3 : Number(args.steps);
if (!Number.isInteger(STEPS) || STEPS < 0 || STEPS > 10)
  throw new Error(`--steps takes 0 to 10 (keep going reports its last ten), not ${args.steps}.`);

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
const stamp = args.remeasure ?? startedAt.toISOString().slice(0, 16).replace(":", "-");
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

/** The run video of a measured play, when its evidence is still on disk. */
function videoOf(root: string, tier: GameBuildFacts["idle"]): string | null {
  if (tier.status !== "measured" || tier.value.evidence === null) return null;
  const video = NodePath.join(root, tier.value.evidence, "run.mp4");
  return NodeFS.existsSync(video) ? video : null;
}

/** Frames of a video at the given shares of its length, as `shots/<name>-<n>.jpg`. */
async function frames(video: string, shares: ReadonlyArray<number>, name: string) {
  const shotsDir = NodePath.join(runDir, "shots");
  await NodeFSP.mkdir(shotsDir, { recursive: true });
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
  if (!(duration > 0)) return [];
  const shots: Array<string> = [];
  for (const [index, share] of shares.entries()) {
    const file = `${name}-${index + 1}.jpg`;
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
  return shots;
}

/**
 * Three pictures of play from the facts' own plays: the random-input run first
 * (it moves), then no input, then the tester's bot. Early, middle and late.
 */
async function screenshots(root: string, facts: GameBuildFacts, id: string) {
  for (const tier of [facts.masher, facts.idle, facts.skilled]) {
    const video = videoOf(root, tier);
    if (video === null || tier.status !== "measured") continue;
    const shots = await frames(video, [0.2, 0.55, 0.92], id);
    if (shots.length > 0) return { shots, from: tier.value.evidence };
  }
  return { shots: [], from: null };
}

/**
 * A build's facts once they settle, and how long they took from the moment the
 * server was seen measuring them (null when they were never seen measuring:
 * already measured, or measured between two polls). A person's measure is
 * asked for when the server never starts one, and when the tester's bot was
 * left for keep going: the floor reads all three plays, as it always has.
 */
async function settledFacts(
  server: BenchmarkServer,
  cookie: string,
  threadId: ThreadId,
  build: string,
  id: string,
  options: { readonly ask?: boolean } = {},
): Promise<{ readonly facts: GameBuildFacts | null; readonly seconds: number | null }> {
  const ref = { threadId, build: { _tag: "build" as const, build: build as never } };
  const deadline = Date.now() + WAIT.factsMinutes * 60_000;
  const since = Date.now();
  let measuringSince: number | null = null;
  let asked = false;
  let askedSkilled = false;
  if (options.ask === true) {
    asked = true;
    await call(server, cookie, (client) => client[WS_METHODS.gameBuildMeasure](ref));
  }
  while (true) {
    const facts = await call(server, cookie, (client) => client[WS_METHODS.gameBuildFacts](ref));
    if (facts.state === "measuring" && measuringSince === null) measuringSince = Date.now();
    const settled = FACTS_SETTLED.has(facts.state);
    if (
      settled &&
      !askedSkilled &&
      facts.skilled.status === "not-measured" &&
      facts.skilled.why === GAME_FACTS_SKILLED_DEFERRED
    ) {
      askedSkilled = true;
      log(`${id}: the tester's bot was left for keep going; asking for it`);
      await call(server, cookie, (client) => client[WS_METHODS.gameBuildMeasure](ref));
    } else if (settled || Date.now() > deadline) {
      const seconds = measuringSince === null ? null : (Date.now() - measuringSince) / 1000;
      log(`${id}: facts ${facts.state}${seconds === null ? "" : ` in ${Math.round(seconds)} s`}`);
      return { facts: settled ? facts : null, seconds };
    } else if (
      !asked &&
      facts.state === "never" &&
      Date.now() - since > WAIT.factsStartSeconds * 1000
    ) {
      asked = true;
      log(`${id}: facts never started; asking for them`);
      await call(server, cookie, (client) => client[WS_METHODS.gameBuildMeasure](ref));
    }
    await sleep(WAIT.factsPollSeconds);
  }
}

const brokeOrBetter = (deltas: ReadonlyArray<GameFactDelta>, tone: "better" | "worse") =>
  deltas
    .filter((delta) => delta.change !== "not-comparable" && delta.tone === tone)
    .map((delta) => ({ id: delta.id, label: delta.label, a: delta.a, b: delta.b }));

/**
 * Phase 2: keep going on the game, on Autopilot, until `STEPS` steps have a
 * verdict or the run ends by itself; then the bench turns it off. Each step's
 * facts are compared with the build it started from, the way keep going
 * judged it, and the game's last build with its first.
 */
async function keepGoing(
  server: BenchmarkServer,
  cookie: string,
  game: { readonly threadId: ThreadId; readonly root: string },
  first: { readonly build: string; readonly turnSeconds: number | null },
  id: string,
): Promise<BenchKeepGoing> {
  const started = Date.now();
  const status = () =>
    call(server, cookie, (client) =>
      client[WS_METHODS.gameKeepGoingStatus]({ threadId: game.threadId }),
    );
  log(`${id}: keep going for ${STEPS} step(s)`);
  let now = await call(server, cookie, (client) =>
    client[WS_METHODS.gameKeepGoing]({
      threadId: game.threadId,
      commandId: `bench:${NodeCrypto.randomUUID()}`,
      mode: "autopilot",
      budgetMinutes: null,
    }),
  );
  const deadline = started + STEPS * WAIT.stepMinutes * 60_000;
  const settledSteps = () =>
    now.steps.filter((step) => step.verdict !== null && step.n <= STEPS).length;
  let seen = 0;
  while (now.mode !== "off" && settledSteps() < STEPS && Date.now() < deadline) {
    await sleep(5);
    now = await status();
    if (settledSteps() > seen) {
      seen = settledSteps();
      const step = now.steps.find((each) => each.n === seen);
      log(`${id}: step ${seen} ${step?.verdict ?? "?"}: ${step?.reason ?? ""}`);
    }
  }
  // Why the run ended before the bench stopped it, if it did.
  const ending = now.mode === "off" ? now.ending : null;
  if (now.mode !== "off") {
    await call(server, cookie, (client) =>
      client[WS_METHODS.gameKeepGoing]({
        threadId: game.threadId,
        commandId: `bench:${NodeCrypto.randomUUID()}`,
        mode: "off",
      }),
    );
    if (settledSteps() < STEPS)
      log(
        `${id}: keep going had ${settledSteps()} of ${STEPS} step(s) after ${WAIT.stepMinutes * STEPS} min; stopped`,
      );
  }
  // The step turn the stop interrupted settles before the builds are read.
  const settleBy = Date.now() + WAIT.settleSeconds * 1000;
  while (Date.now() < settleBy) {
    const projection = await call(server, cookie, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: game.threadId }),
    );
    if (projection.runs.every((run) => TERMINAL_RUN.has(run.status))) break;
    await sleep(WAIT.pollSeconds);
  }
  const seconds = (Date.now() - started) / 1000;
  now = await status();
  const listed = await call(server, cookie, (client) =>
    client[WS_METHODS.gameBuilds]({ threadId: game.threadId, limit: 50 }),
  );
  const compare = (a: string, b: string) =>
    call(server, cookie, (client) =>
      client[WS_METHODS.gameBuildCompare]({
        threadId: game.threadId,
        a: { _tag: "build", build: a as never },
        b: { _tag: "build", build: b as never },
      }),
    ).catch(() => null);
  const steps: Array<BenchStep> = [];
  for (const step of now.steps.filter((each) => each.n <= STEPS).toSorted((a, b) => a.n - b.n)) {
    const base =
      step.build === null
        ? null
        : (listed.builds.find((build) => build.id === step.build)?.base ?? null);
    const comparison =
      step.build === null || base === null ? null : await compare(base, step.build);
    const video = comparison === null ? null : videoOf(game.root, comparison.factsB.masher);
    const shot = video === null ? [] : await frames(video, [0.55], `${id}-step${step.n}`);
    steps.push({
      n: step.n,
      why: step.why,
      text: step.text,
      verdict: step.verdict,
      reason: step.reason,
      gain: step.gain,
      minutes: step.minutes,
      tokens: step.tokens,
      build: step.build,
      base,
      improved: comparison === null ? [] : brokeOrBetter(comparison.deltas, "better"),
      regressed: comparison === null ? [] : brokeOrBetter(comparison.deltas, "worse"),
      frame: shot[0] ?? null,
    });
  }
  const final = listed.current;
  const net = final === null || final === first.build ? null : await compare(first.build, final);
  const finalFacts =
    final === null
      ? null
      : (net?.factsB ??
        (await call(server, cookie, (client) =>
          client[WS_METHODS.gameBuildFacts]({
            threadId: game.threadId,
            build: { _tag: "build", build: final },
          }),
        )));
  return {
    asked: STEPS,
    ending,
    seconds,
    steps,
    first: first.build,
    final,
    net: {
      improved: net === null ? [] : brokeOrBetter(net.deltas, "better"),
      regressed: net === null ? [] : brokeOrBetter(net.deltas, "worse"),
    },
    finalScore:
      finalFacts === null
        ? null
        : scoreGame({
            facts: finalFacts,
            files: null,
            complete: true,
            turnSeconds: first.turnSeconds,
            missing: "",
          }),
  };
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
  const overdue = projection.runs[0];
  if (overdue !== undefined && !TERMINAL_RUN.has(overdue.status)) {
    // A turn left running would load the machine while later games are measured.
    log(`${brief.id}: turn still ${overdue.status} after ${WAIT.turnMinutes} min; stopping it`);
    await call(server, cookie, (client) =>
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "run.interrupt",
        commandId: CommandId.make(`bench:${NodeCrypto.randomUUID()}`),
        threadId: game.threadId,
        runId: overdue.id,
        reason: `the benchmark waits ${WAIT.turnMinutes} min for a first turn`,
      }),
    );
    const settleDeadline = Date.now() + 120_000;
    while (!TERMINAL_RUN.has(projection.runs[0]?.status ?? "") && Date.now() < settleDeadline) {
      await sleep(WAIT.pollSeconds);
      projection = await projectionOf();
    }
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
  let factsSeconds: number | null = null;
  let missing = turnEnded ? "the turn made no build" : "the turn did not end";
  if (build !== undefined) {
    const settled = await settledFacts(server, cookie, game.threadId, build.id, brief.id);
    facts = settled.facts;
    factsSeconds = settled.seconds;
    if (facts === null) missing = `facts not settled after ${WAIT.factsMinutes} min`;
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
  const score = scoreGame({
    facts,
    files: build === undefined ? null : build.files.map((file) => file.path),
    complete: build === undefined || build.files.length === build.fileCount,
    turnSeconds: sinceBrief,
    missing,
  });
  // Keep going needs a game that boots: a build that does not is phase 1's finding, not phase 2's.
  const phase2 =
    STEPS === 0
      ? null
      : build === undefined || score.verdicts.boots.result !== "pass"
        ? { skipped: `no booting first build (${score.verdicts.boots.detail})` }
        : await keepGoing(
            server,
            cookie,
            game,
            { build: build.id, turnSeconds: sinceBrief },
            brief.id,
          ).catch((cause: unknown) => ({
            skipped: `runner error: ${cause instanceof Error ? cause.message : String(cause)}`,
          }));
  if (phase2 !== null)
    await call(server, cookie, (client) =>
      client[WS_METHODS.gameAction]({ threadId: game.threadId, action: "stop" }),
    ).catch(() => undefined);
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
    factsSeconds,
    score,
    keepGoing: phase2,
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
    // The app's default for a new game (GameEntry): the text-generation instance's own chat
    // default, its flagship, at the provider's default effort.
    const text = config.settings.textGenerationModelSelection;
    const entry = config.providers.find((provider) => provider.instanceId === text.instanceId);
    const builtIn = entry === undefined ? undefined : DEFAULT_MODEL_BY_PROVIDER[entry.driver];
    const models = entry?.models ?? [];
    const chat =
      models.find((model) => model.isDefault === true && !model.isCustom)?.slug ??
      models.find((model) => !model.isCustom && model.slug === builtIn)?.slug ??
      builtIn;
    // Never the text-generation model: a run on it measures an agent that quits, not the harness.
    if (args.model === undefined && (chat === undefined || chat === text.model))
      throw new Error(
        `No chat model found for ${text.instanceId} (only ${text.model}); pass --model <instance>/<model>.`,
      );
    modelSelection =
      args.model === undefined
        ? { instanceId: text.instanceId, model: chat ?? text.model }
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
          factsSeconds: null,
          score: scoreGame({
            facts: null,
            files: null,
            complete: true,
            turnSeconds: null,
            missing: `runner error: ${why}`,
          }),
          keepGoing: null,
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

/** One earlier game measured again: its floor then and now, and how long its facts took each time. */
interface Remeasured {
  readonly id: string;
  readonly harness: string | null;
  readonly before: { readonly score: number; readonly factsSeconds: number | null };
  readonly after: { readonly score: number; readonly factsSeconds: number | null };
  readonly criteria: ReadonlyArray<{
    readonly criterion: string;
    readonly before: string;
    readonly after: string;
  }>;
  /** Facts whose reading moved between the two measurements. */
  readonly moved: ReadonlyArray<{
    readonly fact: string;
    readonly before: string;
    readonly after: string;
  }>;
  readonly facts: GameBuildFacts | null;
}

const readingOf = (facts: GameBuildFacts | null) =>
  new Map(
    (facts === null ? [] : gameFactsView(facts)).map((view) => [
      view.id,
      view.reading._tag === "measured"
        ? `${view.reading.tone}: ${view.reading.text}`
        : view.reading._tag === "pending"
          ? "pending"
          : `not measured: ${view.reading.why}`,
    ]),
  );

async function remeasure() {
  const earlier = JSON.parse(
    await NodeFSP.readFile(NodePath.join(runDir, "results.json"), "utf8"),
  ) as BenchRun;
  const when = new Date().toISOString().slice(0, 16).replace(":", "-");
  log(`remeasuring run ${stamp} (${earlier.games.length} games) on commit of ${checkout}`);
  const sandbox = await prepareDisplaySandbox(runDir);
  const server = await startBenchmarkServer({
    checkout,
    homeDir: home,
    sandbox,
    logPath: NodePath.join(runDir, `remeasure-${when}-server.log`),
    provider: earlier.model?.instanceId ?? "codex",
  });
  const out: Array<Remeasured> = [];
  try {
    const cookie = await openSession(server);
    for (const game of earlier.games) {
      if (game.threadId === null || game.build === null || game.root === null) continue;
      const files = game.build.files;
      const settled = await settledFacts(
        server,
        cookie,
        game.threadId as ThreadId,
        game.build.id,
        game.id,
        { ask: true },
      );
      const score = scoreGame({
        facts: settled.facts,
        files,
        // A build's list holds its eight most changed files: fewer is all of them.
        complete: files.length < 8,
        turnSeconds: game.turn.sinceBriefSeconds,
        missing: `facts not settled after ${WAIT.factsMinutes} min`,
      });
      const before = readingOf(game.facts);
      const after = readingOf(settled.facts);
      out.push({
        id: game.id,
        harness: settled.facts?.harness ?? null,
        before: { score: game.score.passed, factsSeconds: game.factsSeconds ?? null },
        after: { score: score.passed, factsSeconds: settled.seconds },
        criteria: CRITERIA.map((criterion) => ({
          criterion,
          before: `${game.score.verdicts[criterion].result}: ${game.score.verdicts[criterion].detail}`,
          after: `${score.verdicts[criterion].result}: ${score.verdicts[criterion].detail}`,
        })),
        moved: [...after.entries()].flatMap(([fact, reading]) =>
          before.get(fact) === reading
            ? []
            : [{ fact, before: before.get(fact) ?? "absent", after: reading }],
        ),
        facts: settled.facts,
      });
      await NodeFSP.writeFile(
        NodePath.join(runDir, `remeasure-${when}.json`),
        `${JSON.stringify(out, null, 2)}\n`,
      );
    }
  } finally {
    await server.stop();
    log("server stopped");
  }
  for (const game of out)
    log(
      `${game.id}: floor ${game.before.score} -> ${game.after.score}, facts ${game.before.factsSeconds ?? "?"} s -> ${game.after.factsSeconds ?? "?"} s, ${game.moved.length} fact(s) read differently`,
    );
  log(`written ${NodePath.join(runDir, `remeasure-${when}.json`)}`);
}

await (args.remeasure === undefined ? main() : remeasure());
