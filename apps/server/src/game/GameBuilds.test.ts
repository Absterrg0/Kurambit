// Undo restores a turn build's base, so the base must be the game as the turn
// began, fixed when the turn lands: turn 1's is the thread's start checkpoint,
// and a turn after an Undo keeps the Undo's target even once a later restore
// replaced the game's restore record.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type CheckpointRef,
  CheckpointScopeId,
  GameBuildId,
  type GameManifest,
  ProjectId,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../checkpointing/Utils.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GameStage from "./GameStage.ts";

const ROOT = "/games/arena";
const THREAD = ThreadId.make("chat");
const SCOPE = CheckpointScopeId.make("scope-chat-root");
const oid = (n: number) => GameBuildId.make(String(n).repeat(40));
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 10, minute));
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Arena",
  brief: "A brief.",
  artDirection: "",
  engine: { name: "three", version: "1" },
  project: "web",
  assets: [],
};

interface Ref {
  readonly checkpointRef: CheckpointRef;
  readonly oid: string;
  readonly committedAt: number;
}

/** A game whose turns are scripted: `turns` and `refs` may grow as a test goes. */
const world = Effect.gen(function* () {
  const refOf = (ordinal: number) =>
    checkpointRefForScopeOrdinal({ scopeId: SCOPE, ordinalWithinScope: ordinal });
  const refs: Ref[] = [];
  const turns: ProjectionStore.ProjectTurnCheckpoint[] = [];
  // Ordinal 0 is T3's capture as turn 1 began; it is no turn's row.
  refs.push({ checkpointRef: yield* refOf(0), oid: oid(1), committedAt: 0 });
  // Turn `ordinal` makes build oid(ordinal + 1), asked at `minute` and captured 5 minutes on.
  const addTurn = (ordinal: number, minute: number) =>
    Effect.gen(function* () {
      const ref = yield* refOf(ordinal);
      refs.push({ checkpointRef: ref, oid: oid(ordinal + 1), committedAt: ordinal });
      turns.unshift({
        threadId: THREAD,
        threadTitle: "Arena",
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        checkpoint: {
          ref,
          scopeId: SCOPE,
          ordinalWithinScope: ordinal,
          status: "ready",
          files: [{ path: "web/main.js", additions: 4, deletions: 1 }],
          capturedAt: at(minute + 5),
        },
        cwd: ROOT,
        request: `Turn ${ordinal}`,
        startedAt: DateTime.formatIso(at(minute)),
      } as unknown as ProjectionStore.ProjectTurnCheckpoint);
      return ref;
    });
  const layer = GameBuilds.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed(ROOT),
          read: () => Effect.succeed(manifest),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({ projectId: ProjectId.make("arena") } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
            >),
          // Newest first, only turns captured before `before`, as the store reads them.
          listProjectTurnCheckpoints: (_project, { before }) =>
            Effect.succeed(
              turns.filter(
                (turn) =>
                  before === undefined || DateTime.formatIso(turn.checkpoint.capturedAt) < before,
              ),
            ),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          listCheckpointRefs: ({ prefix }) =>
            Effect.succeed(refs.filter((ref) => ref.checkpointRef.startsWith(prefix))),
          updateCheckpointRef: ({ checkpointRef, oid: target }) =>
            Effect.sync(() => {
              refs.push({ checkpointRef, oid: target, committedAt: 99 });
              return true;
            }),
          resolveTrees: ({ revisions }) => Effect.succeed(revisions.map((id) => `tree-${id}`)),
          diffCheckpoints: () => Effect.succeed("4\t1\tweb/main.js"),
          withWorkspaceLock: (_cwd, effect) => effect,
          captureCheckpoint: () => Effect.succeed(oid(9)),
        }),
        Layer.mock(GameFacts.GameFacts)({
          harness: "test",
          readMany: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameRunControl.GameRunControl)({
          steps: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameStage.GameStage)({}),
        Layer.mock(GameOperations.GameOperations)({ current: () => null, events: Stream.empty }),
        Layer.mock(GameBuildCopies.GameBuildCopies)({ plays: () => [] }),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
      ),
    ),
  );
  return { refs, addTurn, layer };
});

/** The game's one no-run restore record, as an Undo writes it once it moved the folder. */
const restored = (requestId: string, target: string, before: string, minute: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      requestId,
      target,
      label: `Build ${target.slice(0, 8)}`,
      requestedAt: DateTime.formatIso(at(minute)),
      before,
      outcome: { restored: true, message: "restored" },
    });
    yield* sql`
      INSERT INTO game_build_restores (root, payload_json, updated_at)
      VALUES (${ROOT}, ${payload}, ${DateTime.formatIso(at(minute))})
      ON CONFLICT (root) DO UPDATE SET payload_json = excluded.payload_json
    `;
  });

describe("GameBuilds base", () => {
  it.effect("is the start checkpoint for turn 1 and the turn before for turn 2", () =>
    Effect.gen(function* () {
      const game = yield* world;
      yield* game.addTurn(1, 0);
      yield* game.addTurn(2, 10);
      const listed = yield* Effect.flatMap(GameBuilds.GameBuilds, (builds) =>
        builds.list(THREAD, {}),
      ).pipe(Effect.provide(game.layer));
      const baseOf = new Map(listed.builds.map((b) => [b.id, b.base]));
      assert.strictEqual(baseOf.get(oid(2)), oid(1));
      assert.strictEqual(baseOf.get(oid(3)), oid(2));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory))),
  );

  it.effect("keeps a turn's base through Undo, a new turn, then Undo, with Redo shown", () =>
    Effect.gen(function* () {
      const game = yield* world;
      const park = (requestId: string, build: string) =>
        game.refs.push({
          checkpointRef: checkpointRefForGameRun("game-builds", `restores/${requestId}-before`),
          oid: build,
          committedAt: 50,
        });
      yield* Effect.gen(function* () {
        const builds = yield* GameBuilds.GameBuilds;
        yield* game.addTurn(1, 0); // A = oid(2)
        yield* game.addTurn(2, 10); // T = oid(3)
        // Undo of T: the folder is A again, T parked.
        park("r1", oid(3));
        yield* restored("r1", oid(2), oid(3), 20);
        // A new turn U = oid(4), begun after the Undo, recorded as it lands.
        const u = yield* game.addTurn(3, 25);
        yield* builds.recordTurn(THREAD, u);
        // Undo of U: back to its base, U parked; this record replaces the first.
        park("r2", oid(4));
        yield* restored("r2", oid(2), oid(4), 40);
        const listed = yield* builds.list(THREAD, {});
        const uRow = listed.builds.find((b) => b.id === oid(4));
        // U's Undo lands on A, never on T, which the person had undone.
        assert.strictEqual(uRow?.base, oid(2));
        // Its strip reads "Undone · Redo": the latest restore went to U's base, and redoes to U.
        assert.strictEqual(listed.restore?.target, uRow?.base);
        assert.strictEqual(listed.restore?.undo, oid(4));
      }).pipe(Effect.provide(game.layer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory))),
  );
});

describe("GameBuilds numbers", () => {
  it.effect("keeps a small fix on its build's number and numbers the next build on", () =>
    Effect.gen(function* () {
      const game = yield* world;
      yield* Effect.gen(function* () {
        const builds = yield* GameBuilds.GameBuilds;
        // A fix declared on the first build is a build: there is nothing before it to fix.
        yield* builds.declareChange(THREAD, "fix");
        yield* builds.recordTurn(THREAD, yield* game.addTurn(1, 0));
        yield* builds.declareChange(THREAD, "fix");
        yield* builds.recordTurn(THREAD, yield* game.addTurn(2, 10));
        // Nothing declared: a build of its own.
        yield* builds.recordTurn(THREAD, yield* game.addTurn(3, 20));
        const listed = yield* builds.list(THREAD, {});
        const named = (n: number) => {
          const build = listed.builds.find((b) => b.id === oid(n));
          return [build?.number, build?.fix];
        };
        assert.deepStrictEqual(named(2), [1, undefined]);
        assert.deepStrictEqual(named(3), [1, 1]);
        assert.deepStrictEqual(named(4), [2, undefined]);
      }).pipe(Effect.provide(game.layer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, SqlitePersistence.layerMemory))),
  );
});

describe("the folder's current build", () => {
  const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
  // Turn rows newest first, one a minute: `builds` are the minutes whose turn changed game files.
  const pages = (rows: number, builds: ReadonlyArray<number>, size = 30) => {
    let read = 0;
    const turns = (before: string | undefined) =>
      Effect.sync(() => {
        read += 1;
        const minutes = Array.from({ length: rows }, (_, i) => rows - i).filter(
          (m) => before === undefined || at(m) < before,
        );
        const page = minutes.slice(0, size);
        const found = page.find((m) => builds.includes(m));
        return {
          newest: found === undefined ? null : { id: `turn-${found}`, at: at(found) },
          oldest: page.length === 0 ? null : at(page.at(-1)!),
          more: page.length === size,
        };
      });
    return { turns, reads: () => read };
  };

  it.effect("finds the newest turn build behind any number of notes-only turns", () =>
    Effect.gen(function* () {
      // Fifty-five turns, only the first changed game files; an hours-old restore is older still.
      const walk = pages(55, [1], 10);
      const current = yield* GameBuilds.currentBuild([{ id: "restore", at: at(0) }], walk.turns);
      assert.strictEqual(current, "turn-1");
      assert.strictEqual(walk.reads(), 6);
    }),
  );

  it.effect("takes a later restore or kept edit, and stops reading once turns are older", () =>
    Effect.gen(function* () {
      const walk = pages(55, [1], 10);
      const current = yield* GameBuilds.currentBuild(
        [
          { id: "restore", at: at(40) },
          { id: "edit", at: at(30) },
        ],
        walk.turns,
      );
      assert.strictEqual(current, "restore");
      assert.strictEqual(walk.reads(), 2);
      const newer = yield* GameBuilds.currentBuild(
        [{ id: "restore", at: at(40) }],
        pages(55, [50]).turns,
      );
      assert.strictEqual(newer, "turn-50");
    }),
  );

  it.effect("is none when no turn changed game files and nothing was restored", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* GameBuilds.currentBuild([], pages(12, [], 5).turns), null);
    }),
  );
});
