// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native process, filesystem and loopback boundary of exploration sessions.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  type ThreadId,
  GAME_EXPLORE_BOUNDS,
  EXPLORE_CAPTURE_BOUNDS,
  exploreCaptureIssues,
  exploreStepIssues,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  type GameExploreStep,
  type GameExploreInspection,
  type GameExploreUiControl,
  type GameExploreUiResult,
  type GameConsoleMessage,
  type GamePlaytestProbe,
  type GameViewport,
} from "@kurambit/contracts";
import * as ServerConfig from "../config.ts";
import { engineProfile } from "./engineProfile.ts";
import * as ExploreEvidence from "./exploreEvidence.ts";
import * as ExploreSheet from "./exploreSheet.ts";
import * as GameAssetLibrary from "./GameAssetLibrary.ts";
import * as GameEngine from "./GameEngine.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { insideGame } from "./GameProjectService.ts";
import { ProcessHost } from "./processHost.ts";
import { findWindowHost } from "./windowHost.ts";
import {
  listenForRunner,
  type PlayActObservation,
  type PlayObservation,
  type PlaySession,
} from "./playSession.ts";
import { openWebPlaySession } from "./webPlaySession.ts";
import { keptSavesFor, keptWebStorage } from "./gameKeptSaves.ts";
import { requireChromium } from "./gameChromium.ts";
import { serveGameDirectory } from "./gameWebServer.ts";
import { snapshotBuildSource } from "./sourceSnapshot.ts";

/**
 * Free memory an explore session needs to start, in MB, from
 * whole-tree PSS peaks measured on this machine with small 2D games. A
 * native session peaked at 740 MB during its cold Godot import (about
 * 300 MB while playing); headroom covers bigger games' imports.
 */
const EXPLORE_NATIVE_ROOM: MemoryRoom = {
  what: "native exploration session",
  neededMb: 1280,
  env: "KURAMBIT_EXPLORE_NATIVE_MEMORY_MB",
};
/** Headless Chromium peaked at 480 MB PSS and grows slowly over a session. */
const EXPLORE_WEB_ROOM: MemoryRoom = {
  what: "web exploration session",
  neededMb: 1024,
  env: "KURAMBIT_EXPLORE_WEB_MEMORY_MB",
};
/**
 * A built Linux player under software GL and its private display: a small
 * 3D Unity game's player held 290 MB PSS; headroom covers bigger games. Its
 * build, when the session needs one, is the live editor's own memory guard.
 */
const EXPLORE_PLAYER_ROOM: MemoryRoom = {
  what: "Unity exploration session",
  neededMb: 1024,
  env: "KURAMBIT_EXPLORE_UNITY_MEMORY_MB",
};

const isGameOperationError = Schema.is(GameOperationError);

/** Nominal commanded game time; a process runner's tap spans its physics-frame hold. */
const exploreStepNominalMs = (step: GameExploreStep, target: "native" | "web"): number => {
  if ("press" in step) return target === "native" ? 170 : 50;
  if ("waitMs" in step) return step.waitMs;
  if ("holdMs" in step) return step.holdMs;
  if ("ui" in step) return 100;
  return 0;
};

const exploreStepsNominalMs = (
  steps: readonly GameExploreStep[],
  target: "native" | "web",
): number => {
  let total = 0;
  // Whole milliseconds, so every sum of them is exact and the input cap and
  // the void rule never disagree in the last bit.
  for (const step of steps) total += Math.round(exploreStepNominalMs(step, target));
  return total;
};

/**
 * Bounded, persistent exploration sessions on the current game sources:
 * short act/observe cycles on one runner, with the frames and input each
 * thread spent kept as evidence. How a session plays is the engine's: a page
 * in headless Chromium, the engine's own native runner, or a built player.
 * Descriptive only: a session never qualifies or passes quality.
 */
export class GameExplore extends Context.Service<
  GameExplore,
  {
    readonly start: (
      threadId: ThreadId,
      input: typeof GameExploreStartInput.Type,
    ) => Effect.Effect<typeof GameExploreStartResult.Type, GameOperationError>;
    readonly act: (
      threadId: ThreadId,
      input: typeof GameExploreActInput.Type,
    ) => Effect.Effect<typeof GameExploreActResult.Type, GameOperationError>;
    readonly close: (
      threadId: ThreadId,
      input: typeof GameExploreCloseInput.Type,
    ) => Effect.Effect<typeof GameExploreCloseResult.Type, GameOperationError>;
    /** Closes the thread's open session and returns what its sessions played in all. */
    readonly finish: (threadId: ThreadId) => Effect.Effect<
      {
        sessions: number;
        actions: number;
        executedInputSteps: number;
        nominalMs: number;
        images: number;
      },
      GameOperationError
    >;
    /** Caps the explore input this thread may use across all its sessions. */
    readonly limitInput: (threadId: ThreadId, totalMs: number) => Effect.Effect<void>;
    readonly memoryWait: (threadId: ThreadId) => Effect.Effect<
      {
        readonly waitedMs: number;
        readonly refusals: number;
        readonly refused: boolean;
        readonly executedInputSteps: number;
      },
      GameOperationError
    >;
    /** Tiles an even selection of the thread's kept frames into one JPEG at `output`. */
    readonly sheet: (
      threadId: ThreadId,
      output: string,
    ) => Effect.Effect<number, GameOperationError>;
    /** Closes the game's session when this thread owns it, as its turn is cancelled. */
    readonly release: (threadId: ThreadId, root: string) => Effect.Effect<void>;
  }
>()("kurambit/game/GameExplore") {}

const make = Effect.gen(function* () {
  const processHost = yield* ProcessHost;
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const engines = yield* GameEngine.GameEngine;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const players = yield* GamePlayer.GamePlayer;
  const evidenceDir = NodePath.join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "explore-evidence",
  );
  const startedMs = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, startedMs)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Pruning explore evidence failed.", { cause })),
  );
  const snapshot = (root: string, project: string) =>
    Effect.promise((signal) => snapshotBuildSource(root, project, { signal }));
  interface ExploreSession {
    readonly id: string;
    readonly root: string;
    readonly threadId: ThreadId;
    readonly buildId: string;
    readonly sourceId: string | null;
    readonly viewport: GameViewport;
    /** Honest boot timing, frozen with the session. */
    readonly bootMs: number | null;
    readonly traceDir: string;
    readonly play: PlaySession;
    /** Browser sessions run in real time and press for 50 ms; process runners hold the game and tap for 170 ms. */
    readonly target: "native" | "web";
    /** Whether acts can keep a picture: false for a headless runner. */
    readonly pictures: boolean;
    /** Ends what the launch started (process tree, served folder), after the session closed. */
    readonly release: Effect.Effect<void>;
    /** Removed on close; pictures in the trace dir stay as evidence. */
    readonly scratch: ReadonlyArray<string>;
    readonly lock: Semaphore.Semaphore;
    lastActiveMs: number;
    readonly wallDeadlineMs: number;
    calls: number;
    totalSteps: number;
    totalNominalMs: number;
    images: number;
    readonly actions: ExploreActAction[];
    closed: boolean;
    closeReason: string | null;
    closedAt: string | null;
  }
  interface ExploreActAction {
    readonly index: number;
    readonly steps: readonly GameExploreStep[];
    readonly executedInputSteps: number;
    readonly nominalMs: number;
    readonly probe: GamePlaytestProbe | null;
    readonly screenshot: string;
    readonly consoleMessages: readonly GameConsoleMessage[];
    readonly consoleTruncated: number;
    readonly failure?: string;
    readonly execution?: "unknown";
    readonly screenText?: Record<string, string>;
    readonly ui?: ReadonlyArray<GameExploreUiControl>;
    readonly errors?: ReadonlyArray<{ readonly message: string; readonly where: string }>;
    readonly uiResults?: ReadonlyArray<GameExploreUiResult>;
    readonly inspections?: ReadonlyArray<GameExploreInspection>;
    readonly screenshotReason?: string;
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
  const exploreScratchBase = () => NodePath.join(NodeOS.tmpdir(), "game-explore");
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
  // Worktree judges own different roots; a session in one game must not
  // consume another game's play budget. The thread lease still owns input.
  const exploreStartLock = Semaphore.makeUnsafe(1);
  const exploreLive = new Map<string, ExploreSession>();
  // A start's memory waits land in the thread's evidence record, on disk, so
  // the run's cap gives the time back even across a restart.
  const withExploreRoom = <A, E, R>(
    threadId: ThreadId,
    root: string,
    room: MemoryRoom,
    start: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const waited = { ms: 0, refused: null as boolean | null };
      return gate
        .admit("Explore session", root, room, start, (waitedMs, refused) => {
          waited.ms += waitedMs;
          waited.refused = refused;
        })
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              waited.refused === null && waited.ms === 0
                ? Effect.void
                : recordMemory(threadId, root, waited.ms, waited.refused),
            ),
          ),
        );
    });
  // A write-through cache of the records under `evidenceDir`; a restart
  // reloads them, so a sample's earlier play still counts.
  const exploreEvidence = new Map<string, ExploreEvidence.ThreadEvidence>();
  const evidenceLock = Semaphore.makeUnsafe(1);
  const rememberEvidence = (record: ExploreEvidence.ThreadEvidence) => {
    exploreEvidence.delete(record.threadId);
    exploreEvidence.set(record.threadId, record);
    if (exploreEvidence.size > 128) {
      const oldest = exploreEvidence.keys().next().value;
      if (oldest !== undefined) exploreEvidence.delete(oldest);
    }
  };
  const writeEvidence = (record: ExploreEvidence.ThreadEvidence) =>
    Effect.tryPromise(() => ExploreEvidence.write(evidenceDir, record)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Persisting explore evidence failed.", {
          threadId: record.threadId,
          cause,
        }),
      ),
    );
  /** Adds a start's memory wait (and whether it was refused) to the thread's record. */
  const recordMemory = (
    threadId: ThreadId,
    root: string,
    waitedMs: number,
    refused: boolean | null,
  ) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* loadEvidence(String(threadId), root);
        const prior = record.memory ?? { waitedMs: 0, refusals: 0, refused: false };
        const next: ExploreEvidence.ThreadEvidence = {
          ...record,
          memory: {
            waitedMs: prior.waitedMs + waitedMs,
            refusals: prior.refusals + (refused === true ? 1 : 0),
            refused: refused ?? prior.refused,
          },
        };
        rememberEvidence(next);
        yield* writeEvidence(next);
      }),
    );
  /** The caller holds `evidenceLock`. */
  const loadEvidence = (threadId: string, root: string) =>
    Effect.gen(function* () {
      const cached = exploreEvidence.get(threadId);
      if (cached !== undefined) return cached;
      const disk = yield* Effect.promise(() => ExploreEvidence.read(evidenceDir, threadId));
      if (disk === null) return ExploreEvidence.empty(threadId, root);
      const record = ExploreEvidence.closeOrphans(
        disk,
        new Set([...exploreLive.values()].map((live) => live.id)),
      );
      rememberEvidence(record);
      if (record.sessions.some((s, i) => s !== disk.sessions[i])) yield* writeEvidence(record);
      return record;
    });
  const threadEvidence = (threadId: ThreadId, root: string) =>
    evidenceLock.withPermits(1)(loadEvidence(String(threadId), root));
  /** Records the session's play so far; called after its start, every act and its close. */
  const persistSession = (session: ExploreSession) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const owner = String(session.threadId);
        const record = yield* loadEvidence(owner, session.root);
        const frames = [...(record.sessions.find((s) => s.id === session.id)?.frames ?? [])];
        for (const action of session.actions)
          if (action.screenshot !== "" && !frames.some((frame) => frame.step === action.index))
            frames.push({
              step: action.index,
              // Only a capped thread (a blind sample) draws a sheet, so only its
              // frames are kept past a reboot; others record the scratch path.
              path:
                record.inputCapMs !== undefined
                  ? yield* Effect.promise(() =>
                      ExploreEvidence.keepFrame(
                        evidenceDir,
                        owner,
                        session.id,
                        NodePath.join(session.traceDir, action.screenshot),
                      ),
                    )
                  : NodePath.join(session.traceDir, action.screenshot),
            });
        const next = ExploreEvidence.upsert(record, {
          id: session.id,
          actions: session.actions.length,
          executedInputSteps: session.actions.reduce(
            (sum, action) => sum + action.executedInputSteps,
            0,
          ),
          nominalMs: session.totalNominalMs,
          images: session.images,
          frames,
          closed: session.closed,
          closeReason: session.closeReason,
        });
        rememberEvidence(next);
        yield* writeEvidence(next);
      }),
    );
  const exploreBudget =
    `This session holds ${GAME_EXPLORE_BOUNDS.maxCalls} acts and ` +
    `${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s of input, about ` +
    `${(GAME_EXPLORE_BOUNDS.maxTotalNominalMs / GAME_EXPLORE_BOUNDS.maxCalls / 1000).toFixed(1)} s per act.`;
  // Weak players held ~0.8 s per step and ran out of acts at 13-30 s of a
  // 60 s session even with acts-left shown; the seconds per remaining act
  // that would spend the rest is the number they can act on.
  const inputUsedBefore = (threadId: ThreadId, sessionId: string | null) => {
    const record = exploreEvidence.get(String(threadId));
    return record === undefined ? 0 : ExploreEvidence.totals(record, sessionId ?? "").nominalMs;
  };
  const explorePace = (session: ExploreSession) => {
    const s = (ms: number) => (ms / 1000).toFixed(1);
    const actsLeft = GAME_EXPLORE_BOUNDS.maxCalls - session.calls;
    const stepsLeft = GAME_EXPLORE_BOUNDS.maxTotalSteps - session.totalSteps;
    const earlierMs = inputUsedBefore(session.threadId, session.id);
    const cap = exploreEvidence.get(String(session.threadId))?.inputCapMs;
    const leftMs = Math.min(
      GAME_EXPLORE_BOUNDS.maxTotalNominalMs - session.totalNominalMs,
      cap === undefined ? Number.POSITIVE_INFINITY : cap - earlierMs - session.totalNominalMs,
    );
    const used =
      `input used: ${s(session.totalNominalMs)} s of this session's ` +
      `${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s` +
      (cap !== undefined
        ? ` (${s(earlierMs + session.totalNominalMs)} s of your ${s(cap)} s across sessions)`
        : earlierMs > 0
          ? ` (${s(earlierMs + session.totalNominalMs)} s across your sessions)`
          : "");
    if (actsLeft <= 0 || leftMs <= 0 || stepsLeft <= 0) return `${used}; this session is spent.`;
    const perAct = Math.min(leftMs / actsLeft, GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall);
    return `${used}, ${s(leftMs)} s left over ${actsLeft} act(s) and ${stepsLeft} step(s): about ${s(perAct)} s of input per act spends it.`;
  };
  /**
   * Releases a session's player and scratch. The caller holds the session
   * lock; the transition is uninterruptible once it starts so a cancelled
   * close cannot leave a half-removed profile behind.
   */
  const exploreFinalize = (session: ExploreSession, reason: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (session.closed) return null;
        session.closed = true;
        session.closeReason = reason;
        session.closedAt = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.promise(() => session.play.close()).pipe(
          Effect.andThen(session.release),
          Effect.catchCause((cause) =>
            Effect.logWarning("Closing an exploration session failed.", {
              sessionId: session.id,
              cause,
            }),
          ),
        );
        yield* Effect.promise(() =>
          Promise.all(
            session.scratch.map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Removing exploration scratch failed.", {
              sessionId: session.id,
              cause,
            }),
          ),
        );
        if (exploreLive.get(session.root) === session) exploreLive.delete(session.root);
        yield* persistSession(session);
        const result = {
          sessionId: session.id,
          reason,
          actions: session.actions.length,
          executedInputSteps: session.actions.reduce(
            (sum, action) => sum + action.executedInputSteps,
            0,
          ),
          totalNominalMs: session.totalNominalMs,
          images: session.images,
          message:
            `Exploration ${reason}: ${session.actions.length} act(s), ` +
            `${session.totalNominalMs}ms nominal. ` +
            `This session never qualified the build.`,
        } satisfies typeof GameExploreCloseResult.Type;
        return result;
      }),
    );
  const exploreReap = Effect.gen(function* () {
    for (const live of exploreLive.values()) {
      if (live.closed) continue;
      yield* live.lock.withPermits(1)(
        Effect.gen(function* () {
          if (live.closed || exploreLive.get(live.root) !== live) return;
          const now = yield* Clock.currentTimeMillis;
          if (now < live.wallDeadlineMs && now < live.lastActiveMs + GAME_EXPLORE_BOUNDS.idleTtlMs)
            return;
          const reason = now >= live.wallDeadlineMs ? "wall-expired" : "idle-expired";
          yield* exploreFinalize(live, reason).pipe(Effect.ignore);
        }),
      );
    }
  });
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
  interface OpenedPlay {
    readonly play: PlaySession;
    readonly release: Effect.Effect<void>;
    readonly scratch: ReadonlyArray<string>;
    readonly pictures: boolean;
    readonly bootMs: number;
    readonly inputNote: string;
  }
  const exploreFailure = (root: string, cause: unknown) =>
    isGameOperationError(cause)
      ? cause
      : new GameOperationError({
          operation: "Explore session",
          path: root,
          reason: "command-failed",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
  /**
   * Starts the engine's runner process in a window host's window (headless
   * when the engine runs without one and the machine has no host) and waits for its
   * hello. Everything it started is ended on any failure, by PID only.
   */
  const openRunner = (input: {
    readonly root: string;
    readonly backend: GameEngine.GameEngineBackend;
    readonly projectDir: string;
    readonly player: string | null;
    readonly viewport: GameViewport;
    readonly id: string;
    readonly traceDir: string;
    readonly saves: string | null;
    readonly bootTimeoutMs: number;
    readonly what: string;
  }) =>
    Effect.gen(function* () {
      const { root, backend } = input;
      const launch = backend.playProcess;
      if (launch === null)
        return yield* exploreInvalid(
          root,
          `${backend.profile.displayName} games play in the browser.`,
        );
      const host = yield* Effect.promise(() => findWindowHost(processHost));
      const scriptDir = NodePath.join(root, "builds/logs", `game-explore-${input.id}`);
      const requestPath = NodePath.join(input.traceDir, "request.json");
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(input.traceDir, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const listener = yield* Effect.tryPromise({
        try: () => listenForRunner(),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const dropScratch = Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(input.traceDir, { recursive: true, force: true }),
          NodeFSP.rm(scriptDir, { recursive: true, force: true }),
        ]),
      ).pipe(Effect.ignore);
      const dropAll = Effect.gen(function* () {
        yield* processes.stop(root).pipe(Effect.ignore);
        yield* Effect.promise(() => listener.drop());
        yield* dropScratch;
      });
      return yield* Effect.gen(function* () {
        const spec = yield* launch({
          projectDir: input.projectDir,
          player: input.player,
          requestPath,
          scriptDir,
          traceDir: input.traceDir,
          saves: input.saves,
          viewport: input.viewport,
          window: host?.kind ?? null,
        });
        yield* Effect.tryPromise({
          try: () => listener.writeRequest(requestPath, spec.request),
          catch: (cause) =>
            new GameOperationError({
              operation: "Explore session",
              path: root,
              reason: "io",
              cause,
            }),
        });
        // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs; the run's game time uses the controlled clock.
        const bootWallStart = Date.now();
        const launched = yield* processes.start({
          root,
          executable: spec.executable,
          args: spec.args,
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          operation: "explore-play",
          timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
          env: spec.env,
          envMode: "replace",
          window: host === null ? undefined : { host, viewport: input.viewport },
        });
        const play = yield* Effect.tryPromise({
          try: (signal) =>
            listener.accept({
              timeoutMs: input.bootTimeoutMs,
              what: input.what,
              signal,
              alive: () => processes.list(root).some((entry) => entry.pid === launched.pid),
            }),
          catch: (cause) => exploreFailure(root, cause),
        });
        // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
        const bootMs = Date.now() - bootWallStart;
        // A kept session's game gets its quit and a few seconds to finish
        // writing its saves before anything left is stopped.
        const exited = Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 5_000;
          while (
            processes.list(root).some((entry) => entry.pid === launched.pid) &&
            (yield* Clock.currentTimeMillis) < deadline
          )
            yield* Effect.sleep(Duration.millis(100));
        });
        return {
          play,
          release: (input.saves === null ? Effect.void : exited).pipe(
            Effect.andThen(processes.stop(root)),
            Effect.ignore,
          ),
          scratch: spec.scratch,
          pictures: host !== null,
          bootMs,
          inputNote: spec.inputNote,
        } satisfies OpenedPlay;
      }).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
    });
  /** Registers an opened session and says what it is. */
  const exploreRegister = (
    threadId: ThreadId,
    root: string,
    opened: OpenedPlay,
    input: {
      readonly id: string;
      readonly traceDir: string;
      readonly sourceId: string;
      readonly viewport: GameViewport;
      readonly target: "native" | "web";
      readonly opening: string;
      /** What the session plays: the sources themselves or a player built from them. */
      readonly plays: string;
      /** The kept save location, or null when the session started with no saved data. */
      readonly saves: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { play } = opened;
      const live: ExploreSession = {
        id: input.id,
        root,
        threadId,
        buildId: input.sourceId,
        sourceId: input.sourceId,
        viewport: { ...input.viewport },
        bootMs: opened.bootMs,
        traceDir: input.traceDir,
        play,
        target: input.target,
        pictures: opened.pictures,
        release: opened.release,
        scratch: opened.scratch,
        lock: Semaphore.makeUnsafe(1),
        lastActiveMs: now,
        wallDeadlineMs: now + GAME_EXPLORE_BOUNDS.wallTtlMs,
        calls: 0,
        totalSteps: 0,
        totalNominalMs: 0,
        images: 0,
        actions: [],
        closed: false,
        closeReason: null,
        closedAt: null,
      };
      const boot = play.boot;
      if (boot.probe !== null)
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...boot.probe.gameState },
            player: boot.probe.player === null ? null : { ...boot.probe.player },
          },
          screenshot: "",
          consoleMessages: [...(boot.consoleMessages ?? [])],
          consoleTruncated: 0,
          ...observedFields(boot),
        });
      exploreLive.set(root, live);
      const held = input.target === "native";
      const noPicture = opened.pictures
        ? ""
        : "Runs headless without a picture (this machine has no private display: install Xvfb): state, text, ui and errors stay available. ";
      const savesNote =
        input.saves === null
          ? ""
          : `Saved data is kept in ${NodePath.relative(root, input.saves)}/: what this session saves, the next kept session reads. `;
      return {
        sessionId: input.id,
        buildId: input.sourceId,
        sourceId: input.sourceId,
        viewport: { ...input.viewport },
        booted: true,
        bootMs: opened.bootMs,
        message:
          `${input.opening} exploration session ${input.id.slice(0, 8)} opened on ${input.plays} ${input.sourceId.slice(0, 12)} ` +
          `at ${input.viewport.width}x${input.viewport.height} (${held ? "paused between calls" : "real time: the game keeps running between calls"}). ` +
          `${savesNote}${opened.inputNote}${exploreBudget} Act with input steps${play.capabilities.has("ui") ? " plus ui and inspect steps" : ""}, then game_explore_close. ` +
          `${noPicture}This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  /**
   * Opens a session on the current game sources played by the engine's own
   * runner: no export is built or served. The game is held between acts.
   */
  const exploreStartNative = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root);
      const { backend, ctx } = yield* engines.context(root);
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Explore session",
      });
      const imported = (yield* backend.importProject(ctx)).result;
      if (!imported.success)
        return yield* new GameOperationError({
          operation: "Explore session",
          path: root,
          reason: "command-failed",
          detail:
            `The ${backend.profile.displayName} import failed before the native session started.\n${imported.message}`.slice(
              -2000,
            ),
        });
      const before = yield* snapshot(root, ctx.projectName);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the native session ran; the result would not be current.",
        );
      const projectText = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(ctx.projectDir, backend.projectSettingsFile), "utf8").catch(
          () => "",
        ),
      );
      const viewport = backend.projectSettings(projectText).viewport;
      if (
        viewport.width > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        viewport.height > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        viewport.width < EXPLORE_CAPTURE_BOUNDS.minDimension ||
        viewport.height < EXPLORE_CAPTURE_BOUNDS.minDimension
      )
        return yield* exploreInvalid(
          root,
          `The game's base viewport (${viewport.width}x${viewport.height}) does not fit the capture bounds. Change display/window/size in project.godot first.`,
        );
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const opened = yield* openRunner({
        root,
        backend,
        projectDir: ctx.projectDir,
        player: null,
        viewport,
        id,
        traceDir,
        saves,
        bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
        what: "The native runner",
      });
      return yield* exploreRegister(threadId, root, opened, {
        id,
        traceDir,
        sourceId: before.sourceId,
        viewport,
        target: "native",
        opening: "Native",
        plays: "the current sources",
        saves,
      });
    });
  /**
   * Opens a session on a built player of the current sources (see
   * GamePlayer), on a private display. The game is held between acts.
   */
  const exploreStartPlayer = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
    prepared: GamePlayer.PreparedPlayer,
  ) =>
    Effect.gen(function* () {
      // The player is already built: the engine's executable is not needed again.
      const manifest = yield* projects.read(root);
      const backend = yield* engines.backendFor(manifest.engine.name);
      const engine = backend.profile.displayName;
      const viewport = backend.profile.viewport;
      if (viewport === null)
        return yield* exploreInvalid(root, `${engine} games play no prepared player.`);
      // Where the player came from stays in the server log: a blind sample's
      // notes reach its comparator verbatim, and a sample that waited on a
      // build must read the same as one that did not.
      yield* Effect.logInfo(`${engine} explore session plays its player`, {
        root,
        sourceId: prepared.sourceId,
        origin: prepared.origin,
        ms: prepared.ms,
      });
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Explore session",
      });
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const opened = yield* openRunner({
        root,
        backend,
        projectDir: insideGame(root, backend.projectDirectory(manifest)),
        player: prepared.player,
        viewport,
        id,
        traceDir,
        saves,
        bootTimeoutMs: input.bootTimeoutMs ?? 90_000,
        what: `The ${engine} player (log: ${NodePath.join(traceDir, "player.log")})`,
      });
      return yield* exploreRegister(threadId, root, opened, {
        id,
        traceDir,
        sourceId: prepared.sourceId,
        viewport,
        target: "native",
        opening: engine,
        plays: "a Linux player of the current sources",
        saves,
      });
    });
  /**
   * Opens a session on the current sources of a browser game: the static
   * folder served over loopback, played in headless Chromium in real time.
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
      if (backend.profile.play !== "browser" || viewport === null)
        return yield* exploreInvalid(
          root,
          "Web exploration plays browser games; this game runs on another engine.",
        );
      const before = yield* snapshot(root, ctx.projectName);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the web session ran; the result would not be current.",
        );
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const executable = yield* requireChromium("Explore session", root);
      const saves = yield* keptSavesFor({
        root,
        engine: manifest.engine.name,
        saves: input.saves,
        operation: "Explore session",
      });
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(traceDir, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const server = yield* Effect.tryPromise({
        try: () => serveGameDirectory(root, ctx.projectName),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: root,
            reason: "io",
            detail: "The static project could not be served.",
            cause,
          }),
      });
      const dropServer = Effect.promise(() => server.close()).pipe(Effect.ignore);
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootWallStart = Date.now();
      const play = yield* Effect.tryPromise({
        try: (signal) =>
          openWebPlaySession({
            executable,
            url: server.url,
            width: viewport.width,
            height: viewport.height,
            bootTimeoutMs,
            signal,
            keptStorage: keptWebStorage(saves),
          }),
        catch: (cause) => exploreFailure(root, cause),
      }).pipe(
        Effect.tapError(() => dropServer),
        Effect.onInterrupt(() => dropServer),
      );
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootMs = Date.now() - bootWallStart;
      return yield* exploreRegister(
        threadId,
        root,
        { play, release: dropServer, scratch: [], pictures: true, bootMs, inputNote: "" },
        {
          id,
          traceDir,
          sourceId: before.sourceId,
          viewport,
          target: "web",
          opening: "Web",
          plays: "the current sources",
          saves,
        },
      );
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      // The cache, else disk: right after a restart the cache is cold.
      const startRecord = yield* evidenceLock.withPermits(1)(loadEvidence(String(threadId), root));
      const threadCap = startRecord.inputCapMs;
      const usedBefore =
        threadCap === undefined ? 0 : ExploreEvidence.totals(startRecord).nominalMs;
      if (threadCap !== undefined && usedBefore >= threadCap - 500)
        return yield* exploreInvalid(
          root,
          `Your ${threadCap / 1000} s input budget across sessions is spent; do not start another session. Write your notes now.`,
        );
      const engine = engineProfile((yield* projects.read(root)).engine.name);
      // Only a start that can open a session waits for room: a wrong target or
      // an open session is refused inside the lock without a memory wait.
      const target = input.target ?? (engine.play === "browser" ? "web" : "native");
      const playsPlayer = engine.play === "player" && target !== "web";
      const room = exploreLive.has(root)
        ? null
        : target === "web"
          ? engine.play === "browser"
            ? EXPLORE_WEB_ROOM
            : null
          : engine.play === "native"
            ? EXPLORE_NATIVE_ROOM
            : playsPlayer
              ? EXPLORE_PLAYER_ROOM
              : null;
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      // The player build takes minutes and is the game's own exclusive
      // operation; the start lock is held only to launch and register.
      // The editor that builds it opens through the memory gate, outside this
      // start's own gate hold; its refusal counts like a gated start's, so a
      // run replays a sample turn that never played instead of voiding it.
      const player =
        playsPlayer && !exploreLive.has(root)
          ? yield* players
              .playerFor(String(threadId), root)
              .pipe(
                Effect.tapError((error) =>
                  error.reason === "low-memory"
                    ? recordMemory(threadId, root, 0, true)
                    : Effect.void,
                ),
              )
          : null;
      const locked = exploreStartLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = exploreLive.get(root);
          if (existing !== undefined)
            return yield* exploreInvalid(
              existing.id,
              "Another exploration session is open for this game; its owning thread must close it before this game can start another.",
            );
          const engine = engineProfile((yield* projects.read(root)).engine.name);
          const target = input.target ?? (engine.play === "browser" ? "web" : "native");
          if (target === "web") {
            if (engine.play !== "browser")
              return yield* exploreInvalid(
                root,
                `${engine.displayName} web play is not in this build; start the session without a target (or with target native).`,
              );
            return yield* exploreStartWeb(threadId, root, input);
          }
          if (engine.play === "browser")
            return yield* exploreInvalid(
              root,
              `This is a ${engine.displayName} browser game; start the session with target web.`,
            );
          if (engine.play === "player")
            return player === null
              ? yield* exploreInvalid(
                  root,
                  "An exploration session for this game closed while this one was starting; start the session again.",
                )
              : yield* exploreStartPlayer(threadId, root, input, player);
          return yield* exploreStartNative(threadId, root, input);
        }),
      );
      // The memory gate is taken before the start lock, as by every gated start.
      return yield* (room === null ? locked : withExploreRoom(threadId, root, room, locked)).pipe(
        Effect.tap((started) => {
          const live = exploreLive.get(root);
          return live?.id === started.sessionId ? persistSession(live) : Effect.void;
        }),
      );
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
      const screenshotPath = session.pictures ? NodePath.join(session.traceDir, file) : null;
      const reply = yield* Effect.tryPromise({
        try: (signal) => session.play.act([...input.steps], screenshotPath, signal),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: session.id,
            reason: "command-failed",
            detail:
              cause instanceof Error && cause.message !== "aborted"
                ? cause.message.slice(0, 500)
                : "The act failed.",
            cause,
          }),
      });
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (screenshotPath === null)
        screenshotReason =
          "This machine has no private display (install Xvfb), so the native session runs headless without a picture. State, text, ui and errors stay available.";
      else if (
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
          session.target === "web"
            ? "The browser returned no picture for this act; state and console messages stay available."
            : "The native picture was unavailable even though a display was expected; state, text, ui and errors stay available.";
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
      session.actions.push({
        index: callIndex,
        steps: [...input.steps],
        executedInputSteps: reply.executedInputSteps,
        nominalMs,
        probe,
        screenshot: keptScreenshot,
        consoleMessages,
        consoleTruncated,
        ...observed,
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
      });
      session.totalNominalMs += nominalMs;
      if (keptScreenshot !== "") session.images += 1;
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
        ...observedFields(reply),
        consoleMessages,
        consoleTruncated,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${reply.executedInputSteps} input, +${nominalMs}ms nominal); ` +
          (uiResults.length > 0 ? `${received}/${uiResults.length} ui action(s) received; ` : "") +
          `${explorePace(session)} ` +
          `This observation is descriptive only, never a verdict.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
        totalNominalMs: session.totalNominalMs,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? Effect.gen(function* () {
              if (session.actions.some((action) => action.index === callIndex)) return;
              session.actions.push({
                index: callIndex,
                steps: [...input.steps],
                executedInputSteps: 0,
                nominalMs: 0,
                probe: null,
                screenshot: "",
                consoleMessages: [],
                consoleTruncated: 0,
                execution: "unknown",
                failure:
                  "Act failed or was interrupted after possible partial execution. Exact input progress is unknown.",
              });
              yield* exploreFinalize(session, "act-failed");
            })
          : Effect.void,
      ),
    );
  const exploreAct = (threadId: ThreadId, input: typeof GameExploreActInput.Type) =>
    Effect.gen(function* () {
      const session = [...exploreLive.values()].find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; start a new one with game_explore_start.",
        );
      const root = yield* projects.resolve(threadId);
      const lease = exploreLease(session, root, threadId);
      if (lease !== null) return yield* lease;
      // Direct service callers bypass the tool schema, so the per-call shape
      // is enforced here too, before any budget or browser work.
      if (input.steps.length === 0 || input.steps.length > GAME_EXPLORE_BOUNDS.maxStepsPerCall)
        return yield* exploreInvalid(
          session.id,
          `Use 1–${GAME_EXPLORE_BOUNDS.maxStepsPerCall} steps per act; this act has ${input.steps.length}.`,
        );
      if (session.calls >= GAME_EXPLORE_BOUNDS.maxCalls)
        return yield* exploreInvalid(
          session.id,
          `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and start a new exploration.`,
        );
      const nominalMs = exploreStepsNominalMs(input.steps, session.target);
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
              "That exploration session is closed or expired; start a new one with game_explore_start.",
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
              `That exploration session ${reason}. Start a new exploration with game_explore_start.`,
            );
          }
          // Budgets are checked under the session lock so concurrent acts
          // cannot each pass before either one accounts for itself.
          if (session.calls >= GAME_EXPLORE_BOUNDS.maxCalls)
            return yield* exploreInvalid(
              session.id,
              `This session used its ${GAME_EXPLORE_BOUNDS.maxCalls} act calls; close it and start a new exploration.`,
            );
          if (session.totalSteps + input.steps.length > GAME_EXPLORE_BOUNDS.maxTotalSteps)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalSteps} total steps; close it and start a new exploration.`,
            );
          if (session.totalNominalMs + nominalMs > GAME_EXPLORE_BOUNDS.maxTotalNominalMs)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxTotalNominalMs}ms total nominal time; close it and start a new exploration.`,
            );
          const record = yield* evidenceLock.withPermits(1)(
            loadEvidence(String(session.threadId), session.root),
          );
          const threadCap = record.inputCapMs;
          if (threadCap !== undefined) {
            const usedMs =
              ExploreEvidence.totals(record, session.id).nominalMs + session.totalNominalMs;
            if (usedMs + nominalMs > threadCap)
              return yield* exploreInvalid(
                session.id,
                `This act would pass your ${threadCap / 1000} s input budget across sessions (${(usedMs / 1000).toFixed(1)} s used, ${((threadCap - usedMs) / 1000).toFixed(1)} s left); use a shorter act, or close the session and write your notes.`,
              );
          }
          // Headless native acts persist no picture, so the image bound only
          // covers acts that actually keep one. Web acts always keep one.
          const keepsImage = session.pictures;
          if (keepsImage && session.images + 1 > GAME_EXPLORE_BOUNDS.maxImages)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxImages} persisted images; close it and start a new exploration.`,
            );
          const callIndex = session.calls + 1;
          session.calls = callIndex;
          session.totalSteps += input.steps.length;
          return yield* exploreActOnce(session, input, callIndex, nominalMs).pipe(
            Effect.ensuring(persistSession(session)),
          );
        }),
      );
    });
  const exploreClose = (threadId: ThreadId, input: typeof GameExploreCloseInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const session = [...exploreLive.values()].find((live) => live.id === input.sessionId);
      if (session === undefined)
        return yield* exploreInvalid(
          input.sessionId,
          "That exploration session is unknown or expired; start a new one with game_explore_start.",
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
            "That exploration session is closed or expired; start a new one with game_explore_start.",
          );
        }),
      );
    });
  // Idle and wall-clock expiry without a caller: one scoped fiber sweeps the
  // live sessions. Production timers own it; every act/close also
  // checks the same deadlines lazily.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (let sweep = 1; ; sweep += 1) {
        yield* Effect.sleep(Duration.seconds(30));
        yield* exploreReap;
        // A server that runs for weeks never restarts to prune; once an hour.
        if (sweep % 120 === 0) {
          const now = yield* Clock.currentTimeMillis;
          // Locked: a thread resuming mid-prune must not lose its fresh write.
          yield* evidenceLock
            .withPermits(1)(Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, now)))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Pruning explore evidence failed.", { cause }),
              ),
            );
        }
      }
    }),
  );
  return GameExplore.of({
    start: exploreStart,
    act: exploreAct,
    close: exploreClose,
    finish: Effect.fn("GameExplore.finish")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      const live = exploreLive.get(root);
      if (live !== undefined && String(live.threadId) === String(threadId))
        yield* live.lock.withPermits(1)(exploreFinalize(live, "role-finished"));
      // A finish starts the thread's memory marks over: the next turn counts its own.
      const record = yield* evidenceLock.withPermits(1)(
        Effect.gen(function* () {
          const loaded = yield* loadEvidence(String(threadId), root);
          if (loaded.memory === undefined) return loaded;
          const { memory: _cleared, ...rest } = loaded;
          rememberEvidence(rest);
          yield* writeEvidence(rest);
          return rest;
        }),
      );
      return ExploreEvidence.totals(record);
    }),
    // On the thread's evidence record, so a restart keeps a sample's budget.
    limitInput: (threadId, totalMs) =>
      Effect.flatMap(projects.resolve(threadId), (root) =>
        evidenceLock.withPermits(1)(
          Effect.gen(function* () {
            const record = yield* loadEvidence(String(threadId), root);
            if (record.inputCapMs === totalMs) return;
            const next = { ...record, inputCapMs: totalMs };
            rememberEvidence(next);
            yield* writeEvidence(next);
          }),
        ),
      ).pipe(Effect.ignore),
    memoryWait: Effect.fn("GameExplore.memoryWait")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      const record = yield* threadEvidence(threadId, root);
      const { executedInputSteps } = ExploreEvidence.totals(record);
      const memory = record.memory ?? { waitedMs: 0, refusals: 0, refused: false };
      return { ...memory, executedInputSteps };
    }),
    sheet: Effect.fn("GameExplore.sheet")(function* (threadId, output) {
      const root = yield* projects.resolve(threadId);
      const kept = ExploreEvidence.frames(yield* threadEvidence(threadId, root));
      // A frame whose copy failed stays in temp scratch, which can be cleaned,
      // and a capture can be cut off mid-write; only complete PNGs are drawn.
      const present = yield* Effect.promise(() =>
        Promise.all(
          kept.map((frame) => ExploreSheet.pngSize(frame.path).then((size) => size !== null)),
        ),
      );
      const onDisk = kept.filter((_, i) => present[i]);
      if (onDisk.length < kept.length)
        yield* Effect.logWarning(
          "Some kept explore frames are gone or incomplete; the sheet draws the rest.",
          {
            threadId,
            kept: kept.length,
            lost: kept.length - onDisk.length,
          },
        );
      const frames = ExploreSheet.pickFrames(onDisk);
      const size =
        frames.length === 0
          ? null
          : yield* Effect.promise(() => ExploreSheet.pngSize(frames[0]!.path));
      if (size === null || size.w === 0) return 0;
      const ffmpeg = yield* Effect.promise(() =>
        GameProcesses.findExecutable("ffmpeg", {
          pathEnv: process.env.PATH,
          override: process.env.KURAMBIT_FFMPEG,
        }),
      );
      if (ffmpeg === null)
        return yield* new GameOperationError({
          operation: "Explore sheet",
          path: "ffmpeg",
          reason: "tool-missing",
          detail: "ffmpeg draws the frame sheet.",
        });
      const fontDirectory = yield* GameAssetLibrary.labelFontDirectory();
      // ffmpeg writes a fresh name, then the rename replaces whatever sits at
      // `output` without following a link planted there.
      const temporary = NodePath.join(
        NodePath.dirname(output),
        `.sheet-${NodeCrypto.randomUUID()}.jpg`,
      );
      const removeTemporary = Effect.promise(() =>
        NodeFSP.rm(temporary, { force: true }).catch(() => undefined),
      );
      const result = yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(NodePath.dirname(output), { recursive: true }),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore sheet",
            path: output,
            reason: "io",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(
        Effect.andThen(
          processes.run({
            root,
            ...(fontDirectory === undefined ? {} : { cwd: fontDirectory }),
            executable: ffmpeg,
            args: ExploreSheet.sheetArgs(
              frames,
              size.h / size.w,
              fontDirectory === undefined ? null : GameAssetLibrary.LABEL_FONT,
              temporary,
            ),
            operation: "explore-sheet",
            timeoutMs: 60_000,
            envMode: "replace",
            env: GameProcesses.engineChildEnv(),
          }),
        ),
      );
      if (result.exitCode !== 0) {
        yield* removeTemporary;
        return yield* new GameOperationError({
          operation: "Explore sheet",
          path: output,
          reason: "command-failed",
          detail: result.stderr.slice(0, 1000),
        });
      }
      yield* Effect.tryPromise({
        try: () => NodeFSP.rename(temporary, output),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore sheet",
            path: output,
            reason: "command-failed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(Effect.onError(() => removeTemporary));
      return frames.length;
    }),
    release: (threadId, root) =>
      Effect.gen(function* () {
        // A cancelled turn also releases the game's exploration session: the
        // browser belongs to the user, not to a turn that is going away.
        const live = exploreLive.get(root);
        if (live !== undefined && String(live.threadId) === String(threadId))
          yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
      }),
  });
});

export const layer = Layer.effect(GameExplore, make);
