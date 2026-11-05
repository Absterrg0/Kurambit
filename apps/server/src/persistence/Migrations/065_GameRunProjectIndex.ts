import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every run control finds its game's run by project, ordered by start.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_projection_game_runs_project_idx ON orchestration_v2_projection_game_runs(project_id, started_at)`;
});
