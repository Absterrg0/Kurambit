import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@kurambit/contracts";
import * as NodeSqliteClient from "@kurambit/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";

it.effect("migrates empty state and rebuilds ordinary project and thread events", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`, []);
    assert.deepEqual(yield* runMigrations(), migrationManifest);

    yield* Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const threads = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("project:fresh-game");
      const threadId = ThreadId.make("thread:fresh-game");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = DateTime.makeUnsafe("2026-10-19T00:00:00.000Z");
      const timestamp = DateTime.formatIso(now);
      const project = yield* store.appendProjectEvent({
        type: "project.created",
        eventId: EventId.make("event:fresh-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: timestamp,
        commandId: CommandId.make("command:fresh-project"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Fresh game",
          workspaceRoot: "/games/fresh-game",
          defaultModelSelection: null,
          scripts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Build the first scene",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const appended = yield* store.appendAgentEvents({
        events: [
          {
            id: EventId.make("event:fresh-thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
          {
            id: EventId.make("event:fresh-title"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: { ...thread, title: "First scene complete" },
          },
        ],
      });
      const replayed = yield* store
        .readApplicationEvents({
          afterSequence: 0,
          throughSequence: yield* store.latestApplicationSequence,
        })
        .pipe(Stream.runCollect);
      assert.deepEqual(replayed, [project, ...appended]);
      for (const event of replayed) {
        if ("aggregateKind" in event) yield* projects.apply(event);
        else yield* threads.apply(event.event);
      }
      const restoredProject = yield* projects.get(projectId);
      assert.isTrue(Option.isSome(restoredProject));
      if (Option.isSome(restoredProject))
        assert.equal(restoredProject.value.workspaceRoot, "/games/fresh-game");
      const restoredThread = yield* threads.getThreadProjection(threadId);
      assert.equal(restoredThread?.thread.projectId, projectId);
      assert.equal(restoredThread?.thread.title, "First scene complete");
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(OrchestrationEventStore.layer, ProjectStore.layer, ProjectionStore.layer),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
