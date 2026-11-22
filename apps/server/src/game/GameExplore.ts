// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native process, filesystem and loopback boundary of exploration sessions.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
} from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import * as GameTemplates from "./GameTemplates.ts";
import { runtimesFor } from "./gameRuntime.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GameProjectService from "./GameProjectService.ts";
import {
  PlayClosed,
  PlayUnresponsive,
  type PlayActObservation,
  type PlayObservation,
  type PlaySession,
} from "./playSession.ts";
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
    /** Closes the game's session when this thread owns it, as its turn is cancelled. */
    readonly release: (threadId: ThreadId, root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameExplore") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const scheduler = yield* Scheduler.Scheduler;
  const projects = yield* GameProjectService.GameProjectService;
  const gameBrowser = yield* makeGameBrowser;
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
    closed: boolean;
    /** How the game ended an act, when it did: the session's close reason. */
    endedBy: "unresponsive" | "crashed" | "host-lost" | null;
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
  const keepFinishedPlays = (session: ExploreSession) =>
    Effect.gen(function* () {
      const taken = yield* Effect.promise(() => session.play.takePlays?.() ?? Promise.resolve([]));
      for (const raw of taken) {
        const play = decodePlay(raw);
        if (Option.isNone(play)) continue;
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
          message:
            `Exploration ${reason}: ${session.calls} act(s), ` +
            `${session.totalNominalMs}ms nominal. ` +
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
    input: Pick<ExploreSession, "id" | "traceDir" | "play" | "release">,
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
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const { backend, ctx } = yield* engines.context(root);
      const viewport = backend.profile.viewport;
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
      });
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
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
  /**
   * Runs one act through the session and keeps the picture the runner wrote,
   * when it is really there. A held runner kept the game frozen while the
   * caller thought; a browser game kept running, so waits and holds in the
   * steps already advanced it.
   */
  const exploreActOnce = (
    session: ExploreSession,
    input: typeof GameExploreActInput.Type,
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
      const screenshotPath = NodePath.join(session.traceDir, file);
      const reply = yield* Effect.tryPromise({
        try: (signal) => session.play.act([...input.steps], screenshotPath, signal),
        // The game stopping, crashing or refusing the act is the build's; our
        // browser going away is ours.
        catch: (cause) => {
          session.endedBy =
            cause instanceof PlayUnresponsive
              ? "unresponsive"
              : cause instanceof PlayClosed || cause instanceof WebPageCrashed
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
        },
      });
      yield* keepFinishedPlays(session);
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (
        reply.screenshot &&
        (yield* Effect.promise(() =>
          NodeFSP.stat(screenshotPath)
            .then((stat) => stat.isFile() && stat.size > 0)
            .catch(() => false),
        ))
      )
        keptScreenshot = file;
      else
        screenshotReason =
          "The browser returned no picture for this act; state and console messages stay available.";
      const probe =
        reply.probe === null
          ? null
          : {
              gameState: { ...reply.probe.gameState },
              player: reply.probe.player === null ? null : { ...reply.probe.player },
            };
      const observed = observedFields(reply);
      const consoleMessages = [...(reply.consoleMessages ?? [])];
      const consoleTruncated = reply.consoleTruncated ?? 0;
      session.totalNominalMs += nominalMs;
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      const uiResults = observed.uiResults ?? [];
      const received = uiResults.filter((result) => result.received).length;
      return {
        sessionId: session.id,
        callIndex,
        executedInputSteps: reply.executedInputSteps,
        nominalMs,
        probe,
        screenshotPath:
          keptScreenshot === "" ? null : NodePath.join(session.traceDir, keptScreenshot),
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
        ...observed,
        consoleMessages,
        consoleTruncated,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${reply.executedInputSteps} input, +${nominalMs}ms nominal); ` +
          (uiResults.length > 0 ? `${received}/${uiResults.length} ui action(s) received; ` : "") +
          `This observation is descriptive only, never a verdict.`,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? exploreFinalize(session, session.endedBy ?? "act-failed").pipe(
              Effect.ignore({ log: true }),
            )
          : Effect.void,
      ),
    );
  const exploreAct = (threadId: ThreadId, input: typeof GameExploreActInput.Type) =>
    Effect.gen(function* () {
      const session = liveSessions().find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; act without a sessionId to open a new one.",
        );
      const root = yield* projects.resolve(threadId);
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
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
      return yield* session.lock.withPermits(1)(
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
          return yield* exploreActOnce(session, input, session.calls, nominalMs);
        }),
      );
    });
  const exploreClose = (threadId: ThreadId, input: typeof GameExploreCloseInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const session = liveSessions().find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; act without a sessionId to open a new one.",
        );
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
              yield* exploreFinalize(session, reason);
            }
          }
          const result = yield* exploreFinalize(session, "closed");
          if (result !== null) return result;
          return yield* exploreInvalid(
            input.sessionId,
            "That exploration session is closed or expired; act without a sessionId to open a new one.",
          );
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
    start: typeof GameExploreStartInput.Type,
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
      const { sessionId: named, steps, ...start } = input;
      const sessionId = yield* sessionFor(threadId, named, start);
      return yield* exploreAct(threadId, { sessionId, steps });
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
    release: (threadId, root) =>
      Effect.gen(function* () {
        // A cancelled turn also releases the game's exploration session: the
        // browser belongs to the user, not to a turn that is going away.
        const live = exploreLive.get(root);
        if (live !== undefined && live !== "starting" && String(live.threadId) === String(threadId))
          yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
      }),
  });
});

export const layer = Layer.effect(GameExplore, make);
