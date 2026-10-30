// @effect-diagnostics nodeBuiltinImport:off -- Tests use real temporary game and scratch directories with a fake browser adapter.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import {
  GAME_EXPLORE_BOUNDS,
  GameOperationError,
  ThreadId,
  type GameManifest,
  type GameWebPlaytestResult,
} from "@t3tools/contracts";
import { hashWebBuild } from "./webBuild.ts";
import * as GameService from "./GameService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GamePreview from "./GamePreview.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as GameDesignApproval from "./GameDesignApproval.ts";
import * as GameProcesses from "./GameProcesses.ts";
import * as GameToolchain from "./GameToolchain.ts";
import type * as GameExploreBrowser from "./GameExploreBrowser.ts";
import { admissionTestLayer, qualificationTestLayer } from "./gameTestLayers.ts";

const threadId = ThreadId.make("game-explore-test");
const otherThreadId = ThreadId.make("game-explore-other");
const otherRootThreadId = ThreadId.make("game-explore-other-root");
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const manifest = (): GameManifest => ({
  schemaVersion: 1,
  name: "Explore probe",
  brief: "",
  artDirection: "",
  engine: { name: "godot", version: "4.7.2" },
  godotProject: "godot",
  assets: [],
});

type ReplayRun = NonNullable<Parameters<typeof GameService.layerWithExploreBrowser>[1]>;

const designRead = () => ({
  state: "approved" as const,
  document: null,
  documentTruncated: false,
  approvedHash: null,
  currentHash: null,
  approvedAt: null,
  acceptance: [],
  issues: [],
  autoRevision: 0,
  pendingRevision: null,
  revisionDiff: null,
});

const plainGate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((runner) => {
    resolve = runner;
  });
  return { promise, resolve };
};

/** Effect 4 forked through the ambient test scope; the fiber stays interruptible. */
const forkTest = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    return yield* Effect.forkIn(effect, scope);
  });

interface FakeControl {
  readonly open: GameExploreBrowser.ExploreBrowserOpen;
  readonly state: {
    opens: number;
    closes: number;
    abortedOpens: number;
    handles: number;
    acts: Array<{ steps: readonly unknown[]; firstStepIndex: number }>;
    count: number;
    /** One-shot open failure, consumed by the next open. */
    failOpen: GameOperationError | null;
    failAct: boolean;
    openStarted: Array<() => void>;
    actStarted: Array<() => void>;
    /** Fires when the fake browser closes; proves the reaper ran without polling. */
    onClose: Array<() => void>;
    openGate: { promise: Promise<void>; resolve: () => void } | null;
    actGate: { promise: Promise<void>; resolve: () => void } | null;
  };
}

const makeFake = (): FakeControl => {
  const state: FakeControl["state"] = {
    opens: 0,
    closes: 0,
    abortedOpens: 0,
    handles: 0,
    acts: [],
    count: 0,
    failOpen: null,
    failAct: false,
    openStarted: [],
    actStarted: [],
    onClose: [],
    openGate: null,
    actGate: null,
  };
  const open: GameExploreBrowser.ExploreBrowserOpen = async (input, signal) => {
    state.opens++;
    for (const notify of state.openStarted) notify();
    if (state.failOpen !== null) {
      const failure = state.failOpen;
      state.failOpen = null;
      throw failure;
    }
    // A real profile directory, so cleanup assertions mean something.
    await NodeFSP.mkdir(input.profileDirectory, { recursive: true });
    if (state.openGate) await state.openGate.promise;
    if (signal?.aborted) {
      state.abortedOpens++;
      throw new Error("aborted");
    }
    if (input.width <= 0 || input.height <= 0) throw new Error("bad viewport");
    state.handles++;
    return {
      handle: {
        act: async (steps, firstStepIndex, actSignal) => {
          state.acts.push({ steps: [...steps], firstStepIndex });
          for (const notify of state.actStarted) notify();
          if (state.actGate) await state.actGate.promise;
          actSignal?.throwIfAborted();
          let executed = 0;
          let nominal = 0;
          for (const step of steps) {
            const record = step as Record<string, unknown>;
            if ("press" in record) {
              nominal += 50;
              executed++;
            } else if ("waitMs" in record) nominal += record.waitMs as number;
            else if ("holdMs" in record) {
              nominal += record.holdMs as number;
              executed++;
            } else if (!("screenshot" in record)) executed++;
          }
          state.count++;
          if (state.failAct) throw new Error("Failed after receiving input.");
          return {
            executedInputSteps: executed,
            nominalMs: nominal,
            probe: { gameState: { count: state.count }, player: null },
            screenshotData: PIXEL,
            screenshotWidth: 8,
            screenshotHeight: 8,
            consoleMessages: [{ level: "log" as const, text: `observed ${steps.length} step(s)` }],
          };
        },
        close: async () => {
          state.closes++;
          for (const notify of state.onClose) notify();
        },
      },
      boot: {
        booted: true,
        bootMs: 42,
        probe: { gameState: {}, player: null },
        pauseConfirmed: true,
        consoleMessages: [],
      },
    };
  };
  return { open, state };
};

const makeReplayRun = (seen: {
  calls: Array<{ profileDirectory: string; steps: readonly unknown[] }>;
}): ReplayRun => {
  const run = (input: { profileDirectory: string; steps: readonly unknown[] }) =>
    Effect.sync(() => {
      seen.calls.push({ profileDirectory: input.profileDirectory, steps: [...input.steps] });
      return {
        success: true,
        booted: true,
        bootMs: 5,
        responded: true,
        executedInputSteps: input.steps.length,
        changedPercent: 7,
        message: "Replay run finished.",
        consoleMessages: [],
        screenshots: [
          {
            label: "booted",
            mimeType: "image/png" as const,
            data: PIXEL,
            width: 1280,
            height: 720,
          },
          {
            label: "after-steps",
            mimeType: "image/png" as const,
            data: PIXEL,
            width: 1280,
            height: 720,
          },
        ],
        state: {
          before: { gameState: { count: 99 }, player: null },
          after: { gameState: { count: 99 }, player: null },
          playerMoved: 0,
          changes: [],
        },
        qualifies: true,
        blockers: [],
        interaction: "fresh replay",
        timing: "controlled-clock" as const,
      } satisfies GameWebPlaytestResult;
    });
  return run as unknown as ReplayRun;
};

interface Fixture {
  readonly root: string;
  readonly otherRoot: string;
  readonly buildId: string;
  readonly candidateDir: string;
}

const withFixture = <A, E, R>(
  body: (
    input: Fixture & {
      readonly game: GameService.GameService["Service"];
      readonly fake: FakeControl;
    },
  ) => Effect.Effect<A, E, R>,
  options?: {
    readonly fake?: FakeControl;
    readonly run?: ReplayRun;
    readonly selected?: boolean;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = options?.fake ?? makeFake();
      const base = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "game-explore-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const root = NodePath.join(base, "game");
      const otherRoot = NodePath.join(base, "other");
      const stateDir = NodePath.join(base, "state");
      const current = manifest();
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "godot"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "godot/project.godot"),
          "[application]\n[display]\nwindow/size/viewport_width=640\nwindow/size/viewport_height=360\n",
        );
        await NodeFSP.writeFile(NodePath.join(root, "game.json"), `${JSON.stringify(current)}\n`);
      });
      // The recorded build is real bytes on disk; the round-store binding is
      // mocked, but the byte check reads these files.
      const placeholder = "0".repeat(64);
      const staging = NodePath.join(root, "builds/candidates", placeholder);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(staging, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(staging, "index.html"), "<html>explore</html>");
      });
      const hashed = yield* Effect.promise(() =>
        hashWebBuild(root, `builds/candidates/${placeholder}`),
      );
      if (hashed === null) throw new Error("Fixture build should hash");
      const buildId = hashed.buildId;
      const candidateDir = NodePath.join(root, "builds/candidates", buildId);
      yield* Effect.promise(() => NodeFSP.rename(staging, candidateDir));
      const selected =
        options?.selected === false
          ? null
          : {
              buildId,
              directory: `builds/candidates/${buildId}`,
              sourceId: "test-source",
              engine: "godot" as const,
              target: "Web" as const,
              entry: "index.html",
              promotedAt: "2026-10-20T00:00:00.000Z",
              roundId: null,
            };
      const services = GameService.layerWithExploreBrowser(fake.open, options?.run).pipe(
        Layer.provide(
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: (id) =>
              Effect.succeed(String(id) === String(otherRootThreadId) ? otherRoot : root),
            read: () => Effect.succeed(current),
          }),
        ),
        Layer.provide(
          Layer.mock(GameRoundStore.GameRoundStore)({
            read: () => Effect.succeed({ selected, rounds: [] }),
            exported: (_root, bid) =>
              Effect.succeed(
                bid === buildId
                  ? {
                      artifact: {
                        buildId,
                        directory: `builds/candidates/${buildId}`,
                        sourceId: "test-source",
                        engine: "godot" as const,
                        target: "Web" as const,
                        entry: "index.html",
                      },
                      sourceDirectory: root,
                      playtest: null,
                    }
                  : null,
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(GamePreview.GamePreview)({
            open: () => Effect.succeed("http://127.0.0.1:9/"),
            url: () => null,
            urlFor: () => null,
            directories: () => [],
            serving: () => false,
          }),
        ),
        Layer.provide(
          Layer.mock(PreviewBrowser.PreviewBrowser)({
            executable: Effect.succeed("/fake/browser"),
          }),
        ),
        Layer.provide(
          Layer.mock(GameDesignApproval.GameDesignApproval)({
            status: () => Effect.succeed(designRead()),
            snapshot: () => Effect.succeed({ read: designRead(), record: null }),
            readPolicy: () =>
              Effect.succeed({
                policy: {
                  testSuite: "res://tests/smoke_test.gd",
                  gameplayScene: null,
                  probe: false,
                },
                revision: "rev1",
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(GameProcesses.GameProcesses)({
            run: () => Effect.die("This test provides no engine run."),
            start: () => Effect.die("This test provides no native launch."),
            list: () => [],
            stop: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(GameToolchain.GameToolchain)({
            executable: () => Effect.die("This test provides no toolchain."),
            status: Effect.die("This test provides no toolchain."),
          }),
        ),
        Layer.provideMerge(qualificationTestLayer(stateDir)),
        Layer.provideMerge(admissionTestLayer),
      );
      return yield* Effect.gen(function* () {
        const game = yield* GameService.GameService;
        return yield* body({ root, otherRoot, buildId, candidateDir, game, fake });
      }).pipe(Effect.provide(services));
    }),
  );

it.effect("opens, continues state across acts and closes with a saved trace", () =>
  withFixture(({ game, buildId }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      expect(started.buildId).toBe(buildId);
      expect(started.viewport).toEqual({ width: 1280, height: 720 });
      expect(started.callsLeft).toBe(GAME_EXPLORE_BOUNDS.maxCalls);
      const first = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ press: "Space" }],
      });
      expect(first.callIndex).toBe(1);
      expect(first.executedInputSteps).toBe(1);
      expect(first.nominalMs).toBe(50);
      expect(first.probe).toEqual({ gameState: { count: 1 }, player: null });
      expect(first.consoleMessages).toEqual([{ level: "log", text: "observed 1 step(s)" }]);
      const second = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ key: "w", holdMs: 200 }],
      });
      expect(second.callIndex).toBe(2);
      expect(second.nominalMs).toBe(200);
      expect(second.totalNominalMs).toBe(250);
      // One browser session served both acts: the probe kept counting.
      expect(second.probe).toEqual({ gameState: { count: 2 }, player: null });
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.reason).toBe("closed");
      expect(closed.tracePath.endsWith("trace.json")).toBe(true);
      const trace = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(closed.tracePath, "utf8")),
      );
      expect(trace.buildId).toBe(buildId);
      expect(trace.timing).toBe("controlled-clock");
      expect(trace.actions.length).toBeGreaterThanOrEqual(2);
      expect(trace.actions.at(-1)?.steps).toEqual([{ key: "w", holdMs: 200 }]);
      expect(trace.closed?.reason).toBe("closed");
      // One persisted screenshot per act, plus the trace itself.
      expect(yield* Effect.promise(() => NodeFSP.stat(first.screenshotPath))).toBeDefined();
      expect(yield* Effect.promise(() => NodeFSP.stat(second.screenshotPath))).toBeDefined();
      expect(first.screenshotPath).not.toBe(second.screenshotPath);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("refuses a second live session until the first closes", () =>
  withFixture(({ game, buildId }) =>
    Effect.gen(function* () {
      const first = yield* game.exploreStart(threadId, { buildId });
      const busy = yield* game.exploreStart(threadId, { buildId }).pipe(Effect.flip);
      expect(String(busy.detail ?? busy.message)).toContain("already open");
      yield* game.exploreClose(threadId, { sessionId: first.sessionId });
      const again = yield* game.exploreStart(threadId, { buildId });
      expect(again.sessionId).not.toBe(first.sessionId);
      const closed = yield* game.exploreClose(threadId, { sessionId: again.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("counts only explicit durations toward nominal time", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      // Captures and probe reads cost wall time but no game time: the act
      // accounts exactly the route's explicit durations.
      const acted = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ press: "Space" }, { waitMs: 300 }, { screenshot: "look" }],
      });
      expect(acted.executedInputSteps).toBe(1);
      expect(acted.nominalMs).toBe(350);
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("refuses unknown, cross-thread and cross-root sessions", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const unknown = yield* game
        .exploreAct(threadId, { sessionId: "nope", steps: [{ press: "Space" }] })
        .pipe(Effect.flip);
      expect(String(unknown.detail ?? unknown.message)).toContain("unknown or expired");
      const started = yield* game.exploreStart(threadId, {});
      const crossThread = yield* game
        .exploreAct(otherThreadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] })
        .pipe(Effect.flip);
      expect(String(crossThread.detail ?? crossThread.message)).toContain("another thread");
      const crossRoot = yield* game
        .exploreAct(otherRootThreadId, {
          sessionId: started.sessionId,
          steps: [{ press: "Space" }],
        })
        .pipe(Effect.flip);
      expect(String(crossRoot.detail ?? crossRoot.message)).toContain("another game");
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("rejects per-call step and time budgets", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      const tooMany = yield* game
        .exploreAct(threadId, {
          sessionId: started.sessionId,
          steps: Array.from({ length: GAME_EXPLORE_BOUNDS.maxStepsPerCall + 1 }, () => ({
            press: "Space",
          })),
        })
        .pipe(Effect.flip);
      expect(String(tooMany.detail ?? tooMany.message)).toContain("per act");
      const tooLong = yield* game
        .exploreAct(threadId, {
          sessionId: started.sessionId,
          steps: [{ key: "w", holdMs: GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall + 1 }],
        })
        .pipe(Effect.flip);
      expect(String(tooLong.detail ?? tooLong.message)).toContain("at most");
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("a failed open saves no session and a retry opens cleanly", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      fake.state.failOpen = new GameOperationError({
        operation: "Explore session",
        path: "fake",
        reason: "command-failed",
        detail: "fake boot blew up",
      });
      const failed = yield* game.exploreStart(threadId, {}).pipe(Effect.flip);
      expect(String(failed.detail ?? failed.message)).toContain("fake boot blew up");
      // No session leaked: a retry with a working browser opens cleanly.
      const started = yield* game.exploreStart(threadId, {});
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("an interrupted act still closes cleanly", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      // The fake browser blocks inside the act; cancelling the caller must not
      // wedge the session: close still releases everything.
      const entered = plainGate();
      fake.state.actStarted.push(() => entered.resolve());
      const blocker = plainGate();
      fake.state.actGate = blocker;
      const fiber = yield* forkTest(
        game.exploreAct(threadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      blocker.resolve();
      fake.state.actGate = null;
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.reason).toBe("act-failed");
      expect(fake.state.closes).toBe(1);
      const replay = yield* Effect.result(
        game.exploreReplay(threadId, { traceId: closed.traceId }),
      );
      expect(replay._tag).toBe("Failure");
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("an interrupted open removes its scratch and leaks no session", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const entered = plainGate();
      fake.state.openStarted.push(() => entered.resolve());
      const blocker = plainGate();
      fake.state.openGate = blocker;
      const fiber = yield* forkTest(game.exploreStart(threadId, {}));
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      // The open raced the abort; the profile it made is already gone and
      // the next start proves nothing lingered.
      blocker.resolve();
      fake.state.openGate = null;
      const started = yield* game.exploreStart(threadId, {});
      expect(fake.state.abortedOpens).toBe(1);
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("idle expiry saves its reason and removes the profile", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      yield* TestClock.adjust(Duration.millis(GAME_EXPLORE_BOUNDS.idleTtlMs + 60_000));
      const expired = yield* game
        .exploreAct(threadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] })
        .pipe(Effect.flip);
      // The scoped reaper usually finalizes first; the lazy check covers a
      // missed sweep. Either way the saved reason is the expiry, not a close.
      expect(String(expired.detail ?? expired.message)).toContain("expired");
      const traceFile = NodePath.join(
        NodeOS.tmpdir(),
        "game-explore",
        started.sessionId,
        "trace.json",
      );
      const trace = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(traceFile, "utf8")));
      expect(trace.closed?.reason).toBe("idle-expired");
      const profileMissing = yield* Effect.promise(() =>
        NodeFSP.stat(
          NodePath.join(NodeOS.tmpdir(), "game-explore", started.sessionId, "profile"),
        ).then(
          () => false,
          () => true,
        ),
      );
      expect(profileMissing).toBe(true);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(NodeOS.tmpdir(), "game-explore", started.sessionId), {
          recursive: true,
          force: true,
        }),
      );
    }),
  ),
);

it.effect("the reaper expires an untouched session without any caller", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const finalized = plainGate();
      fake.state.onClose.push(() => finalized.resolve());
      const started = yield* game.exploreStart(threadId, {});
      const traceDir = NodePath.join(NodeOS.tmpdir(), "game-explore", started.sessionId);
      yield* TestClock.adjust(Duration.millis(GAME_EXPLORE_BOUNDS.idleTtlMs + 61_000));
      // Only the scoped reaper closes the browser: no act or close ran.
      yield* Effect.promise(() => finalized.promise);
      // The close serializes on the session lock, so it answers only after
      // the reaper's finalize saved the trace.
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.reason).toBe("idle-expired");
      yield* Effect.promise(() => NodeFSP.rm(traceDir, { recursive: true, force: true }));
    }),
  ),
);

it.effect("a tampered export refuses instead of exploring", () =>
  withFixture(({ game, candidateDir, buildId }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(candidateDir, "index.html"), "<html>tampered</html>"),
      );
      const refused = yield* game.exploreStart(threadId, { buildId }).pipe(Effect.flip);
      expect(String(refused.detail ?? refused.message)).toContain("changed after export");
      // Nothing registered: restoring the bytes lets the next start through.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(candidateDir, "index.html"), "<html>explore</html>"),
      );
      const started = yield* game.exploreStart(threadId, { buildId });
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("replay runs the saved sequence fresh against the same build", () => {
  const fake = makeFake();
  const seen: { calls: Array<{ profileDirectory: string; steps: readonly unknown[] }> } = {
    calls: [],
  };
  return withFixture(
    ({ game, buildId }) =>
      Effect.gen(function* () {
        const started = yield* game.exploreStart(threadId, {});
        yield* game.exploreAct(threadId, {
          sessionId: started.sessionId,
          steps: [{ press: "Space" }, { key: "w", holdMs: 200 }],
        });
        const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
        const replayed = yield* game.exploreReplay(threadId, { traceId: closed.traceId });
        expect(replayed.buildId).toBe(buildId);
        expect(replayed.evidenceDirectory).not.toBe(NodePath.dirname(closed.tracePath));
        expect(replayed.frames.length).toBeGreaterThan(0);
        for (const frame of replayed.frames)
          expect(frame.path.startsWith(replayed.evidenceDirectory)).toBe(true);
        // The fresh run's own probe, never the exploratory one.
        expect(replayed.state?.after).toEqual({ gameState: { count: 99 }, player: null });
        expect(replayed.message).toContain("Replay of exploration");
        expect(replayed.message).toContain("unknown");
        // One fresh browser run, on a fresh profile, with the saved steps.
        expect(seen.calls).toHaveLength(1);
        expect(seen.calls[0]!.profileDirectory).toContain(`replay-${closed.traceId}`);
        expect(seen.calls[0]!.steps).toEqual([{ press: "Space" }, { key: "w", holdMs: 200 }]);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
        );
        yield* Effect.promise(() =>
          NodeFSP.rm(replayed.evidenceDirectory, { recursive: true, force: true }),
        );
      }),
    { fake, run: makeReplayRun(seen) },
  );
});

it.effect("replay refuses while the exploratory session is still open", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ press: "Space" }],
      });
      const refused = yield* game
        .exploreReplay(threadId, { traceId: started.sessionId })
        .pipe(Effect.flip);
      expect(String(refused.detail ?? refused.message)).toContain(
        "close it with game_explore_close first",
      );
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("the trace stays within its persisted bounds", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      for (let call = 0; call < 4; call++)
        yield* game.exploreAct(threadId, {
          sessionId: started.sessionId,
          steps: [{ press: "Space" }, { key: "w", holdMs: 500 }],
        });
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      const text = yield* Effect.promise(() => NodeFSP.readFile(closed.tracePath, "utf8"));
      expect(text.length).toBeLessThan(GAME_EXPLORE_BOUNDS.maxTraceBytes);
      const trace = JSON.parse(text);
      expect(trace.actions.length).toBe(5);
      const pngs = yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(closed.tracePath)));
      expect(pngs.filter((file) => file.endsWith(".png"))).toHaveLength(4);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("a partially executed failed act closes its runtime and cannot claim exact replay", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      fake.state.failAct = true;
      const attempted = yield* Effect.result(
        game.exploreAct(threadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] }),
      );
      expect(attempted._tag).toBe("Failure");
      expect(fake.state.count).toBe(1);
      expect(fake.state.closes).toBe(1);
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.reason).toBe("act-failed");
      const trace = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(closed.tracePath, "utf8")),
      );
      expect(trace.actions.at(-1).execution).toBe("unknown");
      const replay = yield* Effect.result(
        game.exploreReplay(threadId, { traceId: closed.traceId }),
      );
      expect(replay._tag).toBe("Failure");
      const anotherAct = yield* Effect.result(
        game.exploreAct(threadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] }),
      );
      expect(anotherAct._tag).toBe("Failure");
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("closed summaries preserve thread and root leases", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      for (const caller of [otherThreadId, otherRootThreadId]) {
        const result = yield* Effect.result(
          game.exploreClose(caller, { sessionId: started.sessionId }),
        );
        expect(result._tag).toBe("Failure");
      }
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("replay rejects path traversal, malformed steps, and incomplete traces", () =>
  withFixture(({ game }) =>
    Effect.gen(function* () {
      const traversal = yield* Effect.result(
        game.exploreReplay(threadId, { traceId: "../../foreign" }),
      );
      expect(traversal._tag).toBe("Failure");
      const started = yield* game.exploreStart(threadId, {});
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      const original = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(closed.tracePath, "utf8")),
      );
      for (const modified of [
        { ...original, actions: [{ steps: [null] }] },
        { ...original, closed: null },
      ]) {
        yield* Effect.promise(() => NodeFSP.writeFile(closed.tracePath, JSON.stringify(modified)));
        const replay = yield* Effect.result(
          game.exploreReplay(threadId, { traceId: closed.traceId }),
        );
        expect(replay._tag).toBe("Failure");
      }
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("a failed trace save reports failure while releasing the browser", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      const acted = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ press: "Space" }],
      });
      const directory = NodePath.dirname(acted.screenshotPath);
      yield* Effect.promise(async () => {
        await NodeFSP.unlink(NodePath.join(directory, "trace.json"));
        await NodeFSP.mkdir(NodePath.join(directory, "trace.json"));
      });
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.traceSaved).toBe(false);
      expect(closed.message).toContain("Saving the trace failed");
      expect(fake.state.closes).toBe(1);
      const retry = yield* game.exploreStart(threadId, {});
      const retried = yield* game.exploreClose(threadId, { sessionId: retry.sessionId });
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(retried.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("an idle reaper waiting behind an act rechecks its renewed activity", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      const entered = plainGate();
      fake.state.actStarted.push(() => entered.resolve());
      const blocked = plainGate();
      fake.state.actGate = blocked;
      const acting = yield* forkTest(
        game.exploreAct(threadId, { sessionId: started.sessionId, steps: [{ press: "Space" }] }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(Duration.millis(GAME_EXPLORE_BOUNDS.idleTtlMs + 30000));
      blocked.resolve();
      fake.state.actGate = null;
      yield* Fiber.join(acting);
      yield* TestClock.adjust(Duration.seconds(30));
      expect(fake.state.closes).toBe(0);
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      expect(closed.reason).toBe("closed");
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);

it.effect("a multi-input act persists one observation with exact nominal time", () =>
  withFixture(({ game, fake }) =>
    Effect.gen(function* () {
      const started = yield* game.exploreStart(threadId, {});
      const first = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ press: "Space" }, { waitMs: 200 }, { key: "w", holdMs: 80 }],
      });
      expect(first.executedInputSteps).toBe(2);
      expect(first.nominalMs).toBe(330);
      const second = yield* game.exploreAct(threadId, {
        sessionId: started.sessionId,
        steps: [{ click: "left" }, { waitMs: 100 }, { screenshot: "mid" }],
      });
      expect(second.executedInputSteps).toBe(1);
      expect(second.nominalMs).toBe(100);
      expect(second.totalNominalMs).toBe(430);
      // Handoff keeps route order; the session threads the global index.
      expect(fake.state.acts).toHaveLength(2);
      expect(fake.state.acts[0]!.firstStepIndex).toBe(0);
      expect(fake.state.acts[0]!.steps).toEqual([
        { press: "Space" },
        { waitMs: 200 },
        { key: "w", holdMs: 80 },
      ]);
      expect(fake.state.acts[1]!.firstStepIndex).toBe(3);
      // One persisted frame per act even though the acts carried several inputs.
      expect(first.screenshotPath).not.toBe(second.screenshotPath);
      const closed = yield* game.exploreClose(threadId, { sessionId: started.sessionId });
      const trace = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(closed.tracePath, "utf8")),
      );
      expect(trace.actions.slice(-2).map((action: { steps: unknown }) => action.steps)).toEqual([
        [{ press: "Space" }, { waitMs: 200 }, { key: "w", holdMs: 80 }],
        [{ click: "left" }, { waitMs: 100 }, { screenshot: "mid" }],
      ]);
      const pngs = yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(closed.tracePath)));
      expect(pngs.filter((file) => file.endsWith(".png"))).toHaveLength(2);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.dirname(closed.tracePath), { recursive: true, force: true }),
      );
    }),
  ),
);
