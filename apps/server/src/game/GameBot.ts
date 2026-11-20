// @effect-diagnostics globalTimers:off globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off -- This service owns the native display/process boundary; wall-clock ticks, pids and line JSON are the domain here.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import {
  GAME_BOT_BOUNDS,
  GameOperationError,
  isAvailableEngine,
  type GameBotPerf,
  type GameBotRunInput,
  type GameBotRunResult,
  type GameBotViewInput,
  type GameBotViewResult,
  type ThreadId,
  manifestProject,
} from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotEvidence from "./botEvidence.ts";
import * as ExploreEvidence from "./exploreEvidence.ts";
import * as GameEngine from "./GameEngine.ts";
import { unavailableEngine } from "./engineProfile.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { inGame } from "./gamePath.ts";
import { findExecutable } from "./GameProcesses.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { ProcessHost } from "./processHost.ts";
import { openPagePlay } from "./playLaunch.ts";
import { encodePlayUse, PLAY_USE_FILE } from "./assetUse.ts";
import { PLAY_PERF_FILE } from "./playPerf.ts";
import { encodeSceneFile, keepSceneReport, SCENE_FILE } from "./sceneReport.ts";
import {
  appendNoFollow,
  ensureGameDir,
  keptSavesFor,
  keptWebStorage,
  writeKeptStorage,
} from "./gameKeptSaves.ts";
import { playBot, runWithoutPlay } from "./gameBotPlay.ts";
import { botEnding, botFinalState, cellOf, opError, type Session } from "./gameBotRuntime.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import { runtimesFor } from "./gameRuntime.ts";
import * as GameTemplates from "./GameTemplates.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import { isPathWithinRoot } from "@kurambit/shared/pathContainment";
import { PLAY_BOUNDS, bounded } from "./playSession.ts";

/**
 * A Chromium bot peaked at 630 MB (the page, ffmpeg recording, the bot
 * child). Each run's boot holds the memory gate, so the next start's check
 * sees what this one took.
 */
const BOT_ROOM: MemoryRoom = {
  what: "bot run",
  neededMb: 1536,
  env: "KURAMBIT_BOT_MEMORY_MB",
};

/** How long a stop waits for a bot call to end: its run's teardown is bounded well inside. */
const STOP_WAIT_MS = 60_000;
const STOP_WAIT = Duration.millis(STOP_WAIT_MS);

/** The call a run holds: the checkout's own, or one lane of it when its caller plays it several ways at once. */
const sessionKey = (root: string, lane: string | undefined) =>
  lane === undefined ? root : `${root}\0${lane}`;

/** The people-facing copy of a run in `.studio/bot-results.jsonl`, never through a planted link. */
const appendResult = async (root: string, line: string) => {
  try {
    await appendNoFollow(
      NodePath.join(await ensureGameDir(root, ".studio"), "bot-results.jsonl"),
      line,
    );
  } catch {
    // A copy for people: the run decides by its record, so a refused write costs nothing.
  }
};

export class GameBot extends Context.Service<
  GameBot,
  {
    /**
     * `game_play` op `bot`: a model-written bot file against the thread's game in
     * real time at normal speed on a private display. Holds and releases go
     * out at 10 Hz, one continuous video is recorded, and detectors' findings
     * carry time and position. Each run is recorded on the thread's bot
     * evidence before the next starts; a run that cannot be recorded fails the
     * call. The run itself takes minutes and holds no game lock: the game's
     * operation lock and the memory gate are taken only around each run's
     * import and boot, and a second call on the same checkout is refused as busy.
     */
    readonly run: (
      threadId: ThreadId,
      input: GameBotRunInput,
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /**
     * The same bot run in a checkout of the game no thread owns, such as a
     * build's copy for its facts; recorded on no thread. Each `lane` is a call
     * of its own beside the checkout's others (GameFacts plays a copy two ways
     * at once); without one the checkout has one call at a time.
     */
    readonly runIn: (
      root: string,
      input: GameBotRunInput,
      options?: { readonly lane?: string },
    ) => Effect.Effect<GameBotRunResult, GameOperationError>;
    /** A quick look at a finished bot run: summary, findings and evidence paths. */
    readonly view: (
      threadId: ThreadId,
      input: GameBotViewInput,
    ) => Effect.Effect<GameBotViewResult, GameOperationError>;
    /**
     * The latest play-mode bot any thread ran on this game folder, from the
     * server's records (never the folder's own results file); null when none ran.
     */
    readonly latestPlayBot: (
      root: string,
    ) => Effect.Effect<{ readonly file: string; readonly at: string } | null>;
    /** Stops one game's bot call by root and waits for it to end (bounded); game_builds op stop calls this. */
    readonly stop: (root: string) => Effect.Effect<void>;
    /** Stops every bot call a thread started and waits for each to end (bounded): its turn is over. */
    readonly stopOwned: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("kurambit/game/GameBot") {}

interface RunTrace {
  runId: string;
  /** False on a run whose bot never ran: not a run on the record, nor in a report. */
  played?: boolean;
  file: string;
  goal: string;
  ticks: number;
  gameSeconds: number;
  decisions: number;
  usedSetState: boolean;
  setStates: Array<{ t: number; target: unknown; values: unknown }>;
  picks: Array<{ t: number; name: string }>;
  offered: Array<{ t: number; options: string[] }>;
  status: { state: string; note: string };
  findings: Array<{
    detector: string;
    severity: string;
    summary: string;
    t: number;
    pos: [number, number, number] | null;
    detail: string;
  }>;
  samples: Array<{ t: number; pos: [number, number, number] | null; state: unknown }>;
  finalPos: [number, number, number] | null;
  finalState?: Record<string, number | boolean | string | null>;
  perf?: GameBotPerf;
  videoPath?: string;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const traceFile = (root: string, runId: string) =>
  NodePath.join(root, "builds/logs", `game-bot-${runId}`, "trace.json");

/** One run's trace, or null when it is missing, unreadable or another run's. */
const readTrace = async (root: string, runId: string): Promise<RunTrace | null> => {
  if (!RUN_ID.test(runId)) return null;
  try {
    const trace = JSON.parse(await NodeFSP.readFile(traceFile(root, runId), "utf8")) as RunTrace;
    return trace?.runId === runId ? trace : null;
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const processHost = yield* ProcessHost;
  const engines = yield* GameEngine.GameEngine;
  const projects = yield* GameProjectService.GameProjectService;
  const gameBrowser = yield* makeGameBrowser;
  const scheduler = yield* Scheduler.Scheduler;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const templates = yield* GameTemplates.GameTemplates;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const evidenceDir = NodePath.join((yield* ServerConfig.ServerConfig).stateDir, "bot-evidence");
  const evidenceLock = Semaphore.makeUnsafe(1);
  // Records untouched as long as explore evidence's belong to runs long finished.
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* evidenceLock
      .withPermits(1)(Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, now)))
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("Pruning bot evidence failed.", { cause })),
      );
  });
  yield* prune;
  yield* scheduler.register("game-bot-evidence", yield* Scheduler.every(3_600_000, prune));
  /** Each game's latest play-mode bot, read from the records once and kept as runs are recorded. */
  const latestPlays = new Map<string, BotEvidence.BotRun | null>();
  const recordRun = (threadId: ThreadId, root: string, run: BotEvidence.BotRun) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const found = yield* Effect.tryPromise({
          try: () => BotEvidence.read(evidenceDir, threadId),
          catch: (cause) => opError("Bot run", evidenceDir, "io", undefined, cause),
        });
        if (found === "damaged") {
          const now = yield* Clock.currentTimeMillis;
          const aside = yield* Effect.tryPromise({
            try: () => BotEvidence.setAside(evidenceDir, threadId, now),
            catch: (cause) =>
              opError(
                "Bot run",
                evidenceDir,
                "io",
                "A damaged bot record could not be moved aside.",
                cause,
              ),
          });
          yield* Effect.logWarning("A thread's bot evidence was unreadable; it is kept aside.", {
            threadId,
            aside,
          });
        }
        const next = BotEvidence.add(
          found === null || found === "damaged" ? BotEvidence.empty(threadId, root) : found,
          root,
          run,
        );
        yield* fileServices(BotEvidence.write(evidenceDir, next)).pipe(
          Effect.mapError((cause) =>
            opError("Bot run", evidenceDir, "io", "The bot run could not be recorded.", cause),
          ),
        );
        // The game's latest play bot, as latestPlayBot answers it, follows the record.
        latestPlays.set(root, run);
      }),
    );

  /** One bot call per checkout root (or lane of one), with whose it is and when it has ended. */
  const sessions = new Map<
    string,
    {
      readonly root: string;
      readonly session: Session;
      readonly owner: ThreadId | undefined;
      readonly done: Deferred.Deferred<void>;
      /** Completed by a stop, which every wait of the call races: gate, boot, player build. */
      readonly stopRequested: Deferred.Deferred<void>;
    }
  >();
  const botLocks = yield* KeyedLock.make<string>();
  // A stop flips the flag before it ends anything, so the run reads its end
  // as stopped, never as the game crashing.
  const drop = (key: string) => {
    const entry = sessions.get(key);
    if (entry === undefined) return null;
    entry.session.stopped = true;
    Deferred.doneUnsafe(entry.stopRequested, Exit.void);
    for (const owned of entry.session.processes) void owned.stop();
    return entry.done;
  };
  /** Stops the calls `which` picks and waits for each to end, bounded. */
  const stopWhere = (which: (root: string, owner: ThreadId | undefined) => boolean) =>
    Effect.gen(function* () {
      const ending = [...sessions.entries()]
        .filter(([, entry]) => which(entry.root, entry.owner))
        .map(([key]) => drop(key))
        .filter((done) => done !== null);
      for (const done of ending) {
        const ended = yield* Deferred.await(done).pipe(Effect.timeoutOption(STOP_WAIT));
        if (Option.isNone(ended))
          yield* Effect.logWarning("A stopped bot run did not end within its bound.");
      }
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of sessions.keys()) drop(key);
    }),
  );

  const isGameOperationError = Schema.is(GameOperationError);

  const runLocked = (
    root: string,
    input: GameBotRunInput,
    owner: ThreadId | undefined,
    lane: string | undefined,
  ) =>
    Effect.gen(function* () {
      // A bot is a game file under .studio/bot/*.mjs; anything else is refused.
      const botDir = NodePath.resolve(root, ".studio/bot");
      const botFile = NodePath.resolve(root, input.file);
      if (!isPathWithinRoot(botFile, botDir) || botFile === botDir || !botFile.endsWith(".mjs"))
        return yield* opError(
          "Bot run",
          input.file,
          "invalid-input",
          "The bot file must live under .studio/bot/ and end with .mjs.",
        );
      // The run executes the file: one that leads out of the game through a link is refused.
      yield* inGame(root, NodePath.relative(root, botFile));
      const isFile = yield* Effect.promise(() =>
        NodeFSP.stat(botFile)
          .then((stat) => stat.isFile())
          .catch(() => false),
      );
      if (!isFile)
        return yield* opError("Bot run", input.file, "invalid-input", "No bot file there.");
      const seconds = Math.min(
        GAME_BOT_BOUNDS.maxSeconds,
        Math.max(GAME_BOT_BOUNDS.minSeconds, input.seconds ?? GAME_BOT_BOUNDS.defaultSeconds),
      );
      // One call may make several sequential runs. Ten at most; each run gets its own directory.
      const count = Math.min(10, Math.max(1, Math.floor(input.runs ?? 1)));
      const pathEnv = process.env.PATH ?? "";
      const manifest = yield* projects.read(root);
      if (!isAvailableEngine(manifest.engine.name))
        return yield* unavailableEngine(manifest.engine.name);
      const backend = yield* engines.backendFor(manifest.engine.name);
      const projectDir = yield* inGame(root, manifestProject(manifest));
      const viewport = yield* backend.viewport(projectDir);
      const browser = yield* gameBrowser("Bot run", root);
      const runtimes = yield* runtimesFor(templates, manifest);
      // The child program ships with the server, never from a game's folder.
      const childPath = NodePath.join(yield* templates.directory, "bot-child.mjs");
      const ffmpeg = yield* Effect.promise(() =>
        findExecutable("ffmpeg", { pathEnv, override: process.env.KURAMBIT_FFMPEG }),
      );
      if (ffmpeg === null)
        return yield* opError(
          "Bot run",
          "ffmpeg",
          "tool-missing",
          "ffmpeg is needed to record the play; install it (Settings > Game tools).",
        );
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Bot run",
      });
      // One session object spans the whole call: drop() flips its flag, so
      // a stop between runs ends the call with the runs it has. A per-run
      // entry in the map would vanish with each run's cleanup and the loop
      // could never tell "stopped" from "between runs".
      const session: Session = {
        root,
        runId: NodeCrypto.randomUUID(),
        stopped: false,
        processes: [],
      };
      const each = yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const stopRequested = yield* Deferred.make<void>();
          sessions.set(sessionKey(root, lane), { root, session, owner, done, stopRequested });
          return { done, stopRequested };
        }),
        ({ stopRequested }) =>
          Effect.gen(function* () {
            const stoppedError = opError("Bot run", root, "cancelled", "Bot run stopped.");
            /** A stop ends `effect` wherever it waits; what it started is ended by its own scope. */
            const untilStopped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.raceFirst(
                effect,
                Deferred.await(stopRequested).pipe(Effect.andThen(Effect.fail(stoppedError))),
              );
            const out: GameBotRunResult[] = [];
            // What earlier runs of this call covered, told to each next run so
            // runs differ instead of collapsing onto one trajectory.
            const priorRuns: Array<{ topOptions: string; cells: number; ending: string }> = [];
            for (let index = 0; index < count; index++) {
              if (session.stopped) break;
              const runId = NodeCrypto.randomUUID();
              const runDir = NodePath.join(root, "builds/logs", `game-bot-${runId}`);
              const videoPath = NodePath.join(runDir, "run.mp4");
              const tracePath = NodePath.join(runDir, "trace.json");
              // A fresh folder of its own under a logs folder checked to be the
              // game's: nothing the run writes there can follow a planted link.
              yield* Effect.tryPromise({
                try: async () => {
                  await ensureGameDir(root, "builds/logs");
                  await NodeFSP.mkdir(runDir);
                },
                catch: (cause) => opError("Bot run", runDir, "io", undefined, cause),
              });
              // Anything the run loop throws that is not already ours to name is
              // a fault of our own side: the game's ends are results.
              const failed = (cause: unknown) =>
                isGameOperationError(cause)
                  ? cause
                  : opError(
                      "Bot run",
                      root,
                      "tool-failed",
                      cause instanceof Error
                        ? cause.message.slice(0, 2000)
                        : String(cause).slice(0, 2000),
                      cause,
                    );
              // The boot is the start's own memory peak, so it runs inside the gate.
              const open = untilStopped(
                gate.admit(
                  "Bot run",
                  root,
                  BOT_ROOM,
                  openPagePlay({
                    operation: "Bot run",
                    root,
                    projectDir,
                    browser,
                    viewport,
                    bootTimeoutMs: PLAY_BOUNDS.bootMs,
                    keptStorage: keptWebStorage(saves),
                    recordUse: true,
                    sceneReport: true,
                    runtimes,
                  }),
                ),
              );
              // An interrupt does not wait for the play promise, and its finally
              // still stops the bot child and the video encoder: the launch ends
              // only once that settled (bounded), so nothing writes into the run's
              // folder once the call returns and its caller removes it.
              let playing: Promise<unknown> = Promise.resolve();
              // A stop during boot interrupts the launch, which ends what it started.
              const one = yield* Effect.acquireUseRelease(
                open.pipe(
                  Effect.interruptible,
                  Effect.mapError((error) =>
                    session.stopped
                      ? opError("Bot run", root, "cancelled", "Bot run stopped.")
                      : error,
                  ),
                ),
                (opened) =>
                  // A stop that landed as the game opened ends it unplayed.
                  (session.stopped ? Effect.fail(stoppedError) : Effect.void).pipe(
                    Effect.andThen(
                      Effect.tryPromise({
                        try: (signal) => {
                          const run = playBot(opened, {
                            host: processHost,
                            root,
                            runId,
                            runDir,
                            childPath,
                            videoPath,
                            tracePath,
                            botFile,
                            seconds,
                            ffmpeg,
                            session,
                            signal,
                            runIndex: index,
                            runTotal: count,
                            seed: NodeCrypto.randomInt(1_000_000_000),
                            priorRuns: [...priorRuns],
                          });
                          playing = run;
                          return run;
                        },
                        catch: failed,
                      }).pipe(
                        // The backstop behind every per-call bound: a run past it is
                        // our own side hung, never the game.
                        Effect.timeoutOrElse({
                          duration: Duration.millis(PLAY_BOUNDS.bootMs + (seconds + 300) * 1000),
                          orElse: () =>
                            Effect.fail(
                              opError(
                                "Bot run",
                                root,
                                "tool-failed",
                                "The bot run overran its bound.",
                              ),
                            ),
                        }),
                      ),
                    ),
                  ),
                (opened) =>
                  Effect.gen(function* () {
                    yield* Effect.promise(() =>
                      bounded(
                        playing.catch(() => undefined),
                        STOP_WAIT_MS / 2,
                      ),
                    );
                    const stopped = yield* Effect.promise(() => opened.stop());
                    if (stopped.keptStorage !== null)
                      yield* fileServices(writeKeptStorage(stopped.keptStorage));
                    // Evidence beside the trace: the build's facts read it (asset use, performance).
                    const use = stopped.use;
                    if (use !== null)
                      yield* Effect.promise(() =>
                        NodeFSP.writeFile(
                          NodePath.join(runDir, PLAY_USE_FILE),
                          encodePlayUse(use),
                        ).catch(() => undefined),
                      );
                    const perf = stopped.perf;
                    if (perf !== null && perf !== undefined)
                      yield* Effect.promise(() =>
                        NodeFSP.writeFile(
                          NodePath.join(runDir, PLAY_PERF_FILE),
                          `${JSON.stringify(perf)}\n`,
                        ).catch(() => undefined),
                      );
                    // The scene report's frames go beside it, named from the run folder.
                    const scene = stopped.scene;
                    if (scene !== null)
                      yield* Effect.promise(async () => {
                        const kept =
                          scene === "no-shell"
                            ? scene
                            : await keepSceneReport(scene.raw, runDir, "");
                        if (kept !== null)
                          await NodeFSP.writeFile(
                            NodePath.join(runDir, SCENE_FILE),
                            encodeSceneFile(kept),
                          ).catch(() => undefined);
                      });
                  }),
              ).pipe(
                // The game never booted: measured, and a run on the record.
                Effect.catchTags({
                  PlayDidNotBoot: (error) =>
                    Effect.promise(() =>
                      runWithoutPlay(
                        { root, runId, botFile, tracePath, videoPath },
                        { goal: "play the game", state: "not-booted", note: error.detail },
                      ),
                    ),
                  // A stop ends the call with the runs it has.
                  GameOperationError: (error) =>
                    session.stopped && error.reason === "cancelled"
                      ? Effect.succeed(null)
                      : Effect.fail(error),
                }),
              );
              if (one === null) break;
              out.push(one);
              // A bot that never ran is not a bot run, and the same module would
              // fail the same way on every run of the call: nothing is recorded.
              if (one.played === false) break;
              const at = new Date().toISOString();
              // A run that played is recorded even when a stop lands right after it.
              if (owner !== undefined)
                yield* Effect.uninterruptible(
                  recordRun(owner, root, {
                    runId,
                    file: NodePath.relative(root, botFile),
                    mode: "play",
                    won: one.status.state === "done",
                    ending: botEnding(one.status.state),
                    seconds: one.gameSeconds,
                    findings: one.findings.length,
                    at,
                  }),
                );
              // A copy for people reading the game folder; the run decides by the record above.
              yield* Effect.promise(() =>
                appendResult(
                  root,
                  `${JSON.stringify({
                    runId,
                    seconds: one.gameSeconds,
                    won: one.status.state === "done",
                    ending: botEnding(one.status.state),
                    note: one.status.note.slice(0, 160),
                    final: botFinalState(one.finalState),
                    video: videoPath,
                    findings: one.findings.length,
                    file: NodePath.relative(root, botFile),
                    at,
                  })}\n`,
                ),
              );
              // Tell the next run what this one covered: top options by picks,
              // visited 4 m cells, and how it ended. Best effort, never fatal.
              const trace = yield* Effect.promise(() => readTrace(root, runId));
              if (trace !== null) {
                const counts = new Map<string, number>();
                for (const pick of trace.picks ?? []) {
                  const name = String(pick?.name ?? "");
                  if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
                }
                const top = [...counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([name, n]) => `${name} x${n}`)
                  .join(", ");
                const cells = new Set<string>();
                for (const sample of trace.samples ?? []) {
                  const pos = sample?.pos ?? null;
                  if (pos !== null && Number.isFinite(pos[0]) && Number.isFinite(pos[2]))
                    cells.add(cellOf(pos[0], pos[2]).key);
                }
                priorRuns.push({
                  topOptions: top === "" ? "no picks" : top,
                  cells: cells.size,
                  ending: String(trace.status?.state ?? "unknown"),
                });
              }
            }
            return out;
          }),
        // The map entry spans the whole call: one game's runs never overlap,
        // and a stop between runs still releases the game for the next call.
        ({ done }) =>
          Effect.sync(() => {
            const key = sessionKey(root, lane);
            if (sessions.get(key)?.session === session) sessions.delete(key);
          }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      );
      if (each.length === 0)
        return yield* opError("Bot run", root, "cancelled", "The run was stopped.");
      const last = each[each.length - 1]!;
      const runIds = each.map((entry) => entry.runId);
      if (each.length === 1) return { ...last, runIds };
      const ticks = each.reduce((sum, entry) => sum + entry.ticks, 0);
      const decisions = each.reduce((sum, entry) => sum + entry.decisions, 0);
      const findings = each
        .flatMap((entry) => entry.findings)
        .slice(0, GAME_BOT_BOUNDS.maxFindings);
      const states = each.map((entry) => entry.status.state).join("/");
      return {
        ...last,
        // The call played if any of its runs did.
        ...(each.some((entry) => entry.played !== false) ? { played: true } : { played: false }),
        ticks,
        decisions,
        findings,
        runIds,
        message:
          `Bot "${NodePath.relative(root, botFile)}": ${each.length} runs, ending ${states}. ` +
          `${decisions} decisions, ${findings.length} finding(s). ` +
          `Last run video: ${last.videoPath}`,
      };
    });

  const run = (root: string, input: GameBotRunInput, owner?: ThreadId, lane?: string) =>
    botLocks
      .tryWithLock(sessionKey(root, lane), 0, runLocked(root, input, owner, lane))
      .pipe(
        Effect.flatMap((ran) =>
          Option.isSome(ran)
            ? Effect.succeed(ran.value)
            : Effect.fail(
                opError(
                  "Bot run",
                  root,
                  "busy",
                  "A bot run is already in progress for this game: wait for it to end before starting another.",
                ),
              ),
        ),
      );

  const view = (root: string, input: GameBotViewInput) =>
    Effect.gen(function* () {
      // Read from the run's own trace, so a view after a restart still works.
      const trace = yield* Effect.promise(() => readTrace(root, input.runId));
      if (trace === null)
        return yield* opError(
          "Bot view",
          input.runId,
          "invalid-input",
          "No bot run with that id for this game.",
        );
      const kept = trace as RunTrace & Partial<GameBotViewResult>;
      return {
        runId: trace.runId,
        goal: trace.goal,
        status: kept.status ?? { state: "unknown", note: "" },
        ticks: trace.ticks,
        tickHz: kept.tickHz ?? 0,
        timeRatio: kept.timeRatio ?? 0,
        decisions: trace.decisions,
        usedSetState: trace.usedSetState ?? false,
        ...(kept.refusedStates === undefined ? {} : { refusedStates: kept.refusedStates }),
        findings: trace.findings ?? [],
        tracePath: traceFile(root, trace.runId),
        videoPath: kept.videoPath ?? "",
        frames: kept.frames ?? [],
        message: kept.message ?? `Bot run ${trace.runId}: ${kept.status?.state ?? "unknown"}.`,
      } satisfies GameBotViewResult;
    });

  const latestPlayBot: GameBot["Service"]["latestPlayBot"] = (root) =>
    Effect.promise(async () => {
      if (latestPlays.has(root)) return latestPlays.get(root) ?? null;
      const play = await BotEvidence.latestPlay(evidenceDir, root);
      if (latestPlays.size > 500) latestPlays.clear();
      latestPlays.set(root, play);
      return play;
    }).pipe(Effect.map((play) => (play === null ? null : { file: play.file, at: play.at })));

  return GameBot.of({
    // Its video lands in the game folder; the run is recorded on the thread.
    run: (threadId, input) =>
      Effect.flatMap(projects.resolve(threadId), (root) => run(root, input, threadId)),
    runIn: (root, input, options) => run(root, input, undefined, options?.lane),
    latestPlayBot,
    view: (threadId, input) =>
      Effect.flatMap(projects.resolve(threadId), (root) => view(root, input)),
    stop: (root) => stopWhere((each) => each === root),
    stopOwned: (threadId) => stopWhere((_root, owner) => owner === threadId),
  });
});

export const layer = Layer.effect(GameBot, make);
