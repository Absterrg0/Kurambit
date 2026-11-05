// @effect-diagnostics nodeBuiltinImport:off -- The role test's game folder is a real git checkout on disk.
// A production run on the orchestration core survives what a restart does to
// it: no job is lost for good, nothing that finished runs again, a stopped run
// stays stopped, a decision's default needs no fiber, a role's finished turn
// still lands, and a role's submission of the wrong kind is refused to it.
// Real orchestrator, event sink and outbox over SQLite; the effect worker is
// drained by hand and every wait is on a persisted record, never a sleep.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GameRunId,
  type GameRunStep,
  type GameRunStepResult,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@kurambit/provider-core/server/ProviderAdapter";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import * as GameRunRecovery from "../../orchestration-v2/gameRun/GameRunRecovery.ts";
import { roleThreadId, roleTurnMessageId } from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as TurnAdmission from "../../orchestration-v2/TurnAdmission.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameRun from "../GameRun.ts";
import * as GameRunControl from "../GameRunControl.ts";
import * as GameService from "../GameService.ts";
import * as GameRunRoleReactor from "./GameRunRoleReactor.ts";
import * as GameRunStepRunner from "./GameRunStepRunner.ts";
import * as Policy from "./policy.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:game");
const creator = ThreadId.make("thread:game-creator");
const runId = GameRunId.make("run_core");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A game run's core starts no provider session here."),
} as ProviderAdapter.ProviderAdapterV2["Service"];

// The creator's chat is held, so a decision's wake starts no provider turn.
const refuseTurns = Layer.succeed(TurnAdmission.TurnAdmission, {
  admit: () => Effect.fail(new TurnAdmission.TurnAdmissionRejectedError({ detail: "held" })),
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerCore = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "game-run-core" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(layerDatabase), Layer.provide(refuseTurns));
const layerWithRecovery = GameRunRecovery.layer.pipe(Layer.provideMerge(layerCore));

const createCreator = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-creator"),
    threadId: creator,
    projectId,
    title: "Arena",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/games/arena",
    createdBy: "user",
    creationSource: "web",
  });
});

let commands = 0;
const nextId = () => CommandId.make(`test-command-${++commands}`);

const startRun = (profile: "guided" | "autopilot") =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "game-run.start",
      commandId: nextId(),
      threadId: creator,
      runId,
      lane: "godot",
      brief: "A small arena game.",
      profile,
      modelSelection,
      runtimeMode: "full-access",
    }),
  );

const inFlight = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const records = yield* projections.getGameRunRecords(creator);
  const run = records.gameRuns.at(-1)!;
  return {
    run,
    step: records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null,
    steps: records.gameRunSteps,
  };
});

const completeStep = (step: GameRunStep, result: GameRunStepResult) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "game-run.step.complete",
      commandId: gameRunStepCommandId(step.id, step.attempt, "complete"),
      threadId: creator,
      runId,
      stepId: step.id,
      attempt: step.attempt,
      result,
    }),
  );

const gitOk: GameRunStepResult = {
  kind: "git",
  git: {
    ok: true,
    sha: "c0ffee",
    branch: "main",
    changed: true,
    entered: false,
    lines: 10,
    detail: "",
    same: false,
  },
};

/** Resolves once the step's record is committed with that status, counting from now. */
const awaitStep = (stepId: string, status: GameRunStep["status"]) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const from = yield* sink.latestSequence();
    return yield* sink.stream({ afterSequence: from }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "game-run-step.updated" &&
          event.payload.id === stepId &&
          event.payload.status === status,
      ),
      Stream.runHead,
      Effect.forkScoped,
    );
  });

/** A runner standing in for the game layer: it counts each step it is handed and lands git steps. */
const countingRunner = Effect.gen(function* () {
  const handed: string[] = [];
  const arrivals = yield* Queue.unbounded<string>();
  const hold = yield* Deferred.make<void>();
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const runner: GameRunJobs.GameRunJobRunner = {
    execute: (job) =>
      Effect.gen(function* () {
        handed.push(`${job.stepId}#${job.attempt}`);
        yield* Queue.offer(arrivals, `${job.stepId}#${job.attempt}`);
        yield* Deferred.await(hold);
        const { step } = yield* inFlight;
        if (step?.id !== job.stepId || step.kind !== "git") return;
        yield* completeStep(step, gitOk);
      }).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
        Effect.orDie,
      ),
    deadline: () => Effect.void,
  };
  yield* (yield* GameRunJobs.GameRunJobs).attach(runner);
  const jobs = yield* GameRunJobs.GameRunJobs;
  return {
    handed,
    /** The next job the runner was handed. */
    next: Queue.take(arrivals),
    live: (stepId: string, attempt: number) => jobs.isLive(`execute:${stepId}:attempt:${attempt}`),
    release: Deferred.succeed(hold, undefined),
  };
});

it.effect(
  "a job a restart lost runs again once, and a step that finished never does",
  () =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      const { handed, next, release } = yield* countingRunner;
      const recovery = yield* GameRunRecovery.GameRunRecovery;
      const first = (yield* inFlight).step!;
      // The step's effect never ran: the server stopped before the worker claimed it.
      yield* recovery.recover();
      assert.equal(yield* next, `${first.id}#1`);
      // A second pass while the job is live hands nothing new.
      yield* recovery.recover();
      assert.deepEqual(handed, [`${first.id}#1`]);

      const landed = yield* awaitStep(first.id, "completed");
      yield* release;
      yield* Fiber.join(landed);
      const second = (yield* inFlight).step!;
      assert.notEqual(second.id, first.id);
      yield* recovery.recover();
      assert.equal(yield* next, `${second.id}#1`);
      assert.deepEqual(handed, [`${first.id}#1`, `${second.id}#1`]);
      // The outbox's own effects for the finished step change nothing either.
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.deepEqual(handed.filter((h) => h === `${first.id}#1`).length, 1);
      assert.equal((yield* inFlight).steps.find((s) => s.id === first.id)?.status, "completed");
    }).pipe(Effect.provide(layerWithRecovery)),
  20_000,
);

it.effect("a stopped run stays stopped across recovery, until a resume", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    const { handed, next, live } = yield* countingRunner;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.stop",
      commandId: nextId(),
      threadId: creator,
      runId,
      reason: "lunch",
    });
    const recovery = yield* GameRunRecovery.GameRunRecovery;
    yield* recovery.recover();
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    // A job is registered as it is handed over, so none means none was started.
    assert.isFalse(yield* live((yield* inFlight).step!.id, 1));
    assert.deepEqual(handed, []);
    assert.equal((yield* inFlight).run.ending, "stopped");

    yield* orchestrator.dispatch({
      type: "game-run.resume",
      commandId: nextId(),
      threadId: creator,
      runId,
    });
    yield* recovery.recover();
    assert.equal(yield* next, `${(yield* inFlight).step!.id}#2`);
  }).pipe(Effect.provide(layerWithRecovery)),
);

it.effect(
  "a decision takes its default from the deadline effect, with no fiber waiting on it",
  () =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("guided");
      // Through the creator's style decision, step by step, as the jobs would report.
      const planner = ThreadId.make("thread:vision");
      yield* completeStep((yield* inFlight).step!, gitOk);
      yield* completeStep((yield* inFlight).step!, {
        kind: "done",
        threadId: planner,
        evidence: null,
        timedOut: false,
        budgetCut: false,
        elapsedMs: 60_000,
        sourceBefore: "",
        sourceAfter: "",
        botsBefore: 0,
        botsAfter: 0,
        bot: null,
        sheet: "",
      });
      yield* completeStep((yield* inFlight).step!, { ...gitOk, git: { ...gitOk.git, sha: "s2" } });
      yield* completeStep((yield* inFlight).step!, {
        kind: "boot",
        ok: true,
        detail: "boot clean",
      });
      const waiting = yield* inFlight;
      assert.equal(waiting.run.status, "waiting");
      assert.equal(waiting.step?.kind, "decide");

      // Nothing runs a decision: only the outbox holds its deadline.
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.equal((yield* inFlight).run.status, "waiting");
      yield* TestClock.adjust(Policy.DECISION_DELIVERY_MS + 1_000);
      yield* worker.drain();
      const after = yield* inFlight;
      assert.equal(after.run.status, "running");
      assert.deepEqual(
        after.run.decided.map((d) => [d.kind, d.by]),
        [["style", "default"]],
      );
    }).pipe(Effect.provide(layerWithRecovery)),
);

// ── With the game layer's runner and role reactor. ─────────────────────────
const role = roleThreadId;
const turnRun = (stepId: GameRunStep["id"], status: OrchestrationV2Run["status"]) => {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 5, 10));
  return {
    id: RunId.make(`run:role:${stepId}`),
    ordinal: 1,
    userMessageId: roleTurnMessageId(stepId, 1, "turn", 1),
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: status === "completed" ? DateTime.add(at, { minutes: 5 }) : null,
  } as unknown as OrchestrationV2Run;
};

/** The role thread as T3 holds it: launched by the run under the creator, with one turn. */
const roleThreads = (runsOf: () => ReadonlyArray<OrchestrationV2Run>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const roleThread = (threadId: ThreadId) => ({
        id: threadId,
        projectId,
        launchedBy: "game_run" as const,
        lineage: { parentThreadId: creator, relationshipToParent: "role", rootThreadId: creator },
      });
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadShell: (threadId) =>
          threadId === creator
            ? orchestrator.getThreadShell(threadId)
            : Effect.succeed({
                ...roleThread(threadId),
                deletedAt: null,
                worktreePath: null,
                activeRunId: null,
              } as unknown as OrchestrationV2ThreadShell),
        getThreadRecords: ((threadId: ThreadId) =>
          Effect.succeed({
            thread: roleThread(threadId),
            runs: runsOf(),
            messages: [],
            turnItems: [],
          })) as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        getCommandReceipt: () => Effect.succeed(null),
      });
    }),
  );

const gameRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "game-run-core-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
};

const layerGame = (root: string, runsOf: () => ReadonlyArray<OrchestrationV2Run>) =>
  Layer.mergeAll(GameRunStepRunner.layer, GameRunControl.layerDomain).pipe(
    Layer.provideMerge(GameRunRoleReactor.layer),
    Layer.provide(
      Layer.mergeAll(
        roleThreads(runsOf),
        Layer.mock(GameService.GameService)({
          finishExploration: () =>
            Effect.succeed({
              sessions: 0,
              actions: 0,
              executedInputSteps: 0,
              nominalMs: 0,
              images: 0,
            }),
          exploreMemoryWait: () =>
            Effect.succeed({ waitedMs: 0, refusals: 0, refused: false, executedInputSteps: 0 }),
          limitExploreInput: () => Effect.void,
          closeLiveEditors: () => Effect.void,
        }),
        Layer.mock(GameProjectService.GameProjectService)({ resolve: () => Effect.succeed(root) }),
        Layer.mock(GameOperations.GameOperations)({
          current: () => null,
          run: () => null,
          recordRun: () => Effect.void,
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({}),
        Layer.mock(GameRun.GameRun)({}),
      ),
    ),
    Layer.provideMerge(layerWithRecovery),
  );

it.effect("a role step whose turn ended while the server was down lands from its thread", () => {
  const root = gameRoot();
  let runs: ReadonlyArray<OrchestrationV2Run> = [];
  return Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    yield* completeStep((yield* inFlight).step!, gitOk);
    const vision = (yield* inFlight).step!;
    assert.equal(vision.kind, "role");
    const thread = role(vision.id);
    // Before the restart: the role's thread was recorded and its turn ran to its end.
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.step.start",
      commandId: gameRunStepCommandId(vision.id, 1, "start"),
      threadId: creator,
      runId,
      stepId: vision.id,
      roleThreadId: thread,
      before: { source: "", bots: 0 },
    });
    runs = [turnRun(vision.id, "completed")];

    const runner = yield* GameRunStepRunner.GameRunStepRunner;
    yield* runner.start();
    const landed = yield* awaitStep(vision.id, "completed");
    yield* (yield* GameRunRecovery.GameRunRecovery).recover();
    yield* Fiber.join(landed);
    const done = (yield* inFlight).steps.find((s) => s.id === vision.id)!;
    assert.equal(done.result?.kind, "done");
    assert.equal(done.result?.kind === "done" ? done.result.threadId : null, thread);
    assert.notEqual((yield* inFlight).step?.id, vision.id);
  }).pipe(
    Effect.provide(layerGame(root, () => runs)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("a role's submission of the wrong kind is refused to it, with the reason", () => {
  const root = gameRoot();
  let runs: ReadonlyArray<OrchestrationV2Run> = [];
  return Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    yield* completeStep((yield* inFlight).step!, gitOk);
    const vision = (yield* inFlight).step!;
    const thread = role(vision.id);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.step.start",
      commandId: gameRunStepCommandId(vision.id, 1, "start"),
      threadId: creator,
      runId,
      stepId: vision.id,
      roleThreadId: thread,
    });
    runs = [turnRun(vision.id, "running")];
    const control = yield* GameRunControl.GameRunControl;
    const refused = yield* control
      .runSubmit(thread, { _tag: "verdict", verdict: "A", reasons: "It plays better." })
      .pipe(Effect.flip);
    assert.equal(refused.reason, "wrong-kind");
    assert.include(refused.message, "takes no submission");
    // Another thread never submits for the step.
    const stranger = yield* control
      .runSubmit(ThreadId.make("thread:stranger"), { _tag: "report", report: "r" })
      .pipe(Effect.flip);
    assert.equal(stranger.reason, "wrong-thread");
  }).pipe(
    Effect.provide(layerGame(root, () => runs)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});
