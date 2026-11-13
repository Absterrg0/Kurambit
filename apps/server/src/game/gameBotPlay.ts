// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off -- One real-time bot run over a play session: the bot child by pid, wall-clock ticks and line JSON.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  type GameBotFinding,
  type GameBotMode,
  type GameBotRunResult,
} from "@kurambit/contracts";
import {
  CHILD_EXTRA_MS,
  CHILD_FIRST_INPUT_MS,
  FRACTION_RE,
  asGameState,
  asNumber,
  botChildEnv,
  boundEvidence,
  botsOwnWord,
  END_FRAME,
  extractRunFrames,
  perfFrom,
  posOf,
  sleep,
  type Session,
} from "./gameBotRuntime.ts";
import {
  PLAY_BOUNDS,
  TIMED_OUT,
  bounded,
  createLineReader,
  parseLine,
  type LineReader,
} from "./playSession.ts";
import { spawnOwned, type OwnedProcess, type ProcessHostState } from "./processHost.ts";
import { VIDEO_FPS, VIDEO_WIDTH, openFrameVideo, type FrameVideo } from "./frameVideo.ts";
import type { PlayLaunch } from "./playLaunch.ts";

const END_SETTLE_MS = 1500;

/** What the launch hands the bot run: the session, how it ended, and how to end what it started. */
export type BotLaunch = Pick<PlayLaunch, "play" | "stop" | "ended">;

/** A stall this long in the engine's own frames is a frozen screen. */
const FROZEN_MS = 5_000;

export interface BotRunArgs {
  readonly host: ProcessHostState;
  readonly root: string;
  readonly runId: string;
  readonly runDir: string;
  /** The bot child program, from the server's templates. */
  readonly childPath: string;
  readonly videoPath: string;
  readonly tracePath: string;
  readonly botFile: string;
  readonly mode: GameBotMode;
  readonly seconds: number;
  readonly ffmpeg: string;
  readonly session: Session;
  readonly signal: AbortSignal | undefined;
  /** Where this run stands among its siblings, so runs differ. */
  readonly runIndex: number;
  readonly runTotal: number;
  readonly seed: number;
  readonly priorRuns: ReadonlyArray<{
    readonly topOptions: string;
    readonly cells: number;
    readonly ending: string;
  }>;
}

// Keys whose hold should move the player: the kit's steer helpers send the
// upper-case letters, hand-written bots often the lower-case ones.
const MOVERS = new Set([
  "w",
  "a",
  "s",
  "d",
  "W",
  "A",
  "S",
  "D",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
]);

type Click = { readonly x: number; readonly y: number } | { readonly id: string };

const clickOf = (value: unknown): Click | null => {
  if (typeof value !== "object" || value === null) return null;
  const spec = value as Record<string, unknown>;
  if (typeof spec["id"] === "string" && spec["id"] !== "") return { id: spec["id"] };
  const x = asNumber(spec["x"]);
  const y = asNumber(spec["y"]);
  return x === null || y === null ? null : { x, y };
};

/**
 * One real-time run on an opened session: the game runs unheld at normal
 * speed, a 10 Hz controller loop bridges it and the bot child, detectors read
 * every tick, and the launch keeps the video. The same loop plays every
 * engine; what a runner does not report (a body, a sweep, node counts) its
 * detectors simply never see.
 */
export const playBot = async (launch: BotLaunch, args: BotRunArgs): Promise<GameBotRunResult> => {
  const { play } = launch;
  const can = play.capabilities;
  const stopped = (): boolean => args.session.stopped || args.signal?.aborted === true;
  if (!can.has("realtime"))
    throw new Error(
      play.protocol === 0
        ? "This game's in-game runner predates real-time play, so bots cannot drive it."
        : "This game's in-game runner does not play in real time, so bots cannot drive it.",
    );
  let botChild: NodeChildProcess.ChildProcess | undefined;
  let botProcess: OwnedProcess | undefined;
  let video: FrameVideo | null = null;
  const readers: LineReader[] = [];
  try {
    // The bot child: allowlisted environment only, so no key or display
    // route can reach it. Game data reaches it only through our messages.
    const childLog = NodeFS.openSync(NodePath.join(args.runDir, "child-stderr.log"), "w");
    // The bot file as a file URL: Node's ESM loader refuses a bare C:\ path.
    const owned = spawnOwned(
      args.host,
      process.execPath,
      [args.childPath, NodeURL.pathToFileURL(args.botFile).href],
      { env: botChildEnv(), cwd: args.root, stdio: ["pipe", "pipe", childLog], tree: false },
    );
    NodeFS.closeSync(childLog);
    botProcess = owned;
    botChild = owned.child;
    args.session.processes.push(owned);
    // Attached at once: a child that dies before its first line is never
    // mistaken for a bot that played its whole budget without input.
    let childGone = false;
    const childExited = new Promise<void>((resolve) => {
      botChild!.once("exit", () => {
        childGone = true;
        resolve();
      });
      botChild!.once("error", () => {
        childGone = true;
        resolve();
      });
    });
    const spawned = await new Promise<boolean>((resolve) => {
      botChild!.once("spawn", () => resolve(true));
      botChild!.once("error", () => resolve(false));
    });
    if (!spawned)
      throw new GameOperationError({
        operation: "Bot run",
        path: process.execPath,
        reason: "tool-failed",
        detail: "The bot launcher could not start.",
      });
    const childLines = createLineReader(botChild.stdout!);
    readers.push(childLines);
    let goal = "play the game";
    let childDone: { state: string; note: string; evidence: unknown } | null = null;
    const firstLine = await childLines.next(10_000);
    const first =
      typeof firstLine === "string" && firstLine !== "timeout" && firstLine !== "closed"
        ? parseLine(firstLine)
        : null;
    const hello = first !== null && first["op"] === "hello";
    if (hello && typeof first["goal"] === "string") goal = first["goal"].slice(0, 500);
    // The bot itself never ran: its module would not load, or its child died first.
    if (!hello) {
      const note =
        first !== null && first["op"] === "status"
          ? String(first["note"] ?? "").slice(0, 500)
          : firstLine === "timeout"
            ? "The bot did not start within 10 s."
            : "The bot's child exited before it started.";
      return runWithoutPlay(args, { goal, state: "bot-error", note });
    }
    const findings: GameBotFinding[] = [];
    const seen = new Set<string>();
    const picks: Array<{ t: number; name: string }> = [];
    const offered: Array<{ t: number; options: string[] }> = [];
    const setStates: Array<{ t: number; target: string; values: unknown }> = [];
    const refusedSetStates: Array<{ t: number; target: string }> = [];
    const samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }> = [];
    let decisions = 0;
    let ticks = 0;
    let misses = 0;
    let skippedIdClicks = 0;
    let lastObsWall = Date.now();
    let lastT = 0;
    let lastPos: [number, number, number] | null = null;
    let lastGameState: Record<string, number | boolean | string | null> = {};
    let perf = perfFrom(play.bootPerf, null);
    let fallStart: number | null = null;
    let overlapStreak = 0;
    let moveWindow: Array<{ wall: number; pos: [number, number, number] }> = [];
    let noMoveReported = false;
    let lastHeld: string[] = [];
    const addFinding = (
      detector: string,
      severity: string,
      summary: string,
      t: number,
      pos: [number, number, number] | null,
      detail: string,
    ): void => {
      const sig = `${detector}:${summary.slice(0, 120)}`;
      if (seen.has(sig) || findings.length >= GAME_BOT_BOUNDS.maxFindings) return;
      seen.add(sig);
      findings.push({ detector, severity, summary, t, pos, detail: detail.slice(0, 400) });
    };
    const writeChild = (msg: Record<string, unknown>): void => {
      try {
        botChild?.stdin?.write(`${JSON.stringify(msg)}\n`);
      } catch {
        /* closed */
      }
    };
    // The video is the engine's own frames, on every engine; a runner from
    // before protocol 2 plays without one.
    if (can.has("frames")) {
      video = openFrameVideo({
        host: args.host,
        ffmpeg: args.ffmpeg,
        videoPath: args.videoPath,
        sidecarPath: NodePath.join(args.runDir, "run.frames.json"),
        logPath: NodePath.join(args.runDir, "ffmpeg.log"),
      });
      await play.realtime({ fps: VIDEO_FPS, width: VIDEO_WIDTH, onFrame: video.push });
    } else await play.realtime();
    const wallStart = Date.now();
    const budgetMs = args.seconds * 1000;
    // How the game ended, when it ended before the bot did: measured, the
    // game's, only while our own side (display, browser) is alive.
    let gameEnd: { state: "crashed" | "unresponsive"; note: string } | null = null;
    while (!stopped()) {
      if (childDone !== null || childGone) break;
      if (Date.now() - wallStart > budgetMs) break;
      const tick = await play.nextTick(PLAY_BOUNDS.tickMs);
      if (tick.kind === "timeout") {
        misses += 1;
        if (misses > PLAY_BOUNDS.tickMisses) {
          gameEnd = {
            state: "unresponsive",
            note: `The game stopped answering at ${lastT.toFixed(1)} s: no tick for ${((PLAY_BOUNDS.tickMisses * PLAY_BOUNDS.tickMs) / 1000).toFixed(0)} s.`,
          };
          break;
        }
        continue;
      }
      if (tick.kind === "closed") {
        video?.markEnd();
        // A stop ends the game too: it is checked first, so it never reads as a crash.
        if (stopped()) break;
        const end = await bounded(launch.ended, PLAY_BOUNDS.endedMs);
        if (stopped()) break;
        if (end !== TIMED_OUT && end.by === "host")
          throw new GameOperationError({
            operation: "Bot run",
            path: args.root,
            reason: "tool-failed",
            detail: end.detail,
          });
        gameEnd = {
          state: "crashed",
          note: `${end === TIMED_OUT ? "The game closed its session" : end.detail} at ${lastT.toFixed(1)} s.`,
        };
        break;
      }
      const msg = tick.observation;
      misses = 0;
      ticks += 1;
      const wallNow = Date.now();
      const gap = wallNow - lastObsWall;
      const t = asNumber(msg["t"]) ?? lastT;
      lastT = t;
      const pos = posOf(msg);
      if (pos !== null) lastPos = pos;
      const probe = msg["probe"] as Record<string, unknown> | undefined;
      const gameState = asGameState(probe?.["gameState"]);
      if (Object.keys(gameState).length > 0) lastGameState = gameState;
      perf = perfFrom(msg["perf"], perf);
      // Detectors, adapted from the Aura in-game checks (Apache-2.0) plus
      // the sweep's movement/hitch probes; the code here is our own.
      if (gap > 1500 && ticks > 2)
        addFinding("hitch", "warning", `No tick for ${(gap / 1000).toFixed(1)}s wall`, t, pos, "");
      lastObsWall = wallNow;
      for (const entry of Array.isArray(msg["errors"]) ? (msg["errors"] as unknown[]) : []) {
        const error = entry as { message?: unknown; where?: unknown; kind?: unknown };
        if (typeof error?.message !== "string") continue;
        const where = typeof error.where === "string" ? error.where : "";
        const category =
          error.kind === "page"
            ? "Page"
            : /script|parse/i.test(`${error.message} ${where}`)
              ? "Script"
              : "Engine";
        addFinding(
          "log_error",
          "error",
          `${category} error: ${error.message.slice(0, 160)}`,
          t,
          pos,
          where,
        );
      }
      if (
        pos !== null &&
        (Math.abs(pos[0]) > 2000 ||
          Math.abs(pos[1]) > 2000 ||
          Math.abs(pos[2]) > 2000 ||
          pos[1] < -50)
      )
        addFinding(
          "out_of_world",
          "error",
          `Player out of world at (${pos[0].toFixed(0)}, ${pos[1].toFixed(0)}, ${pos[2].toFixed(0)})`,
          t,
          pos,
          "",
        );
      const body = msg["body"] as Record<string, unknown> | null | undefined;
      if (body !== null && body !== undefined && typeof body === "object") {
        const vy = asNumber(body["vy"]);
        if (body["onGround"] === false && vy !== null && vy < -1) {
          if (fallStart === null) fallStart = t;
          else if (t - fallStart >= 6)
            addFinding("long_fall", "error", "Player kept falling for 6s", t, pos, "");
        } else fallStart = null;
      } else fallStart = null;
      const sweep = msg["sweep"] as { overlaps?: unknown; overlapNames?: unknown } | null;
      if (sweep !== null && typeof sweep === "object" && typeof sweep.overlaps === "number") {
        if (sweep.overlaps > 0) {
          overlapStreak += 1;
          if (overlapStreak === 2)
            addFinding(
              "overlap",
              "error",
              `Player overlapping solid geometry (${sweep.overlaps} at ${String(sweep.overlapNames ?? "").slice(0, 120)})`,
              t,
              pos,
              "",
            );
        } else overlapStreak = 0;
      }
      if (pos !== null) {
        moveWindow.push({ wall: wallNow, pos });
        moveWindow = moveWindow.filter((entry) => wallNow - entry.wall < 2000);
        const moving = lastHeld.some((key) => MOVERS.has(key));
        if (moving && !noMoveReported && moveWindow.length >= 2) {
          const start = moveWindow[0]!.pos;
          const dist = Math.hypot(pos[0] - start[0], pos[1] - start[1], pos[2] - start[2]);
          if (wallNow - moveWindow[0]!.wall >= 1900 && dist < 0.3) {
            noMoveReported = true;
            addFinding(
              "no_move",
              "warning",
              `Holding ${lastHeld
                .filter((key) => MOVERS.has(key))
                .slice(0, 3)
                .join("+")} 2s moved nobody (${dist.toFixed(1)}m)`,
              t,
              pos,
              "",
            );
          }
        }
        if (!moving) moveWindow = [];
      }
      const hudText = probe?.["hudText"];
      if (typeof hudText === "string" && hudText !== "")
        for (const match of hudText.matchAll(new RegExp(FRACTION_RE, "g"))) {
          const a = Number(match[1]);
          const b = Number(match[2]);
          if (b > 0 && a > b)
            addFinding(
              "hud_fraction",
              "error",
              `HUD shows ${a}/${b}: more than its stated maximum`,
              t,
              pos,
              match[0].slice(0, 120),
            );
        }
      if (ticks % 10 === 1)
        samples.push({
          t,
          pos,
          state: typeof gameState["state"] === "string" ? gameState["state"] : null,
        });
      writeChild({
        op: "obs",
        tick: ticks,
        t,
        observation: msg,
        runContext: {
          seed: args.seed,
          runIndex: args.runIndex,
          runTotal: args.runTotal,
          priorRuns: args.priorRuns,
        },
      });
      // The child answers each tick with its inputs; offered/picked/status
      // ride the same stream.
      let answer: {
        held: string[];
        taps: string[];
        clicks: unknown[];
        setStates: unknown[];
      } | null = null;
      for (let i = 0; i < 8; i++) {
        const line = await childLines.next(i === 0 ? CHILD_FIRST_INPUT_MS : CHILD_EXTRA_MS);
        if (line === "timeout" || line === "closed") break;
        const childMsg = parseLine(line);
        if (childMsg === null) continue;
        if (childMsg["op"] === "input") {
          answer = {
            held: Array.isArray(childMsg["held"])
              ? (childMsg["held"] as unknown[]).map(String).slice(0, 8)
              : [],
            taps: Array.isArray(childMsg["taps"])
              ? (childMsg["taps"] as unknown[]).map(String).slice(0, 8)
              : [],
            clicks: Array.isArray(childMsg["clicks"]) ? (childMsg["clicks"] as unknown[]) : [],
            setStates: Array.isArray(childMsg["setStates"])
              ? (childMsg["setStates"] as unknown[])
              : [],
          };
        } else if (childMsg["op"] === "offered") {
          const names = Array.isArray(childMsg["options"])
            ? (childMsg["options"] as unknown[]).map(String).filter((name) => name !== "")
            : [];
          if (names.length > 0) offered.push({ t, options: names.slice(0, 20) });
        } else if (childMsg["op"] === "picked") {
          decisions += 1;
          picks.push({ t, name: String(childMsg["name"] ?? "") });
        } else if (childMsg["op"] === "status") {
          childDone = {
            state: String(childMsg["state"] ?? "error"),
            note: String(childMsg["note"] ?? "").slice(0, 500),
            evidence: childMsg["evidence"] ?? {},
          };
        }
      }
      if (answer === null) answer = { held: lastHeld, taps: [], clicks: [], setStates: [] };
      lastHeld = [...answer.held];
      for (const entry of answer.setStates) {
        const spec = entry as { target?: unknown; values?: unknown };
        if (typeof spec?.target !== "string") continue;
        const values =
          typeof spec.values === "object" && spec.values !== null && !Array.isArray(spec.values)
            ? (spec.values as Record<string, unknown>)
            : {};
        if (!can.has("setState")) {
          refusedSetStates.push({ t, target: spec.target });
          continue;
        }
        setStates.push({ t, target: spec.target, values: spec.values ?? null });
        await play.setState(spec.target, values);
      }
      const clicks: Click[] = [];
      for (const raw of answer.clicks) {
        const click = clickOf(raw);
        if (click === null) continue;
        // Without a control tree an id-click has nothing to land on.
        if ("id" in click && !can.has("ui")) skippedIdClicks += 1;
        else clicks.push(click);
      }
      await play.input({ held: answer.held, taps: answer.taps, clicks });
    }
    // The loop ended (the budget, the bot's word) while the game was not
    // answering: it is asked once more, and silence again is the game's,
    // measured, whatever the bot concluded from what it last saw.
    if (misses > 0 && gameEnd === null && !stopped()) {
      const last = await play.nextTick(PLAY_BOUNDS.tickMs);
      if (last.kind === "timeout")
        gameEnd = {
          state: "unresponsive",
          note: `The game stopped answering at ${lastT.toFixed(1)} s.`,
        };
    }
    const wallSeconds = Math.max(0.1, (Date.now() - wallStart) / 1000);
    const tickHz = ticks / wallSeconds;
    const gameSeconds = lastT;
    const timeRatio = gameSeconds / wallSeconds;
    // The harness's words where the game or a stop ended the run; else the bot's own.
    const childStatus =
      childDone === null ? null : { ...childDone, state: botsOwnWord(childDone.state) };
    const status: { state: string; note: string; evidence: unknown } = stopped()
      ? { state: "stopped", note: "The run was stopped.", evidence: undefined }
      : gameEnd !== null
        ? { ...gameEnd, evidence: undefined }
        : (childStatus ??
          (childGone
            ? {
                state: "bot-error",
                note: `The bot's child exited at ${lastT.toFixed(1)} s.`,
                evidence: undefined,
              }
            : {
                state: "budget",
                note: `Wall budget of ${args.seconds}s ended.`,
                evidence: undefined,
              }));
    const evidence = boundEvidence(status.evidence);
    const resultStatus = {
      state: status.state,
      note: evidence.dropped
        ? `${status.note} (its evidence passed 4 KB and was left out)`
        : status.note,
      ...(evidence.value === undefined ? {} : { evidence: evidence.value }),
    };
    video?.markEnd();
    // The run's last screen (often its ending) is kept before the game quits: the
    // video's tail is recorded after the window is gone. A bot that reported an
    // outcome gets a moment first, since games show their end screen after a beat.
    if (childStatus !== null && gameEnd === null) await sleep(END_SETTLE_MS);
    await NodeFSP.mkdir(NodePath.join(args.runDir, "frames"), { recursive: true }).catch(
      () => undefined,
    );
    await play.still(NodePath.join(args.runDir, "frames", END_FRAME)).catch(() => false);
    // Writes the runner never got (it predates them) are refusals too, said plainly.
    const refusedStates = [
      ...play.refusedStates(),
      ...refusedSetStates.map(({ target }) => ({
        target,
        error: `this game's runner takes no state writes, so ${target} was never sent; the game's harness files predate them`,
      })),
    ];
    await play.close();
    const videoFacts = (await video?.finish()) ?? null;
    // Every child ends with the run: the bot child's stdin pipe closes so its
    // read loop exits on its own, and the launch ends the game and its
    // display, so one call that makes many runs cannot leak a process per run.
    try {
      botChild.stdin?.end();
    } catch {
      /* closed */
    }
    await launch.stop();
    await bounded(childExited, 3000);
    if (!childGone) botProcess.signal("SIGTERM");
    const usedSetState = setStates.length > 0;
    const frames = await extractRunFrames(args.host, args.ffmpeg, args.videoPath, args.runDir);
    // The engine's own frame counter, measured by the video, is the one source
    // of a frozen screen.
    const allFindings =
      videoFacts !== null && videoFacts.longestStallMs >= FROZEN_MS
        ? [
            ...findings,
            {
              detector: "frozen",
              severity: "error",
              summary: `The game drew no new frame for ${(videoFacts.longestStallMs / 1000).toFixed(1)} s`,
              t: videoFacts.longestStallAt,
              pos: null,
              detail: "measured from the engine's own frame counter",
            } satisfies GameBotFinding,
          ]
        : findings;
    const trace = {
      runId: args.runId,
      file: NodePath.relative(args.root, args.botFile),
      mode: args.mode,
      goal,
      ticks,
      tickHz: Number(tickHz.toFixed(2)),
      timeRatio: Number(timeRatio.toFixed(3)),
      gameSeconds: Number(gameSeconds.toFixed(2)),
      wallSeconds: Number(wallSeconds.toFixed(1)),
      decisions,
      usedSetState,
      setStates,
      ...(refusedSetStates.length > 0 ? { refusedSetStates } : {}),
      ...(can.has("ui") ? {} : { skippedIdClicks }),
      picks,
      offered: offered.slice(0, 400),
      status: { state: status.state, note: status.note },
      findings: allFindings,
      samples,
      finalPos: lastPos,
      finalState: lastGameState,
      ...(perf === null ? {} : { perf }),
      video: videoFacts,
    };
    const message =
      `Bot "${trace.file}": ${status.state} — ${status.note}. ` +
      `${ticks} ticks at ${tickHz.toFixed(1)} Hz, game/wall ${timeRatio.toFixed(2)}. ` +
      `${decisions} decisions. ${allFindings.length} finding(s). ` +
      (perf === null
        ? ""
        : `Scene nodes ${perf.nodesStart} start, ${perf.nodesPeak} peak, ${perf.nodesEnd} end; ${perf.orphansEnd} orphans. `) +
      (usedSetState ? "Used explicit set-state writes (not pure play)." : "Pure input play.") +
      (refusedSetStates.length > 0
        ? ` ${refusedSetStates.length} set-state write(s) refused and never sent: this game's runner takes no state writes, so reach that state by playing.`
        : "") +
      (skippedIdClicks > 0
        ? ` ${skippedIdClicks} id-click(s) skipped: this game's runner has no control tree.`
        : "") +
      (videoFacts === null
        ? can.has("frames")
          ? " The game sent no frames, so this run has no video."
          : " This game's in-game runner predates engine frames, so this run has no video."
        : ` Video (engine frames): ${args.videoPath}, ${videoFacts.distinctFrames} distinct frames` +
          (videoFacts.longestStallMs >= 2000
            ? `; the game drew no new frame for ${(videoFacts.longestStallMs / 1000).toFixed(1)} s at its longest.`
            : "."));
    // The trace carries what game_bot_view shows, so a view after a restart reads it from disk.
    const kept = {
      ...trace,
      ...(refusedStates.length > 0 ? { refusedStates } : {}),
      status: resultStatus,
      tracePath: args.tracePath,
      videoPath: args.videoPath,
      frames,
      message,
    };
    await NodeFSP.writeFile(args.tracePath, JSON.stringify(kept, null, 2));
    await NodeFSP.writeFile(
      NodePath.join(args.runDir, "summary.json"),
      JSON.stringify({ ...kept, samples: trace.samples.length }, null, 2),
    );
    return {
      runId: args.runId,
      goal,
      status: resultStatus,
      ticks,
      tickHz: Number(tickHz.toFixed(2)),
      timeRatio: Number(timeRatio.toFixed(3)),
      gameSeconds: Number(gameSeconds.toFixed(2)),
      decisions,
      usedSetState,
      ...(refusedStates.length > 0 ? { refusedStates } : {}),
      findings: allFindings,
      finalState: lastGameState,
      ...(perf === null ? {} : { perf }),
      finalPos: lastPos,
      mode: args.mode,
      runIds: [args.runId],
      reportPath: null,
      tracePath: args.tracePath,
      videoPath: args.videoPath,
      frames,
      message,
    };
  } finally {
    for (const reader of readers) reader.close();
    // Waits for the child to go: a run that returned while it still ran would
    // leave it holding the game folder, which Windows then cannot delete.
    await Promise.all([botProcess?.stop(), video?.stop()]);
  }
};

/**
 * A run that never got to play: its bot never ran (its module did not load,
 * or its child died before its first line), which says nothing about the game
 * and is not a bot run on the record; or the game never booted, which is
 * measured. Its trace still says which, for game_bot_view.
 */
export const runWithoutPlay = async (
  args: Pick<BotRunArgs, "root" | "runId" | "botFile" | "mode" | "tracePath" | "videoPath">,
  input: {
    readonly goal: string;
    readonly state: "bot-error" | "not-booted";
    readonly note: string;
  },
): Promise<GameBotRunResult> => {
  const file = NodePath.relative(args.root, args.botFile);
  const played = input.state !== "bot-error";
  const status = { state: input.state, note: input.note };
  const message = played
    ? `Bot "${file}": the game did not boot. ${input.note}`
    : `Bot "${file}" never played: ${input.note} Fix the bot file under .studio/bot/ and run it again; this run is not on the record.`;
  const result: GameBotRunResult = {
    runId: args.runId,
    ...(played ? {} : { played: false }),
    goal: input.goal,
    status,
    ticks: 0,
    tickHz: 0,
    timeRatio: 0,
    gameSeconds: 0,
    decisions: 0,
    usedSetState: false,
    findings: [],
    finalState: {},
    finalPos: null,
    mode: args.mode,
    runIds: [args.runId],
    reportPath: null,
    tracePath: args.tracePath,
    videoPath: args.videoPath,
    frames: [],
    message,
  };
  await NodeFSP.writeFile(
    args.tracePath,
    JSON.stringify({ ...result, file, samples: [] }, null, 2),
  ).catch(() => undefined);
  return result;
};
