import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, ThreadId } from "@kurambit/contracts";
import * as NodeSqliteClient from "@kurambit/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");

// Columns as the webhook-era schema (migrations 057/058) wrote them.
const oldSchemaRow = (input: {
  readonly id: string;
  readonly scheduleJson: string;
  readonly nextRunAt: string | null;
}) => ({
  task_id: input.id,
  title: input.id,
  prompt: `Run ${input.id}`,
  enabled: 1,
  schedule_json: input.scheduleJson,
  project_id: "project",
  thread_id: null,
  workspace_strategy_json: '{"type":"root"}',
  model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
  runtime_mode: "full-access",
  interaction_mode: "default",
  created_by: "user",
  creation_source: "web",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  next_run_at: input.nextRunAt,
  last_run_at: null,
  last_run_status: "never",
  last_run_error: null,
  run_count: 0,
  webhook_token: `token-${input.id}`,
  webhook_secret: "shared-secret",
});

it.effect("tasks stored with webhook tokens still load, and time schedules still run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert(
      oldSchemaRow({
        id: "timed",
        scheduleJson: '{"type":"interval","everyMs":3600000}',
        nextRunAt: "2026-11-08T11:59:00.000Z",
      }),
    )}`;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert(
      oldSchemaRow({
        id: "hooked",
        scheduleJson:
          '{"type":"webhook","signature":{"header":"x-hub-signature-256","encoding":"hex","prefix":"sha256="}}',
        nextRunAt: null,
      }),
    )}`;

    const launchedPrompts: Array<string> = [];
    let runDueWork: Effect.Effect<void> = Effect.void;
    const serviceLayer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler)({
            register: (_name, work) =>
              Effect.map(Effect.context(), (context) => {
                runDueWork = work.pipe(Effect.provideContext(context), Effect.orDie);
              }),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.sync(() => {
                launchedPrompts.push(input.initialMessage?.text ?? "");
                return {
                  threadId: ThreadId.make("thread"),
                  resumed: false,
                  projection: {} as ThreadLaunchService.ThreadLaunchResult["projection"],
                };
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;

      const listed = yield* service.list();
      assert.deepEqual(
        listed.tasks.map((task) => [task.id, task.schedule.type]),
        [
          ["hooked", "webhook"],
          ["timed", "interval"],
        ],
      );

      yield* runDueWork;
      assert.deepEqual(launchedPrompts, ["Run timed"]);
      const after = yield* service.list();
      const timed = after.tasks.find((task) => task.id === "timed");
      assert.equal(timed?.lastRunStatus, "succeeded");
      assert.equal(timed?.runCount, 1);
      assert.equal(timed?.nextRunAt, "2026-11-08T13:00:00.000Z");
      const hooked = after.tasks.find((task) => task.id === "hooked");
      assert.equal(hooked?.runCount, 0);
      assert.equal(hooked?.nextRunAt, null);

      const runNow = yield* Effect.flip(service.runNow({ id: ScheduledTaskId.make("hooked") }));
      assert.include(runNow.message, "no longer supported");

      // Giving the legacy task a time schedule makes it run again.
      if (hooked === undefined) return assert.fail("legacy webhook task did not load");
      const saved = yield* service.upsert({
        id: hooked.id,
        requireExisting: true,
        title: hooked.title,
        prompt: hooked.prompt,
        enabled: true,
        schedule: { type: "interval", everyMs: 3_600_000 },
        projectId: hooked.projectId,
        workspaceStrategy: hooked.workspaceStrategy,
        modelSelection: hooked.modelSelection,
        runtimeMode: hooked.runtimeMode,
        interactionMode: hooked.interactionMode,
      });
      assert.equal(saved.task.schedule.type, "interval");
      assert.equal(saved.task.nextRunAt, "2026-11-08T13:00:00.000Z");
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
