// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native process, filesystem and loopback boundary of exploration sessions.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  type ThreadId,
  GAME_EXPLORE_BOUNDS,
  exploreCaptureIssues,
  exploreStepIssues,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GAME_EVAL_MAX_BYTES,
  type GameEvalInput,
  type GameEvalResult,
  type GamePlayActInput,
  GameExploreActResult,
  GameExploreCloseResult,
  type GameExploreStep,
  GamePlay,
  type GamePlayScript,
  type GamePlayScriptRun,
  type GamePlayViewport,
  keptRunTag,
} from "@kurambit/contracts";
import { isPathWithinRoot } from "@kurambit/shared/pathContainment";
import * as ServerConfig from "../config.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { runtimesFor } from "./gameRuntime.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProjectService from "./GameProjectService.ts";
import {
  PlayClosed,
  type PlayActObservation,
  type PlayObservation,
  type PlaySession,
} from "./playSession.ts";
import { isSteppedBot, runSteppedBot } from "./gameBotStep.ts";
import { inGame } from "./gamePath.ts";
import { keptSavesFor, keptWebStorage, writeKeptStorage } from "./gameKeptSaves.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import { openPagePlay, type PlayDidNotBoot, type PlayLaunch } from "./playLaunch.ts";
import { WebBrowserGone, WebPageCrashed } from "./webPlaySession.ts";
import { keepPlay } from "./playFiles.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

const decodePlay = Schema.decodeUnknownOption(GamePlay);

/** Free memory an explore session needs to start, in MB, from whole-tree PSS peaks measured on this machine. */
/** Headless Chromium peaked at 480 MB PSS and grows slowly over a session. */
const EXPLORE_WEB_ROOM: MemoryRoom = {
  what: "web exploration session",
  neededMb: 1024,
  env: "KURAMBIT_EXPLORE_WEB_MEMORY_MB",
};
/** Nominal commanded game time. */
const exploreStepNominalMs = (step: GameExploreStep): number => {
  if ("press" in step) return 50;
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  if ("ui" in step) return 100;
  return 0;
};

const exploreStepsNominalMs = (steps: readonly GameExploreStep[]): number => {
  let total = 0;
  // Whole milliseconds, so every sum of them is exact and the input cap and
  // the void rule never disagree in the last bit.
  for (const step of steps) total += Math.round(exploreStepNominalMs(step));
  return total;
};

/** Game time stepped against the wall time it took: what a player's real time would show. */
const clockWords = (clock: { readonly gameMs: number; readonly wallMs: number }) => {
  const game = Math.round(clock.gameMs / 100) / 10;
  const wall = Math.round(clock.wallMs / 100) / 10;
  return clock.wallMs > 0 && clock.gameMs > 0
    ? `${game} s of game time in ${wall} s of wall time (${(clock.gameMs / clock.wallMs).toFixed(2)}× real time)`
    : `${game} s of game time in ${wall} s of wall time`;
};

/** The first change after the act's first input, in numbers, and what changed. */
const responseWords = (response: NonNullable<PlayActObservation["response"]>) =>
  response.gameMs === null || response.wallMs === null
    ? `no change in ${Math.round(response.watchedMs)} ms of game time after the first input`
    : `first change after the first input: ${Math.round(response.gameMs)} ms of game time, ${Math.round(response.wallMs)} ms of wall time (${response.changed.join(", ")})`;

/**
 * Exploration sessions on the current game sources: short act/observe cycles
 * on one runner. A session plays the game's page in headless
 * Chromium, speaking the play-session protocol (playSession.ts) an engine's
 * runner would speak too.
 * Descriptive only: a session never qualifies or passes quality.
 */
export class GameExplore extends Context.Service<
  GameExplore,
  {
    readonly close: (
      threadId: ThreadId,
      input: typeof GameExploreCloseInput.Type,
    ) => Effect.Effect<typeof GameExploreCloseResult.Type, GameOperationError>;
    /** An act in the thread's session, which it opens first when the input names none. */
    readonly play: (
      threadId: ThreadId,
      input: GamePlayActInput,
    ) => Effect.Effect<typeof GameExploreActResult.Type, GameOperationError>;
    /** An agent's JavaScript in the session's page (opened first when none is named). */
    readonly evaluate: (
      threadId: ThreadId,
      input: GameEvalInput,
    ) => Effect.Effect<GameEvalResult, GameOperationError>;
    /**
     * Closes the game's session when this thread owns it, as its turn ends: a session left open
     * keeps a browser drawing until it idles out.
     */
    readonly release: (
      threadId: ThreadId,
      root: string,
      reason: "cancelled" | "turn-ended",
    ) => Effect.Effect<void>;
  }
>()("kurambit/game/GameExplore") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Scheduler;
  const projects = yield* GameProjectService.GameProjectService;
  const gameBrowser = yield* makeGameBrowser;
  // Whether this machine draws in software goes into the turn rules; probed in the background.
  yield* gameBrowser.probeInstalled.pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
  const engines = yield* GameEngine.GameEngine;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
  const templates = yield* GameTemplates.GameTemplates;
  // Each session's pictures. Kept off the temp
  // dir (it may be RAM-backed) and gone with the session; none outlives a
  // restart, so whatever an earlier server left is removed now.
  const scratchBase = NodePath.join(stateDir, "game-explore");
  yield* Effect.promise(() => NodeFSP.rm(scratchBase, { recursive: true, force: true }));
  // Per-thread play records earlier servers kept; nothing reads them now.
  yield* Effect.promise(() =>
    NodeFSP.rm(NodePath.join(stateDir, "explore-evidence"), { recursive: true, force: true }),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  /** Ends what a launch started, then writes back a kept page's storage. */
  const releaseOf = (launched: { readonly stop: PlayLaunch["stop"] }) =>
    Effect.promise(launched.stop).pipe(
      Effect.flatMap(({ keptStorage }) =>
        keptStorage === null ? Effect.void : fileServices(writeKeptStorage(keptStorage)),
      ),
    );
  /** A game that never booted is the build's: the session start says so plainly. */
  const notBooted = (root: string) => (error: PlayDidNotBoot) =>
    Effect.fail(
      new GameOperationError({
        operation: "Explore session",
        path: root,
        reason: "command-failed",
        detail: `The game did not boot: ${error.detail}`.slice(0, 4000),
      }),
    );
  interface ExploreSession {
    readonly id: string;
    readonly root: string;
    readonly threadId: ThreadId;
    /** Each act's picture; removed on close. */
    readonly traceDir: string;
    readonly play: PlaySession;
    /** Ends what the launch started (browser page, served folder), after the session closed. */
    readonly release: Effect.Effect<void>;
    readonly lock: Semaphore.Semaphore;
    lastActiveMs: number;
    readonly wallDeadlineMs: number;
    /** Acts started, the failed one included. */
    calls: number;
    totalNominalMs: number;
    /** Every act's stepping: game time played and the wall time it took. */
    gameMs: number;
    wallMs: number;
    /** The page's size now. */
    viewport: GamePlayViewport;
    closed: boolean;
    /** How the game ended an act, when it did: the session's close reason. */
    endedBy: "crashed" | "host-lost" | null;
  }
  /** The control-tree fields of an observation, copied where the runner sent them. */
  const observedFields = (
    o: PlayObservation & Pick<Partial<PlayActObservation>, "uiResults" | "inspections">,
  ) => ({
    ...(o.screenText === undefined ? {} : { screenText: { ...o.screenText } }),
    ...(o.ui === undefined ? {} : { ui: o.ui.map((c) => ({ ...c, rect: { ...c.rect } })) }),
    ...(o.errors === undefined ? {} : { errors: o.errors.map((e) => ({ ...e })) }),
    ...(o.uiResults === undefined ? {} : { uiResults: o.uiResults.map((u) => ({ ...u })) }),
    ...(o.inspections === undefined
      ? {}
      : { inspections: o.inspections.map((e) => ({ ...e, values: { ...e.values } })) }),
  });
  const exploreInvalid = (path: string, detail: string) =>
    new GameOperationError({ operation: "Explore session", path, reason: "invalid-input", detail });
  /** What this session's runner cannot play, before any input goes out. */
  const exploreSessionStepIssues = (
    session: ExploreSession,
    steps: readonly GameExploreStep[],
  ): readonly string[] => {
    const issues: string[] = [];
    const can = session.play.capabilities;
    for (const [index, step] of steps.entries()) {
      if ("ui" in step) {
        if (!can.has("ui")) {
          issues.push(
            `Step ${index + 1} is a ui step: ui steps list native controls, which a browser game has none of.`,
          );
          continue;
        }
        if (step.ui.id.length === 0 || step.ui.id.length > 200)
          issues.push(`Step ${index + 1} ui id must contain 1–200 characters.`);
        if (step.ui.action !== "click" && step.ui.action !== "drag")
          issues.push(`Step ${index + 1} ui action must be click or drag.`);
        if (step.ui.action === "drag" && (step.ui.to === undefined || step.ui.to.length === 0))
          issues.push(`Step ${index + 1} ui drag needs a to id.`);
      } else if ("inspect" in step) {
        if (!can.has("inspect")) {
          issues.push(
            `Step ${index + 1} is an inspect step: read-only reflection lists native nodes, which a browser game has none of.`,
          );
          continue;
        }
        if (step.inspect.path.length === 0 || step.inspect.path.length > 500)
          issues.push(`Step ${index + 1} inspect path must contain 1–500 characters.`);
        const properties = step.inspect.properties ?? [];
        if (properties.length > GAME_EXPLORE_BOUNDS.maxInspectValues)
          issues.push(
            `Step ${index + 1} inspect lists ${properties.length} properties; at most ${GAME_EXPLORE_BOUNDS.maxInspectValues} may be read.`,
          );
        for (const name of properties)
          if (name.length === 0 || name.length > 64)
            issues.push(`Step ${index + 1} inspect property names must contain 1–64 characters.`);
      }
    }
    return issues;
  };
  // One session per game root; the thread lease owns its input. A root's entry is claimed in the same step that finds it free (a start's
  // placeholder), so two starts on one game never both open a session.
  const exploreLive = new Map<string, ExploreSession | "starting">();
  const liveSessions = () =>
    [...exploreLive.values()].filter((live): live is ExploreSession => live !== "starting");
  const withExploreRoom = <A, E, R>(
    root: string,
    room: MemoryRoom,
    start: Effect.Effect<A, E, R>,
  ) => gate.admit("Explore session", root, room, start);
  /**
   * The runs the agent played to an end in the session, kept as the Stage keeps a person's, so
   * `game_play` op `save` can make one a test. Played on the folder as it was: no build.
   */
  const keepFinishedPlays = (session: ExploreSession, keptAlready?: number) =>
    Effect.gen(function* () {
      const taken = yield* Effect.promise(() => session.play.takePlays?.() ?? Promise.resolve([]));
      for (const raw of taken) {
        const play = decodePlay(raw);
        // A scripted act's run is kept under its own id already.
        if (Option.isNone(play) || play.value.seed === keptAlready) continue;
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.tryPromise(() =>
          keepPlay(session.root, { at, build: null, play: play.value }),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Keeping an exploration's finished run failed.", {
          sessionId: session.id,
          cause,
        }),
      ),
    );
  /**
   * Releases a session's player and scratch. The caller holds the session
   * lock; the transition is uninterruptible once it starts so a cancelled
   * close cannot leave a half-removed profile behind.
   */
  const exploreFinalize = (session: ExploreSession, reason: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (session.closed) return null;
        yield* keepFinishedPlays(session);
        session.closed = true;
        yield* Effect.promise(() => session.play.close()).pipe(
          Effect.andThen(session.release),
          Effect.catchCause((cause) =>
            Effect.logWarning("Closing an exploration session failed.", {
              sessionId: session.id,
              cause,
            }),
          ),
        );
        if (exploreLive.get(session.root) === session) exploreLive.delete(session.root);
        yield* Effect.promise(() =>
          NodeFSP.rm(session.traceDir, { recursive: true, force: true }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Removing exploration scratch failed.", {
              sessionId: session.id,
              cause,
            }),
          ),
        );
        const result = {
          sessionId: session.id,
          reason,
          actions: session.calls,
          totalNominalMs: session.totalNominalMs,
          clock: { gameMs: Math.round(session.gameMs), wallMs: session.wallMs },
          message:
            `Exploration ${reason}: ${session.calls} act(s), ` +
            `${session.totalNominalMs}ms nominal; ${clockWords(session)}. ` +
            `This session never qualified the build.`,
        } satisfies typeof GameExploreCloseResult.Type;
        return result;
      }),
    );
  // Every session at once, and none it would wait on: a session mid-act is
  // active by definition, its act is bounded, and the next sweep sees it.
  const exploreReap = Effect.suspend(() =>
    Effect.forEach(
      liveSessions().filter((live) => !live.closed),
      (live) =>
        live.lock.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (live.closed || exploreLive.get(live.root) !== live) return;
            const now = yield* Clock.currentTimeMillis;
            if (
              now < live.wallDeadlineMs &&
              now < live.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs
            )
              return;
            const reason = now >= live.wallDeadlineMs ? "wall-expired" : "idle-expired";
            yield* exploreFinalize(live, reason).pipe(Effect.ignore);
          }),
        ),
      { concurrency: "unbounded", discard: true },
    ),
  );
  /** Idle and wall-clock expiry sweep. One scoped fiber owns it; sessions never sleep in a caller. */
  const exploreLease = (session: ExploreSession, root: string, threadId: ThreadId) => {
    if (session.root !== root)
      return exploreInvalid(session.id, "That exploration session belongs to another game.");
    if (String(session.threadId) !== String(threadId))
      return exploreInvalid(
        session.id,
        "That exploration session belongs to another thread; only its own thread may act on it or close it.",
      );
    return null;
  };
  /** Registers an opened session. */
  const exploreRegister = (
    threadId: ThreadId,
    root: string,
    input: Pick<ExploreSession, "id" | "traceDir" | "play" | "release" | "viewport">,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const live: ExploreSession = {
        ...input,
        root,
        threadId,
        lock: Semaphore.makeUnsafe(1),
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalNominalMs: 0,
        gameMs: 0,
        wallMs: 0,
        closed: false,
        endedBy: null,
      };
      exploreLive.set(root, live);
      return live;
    });
  /**
   * Opens a session on the current sources of a browser game: the static
   * folder served over loopback, played in headless Chromium.
   */
  const exploreStartWeb = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type & { readonly viewport?: GamePlayViewport | undefined },
  ) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const { backend, ctx } = yield* engines.context(root);
      const viewport = input.viewport ?? backend.profile.viewport;
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const browser = yield* gameBrowser("Explore session", root);
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Explore session",
      });
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(scratchBase, id);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(traceDir, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const launched = yield* openPagePlay({
        operation: "Explore session",
        root,
        projectDir: ctx.projectDir,
        browser,
        viewport,
        bootTimeoutMs,
        keptStorage: keptWebStorage(saves),
        runtimes: yield* runtimesFor(templates, manifest),
      }).pipe(Effect.catchTags({ PlayDidNotBoot: notBooted(root) }));
      return yield* exploreRegister(threadId, root, {
        id,
        traceDir,
        play: launched.play,
        release: releaseOf(launched),
        viewport: { width: viewport.width, height: viewport.height },
      });
    });
  const exploreStart = (
    threadId: ThreadId,
    input: typeof GameExploreStartInput.Type & { readonly viewport?: GamePlayViewport | undefined },
  ) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      // Claimed in the step that finds the game free: a second start on it is
      // refused at once, never after both opened a runner.
      const existing = exploreLive.get(root);
      if (existing !== undefined)
        return yield* exploreInvalid(
          existing === "starting" ? root : existing.id,
          "Another exploration session is open for this game; its owning thread must close it before this game can start another.",
        );
      exploreLive.set(root, "starting");
      const unclaim = Effect.sync(() => {
        if (exploreLive.get(root) === "starting") exploreLive.delete(root);
      });
      return yield* withExploreRoom(
        root,
        EXPLORE_WEB_ROOM,
        exploreStartWeb(threadId, root, input),
      ).pipe(Effect.onExit(() => unclaim));
    });
  /** An act's failure by whose side: the game ending under it is the build's, our browser going away ours. */
  const actFailed = (session: ExploreSession) => (cause: unknown) => {
    session.endedBy =
      cause instanceof PlayClosed || cause instanceof WebPageCrashed
        ? "crashed"
        : cause instanceof WebBrowserGone
          ? "host-lost"
          : null;
    return new GameOperationError({
      operation: "Explore session",
      path: session.id,
      reason: cause instanceof WebBrowserGone ? "tool-failed" : "command-failed",
      detail:
        cause instanceof Error && cause.message !== "aborted"
          ? cause.message.slice(0, 500)
          : "The act failed.",
      cause,
    });
  };
  /** An observation's picture, when the runner really wrote it. */
  const keptPicture = (path: string, written: boolean) =>
    written
      ? Effect.promise(() =>
          NodeFSP.stat(path)
            .then((stat) => stat.isFile() && stat.size > 0)
            .catch(() => false),
        )
      : Effect.succeed(false);
  /** The parts of an act's answer every act shares: the probe, its picture, console and numbers. */
  const actAnswer = (session: ExploreSession, reply: PlayActObservation, screenshotPath: string) =>
    Effect.gen(function* () {
      const pictured = yield* keptPicture(screenshotPath, reply.screenshot);
      const probe =
        reply.probe === null
          ? null
          : {
              gameState: { ...reply.probe.gameState },
              player: reply.probe.player === null ? null : { ...reply.probe.player },
              // The HUD's words: what a player reads, without a picture to read it from.
              ...(reply.probe.hudText === undefined ? {} : { hudText: reply.probe.hudText }),
            };
      if (reply.clock !== undefined) {
        session.gameMs += reply.clock.gameMs;
        session.wallMs += reply.clock.wallMs;
      }
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      return {
        sessionId: session.id,
        probe,
        screenshotPath: pictured ? screenshotPath : null,
        ...(pictured
          ? {}
          : {
              screenshotReason:
                "The browser returned no picture for this act; state and console messages stay available.",
            }),
        ...(reply.frames === undefined || reply.frames.length === 0
          ? {}
          : { frames: reply.frames.map((frame) => ({ ...frame })) }),
        ...observedFields(reply),
        consoleMessages: [...(reply.consoleMessages ?? [])],
        consoleTruncated: reply.consoleTruncated ?? 0,
        viewport: { ...session.viewport },
        ...(reply.clock === undefined ? {} : { clock: { ...reply.clock } }),
        ...(reply.response === undefined
          ? {}
          : { response: { ...reply.response, changed: [...reply.response.changed] } }),
      };
    });
  /**
   * Runs one act through the session and keeps the picture the runner wrote,
   * when it is really there. The game stands still between acts; its waits
   * and holds advanced it by their game time. A page too slow for the act
   * answers with how far it got, and the session stays open for the next.
   */
  const exploreActOnce = (
    session: ExploreSession,
    steps: readonly GameExploreStep[],
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const screenshotPath = NodePath.join(
        session.traceDir,
        `act-${String(callIndex).padStart(2, "0")}-observe.png`,
      );
      const reply = yield* Effect.tryPromise({
        try: (signal) =>
          session.play.act([...steps], screenshotPath, signal, (n) =>
            NodePath.join(
              session.traceDir,
              `act-${String(callIndex).padStart(2, "0")}-frame-${String(n)}.png`,
            ),
          ),
        catch: actFailed(session),
      });
      yield* keepFinishedPlays(session);
      const answer = yield* actAnswer(session, reply, screenshotPath);
      session.totalNominalMs += nominalMs;
      const uiResults = answer.uiResults ?? [];
      const received = uiResults.filter((result) => result.received).length;
      return {
        ...answer,
        callIndex,
        executedInputSteps: reply.executedInputSteps,
        nominalMs,
        message:
          `Act ${callIndex} ran ${steps.length} step(s) ` +
          `(${reply.executedInputSteps} input, +${nominalMs}ms nominal); ` +
          (uiResults.length > 0 ? `${received}/${uiResults.length} ui action(s) received; ` : "") +
          (reply.clock === undefined ? "" : `${clockWords(reply.clock)}; `) +
          (reply.response === undefined ? "" : `${responseWords(reply.response)}; `) +
          (reply.short === undefined ? "" : `${reply.short} The session stays open. `) +
          `This observation is descriptive only, never a verdict.`,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(Effect.onExit((exit) => finalizeFailed(session, exit)));
  /** A failed act ends the session: the game ended under it, or our browser went away. */
  const finalizeFailed = (session: ExploreSession, exit: Exit.Exit<unknown, unknown>) =>
    exit._tag === "Failure" && !session.closed
      ? exploreFinalize(session, session.endedBy ?? "act-failed").pipe(Effect.ignore({ log: true }))
      : Effect.void;
  /** A scripted act's module source: a .mjs under the game's .studio/bot/, or inline. */
  const scriptSource = (session: ExploreSession, script: GamePlayScript) =>
    Effect.gen(function* () {
      if (script.file !== undefined) {
        const botDir = NodePath.resolve(session.root, ".studio/bot");
        const botFile = NodePath.resolve(session.root, script.file);
        if (!isPathWithinRoot(botFile, botDir) || botFile === botDir || !botFile.endsWith(".mjs"))
          return yield* exploreInvalid(
            script.file,
            "decide.file must be a .mjs under .studio/bot/.",
          );
        // The page runs the file: one that leads out of the game through a link is refused.
        yield* inGame(session.root, NodePath.relative(session.root, botFile));
        const source = yield* Effect.promise(() =>
          NodeFSP.readFile(botFile, "utf8").catch(() => null),
        );
        if (source === null) return yield* exploreInvalid(script.file, "No file there.");
        return { file: botFile, source };
      }
      if (script.source !== undefined)
        return {
          file: NodePath.join(session.root, ".studio/bot/inline.mjs"),
          source: script.source,
        };
      return yield* exploreInvalid(session.id, "decide needs a file or its source.");
    });
  /**
   * A scripted act: the page's stepped runner (shell studio.bot, the masher's) plays a fresh run,
   * calling the script's decide(obs) each fixed step and holding the player's own controls it
   * names, until the game's win or lose, the script returning false, or its game seconds. The run
   * is kept as a play the person can replay; the script never touches the game's state.
   */
  const exploreScript = (session: ExploreSession, script: GamePlayScript, callIndex: number) =>
    Effect.gen(function* () {
      const { file, source } = yield* scriptSource(session, script);
      if (!isSteppedBot(source))
        return yield* exploreInvalid(
          session.id,
          "The script must export decide(obs), returning the actions to hold this step (false to stop).",
        );
      const seconds = Math.min(
        GAME_EXPLORE_BOUNDS.maxScriptSeconds,
        Math.max(1, script.seconds ?? GAME_EXPLORE_BOUNDS.defaultScriptSeconds),
      );
      // A script refused above leaves the session as it was; one that ran and failed ends it.
      return yield* scriptRun(session, file, source, seconds, callIndex);
    });
  const scriptRun = (
    session: ExploreSession,
    file: string,
    source: string,
    seconds: number,
    callIndex: number,
  ) =>
    Effect.gen(function* () {
      const runId = NodeCrypto.randomUUID();
      const tag = `act-${String(callIndex).padStart(2, "0")}`;
      const runDir = NodePath.join(session.traceDir, `${tag}-script`);
      const screenshotPath = NodePath.join(session.traceDir, `${tag}-observe.png`);
      const ran = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(runDir, { recursive: true });
          return runSteppedBot(
            { play: session.play },
            {
              root: session.root,
              runId,
              runDir,
              tracePath: NodePath.join(runDir, "trace.json"),
              botFile: file,
              source,
              seconds,
              endFrame: false,
            },
          );
        },
        catch: actFailed(session),
      });
      yield* keepFinishedPlays(session, ran.play?.seed);
      // Where the run stands now, as any act ends: its probe and its picture.
      const reply = yield* Effect.tryPromise({
        try: (signal) => session.play.act([], screenshotPath, signal),
        catch: actFailed(session),
      });
      const answer = yield* actAnswer(session, reply, screenshotPath);
      const { result } = ran;
      const ended: GamePlayScriptRun["ended"] =
        ran.outcome !== null
          ? ran.outcome.won
            ? "won"
            : "lost"
          : ran.stopped
            ? "stopped"
            : result.status.state === "done"
              ? "seconds"
              : result.status.state === "bot-error"
                ? "error"
                : "wall";
      const marks = ran.play?.marks ?? [];
      const every = Math.max(1, Math.ceil(marks.length / GAME_EXPLORE_BOUNDS.maxTrailMarks));
      const trail = marks
        .filter((_, index) => index % every === 0 || index === marks.length - 1)
        .map((mark) => ({
          t: mark.t,
          at: mark.at,
          values: Object.fromEntries(Object.entries(mark.values).slice(0, 8)),
        }));
      const run = ran.kept === null ? null : keptRunTag(ran.kept);
      const gameMs = result.gameSeconds * 1000;
      session.gameMs += gameMs;
      session.wallMs += ran.wallMs;
      session.totalNominalMs += gameMs;
      const findings = result.findings.map((finding) => finding.summary).join("; ");
      return {
        ...answer,
        callIndex,
        executedInputSteps: result.decisions,
        nominalMs: gameMs,
        clock: { gameMs, wallMs: ran.wallMs },
        script: {
          ended,
          note: result.status.note ?? "",
          seconds: result.gameSeconds,
          wallMs: ran.wallMs,
          decisions: result.decisions,
          run,
          trail,
        },
        message:
          `A script drove the player's controls on a fresh run: ${result.status.note ?? ended}; ` +
          `${clockWords({ gameMs, wallMs: ran.wallMs })}, ${result.decisions} decisions.` +
          (findings === "" ? "" : ` ${findings}.`) +
          (run === null
            ? ""
            : ` Its run is ${run}: replay {"run": "${run}", "at": <s>} shows a moment; {"save": "<name>", "run": "${run}"} makes it a test play the person can watch on the Stage.`),
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(Effect.onExit((exit) => finalizeFailed(session, exit)));
  /** The session the act names, leased to this thread and still open, or why not. */
  const leasedSession = (threadId: ThreadId, sessionId: string) =>
    Effect.gen(function* () {
      const session = liveSessions().find((live) => live.id === sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          sessionId,
          "That exploration session is unknown or expired; act without a sessionId to open a new one.",
        );
      const root = yield* projects.resolve(threadId);
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      return session;
    });
  /** Runs `work` under the session's lock, after its deadlines, as one more act. */
  const actLocked = <A>(
    session: ExploreSession,
    work: (callIndex: number) => Effect.Effect<A, GameOperationError>,
  ) =>
    session.lock.withPermits(1)(
      Effect.gen(function* () {
        if (session.closed || exploreLive.get(session.root) !== session)
          return yield* exploreInvalid(
            session.id,
            "That exploration session is closed or expired; act without a sessionId to open a new one.",
          );
        const now = yield* Clock.currentTimeMillis;
        if (
          now >= session.wallDeadlineMs ||
          now >= session.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs
        ) {
          const reason = now >= session.wallDeadlineMs ? "wall-expired" : "idle-expired";
          yield* exploreFinalize(session, reason);
          return yield* exploreInvalid(
            session.id,
            `That exploration session ${reason}. Act without a sessionId to open a new one.`,
          );
        }
        session.calls += 1;
        return yield* work(session.calls);
      }),
    );
  /** The page at the act's size, as a player resizes their window; the next acts keep it. */
  const resized = (session: ExploreSession, viewport: GamePlayViewport | undefined) =>
    Effect.gen(function* () {
      if (
        viewport === undefined ||
        (viewport.width === session.viewport.width && viewport.height === session.viewport.height)
      )
        return;
      const resize = session.play.resize;
      if (resize === undefined)
        return yield* exploreInvalid(session.id, "This game's runner cannot change its size.");
      yield* Effect.promise(() => resize(viewport.width, viewport.height));
      session.viewport = { width: viewport.width, height: viewport.height };
    });
  const exploreAct = (
    threadId: ThreadId,
    input: typeof GameExploreActInput.Type & { readonly viewport?: GamePlayViewport | undefined },
  ) =>
    Effect.gen(function* () {
      const session = yield* leasedSession(threadId, input.sessionId);
      // Direct service callers bypass the tool schema, so the per-call shape
      // is enforced here too, before any browser work.
      if (input.steps.length === 0 || input.steps.length > GAME_EXPLORE_BOUNDS.maxStepsPerCall)
        return yield* exploreInvalid(
          session.id,
          `Use 1–${GAME_EXPLORE_BOUNDS.maxStepsPerCall} steps per act; this act has ${input.steps.length}.`,
        );
      const nominalMs = exploreStepsNominalMs(input.steps);
      if (!Number.isFinite(nominalMs) || nominalMs < 0)
        return yield* exploreInvalid(session.id, "The act has an invalid duration.");
      if (nominalMs > GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall)
        return yield* exploreInvalid(
          session.id,
          `The act lasts ${nominalMs}ms; one act may last at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall}ms.`,
        );
      const stepIssues = exploreStepIssues(input.steps);
      if (stepIssues.length > 0) return yield* exploreInvalid(session.id, stepIssues.join("\n"));
      const sessionIssues = exploreSessionStepIssues(session, input.steps);
      if (sessionIssues.length > 0)
        return yield* exploreInvalid(session.id, sessionIssues.join("\n"));
      return yield* actLocked(session, (callIndex) =>
        resized(session, input.viewport).pipe(
          Effect.andThen(exploreActOnce(session, input.steps, callIndex, nominalMs)),
        ),
      );
    });
  const exploreClose = (threadId: ThreadId, input: typeof GameExploreCloseInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const session = liveSessions().find((live) => live.id === input.sessionId);
      // Closing what already ended (idle, its turn, a failed act) leaves what the agent wanted.
      const gone = {
        sessionId: input.sessionId,
        reason: "already-closed",
        actions: 0,
        totalNominalMs: 0,
        message: "That session had already ended; nothing was open to close.",
      } satisfies typeof GameExploreCloseResult.Type;
      if (session === undefined) return gone;
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      return yield* session.lock.withPermits(1)(
        Effect.gen(function* () {
          // A close that arrives after the deadlines reports the expiry the
          // reaper would have saved, instead of claiming a clean close.
          if (!session.closed) {
            const now = yield* Clock.currentTimeMillis;
            if (
              now >= session.wallDeadlineMs ||
              now >= session.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs
            ) {
              const reason = now >= session.wallDeadlineMs ? "wall-expired" : "idle-expired";
              return (yield* exploreFinalize(session, reason)) ?? gone;
            }
          }
          return (yield* exploreFinalize(session, "closed")) ?? gone;
        }),
      );
    });
  // Idle and wall-clock expiry without a caller; every act/close also
  // checks the same deadlines lazily.
  yield* scheduler.register("game-explore-expiry", yield* Scheduler.every(30_000, exploreReap));
  /** The thread's open session on its game, else a new one opened with `start`'s options. */
  const sessionFor = (
    threadId: ThreadId,
    named: string | undefined,
    start: typeof GameExploreStartInput.Type & { readonly viewport?: GamePlayViewport | undefined },
  ) =>
    Effect.gen(function* () {
      if (named !== undefined) return named;
      const root = yield* projects.resolve(threadId);
      const live = exploreLive.get(root);
      if (
        live !== undefined &&
        live !== "starting" &&
        !live.closed &&
        String(live.threadId) === String(threadId)
      )
        return live.id;
      return (yield* exploreStart(threadId, start)).id;
    });
  const explorePlay = (threadId: ThreadId, input: GamePlayActInput) =>
    Effect.gen(function* () {
      const { sessionId: named, steps, decide, viewport, includeImage: _image, ...start } = input;
      const script = steps === undefined ? decide : undefined;
      if ((steps === undefined) === (decide === undefined))
        return yield* exploreInvalid(
          named ?? "",
          "An act takes either steps or decide: one of the two.",
        );
      const sessionId = yield* sessionFor(threadId, named, { ...start, viewport });
      if (steps !== undefined) return yield* exploreAct(threadId, { sessionId, steps, viewport });
      if (script === undefined) return yield* exploreInvalid(sessionId, "The act has no decide.");
      const session = yield* leasedSession(threadId, sessionId);
      return yield* actLocked(session, (callIndex) =>
        resized(session, viewport).pipe(Effect.andThen(exploreScript(session, script, callIndex))),
      );
    });
  const exploreEvaluate = (threadId: ThreadId, input: GameEvalInput) =>
    Effect.gen(function* () {
      const sessionId = yield* sessionFor(threadId, input.sessionId, {});
      const root = yield* projects.resolve(threadId);
      const session = liveSessions().find((live) => live.id === sessionId);
      if (session === undefined || session.closed)
        return yield* exploreInvalid(
          sessionId,
          "That exploration session is closed or expired; eval without a sessionId to open a new one.",
        );
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      const run = session.play.evaluate;
      if (run === undefined)
        return yield* exploreInvalid(sessionId, "This game's runner has no page to evaluate in.");
      const answered = yield* session.lock.withPermits(1)(
        Effect.promise(() => run(input.expression)),
      );
      if ("error" in answered)
        return yield* exploreInvalid(sessionId, `The expression threw: ${answered.error}`);
      const size = Buffer.byteLength(encodeJson(answered.value ?? null), "utf8");
      if (size > GAME_EVAL_MAX_BYTES)
        return yield* exploreInvalid(
          sessionId,
          `The value is ${size} bytes; the most is ${GAME_EVAL_MAX_BYTES}. Return less of it.`,
        );
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      return { sessionId, value: answered.value };
    });
  return GameExplore.of({
    close: exploreClose,
    play: explorePlay,
    evaluate: exploreEvaluate,
    release: (threadId, root, reason) =>
      Effect.gen(function* () {
        // A turn that ended releases the game's exploration session: the browser belongs to the
        // user, not to a turn that is gone, and an idle session would draw until it expired.
        const live = exploreLive.get(root);
        if (live !== undefined && live !== "starting" && String(live.threadId) === String(threadId))
          yield* live.lock.withPermits(1)(exploreFinalize(live, reason)).pipe(Effect.ignore);
      }),
  });
});

export const layer = Layer.effect(GameExplore, make);
