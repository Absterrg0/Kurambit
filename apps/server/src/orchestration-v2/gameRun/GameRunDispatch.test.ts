// A game-run command is durable intent: its records, its receipt and the effect
// that carries it out commit together, and a retried command changes nothing.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GameRunId,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ProviderAdapter from "@kurambit/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A game run's commands start no provider session."),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "game-run-dispatch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:game-creator");
const runId = GameRunId.make("game-run:first");
const start = (commandId: string, id = runId) =>
  ({
    type: "game-run.start",
    commandId: CommandId.make(commandId),
    threadId,
    runId: id,
    lane: "godot",
    brief: "A small arena game.",
    profile: "autopilot",
    modelSelection,
    runtimeMode: "full-access",
  }) as const;

it.effect("game-run.start commits its records, receipt and effect together, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const created = yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-creator"),
      threadId,
      projectId: ProjectId.make("project:game"),
      title: "Arena",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/games/arena",
      createdBy: "user",
      creationSource: "web",
    });
    const threadBefore = yield* projections.getThread(threadId);

    const first = yield* orchestrator.dispatch(start("game-run-start-1"));
    assert.deepEqual(
      first.storedEvents.map((stored) => stored.event.type),
      ["game-run-step.updated", "game-run.created"],
    );

    const records = yield* projections.getGameRunRecords(threadId);
    assert.lengthOf(records.gameRuns, 1);
    assert.lengthOf(records.gameRunSteps, 1);
    const [run] = records.gameRuns;
    const [step] = records.gameRunSteps;
    assert.equal(run?.id, runId);
    assert.equal(run?.status, "running");
    assert.equal(run?.inFlight, 1);
    assert.equal(step?.id, gameRunStepId(runId, 1));
    assert.equal(step?.status, "planned");

    const receipt = yield* receipts.getByCommandId(CommandId.make("game-run-start-1"));
    assert.isTrue(Option.isSome(receipt));
    assert.equal(Option.getOrThrow(receipt).status, "accepted");
    assert.equal(Option.getOrThrow(receipt).resultSequence, first.sequence);

    const queued = yield* outbox.listByCommandId(CommandId.make("game-run-start-1"));
    assert.deepEqual(
      queued.map((effect) => [effect.request, effect.status]),
      [[{ type: "game-run.step.execute", runId, stepId: gameRunStepId(runId, 1) }, "pending"]],
    );
    // A run's steps are not chat activity.
    assert.deepEqual((yield* projections.getThread(threadId)).updatedAt, threadBefore.updatedAt);

    // A retry of the same command replays its receipt and commits nothing new.
    const retried = yield* orchestrator.dispatch(start("game-run-start-1"));
    assert.equal(retried.sequence, first.sequence);
    assert.deepEqual(
      retried.storedEvents.map((stored) => stored.sequence),
      first.storedEvents.map((stored) => stored.sequence),
    );
    const after = yield* projections.getGameRunRecords(threadId);
    assert.lengthOf(after.gameRuns, 1);
    assert.lengthOf(after.gameRunSteps, 1);
    assert.lengthOf(yield* outbox.listByCommandId(CommandId.make("game-run-start-1")), 1);

    // A second start while the run is live is refused, and the refusal is final for its id.
    const refused = yield* orchestrator
      .dispatch(start("game-run-start-2", GameRunId.make("game-run:second")))
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorGameRunRefusedError");
    assert.equal(refused._tag === "OrchestratorGameRunRefusedError" && refused.reason, "run-live");
    const again = yield* orchestrator
      .dispatch(start("game-run-start-2", GameRunId.make("game-run:second")))
      .pipe(Effect.flip);
    assert.equal(again._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.lengthOf((yield* projections.getGameRunRecords(threadId)).gameRuns, 1);

    // The in-memory projection folds the same events to the same records.
    const memory = yield* replayInMemory([...created.storedEvents, ...first.storedEvents]);
    assert.deepEqual(memory, records);
    assert.deepEqual(
      (yield* projections.getGameRunRecords(threadId, { steps: "in-flight" })).gameRunSteps,
      records.gameRunSteps,
    );
  }).pipe(Effect.provide(layerTest)),
);

const replayInMemory = (stored: ReadonlyArray<OrchestrationV2StoredEvent>) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const { event } of stored) yield* projections.apply(event);
    return yield* projections.getGameRunRecords(threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory));
