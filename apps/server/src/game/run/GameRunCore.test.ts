// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- The role tests' game folder is a real git checkout on disk, and their turns are timed against the runner's wall clock.
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
  GameOperationError,
  type GameRun as GameRunRecord,
  GameRunId,
  type GameRunStep,
  type GameRunStepResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  RunId,
  ThreadId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@kurambit/provider-core/server/ProviderAdapter";

import * as ServerSettings from "../../serverSettings.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as GameRunDecisions from "../../orchestration-v2/gameRun/GameRunDecisions.ts";
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
import * as ProjectService from "../../project/ProjectService.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameRunControl from "../GameRunControl.ts";
import * as GameService from "../GameService.ts";
import * as GameRunRoleReactor from "./GameRunRoleReactor.ts";
import * as GameRunStepRunner from "./GameRunStepRunner.ts";
import * as Policy from "./policy.ts";
import { runCopies } from "./roleWorkspace.ts";

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
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
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

const roleDone = (threadId: ThreadId): GameRunStepResult => ({
  kind: "done",
  threadId,
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

/** The ending's finish job reported (as a drained finish effect would): the run may move on. */
const finishEnding = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const { run } = yield* inFlight;
  yield* orchestrator.dispatch({
    type: "game-run.finished",
    commandId: nextId(),
    threadId: creator,
    runId: run.id,
    endedAt: run.endedAt!,
  });
});

const gitOk: GameRunStepResult = {
  kind: "build",
  build: { ok: true, sha: "c0ffee", changed: true, lines: 10, detail: "" },
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
  const finishes: string[] = [];
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
        if (step?.id !== job.stepId || step.kind !== "build") return;
        yield* completeStep(step, gitOk);
      }).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
        Effect.orDie,
      ),
    deadline: () => Effect.void,
    finish: (job) => Effect.sync(() => void finishes.push(job.endedAt)),
    restore: () => Effect.void,
    resend: () => Effect.void,
    outputs: () => Effect.void,
    releaseCopies: () => Effect.void,
    showable: () => Effect.succeed(true),
  };
  yield* (yield* GameRunJobs.GameRunJobs).attach(runner);
  const jobs = yield* GameRunJobs.GameRunJobs;
  return {
    handed,
    /** Each ending a finish job was handed for. */
    finishes,
    /** The next job the runner was handed. */
    next: Queue.take(arrivals),
    live: (stepId: string, attempt: number) => jobs.isLive(`execute:${stepId}:attempt:${attempt}`),
    release: Deferred.succeed(hold, undefined),
  };
});

it.effect(
  "recovery leaves an owed step to the outbox, wakes a lost job through it, and a finished step lands nothing more",
  () =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      const { handed, next, release } = yield* countingRunner;
      const recovery = yield* GameRunRecovery.GameRunRecovery;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const first = (yield* inFlight).step!;
      // The step's effect never ran: the server stopped before the worker
      // claimed it. Recovery leaves the step to that effect, in its order.
      yield* recovery.recover();
      assert.deepEqual(handed, []);
      yield* worker.drain();
      assert.equal(yield* next, `${first.id}#1`);
      // The effect is spent and the job lost to a restart: recovery wakes the
      // step through the outbox. The job still live here asks for one run after.
      yield* recovery.recover();
      yield* worker.drain();
      assert.deepEqual(handed, [`${first.id}#1`]);

      const landed = yield* awaitStep(first.id, "completed");
      yield* release;
      yield* Fiber.join(landed);
      // That run after finds the step done and lands nothing more.
      assert.equal(yield* next, `${first.id}#1`);
      const second = (yield* inFlight).step!;
      assert.notEqual(second.id, first.id);
      yield* recovery.recover();
      yield* worker.drain();
      assert.equal(yield* next, `${second.id}#1`);
      assert.deepEqual(handed, [`${first.id}#1`, `${first.id}#1`, `${second.id}#1`]);
      // The outbox's own effects for the finished step change nothing either.
      yield* worker.drain();
      assert.deepEqual(handed.filter((h) => h === `${first.id}#1`).length, 2);
      assert.equal((yield* inFlight).steps.find((s) => s.id === first.id)?.status, "completed");
    }).pipe(Effect.provide(layerWithRecovery)),
  20_000,
);

it.effect("recovery leaves an ending to its finish effect while the outbox still owes it", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    const { finishes } = yield* countingRunner;
    yield* stopRun;
    const recovery = yield* GameRunRecovery.GameRunRecovery;
    // The finish effect never ran: whatever the thread owes before it runs first.
    yield* recovery.recover();
    assert.deepEqual(finishes, []);
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    // The effect hands the finish to a job of its own.
    for (let turn = 0; turn < 100 && finishes.length === 0; turn += 1) yield* Effect.yieldNow;
    assert.deepEqual(finishes, [(yield* inFlight).run.endedAt]);
  }).pipe(Effect.provide(layerWithRecovery)),
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

    yield* finishEnding;
    yield* orchestrator.dispatch({
      type: "game-run.resume",
      commandId: nextId(),
      threadId: creator,
      runId,
    });
    yield* recovery.recover();
    yield* worker.drain();
    assert.equal(yield* next, `${(yield* inFlight).step!.id}#2`);
  }).pipe(Effect.provide(layerWithRecovery)),
);

it.effect(
  "a decision takes its default from the deadline effect, with no fiber waiting on it",
  () =>
    Effect.gen(function* () {
      yield* createCreator;
      // The runner only says the decision has something to show; nothing holds the wait.
      yield* countingRunner;
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
      yield* completeStep((yield* inFlight).step!, {
        ...gitOk,
        build: { ...gitOk.build, sha: "s2" },
      });
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

const refusalOf = <A, R>(dispatched: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>) =>
  dispatched.pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "OrchestratorGameRunRefusedError" ? error.reason : error._tag,
    ),
  );
const stopRun = Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
  orchestrator.dispatch({ type: "game-run.stop", commandId: nextId(), threadId: creator, runId }),
);
const resume = Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
  orchestrator.dispatch({ type: "game-run.resume", commandId: nextId(), threadId: creator, runId }),
);

it.effect(
  "an ending still finishing holds a resume, a steer and a restore until it is finished",
  () =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      yield* stopRun;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { run } = yield* inFlight;
      assert.equal(run.status, "ended");
      // Its finish effect has not run: the folder may still be moving to trunk.
      assert.equal(yield* refusalOf(resume), "finishing");
      assert.equal(
        yield* refusalOf(
          orchestrator.dispatch({
            type: "game-run.steer",
            commandId: nextId(),
            threadId: creator,
            runId,
            note: "More enemies.",
          }),
        ),
        "finishing",
      );
      assert.equal(
        yield* refusalOf(
          orchestrator.dispatch({
            type: "game-run.restore.request",
            commandId: nextId(),
            threadId: creator,
            runId,
            requestId: "r1",
            round: 1,
          }),
        ),
        "finishing",
      );
      yield* orchestrator.dispatch({
        type: "game-run.finished",
        commandId: nextId(),
        threadId: creator,
        runId,
        endedAt: run.endedAt!,
      });
      yield* resume;
      assert.equal((yield* inFlight).run.status, "running");
    }).pipe(Effect.provide(layerWithRecovery)),
);

it.effect("a restore is recorded first, holds a resume while pending, and lands as the best", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    yield* stopRun;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.finished",
      commandId: nextId(),
      threadId: creator,
      runId,
      endedAt: (yield* inFlight).run.endedAt!,
    });
    yield* orchestrator.dispatch({
      type: "game-run.restore.request",
      commandId: nextId(),
      threadId: creator,
      runId,
      requestId: "r1",
      round: 1,
    });
    assert.deepEqual((yield* inFlight).run.restore?.outcome, null);
    assert.equal(yield* refusalOf(resume), "restoring");
    yield* orchestrator.dispatch({
      type: "game-run.restore",
      commandId: nextId(),
      threadId: creator,
      runId,
      requestId: "r1",
      outcome: { kind: "restored", sha: "restored-sha", message: "back" },
    });
    const { run } = yield* inFlight;
    assert.equal(run.best, "restored-sha");
    assert.isNull(run.pending);
    yield* resume;
    assert.equal((yield* inFlight).run.status, "running");
  }).pipe(Effect.provide(layerWithRecovery)),
);

it.effect("a game has one run: another chat of its project cannot start a second", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const other = ThreadId.make("thread:second-chat");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: nextId(),
      threadId: other,
      projectId,
      title: "Arena, again",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/games/arena",
      createdBy: "user",
      creationSource: "web",
    });
    const second = orchestrator.dispatch({
      type: "game-run.start",
      commandId: nextId(),
      threadId: other,
      runId: GameRunId.make("run_second"),
      lane: "godot",
      brief: "Another game in the same folder.",
      modelSelection,
      runtimeMode: "full-access",
    });
    assert.equal(yield* refusalOf(second), "run-live");
  }).pipe(Effect.provide(layerWithRecovery)),
);

// A decision a resume asks again is a new question to the creator's chat.
const layerAdmitting = GameRunRecovery.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "game-run-core-admitting" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(Layer.provideMerge(layerDatabase)),
  ),
);

it.effect("a decision asked again after a resume wakes the creator's chat again", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* countingRunner;
    yield* startRun("guided");
    yield* completeStep((yield* inFlight).step!, gitOk);
    yield* completeStep((yield* inFlight).step!, roleDone(ThreadId.make("thread:vision")));
    yield* completeStep((yield* inFlight).step!, {
      ...gitOk,
      build: { ...gitOk.build, sha: "s2" },
    });
    yield* completeStep((yield* inFlight).step!, { kind: "boot", ok: true, detail: "boot clean" });
    const decisions = yield* GameRunDecisions.GameRunDecisions;
    const wake = Effect.gen(function* () {
      const { step } = yield* inFlight;
      if (step?.step.kind !== "decide") throw new Error("expected a decision");
      yield* decisions.wake({
        effectId: `wake-${step.attempt}`,
        threadId: creator,
        runId,
        stepId: step.id,
        decisionId: step.step.decision.id,
      });
    });
    yield* wake;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.stop",
      commandId: nextId(),
      threadId: creator,
      runId,
    });
    yield* finishEnding;
    yield* orchestrator.dispatch({
      type: "game-run.resume",
      commandId: nextId(),
      threadId: creator,
      runId,
    });
    assert.equal((yield* inFlight).step?.attempt, 2);
    yield* wake;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { messages } = yield* projections.getThreadRecords(creator, ["messages"]);
    assert.lengthOf(
      messages.filter((m) => m.id.startsWith("message:game-run-decision:")),
      2,
    );
  }).pipe(Effect.provide(layerAdmitting)),
);

// ── With the game layer's runner and role reactor. ─────────────────────────
/** What T3 holds of the role threads, as the run's game layer sees it. */
interface World {
  readonly runs: Map<ThreadId, OrchestrationV2Run[]>;
  readonly existing: Set<ThreadId>;
  readonly deleted: Set<ThreadId>;
  readonly receipts: Set<string>;
  /** Other chats of the game: T3 holds them as it holds the creator's. */
  readonly chats: Set<ThreadId>;
  readonly interrupts: Array<{ readonly threadId: ThreadId; readonly commandId: string }>;
  readonly launches: ThreadId[];
  readonly sends: Array<{ readonly threadId: ThreadId; readonly messageId: string }>;
  exportsAsked: number;
  /** Whose work each export was, as the run named it. */
  readonly exportOwners: Array<string | undefined>;
  /** The export breaks with a defect, as a rejected promise does. */
  exportsBreak: boolean;
  /** The game's project was deleted under the run. */
  projectDeleted: boolean;
  /** The game folder no longer resolves. */
  folderGone: boolean;
  /** Runs when the runner reads the creator's shell, which it does just before a role's start. */
  onCreatorShell: Effect.Effect<void> | null;
  /** Runs as a role turn is sent. */
  onSend: ((threadId: ThreadId, messageId: string) => void) | null;
  /** Runs, once, as a role turn is being sent, before it reaches the thread. */
  duringSend: Effect.Effect<void> | null;
  /** This many sends break before reaching the thread, as a server dying mid-send would. */
  sendBreaks: number;
  /** This many interrupts break before reaching the thread. */
  interruptBreaks: number;
  /** This many of the role reactor's reads of the run's records break. */
  recordsBreaks: number;
  /** Resolved once a role's cap watch reads its turn's memory waits. */
  readonly capWatched: Deferred.Deferred<void>;
  /** Resolved with each role thread launched. */
  readonly launched: Queue.Queue<ThreadId>;
  /** Each interrupt's command id, as it is sent. */
  readonly interrupted: Queue.Queue<string>;
  /** Each push of the run's move to the library and the Run view (its step, null once ended). */
  readonly pushes: Queue.Queue<string | null>;
}
const newWorld = Effect.gen(function* () {
  const world: World = {
    runs: new Map(),
    existing: new Set(),
    deleted: new Set(),
    receipts: new Set(),
    chats: new Set(),
    interrupts: [],
    launches: [],
    sends: [],
    exportsAsked: 0,
    exportOwners: [],
    exportsBreak: false,
    projectDeleted: false,
    folderGone: false,
    onCreatorShell: null,
    onSend: null,
    duringSend: null,
    sendBreaks: 0,
    interruptBreaks: 0,
    recordsBreaks: 0,
    capWatched: yield* Deferred.make<void>(),
    launched: yield* Queue.unbounded<ThreadId>(),
    interrupted: yield* Queue.unbounded<string>(),
    pushes: yield* Queue.unbounded<string | null>(),
  };
  return world;
});

let runOrdinal = 0;
const turnRun = (input: {
  readonly stepId: GameRunStep["id"];
  readonly status: OrchestrationV2Run["status"];
  readonly attempt?: number;
  readonly kind?: "turn" | "continue" | "retry" | "memory";
  readonly n?: number;
  readonly userMessageId?: string;
  readonly continues?: RunId;
  /** Ms ago the turn started; a few seconds by default. */
  readonly ago?: number;
  /** Ms the turn ran; past the instant-failure bound by default. */
  readonly ranMs?: number;
}) => {
  runOrdinal += 1;
  const startedAt = DateTime.makeUnsafe(Date.now() - (input.ago ?? 5_000));
  const settled = !["queued", "starting", "running", "waiting", "preparing"].includes(input.status);
  return {
    id: RunId.make(`run:role:${runOrdinal}`),
    ordinal: runOrdinal,
    userMessageId:
      input.userMessageId ??
      roleTurnMessageId(input.stepId, input.attempt ?? 1, input.kind ?? "turn", input.n ?? 1),
    status: input.status,
    requestedAt: startedAt,
    startedAt,
    completedAt: settled ? DateTime.add(startedAt, { milliseconds: input.ranMs ?? 60_000 }) : null,
    ...(input.continues === undefined ? {} : { restartContinuationOfRunId: input.continues }),
  } as unknown as OrchestrationV2Run;
};

const roleThreadsOf = (world: World) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const roleThread = (threadId: ThreadId) => ({
        id: threadId,
        projectId,
        // The game's chats are its own; every other thread here is a role's.
        ...(threadId === creator || world.chats.has(threadId)
          ? {}
          : { launchedBy: "game_run" as const }),
        lineage: { parentThreadId: creator, relationshipToParent: "role", rootThreadId: creator },
      });
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadShell: (threadId) =>
          world.chats.has(threadId)
            ? orchestrator.getThreadShell(threadId)
            : threadId === creator
              ? (world.onCreatorShell ?? Effect.void).pipe(
                  Effect.andThen(orchestrator.getThreadShell(threadId)),
                )
              : Effect.succeed(
                  world.existing.has(threadId)
                    ? ({
                        ...roleThread(threadId),
                        deletedAt: world.deleted.has(threadId)
                          ? DateTime.makeUnsafe(Date.now())
                          : null,
                        archivedAt: null,
                        worktreePath: null,
                        activeRunId: null,
                      } as unknown as OrchestrationV2ThreadShell)
                    : null,
                ),
        getThreadRecords: ((threadId: ThreadId) =>
          Effect.succeed({
            thread: roleThread(threadId),
            runs: world.runs.get(threadId) ?? [],
            messages: [],
            turnItems: [],
          })) as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        getThreadProjection: orchestrator.getThreadProjection,
        getCommandReceipt: (commandId) =>
          Effect.succeed(
            world.receipts.has(commandId)
              ? { status: "accepted" as const, threadId: creator, commandType: "run.interrupt" }
              : null,
          ),
        interruptThread: (input) =>
          Effect.suspend(() =>
            world.interruptBreaks-- > 0 ? Effect.die("interrupt broke") : Effect.void,
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                world.interrupts.push({ threadId: input.threadId, commandId: input.commandId });
                world.receipts.add(input.commandId);
              }),
            ),
            Effect.andThen(Queue.offer(world.interrupted, input.commandId)),
            Effect.as({ type: "no_active_run" as const }),
          ),
        sendToThread: (input) =>
          Effect.suspend(() =>
            world.sendBreaks-- > 0 ? Effect.die("send broke") : Effect.void,
          ).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const during = world.duringSend ?? Effect.void;
                world.duringSend = null;
                return during;
              }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                world.sends.push({ threadId: input.threadId, messageId: input.messageId });
                world.onSend?.(input.threadId, input.messageId);
                return {} as never;
              }),
            ),
          ),
      });
    }),
  );

/** The game folder, kept for a test that adds files of its own. */
let lastRoot = "";
const gameRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "game-run-core-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  lastRoot = root;
  return root;
};

const layerGame = (root: string, world: World) => {
  // One config for the runner and the test, which looks in the run's copies folder.
  const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "game-run-core-config-",
  }).pipe(Layer.provide(NodeServices.layer));
  // The role reactor reads the run's records through a store whose reads can break.
  const reactorProjections = Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.map(ProjectionStore.ProjectionStoreV2, (real) => ({
      ...real,
      getGameRunRecords: (threadId, filter) =>
        world.recordsBreaks-- > 0
          ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
          : real.getGameRunRecords(threadId, filter),
    })),
  );
  return Layer.mergeAll(GameRunStepRunner.layer, GameRunControl.layer).pipe(
    Layer.provideMerge(GameRunRoleReactor.layer.pipe(Layer.provide(reactorProjections))),
    Layer.provide(
      Layer.mergeAll(
        layerConfig,
        // The run's builds are real checkpoints of the temp game repository.
        CheckpointStore.layer.pipe(
          Layer.provide(
            VcsDriverRegistry.layer.pipe(
              Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
        roleThreadsOf(world),
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
            Deferred.succeed(world.capWatched, undefined).pipe(
              Effect.as({ waitedMs: 0, refusals: 0, refused: false, executedInputSteps: 0 }),
            ),
          limitExploreInput: () => Effect.void,
          closeLiveEditors: () => Effect.void,
          exportTargets: (_threadId, owner) =>
            Effect.sync(() => {
              world.exportsAsked += 1;
              world.exportOwners.push(owner);
              if (world.exportsBreak) throw new Error("disk gone");
              return { targets: [], displayName: "Arena" };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              world.projectDeleted ? Option.none() : Option.some({ id: projectId } as never),
            ),
        }),
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () =>
            world.folderGone
              ? Effect.fail(
                  new GameOperationError({
                    operation: "resolve-thread",
                    path: root,
                    reason: "project-not-found",
                  }),
                )
              : Effect.succeed(root),
          read: () =>
            Effect.fail(
              new GameOperationError({ operation: "read", path: root, reason: "invalid-input" }),
            ),
        }),
        Layer.mock(GameOperations.GameOperations)({
          current: () => null,
          runChanged: (_root, step) => Queue.offer(world.pushes, step).pipe(Effect.asVoid),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              const threadId = input.threadId!;
              world.launches.push(threadId);
              world.existing.add(threadId);
              yield* Queue.offer(world.launched, threadId);
              return { threadId } as never;
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
      ),
    ),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(layerWithRecovery),
  );
};

/** A test against a git game folder of its own, removed after. */
const withGame = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(newWorld, (world) => {
    const root = gameRoot();
    return body(world).pipe(
      Effect.provide(layerGame(root, world)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  });

/** The run at its vision role, on the attempt's own thread, recorded as the runner records it. */
const atVision = (world: World) =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    yield* completeStep((yield* inFlight).step!, gitOk);
    const vision = (yield* inFlight).step!;
    assert.equal(vision.kind, "role");
    const thread = roleThreadId(vision.id, 1);
    yield* recordThread(vision.id, 1, thread);
    world.existing.add(thread);
    return { vision, thread };
  });
const recordThread = (stepId: GameRunStep["id"], attempt: number, thread: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "game-run.step.start",
      commandId: CommandId.make(`${gameRunStepCommandId(stepId, attempt, "start")}:${thread}`),
      threadId: creator,
      runId,
      stepId,
      roleThreadId: thread,
      before: { source: "", bots: 0 },
    }),
  );

/** Resolves once the run's record is committed matching `ok`, counting from now. */
const awaitRun = (ok: (run: GameRunRecord) => boolean) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const from = yield* sink.latestSequence();
    return yield* sink.stream({ afterSequence: from }).pipe(
      Stream.filter(
        ({ event }) =>
          (event.type === "game-run.updated" || event.type === "game-run.created") &&
          ok(event.payload),
      ),
      Stream.runHead,
      Effect.forkScoped,
    );
  });

const startRunner = Effect.flatMap(GameRunStepRunner.GameRunStepRunner, (runner) => runner.start());
/** A restart's recovery, and the outbox that carries out what it leaves or asks for. */
const recover = Effect.gen(function* () {
  yield* (yield* GameRunRecovery.GameRunRecovery).recover();
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
});
/** Recovery, with the cap the step's job sets as a timer for the turn it finds or sends, fired. */
const recoverAndCap = Effect.gen(function* () {
  const scheduled = yield* awaitRun(() => true);
  yield* recover;
  yield* Fiber.join(scheduled);
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
});

it.effect("a role step whose turn ended while the server was down lands from its thread", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "completed" })]);
      yield* startRunner;
      const landed = yield* awaitStep(vision.id, "completed");
      yield* recover;
      yield* Fiber.join(landed);
      const done = (yield* inFlight).steps.find((s) => s.id === vision.id)!;
      assert.equal(done.result?.kind === "done" ? done.result.threadId : null, thread);
      assert.notEqual((yield* inFlight).step?.id, vision.id);
    }),
  ),
);

it.effect("a turn a server restart cut off lands only when its continuation ends", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      // The restart cancelled the turn and continued it in a run of its own.
      const cut = turnRun({ stepId: vision.id, status: "cancelled" });
      const going = turnRun({
        stepId: vision.id,
        status: "running",
        userMessageId: `message:restart-continuation:${cut.id}`,
        continues: cut.id,
      });
      world.runs.set(thread, [cut, going]);
      yield* startRunner;
      yield* recoverAndCap;
      // The step's job reattached and watches the continuation's cap.
      yield* Deferred.await(world.capWatched);
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      // The cancelled turn's own settling lands nothing while its continuation works.
      assert.isNull(yield* roles.settle(thread, cut));
      assert.equal((yield* inFlight).step?.id, vision.id);

      const ended = { ...going, status: "completed" } as OrchestrationV2Run;
      world.runs.set(thread, [cut, ended]);
      const landed = yield* awaitStep(vision.id, "completed");
      yield* roles.settle(thread, ended);
      yield* Fiber.join(landed);
    }),
  ),
);

it.effect(
  "a turn a restart cut off with no continuation is continued by its run, never landed",
  () =>
    withGame((world) =>
      Effect.gen(function* () {
        const { vision, thread } = yield* atVision(world);
        const cut = turnRun({ stepId: vision.id, status: "cancelled" });
        world.runs.set(thread, [cut]);
        world.onSend = (threadId, messageId) => {
          world.runs.set(threadId, [
            ...(world.runs.get(threadId) ?? []),
            turnRun({ stepId: vision.id, status: "running", userMessageId: messageId }),
          ]);
        };
        const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
        // The reactor hands a cut-off turn to its step instead of landing it.
        assert.equal(yield* roles.settle(thread, cut), "continue");
        yield* startRunner;
        yield* recoverAndCap;
        // The step's job continued the turn with its own prompt and watches its cap.
        yield* Deferred.await(world.capWatched);
        assert.deepEqual(
          world.sends.map((send) => send.messageId),
          [roleTurnMessageId(vision.id, 1, "continue", 2)],
        );
        const held = yield* inFlight;
        assert.equal(held.step?.id, vision.id);
        assert.isNull(held.step?.result ?? null);

        // A turn every restart cuts off ends the run resumably instead of looping.
        world.onSend = null;
        world.runs.set(thread, [
          cut,
          turnRun({ stepId: vision.id, status: "cancelled", kind: "continue", n: 2 }),
          turnRun({ stepId: vision.id, status: "cancelled", kind: "continue", n: 3 }),
        ]);
        const ended = yield* awaitRun((run) => run.ending !== null);
        yield* recover;
        yield* Fiber.join(ended);
        assert.equal((yield* inFlight).run.ending, "failed");
        assert.lengthOf(world.sends, 1);
      }),
    ),
);

it.effect("a continued turn's cap runs from where the cut turn's work began", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      // The cut turn had worked past the vision cap before the restart.
      world.runs.set(thread, [
        turnRun({ stepId: vision.id, status: "cancelled", ago: 11 * 60_000 }),
      ]);
      world.onSend = (threadId, messageId) => {
        world.runs.set(threadId, [
          ...(world.runs.get(threadId) ?? []),
          turnRun({ stepId: vision.id, status: "running", userMessageId: messageId, ago: 1_000 }),
        ]);
      };
      // The cap is checked on the run's clock.
      yield* TestClock.setTime(Date.now());
      yield* startRunner;
      yield* recoverAndCap;
      assert.match(yield* Queue.take(world.interrupted), /^server:game-run-role-cap:/);
    }),
  ),
);

it.effect("a stop interrupts the live role turn and stops its jobs, from its outbox effect", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      yield* startRunner;
      yield* recoverAndCap;
      // The cap is checked and set again as a durable timer at its due time.
      yield* Deferred.await(world.capWatched);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "game-run.stop",
        commandId: nextId(),
        threadId: creator,
        runId,
      });
      // No live tail saw the stop: only the effect it committed finishes it.
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      // The stop cancelled the cap's timer: past the cap, nothing caps the turn again.
      yield* TestClock.setTime(Date.now() + 11 * 60_000);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.isFalse(
        world.interrupts.some((i) => i.commandId.startsWith("server:game-run-role-cap:")),
      );
      assert.deepEqual(
        world.interrupts.map((i) => i.threadId),
        [thread],
      );
      assert.equal(world.exportsAsked, 0);
    }),
  ),
);

it.effect("an ending returns to trunk and exports, from its outbox effect", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      yield* completeStep(vision, {
        kind: "ended",
        ending: "usage-limit",
        reason: "usage limit until noon",
      });
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      assert.equal(world.exportsAsked, 1);
      // The run's own work: a Stop game from the creator's chat never cancels it.
      assert.deepEqual(world.exportOwners, [`game-run:${runId}`]);
      assert.deepEqual(
        world.interrupts.map((i) => i.threadId),
        [thread],
      );
    }),
  ),
);

it.effect("an ending whose finish breaks is still recorded, so the run can resume", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision } = yield* atVision(world);
      world.exportsBreak = true;
      yield* completeStep(vision, {
        kind: "ended",
        ending: "usage-limit",
        reason: "usage limit until noon",
      });
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      assert.equal(world.exportsAsked, 1);
      const { run } = yield* inFlight;
      assert.equal(run.finished, run.endedAt);
    }),
  ),
);

it.effect("deleting the creator chat stops its run, which holds the game until it finished", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: (yield* inFlight).step!.id, status: "running" })]);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: nextId(),
        threadId: creator,
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const stopped = (yield* projections.getGameRunRecords(creator)).gameRuns.at(-1)!;
      assert.equal(stopped.ending, "stopped");
      // Its finish still works the folder, so the game is still this run's.
      assert.equal((yield* projections.getProjectGameRun(projectId))?.id, runId);
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      // The finish stopped the role and was recorded on the deleted chat; the game is free.
      assert.deepEqual(
        world.interrupts.map((i) => i.threadId),
        [thread],
      );
      assert.isNull(yield* projections.getProjectGameRun(projectId));
    }),
  ),
);

it.effect("a run whose chat is deleted keeps none of its copies, though it ended stopped", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision } = yield* atVision(world);
      // A blind player's copy the stopped step held: a resume would play on in it.
      const config = yield* ServerConfig.ServerConfig;
      const copies = runCopies(config.worktreesDir, runId);
      const copy = NodePath.join(copies, `step-${vision.seq}`);
      NodeFS.mkdirSync(copy, { recursive: true });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: nextId(),
        threadId: creator,
      });
      assert.equal((yield* inFlight).run.ending, "stopped");
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      // Nothing can resume a run on a deleted chat, so its finish removed the copy.
      assert.isFalse(NodeFS.existsSync(copy));
    }),
  ),
);

it.effect("a spent run frees every copy from its own thread's effect", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision } = yield* atVision(world);
      const config = yield* ServerConfig.ServerConfig;
      const copies = runCopies(config.worktreesDir, runId);
      const copy = NodePath.join(copies, `step-${vision.seq}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // A run whose chat is gone: nothing resumes it.
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: nextId(),
        threadId: creator,
      });
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      yield* Fiber.join(finished);
      // A copy left by a role still at work when the finish ran.
      NodeFS.mkdirSync(copy, { recursive: true });
      yield* orchestrator.dispatch({
        type: "game-run.copies.spend",
        commandId: nextId(),
        threadId: creator,
        runId,
        keepMs: 0,
      });
      assert.isTrue(NodeFS.existsSync(copy));
      yield* worker.drain();
      assert.isFalse(NodeFS.existsSync(copy));
    }),
  ),
);

it.effect("a finish that breaks before the folder still stops the run's role turns", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      yield* completeStep(vision, {
        kind: "ended",
        ending: "usage-limit",
        reason: "usage limit until noon",
      });
      world.folderGone = true;
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* startRunner;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* Fiber.join(finished);
      assert.deepEqual(
        world.interrupts.map((i) => i.threadId),
        [thread],
      );
    }),
  ),
);

it.effect("recovery finishes an ending whose finish never completed, and only once", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision } = yield* atVision(world);
      yield* completeStep(vision, { kind: "ended", ending: "provider-down", reason: "down" });
      // The server stopped before the finish effect ran.
      yield* startRunner;
      const finished = yield* awaitRun((run) => run.finished !== null);
      yield* recover;
      yield* Fiber.join(finished);
      assert.equal(world.exportsAsked, 1);
      yield* recover;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.equal(world.exportsAsked, 1);
    }),
  ),
);

it.effect("a role launches nothing once the run refuses its start", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      yield* completeStep((yield* inFlight).step!, gitOk);
      const vision = (yield* inFlight).step!;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // The run stops after the job read its step and before the role's start.
      world.onCreatorShell = orchestrator
        .dispatch({ type: "game-run.stop", commandId: nextId(), threadId: creator, runId })
        .pipe(Effect.asVoid, Effect.orDie);
      const runner = yield* GameRunStepRunner.GameRunStepRunner;
      yield* runner.execute({ threadId: creator, runId, stepId: vision.id, attempt: 1 });
      assert.equal((yield* inFlight).run.ending, "stopped");
      assert.deepEqual(world.launches, []);
    }),
  ),
);

it.effect("a role is never launched into a deleted project; its step fails instead", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      yield* completeStep((yield* inFlight).step!, gitOk);
      const vision = (yield* inFlight).step!;
      world.projectDeleted = true;
      const runner = yield* GameRunStepRunner.GameRunStepRunner;
      yield* runner.execute({ threadId: creator, runId, stepId: vision.id, attempt: 1 });
      assert.deepEqual(world.launches, []);
      const { run } = yield* inFlight;
      assert.equal(run.ending, "failed");
      assert.match(run.lastFailure ?? "", /its project was deleted/);
    }),
  ),
);

/** The vision step ended on a usage limit after its first turn, then resumed as attempt 2. */
const resumedVision = (world: World) =>
  Effect.gen(function* () {
    const { vision, thread } = yield* atVision(world);
    world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed" })]);
    yield* completeStep(vision, { kind: "ended", ending: "usage-limit", reason: "limit" });
    yield* finishEnding;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "game-run.resume",
      commandId: nextId(),
      threadId: creator,
      runId,
    });
    const step = (yield* inFlight).step!;
    assert.equal(step.attempt, 2);
    return { vision: step, thread };
  });

it.effect("a resume replaces a role thread the creator deleted with a fresh launch", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* resumedVision(world);
      world.deleted.add(thread);
      yield* startRunner;
      yield* recover;
      const own = roleThreadId(vision.id, 2);
      assert.equal(yield* Queue.take(world.launched), own);
      assert.deepEqual(world.launches, [own]);
      assert.equal((yield* inFlight).step?.roles[0]?.threadId, own);
    }),
  ),
);

it.effect("a game-folder role whose reused thread fails at once moves to a fresh thread once", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* resumedVision(world);
      world.runs.set(thread, [
        ...(world.runs.get(thread) ?? []),
        turnRun({ stepId: vision.id, attempt: 2, kind: "continue", status: "failed", ranMs: 500 }),
      ]);
      yield* startRunner;
      yield* recover;
      const fresh = roleThreadId(vision.id, 2, "fresh");
      assert.equal(yield* Queue.take(world.launched), fresh);
      assert.deepEqual(world.launches, [fresh]);
      assert.equal((yield* inFlight).step?.roles[0]?.threadId, fresh);
    }),
  ),
);

it.effect("a turn sent again after an instant failure is capped like the first", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed", ranMs: 500 })]);
      // The resent turn has been running past the vision cap.
      world.onSend = (threadId, messageId) => {
        world.runs.set(threadId, [
          ...(world.runs.get(threadId) ?? []),
          turnRun({
            stepId: vision.id,
            status: "running",
            userMessageId: messageId,
            ago: 11 * 60_000,
          }),
        ]);
      };
      yield* startRunner;
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* roles.settle(thread, world.runs.get(thread)![0]!);
      // The resend is a durable timer: nothing is sent until it is due.
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.lengthOf(world.sends, 0);
      yield* TestClock.setTime(Date.now() + 20_000);
      yield* worker.drain();
      assert.match(yield* Queue.take(world.interrupted), /^server:game-run-role-cap:/);
      assert.lengthOf(world.sends, 1);
    }),
  ),
);

it.effect("a turn sent again is sent by its timer even when the first try breaks", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed", ranMs: 500 })]);
      yield* startRunner;
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* roles.settle(thread, world.runs.get(thread)![0]!);
      // The send breaks once the timer is due, as a server dying before the turn is queued would.
      world.sendBreaks = 1;
      yield* TestClock.setTime(Date.now() + 20_000);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.lengthOf(world.sends, 0);
      // The timer's effect was never done, so it runs again and the turn goes.
      yield* TestClock.adjust("1 second");
      yield* worker.drain();
      assert.deepEqual(
        world.sends.map((send) => send.messageId),
        [roleTurnMessageId(vision.id, 1, "retry", 2)],
      );
    }),
  ),
);

it.effect("a turn sent again is never interrupted because a read after it broke", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed", ranMs: 500 })]);
      yield* startRunner;
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* roles.settle(thread, world.runs.get(thread)![0]!);
      // The look at the run right after the send breaks: the step is still its.
      world.onSend = () => {
        world.recordsBreaks = 1;
      };
      yield* TestClock.setTime(Date.now() + 20_000);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      for (let round = 0; round < 3; round += 1) {
        yield* worker.drain();
        yield* TestClock.adjust("1 second");
      }
      assert.isFalse(world.interrupts.some((i) => i.commandId.includes("resend-late")));
      assert.isAtLeast(world.sends.length, 1);
    }),
  ),
);

it.effect("a turn sent after a stop is interrupted, even when the first interrupt breaks", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed", ranMs: 500 })]);
      yield* startRunner;
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* roles.settle(thread, world.runs.get(thread)![0]!);
      // The run stops while the turn goes out, and the turn's own interrupt breaks once.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      world.duringSend = orchestrator
        .dispatch({ type: "game-run.stop", commandId: nextId(), threadId: creator, runId })
        .pipe(Effect.asVoid, Effect.orDie);
      world.interruptBreaks = 1;
      yield* TestClock.setTime(Date.now() + 20_000);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* withClockRunning(worker.drain());
      // Its retries run inside the act a stop cannot cut, well within a minute.
      const late = () => world.interrupts.some((i) => i.commandId.includes("resend-late"));
      yield* withClockRunning(
        Effect.gen(function* () {
          for (let second = 0; second < 60 && !late(); second += 1) yield* Effect.sleep("1 second");
        }),
      );
      assert.isTrue(late());
    }),
  ),
);

it.effect("a role's cap whose interrupt breaks is sent again by its timer", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      yield* startRunner;
      // Past the cap its timers fire (the step.start's, and the job's for the
      // turn it reattached to), and the interrupt breaks more often than both try once.
      world.interruptBreaks = 3;
      yield* TestClock.setTime(Date.now() + 11 * 60_000);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      for (let round = 0; round < 5; round += 1) {
        yield* worker.drain();
        yield* TestClock.adjust("1 second");
      }
      assert.match(yield* Queue.take(world.interrupted), /^server:game-run-role-cap:/);
    }),
  ),
);

/** Runs `effect` while the test clock moves on, so the backoff between its retries passes. */
const withClockRunning = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(effect);
    // Real file and git work runs between the retries, so the clock moves on
    // until the work is done rather than for a fixed time.
    while (fiber.pollUnsafe() === undefined) {
      yield* Effect.sleep("5 millis").pipe(TestClock.withLive);
      yield* TestClock.adjust("1 second");
    }
    return yield* Fiber.join(fiber);
  });

/** A command of another thread already holds `commandId`, so a report under it can never be written. */
const occupy = (commandId: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make(`thread:occupier-${++commands}`),
      projectId,
      title: "Elsewhere",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.effect("a landing that never gets written fails its step, so the run ends resumably", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      const turn = turnRun({ stepId: vision.id, status: "completed" });
      world.runs.set(thread, [turn]);
      yield* occupy(gameRunStepCommandId(vision.id, 1, "complete"));
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* withClockRunning(roles.settle(thread, turn));
      const { run } = yield* inFlight;
      assert.equal(run.ending, "failed");
      assert.match(run.lastFailure ?? "", /could not be landed/);
    }),
  ),
);

it.effect("a turn whose resend timer never gets written fails its step", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      const turn = turnRun({ stepId: vision.id, status: "failed", ranMs: 500 });
      world.runs.set(thread, [turn]);
      yield* occupy(`server:game-run-resend:${vision.id}:attempt:1:retry:2`);
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* withClockRunning(roles.settle(thread, turn));
      const { run } = yield* inFlight;
      assert.equal(run.ending, "failed");
      assert.match(run.lastFailure ?? "", /could not be set to go again/);
    }),
  ),
);

it.effect("a step whose job cannot report is tried again, then fails", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("autopilot");
      yield* completeStep((yield* inFlight).step!, gitOk);
      const vision = (yield* inFlight).step!;
      const own = roleThreadId(vision.id, 1);
      yield* occupy(`${gameRunStepCommandId(vision.id, 1, "start")}:${own}`);
      const runner = yield* GameRunStepRunner.GameRunStepRunner;
      yield* withClockRunning(
        runner.execute({ threadId: creator, runId, stepId: vision.id, attempt: 1 }),
      );
      assert.deepEqual(world.launches, []);
      const { run } = yield* inFlight;
      assert.equal(run.ending, "failed");
      assert.match(run.lastFailure ?? "", /could not be reported after 4 tries/);
    }),
  ),
);

/** Drains the outbox while its clock moves on, so effects run every try they have. */
const drainThroughRetries = Effect.gen(function* () {
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  for (let round = 0; round < 30; round += 1) {
    yield* worker.drain();
    yield* TestClock.adjust("2 seconds");
  }
});

it.effect("a turn its timer cannot send by the last try fails its step", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "failed", ranMs: 500 })]);
      yield* startRunner;
      const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
      yield* roles.settle(thread, world.runs.get(thread)![0]!);
      world.sendBreaks = 1_000;
      yield* TestClock.setTime(Date.now() + 20_000);
      yield* drainThroughRetries;
      const { run } = yield* inFlight;
      assert.equal(run.ending, "failed");
      assert.match(run.lastFailure ?? "", /turn could not be sent/);
    }),
  ),
);

it.effect("a cap its timer cannot send by the last try is set again a minute on", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      yield* startRunner;
      world.interruptBreaks = 1_000;
      yield* TestClock.setTime(Date.now() + 11 * 60_000);
      yield* drainThroughRetries;
      assert.lengthOf(world.interrupts, 0);
      // The interrupt works again: nothing is left to send it but the cap set
      // again a minute on.
      world.interruptBreaks = 0;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.lengthOf(world.interrupts, 0);
      yield* TestClock.adjust("61 seconds");
      yield* worker.drain();
      assert.isTrue(
        world.interrupts.some((i) => i.commandId.startsWith("server:game-run-role-cap:")),
      );
    }),
  ),
);

it.effect("records a landing cannot write by the last try stop the run before its next step", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* atVision(world);
      yield* startRunner;
      world.folderGone = true;
      const jobs = yield* GameRunJobs.GameRunJobs;
      yield* jobs.outputs({
        threadId: creator,
        runId,
        files: [{ path: ".studio/next.md", text: "1. The jump clips.\n" }],
        release: [],
        effectId: "effect:outputs-test",
        final: true,
      });
      assert.equal((yield* inFlight).run.ending, "stopped");
      // The step the records were for never starts: the stop cancelled its effect.
      world.folderGone = false;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      assert.deepEqual(world.launches, []);
    }),
  ),
);

it.effect("a role turn someone else interrupted is not read as capped", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "interrupted" })]);
      yield* startRunner;
      const landed = yield* awaitStep(vision.id, "completed");
      yield* recover;
      yield* Fiber.join(landed);
      const done = (yield* inFlight).steps.find((s) => s.id === vision.id)!;
      assert.equal(done.result?.kind === "done" ? done.result.timedOut : null, false);
    }),
  ),
);

it.effect("a role's submission of the wrong kind is refused to it, with the reason", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      const control = yield* GameRunControl.GameRunControl;
      const refused = yield* control
        .runSubmit(thread, { _tag: "verdict", verdict: "A", reasons: "It plays better." })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "wrong-kind");
      assert.include(refused.message, "takes no submission");
      const strangerThread = ThreadId.make("thread:stranger");
      world.runs.set(strangerThread, world.runs.get(thread)!);
      const stranger = yield* control
        .runSubmit(strangerThread, { _tag: "report", report: "r" })
        .pipe(Effect.flip);
      assert.equal(stranger.reason, "wrong-thread");
    }),
  ),
);

it.effect("a game an earlier run left a run.json in starts fresh, and says so", () =>
  withGame(() =>
    Effect.gen(function* () {
      yield* createCreator;
      NodeFS.mkdirSync(NodePath.join(lastRoot, ".studio"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(lastRoot, ".studio", "run.json"),
        JSON.stringify({ version: 3, runId: "run_old", stage: "round-4", rounds: [] }),
      );
      const control = yield* GameRunControl.GameRunControl;
      const resume = yield* control.runStart({ threadId: creator, brief: "" }).pipe(Effect.flip);
      assert.equal(resume.reason, "brief-required");
      assert.include(resume.message, "was not carried over");
      const started = yield* control.runStart({ threadId: creator, brief: "A small arena game." });
      assert.isFalse(started.resumed);
      assert.include(started.message, "not carried over");
      assert.include(started.message, "continues from the game as it is now");
      // The one fact taken over: the game was built, so no vision or prototypes go over it.
      assert.equal(started.stage, "build");
      const { run, step } = yield* inFlight;
      assert.equal(run.stage, "build");
      assert.notEqual(run.id, "run_old");
      assert.deepEqual(run.decided, []);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "game-run.step.complete",
        commandId: gameRunStepCommandId(step!.id, step!.attempt, "complete"),
        threadId: creator,
        runId: run.id,
        stepId: step!.id,
        attempt: step!.attempt,
        result: gitOk,
      });
      const next = (yield* inFlight).step!;
      assert.equal(next.step.kind === "role" ? next.step.role : next.kind, "plan");
      assert.equal(next.step.kind === "role" ? next.step.title : "", "studio ladder");
    }),
  ),
);

it.effect("a decision with nothing on disk to show takes its default without asking", () =>
  withGame(() =>
    Effect.gen(function* () {
      yield* createCreator;
      yield* startRun("guided");
      yield* startRunner;
      yield* completeStep((yield* inFlight).step!, gitOk);
      yield* completeStep((yield* inFlight).step!, roleDone(ThreadId.make("thread:vision")));
      yield* completeStep((yield* inFlight).step!, {
        ...gitOk,
        build: { ...gitOk.build, sha: "s2" },
      });
      yield* completeStep((yield* inFlight).step!, {
        kind: "boot",
        ok: true,
        detail: "boot clean",
      });
      assert.equal((yield* inFlight).run.status, "waiting");
      // The game folder has no VISION.md and no key art: the wake takes the default at once.
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      const after = yield* inFlight;
      assert.deepEqual(
        after.run.decided.map((d) => [d.kind, d.by]),
        [["style", "default"]],
      );
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { messages } = yield* projections.getThreadRecords(creator, ["messages"]);
      assert.lengthOf(
        messages.filter((m) => m.id.startsWith("message:game-run-decision:")),
        0,
      );
    }),
  ),
);

it.effect("startup stops a role turn no step record names, and leaves a named one", () =>
  Effect.gen(function* () {
    yield* createCreator;
    yield* startRun("autopilot");
    yield* countingRunner;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* completeStep((yield* inFlight).step!, gitOk);
    const vision = (yield* inFlight).step!;
    const named = roleThreadId(vision.id, 1);
    const unnamed = ThreadId.make("thread:loop-era-role");
    for (const threadId of [named, unnamed])
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: nextId(),
        threadId,
        projectId,
        title: "studio role",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
        parentThreadId: creator,
        launchedBy: "game_run",
      });
    yield* orchestrator.dispatch({
      type: "game-run.step.start",
      commandId: nextId(),
      threadId: creator,
      runId,
      stepId: vision.id,
      roleThreadId: named,
    });
    for (const threadId of [named, unnamed])
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: nextId(),
        threadId,
        messageId: MessageId.make(`message:${threadId}`),
        text: "Keep building.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const live = (yield* projections.listLiveGameRunRoleTurns()).map((t) => t.threadId);
    assert.sameMembers(live, [named, unnamed]);
    yield* (yield* GameRunRecovery.GameRunRecovery).recover();
    const runsOf = (threadId: ThreadId) =>
      Effect.map(projections.getThreadRecords(threadId, ["runs"]), (r) => r.runs);
    const stopped = (yield* runsOf(unnamed)).at(-1);
    const kept = (yield* runsOf(named)).at(-1);
    assert.notInclude(["preparing", "starting", "running", "waiting"], stopped?.status);
    assert.include(["preparing", "starting", "running", "waiting"], kept?.status);
  }).pipe(Effect.provide(layerWithRecovery)),
);

it.effect("every chat of a game reaches its one run, and a role thread only its checks", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { thread } = yield* atVision(world);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const other = ThreadId.make("thread:second-chat");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: nextId(),
        threadId: other,
        projectId,
        title: "Arena, again",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/games/arena",
        createdBy: "user",
        creationSource: "web",
      });
      world.chats.add(other);
      const control = yield* GameRunControl.GameRunControl;
      const status = yield* control.runStatus(other);
      assert.equal(status.runId, runId);
      assert.isTrue(status.active);
      const again = yield* control.runStart({ threadId: other, brief: "A second game here." });
      assert.equal(again.runId, runId);
      assert.isTrue(again.resumed);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      assert.lengthOf((yield* projections.getGameRunRecords(other)).gameRuns, 0);
      // A stop from the second chat stops the game's run.
      yield* control.runStop(other);
      assert.equal((yield* inFlight).run.ending, "stopped");
      // The run's own role thread reaches none of its controls.
      const refused = yield* control.runStatus(thread).pipe(Effect.flip);
      assert.equal(refused.reason, "role-thread");
      // Except its builder's checks, scored against the run's open rung (none yet).
      assert.isNull((yield* control.runChecks(thread)).rung);
    }),
  ),
);

it.effect("a start while the ending still finishes is refused before it touches the folder", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* atVision(world);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "game-run.stop",
        commandId: nextId(),
        threadId: creator,
        runId,
      });
      // The stop's finish has not run, so the folder is still the ending's.
      const agents = NodePath.join(lastRoot, "AGENTS.md");
      NodeFS.rmSync(agents, { force: true });
      const control = yield* GameRunControl.GameRunControl;
      const refused = yield* control.runStart({ threadId: creator, brief: "" }).pipe(Effect.flip);
      assert.equal(refused.reason, "finishing");
      assert.isFalse(NodeFS.existsSync(agents));
    }),
  ),
);

it.effect("a steer sent again under the same id is one note", () =>
  withGame((world) =>
    Effect.gen(function* () {
      yield* atVision(world);
      const control = yield* GameRunControl.GameRunControl;
      const notes = Effect.map(inFlight, ({ run }) => run.steer ?? []);
      const before = (yield* notes).length;
      yield* control.runSteer(creator, "Make the arena bigger.", "steer-1");
      yield* control.runSteer(creator, "Make the arena bigger.", "steer-1");
      assert.lengthOf(yield* notes, before + 1);
      yield* control.runSteer(creator, "Make the arena bigger.", "steer-2");
      assert.lengthOf(yield* notes, before + 2);
    }),
  ),
);

it.effect("a role's cap not yet due fires later from its timer, with no fiber holding it", () =>
  withGame((world) =>
    Effect.gen(function* () {
      const { vision, thread } = yield* atVision(world);
      world.runs.set(thread, [turnRun({ stepId: vision.id, status: "running" })]);
      yield* startRunner;
      // The watch checks once and sets the cap again at its due time: that commit is all it does.
      const scheduled = yield* awaitRun(() => true);
      yield* recover;
      yield* Fiber.join(scheduled);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.lengthOf(world.interrupts, 0);
      yield* TestClock.setTime(Date.now() + 11 * 60_000);
      yield* worker.drain();
      assert.match(yield* Queue.take(world.interrupted), /^server:game-run-role-cap:/);
    }),
  ),
);

it.effect(
  "every move of the run is pushed, and the game's card reads the run from its records",
  () =>
    withGame((world) =>
      Effect.gen(function* () {
        const runner = yield* GameRunStepRunner.GameRunStepRunner;
        const pushOf = (dispatched: {
          readonly storedEvents: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>;
        }) =>
          Effect.forEach(dispatched.storedEvents, ({ event }) => runner.handle(event), {
            discard: true,
          });
        yield* createCreator;
        yield* pushOf(yield* startRun("autopilot"));
        assert.isString(yield* Queue.take(world.pushes));
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal((yield* projections.getProjectGameRun(projectId))?.id, runId);
        yield* pushOf(yield* stopRun);
        assert.isNull(yield* Queue.take(world.pushes));
        assert.equal((yield* projections.getProjectGameRun(projectId))?.status, "ended");
      }),
    ),
);
