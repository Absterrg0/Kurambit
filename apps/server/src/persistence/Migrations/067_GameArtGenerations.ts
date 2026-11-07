import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A game's generated art: one row per generation, so one in flight survives a restart and is
// polled again, and the day's spend across every game is one sum. payload_json is the
// GameGeneration every surface reads; remote_json is the provider's own job ids and state.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS game_art_generations (
      id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      cost_usd REAL,
      payload_json TEXT NOT NULL,
      remote_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS game_art_generations_root ON game_art_generations (root, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS game_art_generations_state ON game_art_generations (state)`;
});
