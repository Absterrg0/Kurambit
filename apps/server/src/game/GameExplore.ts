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
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import {
  GameOperationError,
  gameOperationFault,
  manifestProject,
  isStandingFault,
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
import * as GameTemplates from "./GameTemplates.ts";
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
  PlayClosed,
  PlayUnresponsive,
  type PlayActObservation,
  type PlayObservation,
  type PlaySession,
} from "./playSession.ts";
import { ensureGameDir, keptSavesFor, keptWebStorage, writeKeptStorage } from "./gameKeptSaves.ts";
import { makeGameBrowser } from "./gameChromium.ts";
import {
  openPagePlay,
  openRunnerPlay,
  type PlayDidNotBoot,
  type PlayLaunch,
} from "./playLaunch.ts";
import { WebBrowserGone, WebPageCrashed } from "./webPlaySession.ts";
import { snapshotBuildSource } from "./sourceSnapshot.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

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
    /**
     * Closes the thread's open session and returns what its sessions played in
     * all. `keepMarks` leaves the memory marks for the turn that reads them.
     */
    readonly finish: (
      threadId: ThreadId,
      options?: { readonly keepMarks?: boolean },
    ) => Effect.Effect<
      {
        sessions: number;
        actions: number;
        executedInputSteps: number;
        nominalMs: number;
        images: number;
      },
      GameOperationError
    >;
    /**
     * Caps the explore input this thread may use across all its sessions. It
     * fails when the cap cannot be kept on disk, since a restart would then
     * let a blind sample play past its fair budget. `root` is the folder the
     * thread plays, given rather than resolved: the cap is set before the
     * thread exists, so its first turn is never sent without it.
     */
    readonly limitInput: (
      threadId: ThreadId,
      totalMs: number,
      root: string,
    ) => Effect.Effect<void, GameOperationError>;
    /**
     * Marks a play start refused for a cause not about the game (machine or
     * tool), as an explore start's refusal is marked: the agent's bot run uses it.
     */
    readonly markRefused: (
      threadId: ThreadId,
      root: string,
      reason: GameOperationError["reason"],
      waitedMs: number,
    ) => Effect.Effect<void, GameOperationError>;
    readonly memoryWait: (threadId: ThreadId) => Effect.Effect<
      {
        readonly waitedMs: number;
        readonly refused: "low-memory" | "busy" | "tool-failed" | null;
        /** The refusal is one waiting cannot clear (isStandingFault). */
        readonly standing: boolean;
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
  const scheduler = yield* Scheduler.Scheduler;
  const processHost = yield* ProcessHost;
  const projects = yield* GameProjectService.GameProjectService;
  const processes = yield* GameProcesses.GameProcesses;
  const gameBrowser = yield* makeGameBrowser;
  const engines = yield* GameEngine.GameEngine;
  const gate = yield* GameMemoryGate.GameMemoryGate;
  const players = yield* GamePlayer.GamePlayer;
  const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
  const templates = yield* GameTemplates.GameTemplates;
  const evidenceDir = NodePath.join(stateDir, "explore-evidence");
  // Each session's runner files, user:// tree and pictures. Kept off the temp
  // dir (it may be RAM-backed) and gone with the session; none outlives a
  // restart, so whatever an earlier server left is removed now.
  const scratchBase = NodePath.join(stateDir, "game-explore");
  yield* Effect.promise(() => NodeFSP.rm(scratchBase, { recursive: true, force: true }));
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
  const startedMs = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, startedMs)).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Pruning explore evidence failed.", { cause })),
  );
  const snapshot = (root: string, project: string, backend: GameEngine.GameEngineBackend) =>
    Effect.promise((signal) =>
      snapshotBuildSource(root, project, { signal, rules: backend.profile.buildInputs }),
    );
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
    /** How the game ended an act, when it did: the session's close reason. */
    endedBy: "unresponsive" | "crashed" | "host-lost" | null;
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
  /** The acts a session ran: index 0 is the boot observation, not an act. */
  const actsOf = (session: ExploreSession) =>
    session.actions.filter((action) => action.index > 0).length;
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
  const exploreScratchBase = () => scratchBase;
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
  // A root's entry is claimed in the same step that finds it free (a start's
  // placeholder), so two starts on one game never both open a session.
  const exploreLive = new Map<string, ExploreSession | "starting">();
  const liveSessions = () =>
    [...exploreLive.values()].filter((live): live is ExploreSession => live !== "starting");
  // A start's memory waits land in the thread's evidence record, on disk, so
  // the run's cap gives the time back even across a restart.
  const withExploreRoom = <A, E, R>(
    threadId: ThreadId,
    root: string,
    room: MemoryRoom,
    start: Effect.Effect<A, E, R>,
    lock: { readonly name: string; readonly owner: string } | undefined,
  ) =>
    Effect.suspend(() => {
      const waited = { ms: 0, refused: undefined as "low-memory" | "busy" | null | undefined };
      return gate
        .admit(
          "Explore session",
          root,
          room,
          start,
          (waitedMs, refused) => {
            waited.ms += waitedMs;
            waited.refused = refused;
          },
          lock === undefined ? undefined : { lock },
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              waited.refused === undefined
                ? Effect.void
                : markRefusal(threadId, root, waited.ms, waited.refused ?? false, false).pipe(
                    Effect.ignore({ log: true }),
                  ),
            ),
          ),
        );
    });
  // A write-through cache of the records under `evidenceDir`; a restart
  // reloads them, so a sample's earlier play still counts. A record enters it
  // only once it is on disk, so the cache never claims more than a restart reads.
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
  const evidenceError = (detail: string) => (cause: unknown) =>
    new GameOperationError({
      operation: "Explore evidence",
      path: evidenceDir,
      reason: "io",
      detail,
      cause,
    });
  /** On disk, then in the cache; a failed write fails whatever made it. */
  const writeEvidence = (record: ExploreEvidence.ThreadEvidence) =>
    fileServices(ExploreEvidence.write(evidenceDir, record)).pipe(
      Effect.mapError(evidenceError("The thread's explore evidence could not be written.")),
      Effect.tap(() => Effect.sync(() => rememberEvidence(record))),
    );
  /**
   * Adds a start's wait, and why it was refused if it was, to the thread's
   * record: memory short or queued behind another start or operation, or a
   * tool of ours that failed (`standing` when waiting cannot clear it).
   */
  const markRefusal = (
    threadId: ThreadId,
    root: string,
    waitedMs: number,
    refused: "low-memory" | "busy" | "tool-failed" | false,
    standing: boolean,
  ) =>
    evidenceLock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* loadEvidence(String(threadId), root);
        const prior = record.memory ?? { waitedMs: 0, refused: false };
        yield* writeEvidence({
          ...record,
          memory: {
            waitedMs: prior.waitedMs + waitedMs,
            refused,
            ...(standing ? { standing: true } : {}),
          },
        });
      }),
    );
  /** A start refused by the machine or a tool of ours, by its reason; anything else is not a refusal. */
  const markFault = (
    threadId: ThreadId,
    root: string,
    reason: GameOperationError["reason"],
    waitedMs: number,
  ) => {
    const fault = gameOperationFault(reason);
    return fault !== "machine" && fault !== "tool"
      ? Effect.void
      : markRefusal(
          threadId,
          root,
          waitedMs,
          fault === "tool" ? "tool-failed" : reason === "low-memory" ? "low-memory" : "busy",
          isStandingFault(reason),
        );
  };
  /** The caller holds `evidenceLock`. */
  const loadEvidence = (threadId: string, root: string) =>
    Effect.gen(function* () {
      const cached = exploreEvidence.get(threadId);
      if (cached !== undefined) return cached;
      const disk = yield* Effect.tryPromise({
        try: () => ExploreEvidence.read(evidenceDir, threadId),
        catch: evidenceError("The thread's explore evidence could not be read."),
      });
      if (disk === null) return ExploreEvidence.empty(threadId, root);
      if (disk === "damaged") {
        // Set aside, never overwritten: what it counted is lost, and the fresh
        // record says so until the thread's next explore start.
        const now = yield* Clock.currentTimeMillis;
        const aside = yield* Effect.tryPromise({
          try: () => ExploreEvidence.setAside(evidenceDir, threadId, now),
          catch: evidenceError("A damaged explore record could not be moved aside."),
        });
        yield* Effect.logWarning("A thread's explore evidence was unreadable; it is kept aside.", {
          threadId,
          aside,
        });
        const fresh = { ...ExploreEvidence.empty(threadId, root), damaged: true };
        yield* writeEvidence(fresh);
        return fresh;
      }
      const record = ExploreEvidence.closeOrphans(
        disk,
        new Set(liveSessions().map((live) => live.id)),
      );
      if (record.sessions.some((s, i) => s !== disk.sessions[i])) yield* writeEvidence(record);
      else rememberEvidence(record);
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
          actions: actsOf(session),
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
        if (exploreLive.get(session.root) === session) exploreLive.delete(session.root);
        // Recorded first: a capped thread's kept frames are copied out of the
        // scratch as it is persisted, and the scratch goes after.
        const persisted = yield* persistSession(session).pipe(Effect.exit);
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
        if (persisted._tag === "Failure") return yield* Effect.failCause(persisted.cause);
        const result = {
          sessionId: session.id,
          reason,
          actions: actsOf(session),
          executedInputSteps: session.actions.reduce(
            (sum, action) => sum + action.executedInputSteps,
            0,
          ),
          totalNominalMs: session.totalNominalMs,
          images: session.images,
          message:
            `Exploration ${reason}: ${actsOf(session)} act(s), ` +
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
  interface OpenedPlay {
    readonly play: PlaySession;
    readonly release: Effect.Effect<void>;
    readonly scratch: ReadonlyArray<string>;
    readonly pictures: boolean;
    readonly bootMs: number;
    readonly inputNote: string;
  }
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
      const { root } = input;
      const host = yield* Effect.promise(() => findWindowHost(processHost));
      // The runner's script folder: fresh, under a logs folder checked to be the game's.
      const scriptDir = NodePath.join(root, "builds/logs", `game-explore-${input.id}`);
      yield* Effect.tryPromise({
        try: async () => {
          await ensureGameDir(root, "builds/logs");
          await NodeFSP.mkdir(scriptDir);
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: scriptDir,
            reason: "io",
            cause,
          }),
      });
      const dropScratch = Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(input.traceDir, { recursive: true, force: true }),
          NodeFSP.rm(scriptDir, { recursive: true, force: true }),
        ]),
      ).pipe(Effect.ignore);
      const launched = yield* openRunnerPlay(processes, {
        operation: "Explore session",
        process: "explore-play",
        root,
        backend: input.backend,
        projectDir: input.projectDir,
        player: input.player,
        viewport: input.viewport,
        host,
        scriptDir,
        traceDir: input.traceDir,
        saves: input.saves,
        timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
        bootTimeoutMs: input.bootTimeoutMs,
        what: input.what,
      }).pipe(
        Effect.onError(() => dropScratch),
        Effect.catchTags({ PlayDidNotBoot: notBooted(root) }),
      );
      return {
        play: launched.play,
        release: releaseOf(launched),
        scratch: launched.scratch,
        pictures: host !== null,
        bootMs: launched.bootMs,
        inputNote: launched.inputNote,
      } satisfies OpenedPlay;
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
        scratch: [...opened.scratch, input.traceDir],
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
        endedBy: null,
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
      const before = yield* snapshot(root, ctx.projectName, backend);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the native session ran; the result would not be current.",
        );
      const viewport = yield* backend.viewport(ctx.projectDir);
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
        projectDir: insideGame(root, manifestProject(manifest)),
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
      const before = yield* snapshot(root, ctx.projectName, backend);
      if (before.kind !== "known")
        return yield* exploreInvalid(
          root,
          "The game sources could not be identified before the web session ran; the result would not be current.",
        );
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const browser = yield* gameBrowser("Explore session", root);
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
      const launched = yield* openPagePlay({
        operation: "Explore session",
        root,
        projectDir: ctx.projectDir,
        browser,
        viewport,
        bootTimeoutMs,
        keptStorage: keptWebStorage(saves),
      }).pipe(Effect.catchTags({ PlayDidNotBoot: notBooted(root) }));
      return yield* exploreRegister(
        threadId,
        root,
        {
          play: launched.play,
          release: releaseOf(launched),
          scratch: [],
          pictures: true,
          bootMs: launched.bootMs,
          inputNote: "",
        },
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
      // The cache, else disk: right after a restart the cache is cold. A record
      // found damaged before this start begins a fresh count now.
      const startRecord = yield* evidenceLock.withPermits(1)(
        Effect.gen(function* () {
          const wasDamaged = exploreEvidence.get(String(threadId))?.damaged === true;
          const record = yield* loadEvidence(String(threadId), root);
          if (!wasDamaged || record.damaged !== true) return record;
          const { damaged: _cleared, ...fresh } = record;
          yield* writeEvidence(fresh);
          return fresh;
        }),
      );
      const threadCap = startRecord.inputCapMs;
      const usedBefore =
        threadCap === undefined ? 0 : ExploreEvidence.totals(startRecord).nominalMs;
      if (threadCap !== undefined && usedBefore >= threadCap - 500)
        return yield* exploreInvalid(
          root,
          `Your ${threadCap / 1000} s input budget across sessions is spent; do not start another session. Write your notes now.`,
        );
      const engine = engineProfile((yield* projects.read(root)).engine.name);
      const target = input.target ?? (engine.play === "browser" ? "web" : "native");
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      // A wrong target is refused before any claim, room or build.
      if (target === "web" && engine.play !== "browser")
        return yield* exploreInvalid(
          root,
          `${engine.displayName} web play is not in this build; start the session without a target (or with target native).`,
        );
      if (target === "native" && engine.play === "browser")
        return yield* exploreInvalid(
          root,
          `This is a ${engine.displayName} browser game; start the session with target web.`,
        );
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
      return yield* Effect.gen(function* () {
        // A native session imports into the folder before it plays, and a
        // player with none cached is built there: both write the game, so a
        // production run holding it refuses them to anyone but itself. A copy
        // is no run's game folder, and a web session only serves the sources.
        const admit = projects.admitWrite(threadId, root, "Explore session", String(threadId));
        const native = target === "native" && engine.play === "native";
        if (native) yield* admit;
        // The player build takes minutes and is the game's own exclusive
        // operation, before this start's gate hold; the editor that builds it
        // opens through the memory gate itself, and its refusal is marked like
        // a gated start's, so a run replays a sample turn that never played.
        const player =
          engine.play === "player" ? yield* players.playerFor(String(threadId), root, admit) : null;
        const start =
          target === "web"
            ? exploreStartWeb(threadId, root, input)
            : player !== null
              ? exploreStartPlayer(threadId, root, input, player)
              : exploreStartNative(threadId, root, input);
        const room =
          target === "web"
            ? EXPLORE_WEB_ROOM
            : player !== null
              ? EXPLORE_PLAYER_ROOM
              : EXPLORE_NATIVE_ROOM;
        // A native start's import writes the folder: the game's operation lock,
        // then the memory gate, through the boot (the order GameMemoryGate keeps).
        const started = yield* withExploreRoom(
          threadId,
          root,
          room,
          start,
          native ? { name: "Explore session start", owner: String(threadId) } : undefined,
        );
        const live = exploreLive.get(root);
        // A session whose start cannot be recorded is closed, not left open
        // with nothing on disk to count it.
        if (live !== undefined && live !== "starting" && live.id === started.sessionId)
          yield* persistSession(live).pipe(
            Effect.tapError(() =>
              live.lock.withPermits(1)(exploreFinalize(live, "act-failed")).pipe(Effect.ignore),
            ),
          );
        return started;
      }).pipe(
        Effect.onExit(() => unclaim),
        // The machine or a tool of ours that kept the session from starting
        // (the player's build included) is marked, so a run's play turn that
        // played nothing is replayed, not judged. A run's own refusal of the
        // write is no such start.
        Effect.tapError((error) =>
          error.reason === "cancelled" || error.runReason !== undefined
            ? Effect.void
            : markFault(threadId, root, error.reason, 0).pipe(Effect.ignore({ log: true })),
        ),
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
              yield* exploreFinalize(session, session.endedBy ?? "act-failed").pipe(
                Effect.ignore({ log: true }),
              );
            })
          : Effect.void,
      ),
    );
  const exploreAct = (threadId: ThreadId, input: typeof GameExploreActInput.Type) =>
    Effect.gen(function* () {
      const session = liveSessions().find((live) => live.id === input.sessionId);
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
            // A failed act was recorded as it closed the session; a recorded act
            // that cannot be persisted fails, so disk never falls behind.
            Effect.tap(() => persistSession(session)),
          );
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
  // Idle and wall-clock expiry without a caller; every act/close also
  // checks the same deadlines lazily.
  yield* scheduler.register("game-explore-expiry", yield* Scheduler.every(30_000, exploreReap));
  // A server that runs for weeks never restarts to prune; once an hour.
  yield* scheduler.register(
    "game-explore-evidence",
    yield* Scheduler.every(
      3_600_000,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Locked: a thread resuming mid-prune must not lose its fresh write.
        yield* evidenceLock
          .withPermits(1)(Effect.tryPromise(() => ExploreEvidence.prune(evidenceDir, now)))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Pruning explore evidence failed.", { cause }),
            ),
          );
      }),
    ),
  );
  return GameExplore.of({
    start: exploreStart,
    act: exploreAct,
    close: exploreClose,
    // The thread's evidence is keyed by the thread, not its folder: a role in a
    // folder that is no game (a comparator's blank one) still finishes.
    finish: Effect.fn("GameExplore.finish")(function* (threadId, options) {
      const live = liveSessions().find((session) => String(session.threadId) === String(threadId));
      if (live !== undefined)
        yield* live.lock.withPermits(1)(exploreFinalize(live, "role-finished"));
      // A finish starts the thread's memory marks over: the next turn counts its own.
      const record = yield* evidenceLock.withPermits(1)(
        Effect.gen(function* () {
          const loaded = yield* loadEvidence(String(threadId), live?.root ?? "");
          if (loaded.memory === undefined || options?.keepMarks === true) return loaded;
          const { memory: _cleared, ...rest } = loaded;
          yield* writeEvidence(rest);
          return rest;
        }),
      );
      // What a damaged record counted is lost: no total from it is evidence.
      if (record.damaged === true)
        return yield* new GameOperationError({
          operation: "Explore evidence",
          path: evidenceDir,
          reason: "tool-failed",
          detail: "explore evidence record damaged",
        });
      return ExploreEvidence.totals(record);
    }),
    // On the thread's evidence record, so a restart keeps a sample's budget.
    // Cached only once on disk: a retry after a failed write must find the
    // cap missing and write it again, not take the cache's word for it.
    limitInput: (threadId, totalMs, root) =>
      evidenceLock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* loadEvidence(String(threadId), root);
          if (record.inputCapMs === totalMs) return;
          yield* writeEvidence({ ...record, inputCapMs: totalMs });
        }),
      ),
    markRefused: markFault,
    memoryWait: Effect.fn("GameExplore.memoryWait")(function* (threadId) {
      const record = yield* threadEvidence(threadId, "");
      const { executedInputSteps } = ExploreEvidence.totals(record);
      const memory = record.memory ?? { waitedMs: 0, refused: false };
      // An older record's `true` was a low-memory refusal.
      const refused = memory.refused === true ? "low-memory" : memory.refused || null;
      return {
        waitedMs: memory.waitedMs,
        refused,
        standing: refused !== null && memory.standing === true,
        executedInputSteps,
      };
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
      const fontDirectory = yield* GameAssetLibrary.labelFontDirectory(templates);
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
        if (live !== undefined && live !== "starting" && String(live.threadId) === String(threadId))
          yield* live.lock.withPermits(1)(exploreFinalize(live, "cancelled")).pipe(Effect.ignore);
      }),
  });
});

export const layer = Layer.effect(GameExplore, make);
