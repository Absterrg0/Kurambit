import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The production run's records, each a whole record per row like every other
// v2 projection; the columns are what lookups filter on.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_game_runs (
      game_run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_runs_thread_idx ON orchestration_v2_projection_game_runs(thread_id, started_at, game_run_id)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_runs_status_idx ON orchestration_v2_projection_game_runs(status)`;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_game_run_steps (
      game_run_step_id TEXT PRIMARY KEY,
      game_run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_run_steps_run_idx ON orchestration_v2_projection_game_run_steps(game_run_id, seq)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_run_steps_thread_idx ON orchestration_v2_projection_game_run_steps(thread_id, status)`;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_game_run_rounds (
      game_run_round_id TEXT PRIMARY KEY,
      game_run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_run_rounds_thread_idx ON orchestration_v2_projection_game_run_rounds(thread_id, round)`;
});
