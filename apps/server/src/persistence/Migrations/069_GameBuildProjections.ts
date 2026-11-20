import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A game's builds as records of the event store: a row per build, a row per game folder.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_game_builds (
      project_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      root TEXT NOT NULL,
      kind TEXT NOT NULL,
      number INTEGER,
      at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (project_id, build_id)
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_builds_at_idx ON orchestration_v2_projection_game_builds(project_id, at)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_game_builds_root_idx ON orchestration_v2_projection_game_builds(project_id, root, number)`;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_game_build_folders (
      project_id TEXT NOT NULL,
      root TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (project_id, root)
    )
  `;
});
