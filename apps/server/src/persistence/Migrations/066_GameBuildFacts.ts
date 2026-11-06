import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A build's facts, once per engine-project tree and harness: measured on a
// copy of the build, never on the game folder. And the latest restore of a
// game that has no production run to record it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS game_build_facts (
      facts_key TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS game_build_restores (
      root TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
