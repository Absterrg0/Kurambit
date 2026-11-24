// A game's builds as projection rows: one row per build, one per game folder (the build it
// holds, its latest restore, the keeps it holds). The event sink applies every `game-build.*`
// event here in the commit that records it, so a read never runs ahead of the log.
import {
  GameBuildFolder,
  GameBuildRecord,
  type GameBuildId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

type GameBuildEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: `game-build.${string}` }
>;

const RecordJson = Schema.fromJsonString(GameBuildRecord);
const FolderJson = Schema.fromJsonString(GameBuildFolder);
const encodeRecord = Schema.encodeEffect(RecordJson);
const decodeRecord = Schema.decodeUnknownEffect(RecordJson);
const encodeFolder = Schema.encodeEffect(FolderJson);
const decodeFolder = Schema.decodeUnknownEffect(FolderJson);

export const emptyFolder = (projectId: ProjectId, root: string): GameBuildFolder => ({
  projectId,
  root,
  current: null,
  restore: null,
  held: [],
  migrated: false,
});

/** The folder after one event; null when the event leaves it as it was. */
export const applyToFolder = (
  folder: GameBuildFolder,
  event: GameBuildEvent,
): GameBuildFolder | null => {
  switch (event.type) {
    case "game-build.recorded":
      return event.payload.current ? { ...folder, current: event.payload.build.id } : null;
    case "game-build.restored":
      return {
        ...folder,
        restore: event.payload.restore,
        current: event.payload.current ?? folder.current,
      };
    case "game-build.kept": {
      const { keep, drop } = event.payload;
      const held = folder.held.filter(
        (each) => each.request !== drop && each.request !== keep?.request,
      );
      return { ...folder, held: keep === null ? held : [...held, keep] };
    }
    case "game-build.dropped":
      return event.payload.current === null ? null : { ...folder, current: event.payload.current };
    case "game-build.migrated":
      return {
        ...folder,
        migrated: true,
        current: event.payload.current ?? folder.current,
        restore: folder.restore ?? event.payload.restore,
      };
  }
};

const folderKey = (event: GameBuildEvent) =>
  event.type === "game-build.recorded"
    ? { projectId: event.payload.build.projectId, root: event.payload.build.root }
    : { projectId: event.payload.projectId, root: event.payload.root };

export const applySql = (sql: SqlClient.SqlClient, event: GameBuildEvent) =>
  Effect.gen(function* () {
    if (event.type === "game-build.recorded") {
      const build = event.payload.build;
      const payload = yield* encodeRecord(build);
      // A build is recorded once: a repeat (a landing settled again, a turn recorded by the
      // reactor and a reconcile) keeps its first number and only moves the folder's build.
      yield* sql`
        INSERT INTO orchestration_v2_projection_game_builds (
          project_id, build_id, root, kind, number, at, payload_json
        )
        VALUES (
          ${build.projectId}, ${build.id}, ${build.root}, ${build.kind}, ${build.number},
          ${build.at}, ${payload}
        )
        ON CONFLICT(project_id, build_id) DO NOTHING
      `;
    }
    if (event.type === "game-build.dropped" && event.payload.ids.length > 0)
      yield* sql`
        DELETE FROM orchestration_v2_projection_game_builds
        WHERE project_id = ${event.payload.projectId} AND ${sql.in("build_id", event.payload.ids)}
      `;
    const key = folderKey(event);
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_game_build_folders
      WHERE project_id = ${key.projectId} AND root = ${key.root}
    `;
    const folder =
      rows[0] === undefined
        ? emptyFolder(key.projectId, key.root)
        : yield* decodeFolder(rows[0].payload_json);
    const next = applyToFolder(folder, event);
    if (next === null) return;
    const payload = yield* encodeFolder(next);
    yield* sql`
      INSERT INTO orchestration_v2_projection_game_build_folders (project_id, root, payload_json)
      VALUES (${key.projectId}, ${key.root}, ${payload})
      ON CONFLICT(project_id, root) DO UPDATE SET payload_json = excluded.payload_json
    `;
  });

export interface GameBuildListOptions {
  /** One folder's builds; every folder's of the project when absent. */
  readonly root?: string | undefined;
  /** An ISO time the page ends before. */
  readonly before?: string | undefined;
  readonly limit: number;
}

export interface GameBuildTally {
  /**
   * The game's highest number so far (0: none), across its folder and its copies: a copy numbers
   * on from its seat in the same series, so no two builds a person sees share a number.
   */
  readonly number: number;
  /** The game's restore parks so far. */
  readonly parks: number;
}

export const reads = (sql: SqlClient.SqlClient) => {
  const decodeRows = (rows: ReadonlyArray<{ readonly payload_json: string }>) =>
    Effect.forEach(rows, (row) => decodeRecord(row.payload_json));
  return {
    folder: (projectId: ProjectId, root: string) =>
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_game_build_folders
        WHERE project_id = ${projectId} AND root = ${root}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeFolder(rows[0].payload_json),
        ),
      ),
    folders: () =>
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_game_build_folders
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeFolder(row.payload_json))),
      ),
    list: (projectId: ProjectId, options: GameBuildListOptions) =>
      sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_game_builds
        WHERE project_id = ${projectId}
          ${options.root === undefined ? sql`` : sql`AND root = ${options.root}`}
          ${options.before === undefined ? sql`` : sql`AND at < ${options.before}`}
        ORDER BY at DESC, rowid DESC
        LIMIT ${options.limit}
      `.pipe(Effect.flatMap(decodeRows)),
    get: (projectId: ProjectId, ids: ReadonlyArray<GameBuildId>) =>
      ids.length === 0
        ? Effect.succeed([] as ReadonlyArray<GameBuildRecord>)
        : sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_game_builds
            WHERE project_id = ${projectId} AND ${sql.in("build_id", ids)}
          `.pipe(Effect.flatMap(decodeRows)),
    tally: (projectId: ProjectId) =>
      sql<{ readonly number: number | null; readonly parks: number }>`
        SELECT
          (SELECT MAX(number) FROM orchestration_v2_projection_game_builds
            WHERE project_id = ${projectId}) AS number,
          (SELECT COUNT(*) FROM orchestration_v2_projection_game_builds
            WHERE project_id = ${projectId} AND kind = 'restore-before') AS parks
      `.pipe(
        Effect.map((rows): GameBuildTally => ({
          number: rows[0]?.number ?? 0,
          parks: rows[0]?.parks ?? 0,
        })),
      ),
  };
};
