// @effect-diagnostics nodeBuiltinImport:off -- This service owns the native process, filesystem and loopback boundary of exploration sessions.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import * as GameExploreNative from "./gameExploreNative.ts";
import * as GameMemoryGate from "./GameMemoryGate.ts";
import type { MemoryRoom } from "./GameMemoryGate.ts";
import * as GamePlayer from "./GamePlayer.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { openExploreWeb, webStepIssues, type ExploreWebHandle } from "./gameExploreWeb.ts";
import { requireChromium } from "./gameChromium.ts";
import { userDirConfigIssues } from "./gameNativeUserDir.ts";
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
 * A built Linux player under software GL and its xvfb-run display: a small
 * 3D Unity game's player held 290 MB PSS; headroom covers bigger games. Its
 * build, when the session needs one, is the live editor's own memory guard.
 */
const EXPLORE_PLAYER_ROOM: MemoryRoom = {
  what: "Unity exploration session",
  neededMb: 1024,
  env: "KURAMBIT_EXPLORE_UNITY_MEMORY_MB",
};

const isGameOperationError = Schema.is(GameOperationError);

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
  interface ExploreNativeConn {
    socket: NodeNet.Socket;
    lineState: GameExploreNative.NativeLineState;
    token: string;
    hasDisplay: boolean;
    pid: number;
    server: NodeNet.Server;
    nextId: number;
  }
  interface ExploreWebConn {
    handle: ExploreWebHandle;
    server: { url: string; close: () => Promise<void> };
  }
  interface ExploreSession {
    readonly id: string;
    readonly root: string;
    readonly threadId: ThreadId;
    readonly buildId: string;
    readonly sourceId: string | null;
    readonly viewport: GameViewport;
    /** Honest boot timing, frozen with the session. */
    readonly bootMs: number | null;
    readonly profileDir: string;
    readonly traceDir: string;
    readonly native: ExploreNativeConn | null;
    readonly web: ExploreWebConn | null;
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
    readonly ui?: ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly rect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }>;
    readonly errors?: ReadonlyArray<{ readonly message: string; readonly where: string }>;
    readonly uiResults?: ReadonlyArray<{
      readonly id: string;
      readonly action: string;
      readonly received: boolean;
      readonly detail: string;
    }>;
    readonly inspections?: ReadonlyArray<{
      readonly path: string;
      readonly values: Record<string, string | number | boolean | Array<number> | null>;
      readonly error?: string;
    }>;
    readonly screenshotReason?: string;
  }
  const exploreScratchBase = () => NodePath.join(NodeOS.tmpdir(), "game-explore");
  const exploreInvalid = (path: string, detail: string) =>
    new GameOperationError({ operation: "Explore session", path, reason: "invalid-input", detail });
  const exploreNativeStepIssues = (steps: readonly GameExploreStep[]): readonly string[] => {
    const issues: string[] = [];
    for (const [index, step] of steps.entries()) {
      if ("ui" in step) {
        if (step.ui.id.length === 0 || step.ui.id.length > 200)
          issues.push(`Step ${index + 1} ui id must contain 1–200 characters.`);
        if (step.ui.action !== "click" && step.ui.action !== "drag")
          issues.push(`Step ${index + 1} ui action must be click or drag.`);
        if (step.ui.action === "drag" && (step.ui.to === undefined || step.ui.to.length === 0))
          issues.push(`Step ${index + 1} ui drag needs a to id.`);
      } else if ("inspect" in step) {
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
  /**
   * Ends a native session's tracked process tree by PID only. The quit line
   * asks the runner to exit itself; the tracked stop ends the whole owned
   * group (xvfb-run plus its display server and Godot child) when it lingers.
   * Never matches processes by name.
   */
  const closeNativeConn = (session: ExploreSession) =>
    Effect.gen(function* () {
      const conn = session.native;
      if (conn === null) return;
      yield* Effect.promise(async () => {
        // Ask the runner to exit itself, then end the tracked tree by PID.
        // The quit line is flushed with end(); the tracked stop below ends
        // the whole owned group if the runner lingers. Never match by name.
        try {
          const sock = conn.socket;
          if (!sock.destroyed) {
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              sock.end(JSON.stringify({ op: "quit", id: conn.nextId++ }) + "\n", done);
              // @effect-diagnostics-next-line globalTimers:off -- Best-effort quit flush on a raw socket; the tracked stop below still ends the tree.
              setTimeout(done, 2_000);
            });
          }
        } catch {
          // Best effort; the tracked stop below still ends the tree.
        }
        try {
          conn.socket.destroy();
        } catch {
          // Already gone.
        }
        await new Promise<void>((resolve) => conn.server.close(() => resolve()));
      });
      yield* processes.stop(session.root).pipe(Effect.ignore);
    });
  // Worktree judges own different roots; a session in one game must not
  // consume another game's play budget. The thread lease still owns input.
  const exploreStartLock = Semaphore.makeUnsafe(1);
  const exploreLive = new Map<string, ExploreSession>();
  // Per thread: how long its starts waited for memory (the role runner gives
  // that time back to its clock), how many were refused, and whether the
  // latest one was.
  const exploreMemory = new Map<string, { waitedMs: number; refusals: number; refused: boolean }>();
  const withExploreRoom = <A, E, R>(
    threadId: ThreadId,
    root: string,
    room: MemoryRoom,
    start: Effect.Effect<A, E, R>,
  ) =>
    gate.admit("Explore session", root, room, start, (waitedMs, refused) => {
      const prior = exploreMemory.get(String(threadId));
      exploreMemory.set(String(threadId), {
        waitedMs: (prior?.waitedMs ?? 0) + waitedMs,
        refusals: (prior?.refusals ?? 0) + (refused ? 1 : 0),
        refused,
      });
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
              path: exploreInputCaps.has(owner)
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
  // Per-thread input budgets across sessions (a blind sample's), set by the run.
  const exploreInputCaps = new Map<string, number>();
  const inputUsedBefore = (threadId: ThreadId, sessionId: string | null) => {
    const record = exploreEvidence.get(String(threadId));
    return record === undefined ? 0 : ExploreEvidence.totals(record, sessionId ?? "").nominalMs;
  };
  const explorePace = (session: ExploreSession) => {
    const s = (ms: number) => (ms / 1000).toFixed(1);
    const actsLeft = GAME_EXPLORE_BOUNDS.maxCalls - session.calls;
    const stepsLeft = GAME_EXPLORE_BOUNDS.maxTotalSteps - session.totalSteps;
    const earlierMs = inputUsedBefore(session.threadId, session.id);
    const cap = exploreInputCaps.get(String(session.threadId));
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
        if (session.native !== null)
          yield* closeNativeConn(session).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing a native exploration session failed.", {
                sessionId: session.id,
                cause,
              }),
            ),
          );
        if (session.web !== null)
          yield* Effect.promise(() =>
            (async () => {
              try {
                await session.web!.handle.close();
              } finally {
                await session.web!.server.close();
              }
            })(),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Closing a web exploration session failed.", {
                sessionId: session.id,
                cause,
              }),
            ),
          );
        yield* Effect.promise(() =>
          NodeFSP.rm(session.profileDir, { recursive: true, force: true }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Removing an exploration profile failed.", {
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
  /**
   * Opens a native exploration session on the current game sources. No
   * export is built or served: Godot runs the real main scene under a
   * server-owned runner script (ignored builds/logs only) and talks back
   * over loopback TCP. The game tree stays paused between acts.
   */
  const exploreStartNative = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      yield* projects.read(root);
      const { backend, ctx } = yield* engines.context(root);
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
      const dirIssues = userDirConfigIssues(projectText);
      if (dirIssues.length > 0) return yield* exploreInvalid(root, dirIssues.join(" "));
      const baseViewport = backend.projectSettings(projectText).viewport;
      if (
        baseViewport.width > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        baseViewport.height > EXPLORE_CAPTURE_BOUNDS.maxDimension ||
        baseViewport.width < EXPLORE_CAPTURE_BOUNDS.minDimension ||
        baseViewport.height < EXPLORE_CAPTURE_BOUNDS.minDimension
      )
        return yield* exploreInvalid(
          root,
          `The game's base viewport (${baseViewport.width}x${baseViewport.height}) does not fit the capture bounds. Change display/window/size in project.godot first.`,
        );
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const staged = yield* Effect.tryPromise({
        try: () => GameExploreNative.stageNativeScript(root, id, traceDir),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      // profileDir reuses the finalize removal: the runner script and request
      // live under ignored builds/logs and are removed again on close.
      const profileDir = staged.scriptDir;
      const token = GameExploreNative.nativeSessionToken();
      const now = yield* Clock.currentTimeMillis;
      const dropScratch = Effect.promise(() =>
        Promise.all([
          NodeFSP.rm(traceDir, { recursive: true, force: true }),
          NodeFSP.rm(staged.scriptDir, { recursive: true, force: true }),
        ]),
      ).pipe(Effect.ignore);
      const cleanupChild = processes.stop(root).pipe(Effect.ignore);
      // The TCP server owns the boot handshake; the tracked child is stopped
      // on any exit before the session registers, by PID only.
      const dropAll = Effect.gen(function* () {
        yield* cleanupChild;
        yield* dropScratch;
      });
      const server: NodeNet.Server = yield* Effect.tryPromise({
        try: async () => {
          const listener = NodeNet.createServer();
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
              listener.off("error", reject);
              resolve();
            });
          });
          return listener;
        },
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const lineState: GameExploreNative.NativeLineState = {
        buffer: "",
        notify: null,
        closed: false,
      };
      let runnerSocket: NodeNet.Socket | null = null;
      server.on("connection", (sock) => {
        if (runnerSocket !== null) {
          sock.destroy();
          return;
        }
        runnerSocket = sock;
        GameExploreNative.attachLineState(sock, lineState);
      });
      const port = (server.address() as NodeNet.AddressInfo).port;
      yield* Effect.tryPromise({
        try: () =>
          GameExploreNative.writeNativeRequest(staged.requestPath, {
            port,
            token,
            expectedUserDataPrefix: staged.isolation.dataDir,
          }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      }).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const xvfb = yield* Effect.promise(() => GameExploreNative.findXvfb()).pipe(
        Effect.orElseSucceed(() => null),
      );
      const hasDisplay = xvfb !== null;
      const godotArgs = GameExploreNative.nativeGodotArgs({
        projectDir: ctx.projectDir,
        scriptPath: staged.scriptPath,
        requestPath: staged.requestPath,
        width: baseViewport.width,
        height: baseViewport.height,
        hasDisplay,
      });
      const launched = yield* (
        hasDisplay
          ? processes.start({
              root,
              executable: xvfb!,
              args: [
                "-a",
                "-s",
                // Xvfb rejects a screen without depth ("Invalid screen
                // configuration"), and xvfb-run still runs Godot against the
                // dead display, so every native boot times out with no
                // picture. Keep the x24 depth the helper uses.
                `-screen 0 ${baseViewport.width}x${baseViewport.height}x24`,
                ctx.binary.path,
                ...godotArgs,
              ],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              envMode: "replace",
              ownedProcessGroup: true,
            })
          : processes.start({
              root,
              executable: ctx.binary.path,
              args: [...godotArgs],
              operation: "explore-native",
              timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
              env: GameExploreNative.nativeChildEnv(staged.isolation),
              envMode: "replace",
              ownedProcessGroup: true,
            })
      ).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs; the run's game time uses the controlled clock.
      const bootWallStart = Date.now();
      let everConnected = false;
      const markConnected = () => {
        everConnected = true;
      };
      server.on("connection", markConnected);
      const hello = yield* Effect.tryPromise({
        try: (signal) =>
          (async () => {
            const timeout = AbortSignal.timeout(bootTimeoutMs);
            const combined =
              signal === undefined || signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
            for (;;) {
              let line: string | null;
              try {
                line = await GameExploreNative.nextRunnerLine(lineState, combined);
              } catch (cause) {
                if (signal?.aborted) throw new Error("aborted", { cause });
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: `The native game did not boot within ${bootTimeoutMs}ms; no exploration session was opened. ${cause instanceof Error ? cause.message : String(cause)}`,
                  ...(cause === undefined ? {} : { cause }),
                });
              }
              if (line === null) {
                // The runner connected and went away without a hello.
                if (everConnected)
                  throw new GameOperationError({
                    operation: "Explore session",
                    path: root,
                    reason: "command-failed",
                    detail:
                      "The native runner exited before booting; no exploration session was opened.",
                  });
                continue;
              }
              const text = String(line).trim();
              if (text === "") continue;
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(text);
              } catch {
                continue;
              }
              if (typeof parsed !== "object" || parsed === null) continue;
              const record = parsed as Record<string, unknown>;
              if (typeof record["error"] === "string")
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: record["error"] as string,
                });
              if (record["token"] !== token)
                throw new GameOperationError({
                  operation: "Explore session",
                  path: root,
                  reason: "command-failed",
                  detail: "The native runner presented a wrong session token.",
                });
              return record;
            }
          })(),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.tapError(() => dropAll),
        Effect.onInterrupt(() => dropAll),
      );
      const clean = GameExploreNative.sanitizeNativeObservation(hello);
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs; the run's game time uses the controlled clock.
      const bootMs = Date.now() - bootWallStart;
      if (runnerSocket === null)
        return yield* exploreInvalid(
          root,
          "The native runner never connected; no session was opened.",
        );
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        bootMs,
        profileDir,
        traceDir,
        native: {
          socket: runnerSocket!,
          lineState,
          token,
          hasDisplay,
          pid: launched.pid,
          server,
          nextId: 1,
        },
        web: null,
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
      if (clean.probe !== null) {
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...clean.probe.gameState },
            player: clean.probe.player === null ? null : { ...clean.probe.player },
          },
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          screenText: { ...clean.screenText },
          ui: clean.ui.map((control) => ({
            ...control,
            rect: { ...control.rect },
          })),
          errors: clean.errors.map((error) => ({ ...error })),
        });
      }
      exploreLive.set(root, live);
      const noPicture =
        " Runs headless without a picture (xvfb-run was not found on PATH): state, text, ui and errors stay available.";
      return {
        sessionId: id,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { width: baseViewport.width, height: baseViewport.height },
        booted: true,
        bootMs,
        message:
          `Native exploration session ${id.slice(0, 8)} opened on the current sources ${before.sourceId.slice(0, 12)} ` +
          `at ${baseViewport.width}x${baseViewport.height} (paused between calls). ` +
          `${exploreBudget} Act with input steps plus ui and inspect steps, then game_explore_close. ` +
          (hasDisplay ? "" : noPicture + " ") +
          `This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  /**
   * Opens a session on a built player of the current sources (see
   * GamePlayer), on a private display. The player speaks the native runner's
   * protocol over loopback TCP (Unity's template StudioProbe), so acts,
   * pictures, probe reads and closing share the native path. The game is
   * paused between acts.
   */
  const exploreStartPlayer = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
    prepared: GamePlayer.PreparedPlayer,
  ) =>
    Effect.gen(function* () {
      const { backend } = yield* engines.context(root);
      const engine = backend.profile.displayName;
      const launch = backend.player?.session;
      const viewport = backend.profile.viewport;
      if (launch === undefined || viewport === null)
        return yield* exploreInvalid(root, `${engine} games play no prepared player.`);
      const { player, sourceId } = prepared;
      // Where the player came from stays in the server log: a blind sample's
      // notes reach its comparator verbatim, and a sample that waited on a
      // build must read the same as one that did not.
      yield* Effect.logInfo(`${engine} explore session plays its player`, {
        root,
        sourceId,
        origin: prepared.origin,
        ms: prepared.ms,
      });
      const xvfb = yield* Effect.promise(() => GameExploreNative.findXvfb()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (xvfb === null)
        return yield* exploreInvalid(
          root,
          `${engine} exploration needs xvfb-run for the player's private display; install the system Xvfb package.`,
        );
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      const token = GameExploreNative.nativeSessionToken();
      const requestPath = NodePath.join(traceDir, "request.json");
      const playerHome = NodePath.join(traceDir, "home");
      const dropScratch = Effect.promise(() =>
        NodeFSP.rm(traceDir, { recursive: true, force: true }),
      ).pipe(Effect.ignore);
      const server: NodeNet.Server = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(playerHome, { recursive: true });
          const listener = NodeNet.createServer();
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
              listener.off("error", reject);
              resolve();
            });
          });
          return listener;
        },
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const lineState: GameExploreNative.NativeLineState = {
        buffer: "",
        notify: null,
        closed: false,
      };
      let runnerSocket: NodeNet.Socket | null = null;
      server.on("connection", (sock) => {
        if (runnerSocket !== null) {
          sock.destroy();
          return;
        }
        runnerSocket = sock;
        GameExploreNative.attachLineState(sock, lineState);
      });
      const port = (server.address() as NodeNet.AddressInfo).port;
      const dropAll = Effect.gen(function* () {
        yield* processes.stop(root).pipe(Effect.ignore);
        yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
        yield* dropScratch;
      });
      yield* Effect.tryPromise({
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- The player's request file is the runner protocol's fixed two-field JSON.
        try: () => NodeFSP.writeFile(requestPath, JSON.stringify({ port, token })),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      }).pipe(Effect.tapError(() => dropAll));
      const session = launch({ player, requestPath, traceDir, home: playerHome, viewport });
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootWallStart = Date.now();
      const launched = yield* processes
        .start({
          root,
          executable: xvfb,
          args: ["-a", "-s", `-screen 0 ${viewport.width}x${viewport.height}x24`, ...session.args],
          operation: "explore-unity",
          timeoutMs: GAME_EXPLORE_BOUNDS.wallTtlMs + 60_000,
          env: session.env,
          envMode: "replace",
          ownedProcessGroup: true,
        })
        .pipe(Effect.tapError(() => dropAll));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const hello = yield* Effect.tryPromise({
        try: async (signal) => {
          const timeout = AbortSignal.timeout(bootTimeoutMs);
          const combined = signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
          for (;;) {
            const line = await GameExploreNative.nextRunnerLine(lineState, combined).catch(
              (cause: unknown) => {
                throw new Error(
                  `The ${engine} player did not report in within ${bootTimeoutMs}ms; no exploration session was opened. Player log: ${NodePath.join(traceDir, "player.log")}`,
                  { cause },
                );
              },
            );
            if (line === null) {
              if (runnerSocket !== null)
                throw new Error(`The ${engine} player exited before booting.`);
              continue;
            }
            let parsed: unknown = null;
            try {
              // @effect-diagnostics-next-line preferSchemaOverJson:off -- Runner protocol lines are sanitized field by field below.
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null) continue;
            const record = parsed as Record<string, unknown>;
            if (record["token"] !== token)
              throw new Error(`The ${engine} player presented a wrong session token.`);
            return record;
          }
        },
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: root,
            reason: "command-failed",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }).pipe(Effect.tapError(() => dropAll));
      // @effect-diagnostics-next-line globalDateInEffect:off -- Wall-clock boot latency for honest bootMs.
      const bootMs = Date.now() - bootWallStart;
      const clean = GameExploreNative.sanitizeNativeObservation(hello);
      const now = yield* Clock.currentTimeMillis;
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: sourceId,
        sourceId: sourceId,
        viewport: { ...viewport },
        bootMs,
        // Close removes the player's scratch HOME; pictures and player.log stay as evidence.
        profileDir: playerHome,
        traceDir,
        native: {
          socket: runnerSocket!,
          lineState,
          token,
          hasDisplay: true,
          pid: launched.pid,
          server,
          nextId: 1,
        },
        web: null,
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
      if (clean.probe !== null)
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...clean.probe.gameState },
            player: clean.probe.player === null ? null : { ...clean.probe.player },
          },
          screenshot: "",
          consoleMessages: [],
          consoleTruncated: 0,
          screenText: { ...clean.screenText },
          ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
          errors: clean.errors.map((error) => ({ ...error })),
        });
      exploreLive.set(root, live);
      return {
        sessionId: id,
        buildId: sourceId,
        sourceId: sourceId,
        viewport: { ...viewport },
        booted: true,
        bootMs,
        message:
          `${engine} exploration session ${id.slice(0, 8)} opened on a Linux player of the current sources ${sourceId.slice(0, 12)} ` +
          `at ${viewport.width}x${viewport.height} (paused between calls). ${session.inputNote}` +
          `${exploreBudget} Act with input steps plus ui and inspect steps, then game_explore_close. This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  /**
   * Opens a web exploration session on the current game sources. The static
   * folder is served over loopback and headless Chromium plays it in real
   * time: real keyboard and mouse input, screenshots, console errors and the
   * game's read-only `window.__studio` probe. There is no pause between
   * calls; waits and holds advance game time as they run.
   */
  const exploreStartWeb = (
    threadId: ThreadId,
    root: string,
    input: typeof GameExploreStartInput.Type,
  ) =>
    Effect.gen(function* () {
      yield* projects.read(root);
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
      const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
      if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      const bootTimeoutMs = input.bootTimeoutMs ?? 90_000;
      const executable = yield* requireChromium("Explore session", root);
      const id = NodeCrypto.randomUUID();
      const traceDir = NodePath.join(exploreScratchBase(), id);
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(traceDir, { recursive: true }),
        catch: (cause) =>
          new GameOperationError({ operation: "Explore session", path: root, reason: "io", cause }),
      });
      const profileDir = NodePath.join(traceDir, "chrome-profile");
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
      const now = yield* Clock.currentTimeMillis;
      const dropServer = Effect.promise(() => server.close()).pipe(Effect.ignore);
      const handle = yield* Effect.tryPromise({
        try: (signal) =>
          openExploreWeb({
            executable,
            url: server.url,
            profileDirectory: profileDir,
            width: viewport.width,
            height: viewport.height,
            bootTimeoutMs,
            signal,
          }),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: root,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(
        Effect.tapError(() => dropServer),
        Effect.onInterrupt(() => dropServer),
      );
      const live: ExploreSession = {
        id,
        root,
        threadId,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { ...handle.viewport },
        bootMs: handle.bootMs,
        profileDir,
        traceDir,
        native: null,
        web: { handle, server },
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
      if (handle.bootProbe !== null) {
        live.actions.push({
          index: 0,
          steps: [],
          executedInputSteps: 0,
          nominalMs: 0,
          probe: {
            gameState: { ...handle.bootProbe.gameState },
            player: handle.bootProbe.player === null ? null : { ...handle.bootProbe.player },
          },
          screenshot: "",
          consoleMessages: [...handle.bootConsole],
          consoleTruncated: 0,
        });
      }
      exploreLive.set(root, live);
      return {
        sessionId: id,
        buildId: before.sourceId,
        sourceId: before.sourceId,
        viewport: { ...handle.viewport },
        booted: true,
        bootMs: handle.bootMs,
        message:
          `Web exploration session ${id.slice(0, 8)} opened on the current sources ${before.sourceId.slice(0, 12)} ` +
          `at ${handle.viewport.width}x${handle.viewport.height} (real time: the game keeps running between calls). ` +
          `${exploreBudget} Act with input steps, then game_explore_close. ` +
          `This session never qualifies the build.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls,
        wallTtlMs: GAME_EXPLORE_BOUNDS.wallTtlMs,
        idleTtlMs: GAME_EXPLORE_BOUNDS.idleTtlMs,
      } satisfies typeof GameExploreStartResult.Type;
    });
  const exploreStart = (threadId: ThreadId, input: typeof GameExploreStartInput.Type) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(threadId);
      const threadCap = exploreInputCaps.get(String(threadId));
      // The cache, else disk: right after a restart the cache is cold.
      const usedBefore =
        threadCap === undefined
          ? 0
          : ExploreEvidence.totals(
              yield* evidenceLock.withPermits(1)(loadEvidence(String(threadId), root)),
            ).nominalMs;
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
      if (playsPlayer) {
        const bootIssues = exploreCaptureIssues({ bootTimeoutMs: input.bootTimeoutMs });
        if (bootIssues.length > 0) return yield* exploreInvalid(root, bootIssues.join("\n"));
      }
      // The player build takes minutes and is the game's own exclusive
      // operation; the start lock is held only to launch and register.
      // The editor that builds it refuses at once when memory is short; that
      // refusal counts like a gated start's, so a run replays a sample turn
      // that never played instead of voiding it.
      const player =
        playsPlayer && !exploreLive.has(root)
          ? yield* players.playerFor(String(threadId), root).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (error.reason !== "low-memory") return;
                  const prior = exploreMemory.get(String(threadId));
                  exploreMemory.set(String(threadId), {
                    waitedMs: prior?.waitedMs ?? 0,
                    refusals: (prior?.refusals ?? 0) + 1,
                    refused: true,
                  });
                }),
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
   * Runs one native act through the runner's TCP connection and persists the
   * returned picture where one exists. Headless runs keep no picture; the
   * session stays usable for state, text, ui and errors.
   */
  const exploreActNative = (
    session: ExploreSession,
    input: typeof GameExploreActInput.Type,
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const conn = session.native!;
      const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
      const screenshotPath = conn.hasDisplay ? NodePath.join(session.traceDir, file) : null;
      const failAct = Effect.gen(function* () {
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
      });
      const reply = yield* Effect.tryPromise({
        try: (signal) =>
          (async () => {
            const id = conn.nextId++;
            conn.socket.write(
              JSON.stringify({ id, op: "act", steps: [...input.steps], screenshotPath }) + "\n",
            );
            const timeout = AbortSignal.timeout(120_000);
            const combined =
              signal === undefined || signal.aborted ? timeout : AbortSignal.any([signal, timeout]);
            for (;;) {
              let line: string | null;
              try {
                line = await GameExploreNative.nextRunnerLine(conn.lineState, combined);
              } catch (cause) {
                if (signal?.aborted) throw new Error("aborted");
                if (cause === undefined) throw new Error("The native act timed out after 120s.");
                throw new Error("The native act timed out after 120s.", { cause });
              }
              if (line === null) throw new Error("The native session closed.");
              const text = String(line).trim();
              if (text === "") continue;
              let parsed: unknown = null;
              try {
                parsed = JSON.parse(text);
              } catch {
                continue;
              }
              if (typeof parsed !== "object" || parsed === null) continue;
              const record = parsed as Record<string, unknown>;
              if (record["id"] !== id) continue;
              if (record["ok"] !== true)
                throw new Error(
                  typeof record["error"] === "string"
                    ? (record["error"] as string)
                    : "The native act failed.",
                );
              return record;
            }
          })(),
        catch: (cause) =>
          isGameOperationError(cause)
            ? cause
            : new GameOperationError({
                operation: "Explore session",
                path: session.id,
                reason: "command-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? failAct : Effect.void)));
      const clean = GameExploreNative.sanitizeNativeObservation(reply);
      const executedInputSteps =
        typeof reply["executedInputSteps"] === "number"
          ? (reply["executedInputSteps"] as number)
          : 0;
      // The runner writes the picture directly to the trace dir; the act only
      // keeps it when the file is really there.
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (screenshotPath !== null && reply["screenshot"] === true) {
        const present = yield* Effect.promise(() =>
          NodeFSP.stat(screenshotPath)
            .then((stat) => stat.isFile() && stat.size > 0)
            .catch(() => false),
        );
        if (present) keptScreenshot = file;
        else
          screenshotReason =
            "The native picture was unavailable even though a display was expected; state, text, ui and errors stay available.";
      } else if (screenshotPath === null) {
        screenshotReason =
          "xvfb-run was not found on PATH, so the native session runs headless without a picture. State, text, ui and errors stay available.";
      }
      const probe =
        clean.probe === null
          ? null
          : {
              gameState: { ...clean.probe.gameState },
              player: clean.probe.player === null ? null : { ...clean.probe.player },
            };
      session.actions.push({
        index: callIndex,
        steps: [...input.steps],
        executedInputSteps,
        nominalMs,
        probe,
        screenshot: keptScreenshot,
        consoleMessages: [],
        consoleTruncated: 0,
        screenText: { ...clean.screenText },
        ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
        errors: clean.errors.map((error) => ({ ...error })),
        uiResults: clean.uiResults.map((result) => ({ ...result })),
        inspections: clean.inspections.map((entry) => ({ ...entry, values: { ...entry.values } })),
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
      });
      session.totalNominalMs += nominalMs;
      if (keptScreenshot !== "") session.images += 1;
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      const received = clean.uiResults.filter((result) => result.received).length;
      return {
        sessionId: session.id,
        callIndex,
        executedInputSteps,
        nominalMs,
        probe,
        screenshotPath:
          keptScreenshot === "" ? null : NodePath.join(session.traceDir, keptScreenshot),
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
        screenText: { ...clean.screenText },
        ui: clean.ui.map((control) => ({ ...control, rect: { ...control.rect } })),
        errors: clean.errors.map((error) => ({ ...error })),
        uiResults: clean.uiResults.map((result) => ({ ...result })),
        inspections: clean.inspections.map((entry) => ({ ...entry, values: { ...entry.values } })),
        consoleMessages: [],
        consoleTruncated: 0,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${executedInputSteps} input, +${nominalMs}ms nominal); ` +
          (clean.uiResults.length > 0
            ? `${received}/${clean.uiResults.length} ui action(s) received; `
            : "") +
          `${explorePace(session)} ` +
          `This observation is descriptive only, never a verdict.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
        totalNominalMs: session.totalNominalMs,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? Effect.gen(function* () {
              if (!session.actions.some((action) => action.index === callIndex))
                yield* Effect.gen(function* () {
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
                      "Observation failed after possible partial execution. Exact input progress is unknown.",
                  });
                  yield* exploreFinalize(session, "act-failed");
                });
            })
          : Effect.void,
      ),
    );
  /**
   * Runs one web act through headless Chromium and persists the returned
   * picture. The game runs in real time, so waits and holds in the steps
   * already advanced it; captures cost nothing extra.
   */
  const exploreActWeb = (
    session: ExploreSession,
    input: typeof GameExploreActInput.Type,
    callIndex: number,
    nominalMs: number,
  ) =>
    Effect.gen(function* () {
      const conn = session.web!;
      const file = `act-${String(callIndex).padStart(2, "0")}-observe.png`;
      const screenshotPath = NodePath.join(session.traceDir, file);
      const failAct = Effect.gen(function* () {
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
      });
      const observed = yield* Effect.tryPromise({
        try: (signal) => conn.handle.act([...input.steps], callIndex, signal),
        catch: (cause) =>
          new GameOperationError({
            operation: "Explore session",
            path: session.id,
            reason: "command-failed",
            detail:
              cause instanceof Error && cause.message !== "aborted"
                ? cause.message.slice(0, 500)
                : "The web act failed.",
            cause,
          }),
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? failAct : Effect.void)));
      let keptScreenshot = "";
      let screenshotReason: string | undefined = undefined;
      if (observed.screenshotData !== "") {
        const written = yield* Effect.promise(() =>
          NodeFSP.writeFile(screenshotPath, Buffer.from(observed.screenshotData, "base64"))
            .then(() =>
              NodeFSP.stat(screenshotPath).then(
                (stat) => stat.isFile() && stat.size > 0,
                () => false,
              ),
            )
            .catch(() => false),
        );
        if (written) keptScreenshot = file;
        else
          screenshotReason =
            "The browser picture could not be saved; state and console messages stay available.";
      } else {
        screenshotReason =
          "The browser returned no picture for this act; state and console messages stay available.";
      }
      const probe =
        observed.probe === null
          ? null
          : {
              gameState: { ...observed.probe.gameState },
              player: observed.probe.player === null ? null : { ...observed.probe.player },
            };
      session.actions.push({
        index: callIndex,
        steps: [...input.steps],
        executedInputSteps: observed.executedInputSteps,
        nominalMs,
        probe,
        screenshot: keptScreenshot,
        consoleMessages: [...observed.consoleMessages],
        consoleTruncated: observed.consoleTruncated,
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
      });
      session.totalNominalMs += nominalMs;
      if (keptScreenshot !== "") session.images += 1;
      session.lastActiveMs = yield* Clock.currentTimeMillis;
      return {
        sessionId: session.id,
        callIndex,
        executedInputSteps: observed.executedInputSteps,
        nominalMs,
        probe,
        screenshotPath: keptScreenshot === "" ? null : screenshotPath,
        ...(screenshotReason === undefined ? {} : { screenshotReason }),
        consoleMessages: [...observed.consoleMessages],
        consoleTruncated: observed.consoleTruncated,
        message:
          `Act ${callIndex} ran ${input.steps.length} step(s) ` +
          `(${observed.executedInputSteps} input, +${nominalMs}ms nominal); ` +
          `${explorePace(session)} ` +
          `This observation is descriptive only, never a verdict.`,
        callsLeft: GAME_EXPLORE_BOUNDS.maxCalls - callIndex,
        totalNominalMs: session.totalNominalMs,
      } satisfies typeof GameExploreActResult.Type;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !session.closed
          ? Effect.gen(function* () {
              if (!session.actions.some((action) => action.index === callIndex))
                yield* Effect.gen(function* () {
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
                      "Observation failed after possible partial execution. Exact input progress is unknown.",
                  });
                  yield* exploreFinalize(session, "act-failed");
                });
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
      const nominalMs = GameExploreNative.exploreStepsNominalMs(
        input.steps,
        session.web === null ? "native" : "web",
      );
      if (!Number.isFinite(nominalMs) || nominalMs < 0)
        return yield* exploreInvalid(session.id, "The act has an invalid duration.");
      if (nominalMs > GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall)
        return yield* exploreInvalid(
          session.id,
          `The act lasts ${nominalMs}ms; one act may last at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall}ms.`,
        );
      const stepIssues = exploreStepIssues(input.steps);
      if (stepIssues.length > 0) return yield* exploreInvalid(session.id, stepIssues.join("\n"));
      if (session.web !== null) {
        const webIssues = webStepIssues(input.steps);
        if (webIssues.length > 0) return yield* exploreInvalid(session.id, webIssues.join("\n"));
      } else {
        const nativeIssues = exploreNativeStepIssues(input.steps);
        if (nativeIssues.length > 0)
          return yield* exploreInvalid(session.id, nativeIssues.join("\n"));
      }
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
          const threadCap = exploreInputCaps.get(String(session.threadId));
          if (threadCap !== undefined) {
            const record = yield* evidenceLock.withPermits(1)(
              loadEvidence(String(session.threadId), session.root),
            );
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
          const keepsImage =
            session.web !== null || (session.native !== null && session.native.hasDisplay);
          if (keepsImage && session.images + 1 > GAME_EXPLORE_BOUNDS.maxImages)
            return yield* exploreInvalid(
              session.id,
              `This act would exceed the session's ${GAME_EXPLORE_BOUNDS.maxImages} persisted images; close it and start a new exploration.`,
            );
          const callIndex = session.calls + 1;
          session.calls = callIndex;
          session.totalSteps += input.steps.length;
          return yield* (
            session.web !== null
              ? exploreActWeb(session, input, callIndex, nominalMs)
              : exploreActNative(session, input, callIndex, nominalMs)
          ).pipe(Effect.ensuring(persistSession(session)));
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
      exploreMemory.delete(String(threadId));
      return ExploreEvidence.totals(yield* threadEvidence(threadId, root));
    }),
    limitInput: (threadId, totalMs) =>
      Effect.sync(() => {
        exploreInputCaps.set(String(threadId), totalMs);
      }),
    memoryWait: Effect.fn("GameExplore.memoryWait")(function* (threadId) {
      const root = yield* projects.resolve(threadId);
      const { executedInputSteps } = ExploreEvidence.totals(yield* threadEvidence(threadId, root));
      const memory = exploreMemory.get(String(threadId)) ?? {
        waitedMs: 0,
        refusals: 0,
        refused: false,
      };
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
