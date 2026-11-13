import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@kurambit/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { runMigrations } from "../Migrations.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(Layer.mergeAll(sqlite, EffectOutbox.layer.pipe(Layer.provide(sqlite))));

const step = '"runId":"run-1","stepId":"step-1","attempt":1';

layer("068_EffectOutboxHoldsThread", (it) => {
  // Rows the server before this migration enqueued, as it wrote them: a step's cap due later, a
  // turn queued after it, and stage-era requests this server no longer decodes.
  it.effect("keeps an earlier server's timers from holding the thread and drops retired rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      const rows: ReadonlyArray<readonly [string, string, string]> = [
        ["cap", "game-run.step.deadline", `{"type":"game-run.step.deadline",${step}}`],
        ["turn", "provider-turn.start", '{"type":"provider-turn.start","runId":"run-1"}'],
        ["finish", "game-run.finish", '{"type":"game-run.finish","runId":"run-1"}'],
        [
          "memory",
          "game-run.step.resend",
          `{"type":"game-run.step.resend",${step},"turn":"memory","n":1}`,
        ],
        [
          "retry",
          "game-run.step.resend",
          `{"type":"game-run.step.resend",${step},"turn":"retry","n":1}`,
        ],
      ];
      for (const [id, type, payload] of rows) {
        const availableAt = id === "turn" ? "1970-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox
            (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
          VALUES (${id}, 'command-1', 'thread-1', ${type}, ${payload}, 'pending', ${availableAt}, '2026-01-01', '2026-01-01')
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 68 });

      const kept = yield* sql<{ readonly effect_id: string; readonly holds_thread: number }>`
        SELECT effect_id, holds_thread FROM orchestration_v2_effect_outbox ORDER BY rowid
      `;
      assert.deepStrictEqual(kept, [
        { effect_id: "cap", holds_thread: 0 },
        { effect_id: "turn", holds_thread: 1 },
        { effect_id: "retry", holds_thread: 0 },
      ]);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 1000 });
      assert.strictEqual(Option.getOrUndefined(claimed)?.id, "turn");
    }),
  );
});
