import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A pending effect holds its thread: later effects of the thread wait behind it. A timer that
// only waits for its time is enqueued with holds_thread = 0 instead of being named in the claim
// query. Rows the earlier server enqueued get the flag their type had there, and rows it could
// still hold of the stage era's retired requests (which its worker settled with no work) are
// removed, since this server no longer decodes them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN holds_thread INTEGER NOT NULL DEFAULT 1`;
  yield* sql`
    UPDATE orchestration_v2_effect_outbox
    SET holds_thread = 0
    WHERE effect_type IN (
      'game-run.step.deadline',
      'game-run.decision.deadline',
      'game-run.step.resend',
      'game-run.step.wake'
    )
  `;
  yield* sql`
    DELETE FROM orchestration_v2_effect_outbox
    WHERE effect_type IN (
      'game-run.decision.wake',
      'game-run.finish',
      'game-run.restore.execute',
      'game-run.outputs',
      'game-run.copies.release'
    )
      OR (
        effect_type = 'game-run.step.resend'
        AND json_extract(payload_json, '$.turn') = 'memory'
      )
  `;
});
