import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed to create a child task."),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "game-round-delegation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const seedParent = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${threadId}`),
      threadId,
      projectId,
      title: "Build the game",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/games/probe",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`build-${threadId}`),
      threadId,
      messageId: MessageId.make(`message-build-${threadId}`),
      text: "Build the game.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* projections.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    return { orchestrator, projections, now, run, rootNodeId: run.rootNodeId! };
  });

const completeRun = (input: {
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly run: OrchestrationV2Run;
}) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make(`complete-${input.run.id}`),
      type: "run.updated",
      threadId: input.threadId,
      occurredAt: input.now,
      payload: {
        ...input.run,
        status: "completed",
        completedAt: input.now,
      },
    });
  });

const gameRoundCommand = (input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly role: "critic" | "ballot" | "repair";
  readonly evidenceDirectory: string | null;
}): OrchestrationV2InternalCommand => ({
  type: "game-round.task.request",
  createdBy: "system",
  creationSource: "server",
  commandId: CommandId.make(input.commandId),
  originatingThreadId: input.threadId,
  originatingRunId: input.runId,
  originatingNodeId: input.nodeId,
  loopId: "loop-1",
  roundId: "round-1",
  role: input.role,
  order: 0,
  task: "Review the build against the brief.",
  title: "Game review: critic",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  evidenceDirectory: input.evidenceDirectory,
});

it.effect("a round task creates a fresh child under the completed builder run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:game-round-parent");
    const seeded = yield* seedParent(threadId, ProjectId.make("project:game-round"));
    yield* completeRun({ threadId, now: seeded.now, run: seeded.run });

    yield* seeded.orchestrator.dispatch(
      gameRoundCommand({
        commandId: "game-round-critic-1",
        threadId,
        runId: seeded.run.id,
        nodeId: seeded.rootNodeId,
        role: "critic",
        evidenceDirectory: "/state/game-review/evidence/critic-1",
      }),
    );

    const parent = yield* seeded.projections.getThreadProjection(threadId);
    assert.lengthOf(parent.subagents, 1);
    const task = parent.subagents[0]!;
    const child = yield* seeded.projections.getThreadProjection(task.childThreadId!);
    // The session service derives this id from the command id so a restart can
    // find the child without dispatching again.
    assert.equal(
      child.thread.id,
      IdAllocator.derive.delegatedTaskThread({
        commandId: CommandId.make("game-round-critic-1"),
      }),
    );
    // A child, never a top-level thread: it keeps the parent lineage and the
    // evidence directory is its whole workspace.
    assert.equal(child.thread.lineage.parentThreadId, threadId);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.equal(child.thread.worktreePath, "/state/game-review/evidence/critic-1");
    assert.isNull(child.thread.branch);
    // No parent history: the only message is this task.
    assert.lengthOf(child.messages, 1);
    assert.equal(child.messages[0]?.text, "Review the build against the brief.");
    // Its provider conversation is its own: nothing is resumed or copied from
    // the builder's thread.
    assert.notEqual(child.thread.activeProviderThreadId, parent.thread.activeProviderThreadId);
    assert.equal(task.model, modelSelection.model);
    assert.equal(task.providerInstanceId, instanceId);

    // A repair is the writable role: it keeps the game folder, and it is still
    // a child of the same completed builder run.
    yield* seeded.orchestrator.dispatch(
      gameRoundCommand({
        commandId: "game-round-repair-1",
        threadId,
        runId: seeded.run.id,
        nodeId: seeded.rootNodeId,
        role: "repair",
        evidenceDirectory: null,
      }),
    );
    const afterRepair = yield* seeded.projections.getThreadProjection(threadId);
    assert.lengthOf(afterRepair.subagents, 2);
    const repairChild = yield* seeded.projections.getThreadProjection(
      afterRepair.subagents[1]!.childThreadId!,
    );
    assert.equal(repairChild.thread.worktreePath, "/games/probe");
    assert.equal(repairChild.thread.lineage.parentThreadId, threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a round task's terminal child never wakes the builder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:game-round-silent-child");
      const seeded = yield* seedParent(threadId, ProjectId.make("project:game-round-silent-child"));
      yield* completeRun({ threadId, now: seeded.now, run: seeded.run });
      yield* seeded.orchestrator.dispatch(
        gameRoundCommand({
          commandId: "game-round-silent-critic",
          threadId,
          runId: seeded.run.id,
          nodeId: seeded.rootNodeId,
          role: "critic",
          evidenceDirectory: "/state/game-review/evidence/silent-critic",
        }),
      );

      const parent = yield* seeded.projections.getThreadProjection(threadId);
      const task = parent.subagents[0]!;
      // The policy is recorded on the task itself, so a restart cannot lose it.
      assert.equal(task.completionWake, "never");
      const child = yield* seeded.projections.getThreadProjection(task.childThreadId!);
      const childRun = child.runs[0]!;
      const sink = yield* EventSink.EventSinkV2;
      // Start the committed-event watcher from a known sequence, so the
      // terminal event is observed even if this fiber starts after the write.
      const before = yield* sink.latestSequence();
      const terminal = yield* sink.stream({ afterSequence: before }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === task.id &&
            stored.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );

      // Complete the child exactly as a provider turn would.
      yield* sink.write({
        commandId: CommandId.make("complete-round-child"),
        events: [
          {
            id: EventId.make("complete-round-child-run"),
            type: "run.updated" as const,
            threadId: child.thread.id,
            occurredAt: seeded.now,
            payload: {
              ...childRun,
              status: "completed" as const,
              startedAt: childRun.startedAt ?? seeded.now,
              completedAt: seeded.now,
            },
          },
        ],
      });
      yield* Fiber.join(terminal);
      const after = yield* seeded.projections.getThreadProjection(threadId);

      // Completing a review child must never reserve a parent delivery, wake
      // the builder or start another run on it.
      assert.isUndefined(after.runs[0]!.delegatedCompletion);
      assert.lengthOf(after.runs, 1);
      assert.isUndefined(after.subagents[0]!.completionDelivery);
      assert.lengthOf(after.messages, 1);
    }).pipe(Effect.scoped),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("public delegation still requires an active parent run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:game-round-public");
    const seeded = yield* seedParent(threadId, ProjectId.make("project:game-round-public"));
    yield* completeRun({ threadId, now: seeded.now, run: seeded.run });

    const command = {
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make("delegate-after-completion"),
      parentThreadId: threadId,
      parentRunId: seeded.run.id,
      parentNodeId: seeded.rootNodeId,
      task: "Review the build.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    } satisfies OrchestrationV2Command;
    const exit = yield* Effect.exit(seeded.orchestrator.dispatch(command));
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.match(String(exit.cause), /not active/);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a round task refuses an unfinished origin or a node outside it", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:game-round-guards");
    const seeded = yield* seedParent(threadId, ProjectId.make("project:game-round-guards"));

    // The builder run is still active: only a completed origin is admissible.
    const activeOrigin = yield* Effect.exit(
      seeded.orchestrator.dispatch(
        gameRoundCommand({
          commandId: "game-round-active-origin",
          threadId,
          runId: seeded.run.id,
          nodeId: seeded.rootNodeId,
          role: "ballot",
          evidenceDirectory: "/state/game-review/evidence/ballot-0",
        }),
      ),
    );
    assert.equal(activeOrigin._tag, "Failure");
    if (activeOrigin._tag === "Failure") {
      assert.match(String(activeOrigin.cause), /not a completed run/);
    }

    yield* completeRun({ threadId, now: seeded.now, run: seeded.run });
    const foreignNode = yield* Effect.exit(
      seeded.orchestrator.dispatch(
        gameRoundCommand({
          commandId: "game-round-foreign-node",
          threadId,
          runId: seeded.run.id,
          nodeId: NodeId.make("node:somewhere-else"),
          role: "critic",
          evidenceDirectory: "/state/game-review/evidence/critic-2",
        }),
      ),
    );
    assert.equal(foreignNode._tag, "Failure");
    if (foreignNode._tag === "Failure") {
      assert.match(String(foreignNode.cause), /is not part of run/);
    }
  }).pipe(Effect.provide(layerTest)),
);

// Completes a child run as a provider turn would and returns once the parent
// has committed the task's terminal update, which carries any delivery.
const completeChildRun = (input: {
  readonly childThreadId: ThreadId;
  readonly taskId: NodeId;
  readonly run: OrchestrationV2Run;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const before = yield* sink.latestSequence();
    const terminal = yield* sink.stream({ afterSequence: before }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === input.taskId &&
          stored.event.payload.status === "completed",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* sink.write({
      commandId: CommandId.make(`complete-${input.run.id}`),
      events: [
        {
          id: EventId.make(`complete-${input.run.id}`),
          type: "run.updated" as const,
          threadId: input.childThreadId,
          occurredAt: input.now,
          payload: {
            ...input.run,
            status: "completed" as const,
            startedAt: input.run.startedAt ?? input.now,
            completedAt: input.now,
          },
        },
      ],
    });
    yield* Fiber.join(terminal);
  });

// Sends a user follow-up to a finished child, completes it, and reports how
// the parent changed across that completion.
const followUpAndComplete = (input: {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const messageId = MessageId.make(`message:follow-up-${input.childThreadId}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`follow-up-${input.childThreadId}`),
      threadId: input.childThreadId,
      messageId,
      text: "Look again.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const child = yield* projections.getThreadProjection(input.childThreadId);
    const run = child.runs.find((candidate) => candidate.userMessageId === messageId)!;
    const taskId = run.delegatedTaskId!;
    const before = yield* projections.getThreadProjection(input.parentThreadId);
    yield* completeChildRun({ childThreadId: input.childThreadId, taskId, run, now: input.now });
    const after = yield* projections.getThreadProjection(input.parentThreadId);
    return { taskId, before, after };
  });

it.effect("a round child is read-only: a follow-up is refused and starts no replacement run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:game-round-follow-up");
    const seeded = yield* seedParent(threadId, ProjectId.make("project:game-round-follow-up"));
    yield* completeRun({ threadId, now: seeded.now, run: seeded.run });
    yield* seeded.orchestrator.dispatch(
      gameRoundCommand({
        commandId: "game-round-follow-up-critic",
        threadId,
        runId: seeded.run.id,
        nodeId: seeded.rootNodeId,
        role: "critic",
        evidenceDirectory: "/state/game-review/evidence/follow-up-critic",
      }),
    );
    const original = (yield* seeded.projections.getThreadProjection(threadId)).subagents[0]!;
    const child = yield* seeded.projections.getThreadProjection(original.childThreadId!);
    yield* completeChildRun({
      childThreadId: child.thread.id,
      taskId: original.id,
      run: child.runs[0]!,
      now: seeded.now,
    });

    // Its round judges the one run it recorded; a later writer would escape
    // that check, so user, agent and continuation messages are all refused.
    for (const [createdBy, creationSource] of [
      ["user", "web"],
      ["agent", "mcp"],
      ["agent", "server"],
    ] as const) {
      const refused = yield* Effect.flip(
        seeded.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`follow-up-${createdBy}-${creationSource}`),
          threadId: child.thread.id,
          messageId: MessageId.make(`message:follow-up-${createdBy}-${creationSource}`),
          text: "Look again.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy,
          creationSource,
        }),
      );
      assert.equal(refused._tag, "OrchestratorGameRoundChildReadOnlyError");
    }
    const after = yield* seeded.projections.getThreadProjection(child.thread.id);
    assert.lengthOf(after.runs, 1);
    assert.lengthOf((yield* seeded.projections.getThreadProjection(threadId)).subagents, 1);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("a follow-up to a finished delegated task still delivers to its parent", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:delegated-follow-up");
    const seeded = yield* seedParent(threadId, ProjectId.make("project:delegated-follow-up"));
    yield* seeded.orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make("delegate-follow-up-original"),
      parentThreadId: threadId,
      parentRunId: seeded.run.id,
      parentNodeId: seeded.rootNodeId,
      task: "Review the build.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    const original = (yield* seeded.projections.getThreadProjection(threadId)).subagents[0]!;
    const child = yield* seeded.projections.getThreadProjection(original.childThreadId!);
    yield* completeChildRun({
      childThreadId: child.thread.id,
      taskId: original.id,
      run: child.runs[0]!,
      now: seeded.now,
    });
    yield* completeRun({ threadId, now: seeded.now, run: seeded.run });

    const { taskId, before, after } = yield* followUpAndComplete({
      parentThreadId: threadId,
      childThreadId: child.thread.id,
      now: seeded.now,
    });
    assert.equal(after.subagents.find((task) => task.id === taskId)!.completionWake, "always");
    assert.isUndefined(before.runs[0]!.delegatedCompletion);
    assert.include(after.runs[0]!.delegatedCompletion?.delivery?.taskIds ?? [], taskId);
    // The continuation that carries the result is reserved with the delivery.
    assert.isDefined(after.runs[0]!.delegatedCompletion?.delivery?.messageId);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
