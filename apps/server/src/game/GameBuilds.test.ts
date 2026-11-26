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
import {
  type CheckpointRef,
  CheckpointScopeId,
  CommandId,
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
import * as GameBuildMoves from "../orchestration-v2/gameBuilds/GameBuildMoves.ts";
import { memoryBuildRecords } from "./gameBuildsTestkit.ts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GamePreview from "./GamePreview.ts";
import * as ServerConfig from "../config.ts";
import * as GameFolders from "./GameFolders.ts";
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
  const records = memoryBuildRecords();
  const layer = GameBuilds.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed(ROOT),
          home: () => Effect.succeed({ root: ROOT, projectId: ProjectId.make("arena") }),
          read: () => Effect.succeed(manifest),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          ...records.reads,
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
          readMany: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameRunControl.GameRunControl)({
          steps: () => Effect.succeed(new Map()),
        }),
        Layer.mock(GameStage.GameStage)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "game-builds-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        // No other chat writes the folder here.
        Layer.mock(GameFolders.GameFolders)({
          holder: () => Effect.succeed(null),
          withFolder: (_input, work) => work,
          release: () => Effect.void,
        }),
        Layer.mock(GamePreview.GamePreview)({
          url: () => null,
          liveUrl: () => null,
          liveState: () => "off",
          quietWrite: () => Effect.void,
        }),
        Layer.mock(GameOperations.GameOperations)({ current: () => null, events: Stream.empty }),
        Layer.mock(GameBuildCopies.GameBuildCopies)({ plays: () => [] }),
        Layer.mock(Orchestrator.OrchestratorV2)({ dispatch: records.dispatch }),
        Layer.mock(GameBuildMoves.GameBuildMoves)({ attach: records.attach }),
      ),
    ),
  );
  return { refs, addTurn, layer, records };
});

/** An Undo that moved the folder, as its settle records it: the target is back, the park kept. */
const restored = (
  records: ReturnType<typeof memoryBuildRecords>,
  requestId: string,
  target: string,
  before: string,
  minute: number,
) =>
  records.dispatch({
    type: "game-build.restore.settle",
    commandId: CommandId.make(`settle-${requestId}`),
    threadId: THREAD,
    projectId: ProjectId.make("arena"),
    root: ROOT,
    restore: {
      requestId,
      target: GameBuildId.make(target),
      label: `Build ${target.slice(0, 8)}`,
      requestedAt: DateTime.formatIso(at(minute)),
      before: GameBuildId.make(before),
      outcome: { restored: true, message: "restored", moved: "restored" },
    },
    park: { id: GameBuildId.make(before), at: DateTime.formatIso(at(minute)) },
  });

describe("GameBuilds base", () => {
  it.effect("is the start checkpoint for turn 1 and the turn before for turn 2", () =>
    Effect.gen(function* () {
      const game = yield* world;
      const listed = yield* Effect.gen(function* () {
        const builds = yield* GameBuilds.GameBuilds;
        // Each turn's build is recorded as it lands.
        yield* builds.recordTurn(THREAD, yield* game.addTurn(1, 0));
        yield* builds.recordTurn(THREAD, yield* game.addTurn(2, 10));
        return yield* builds.list(THREAD, {});
      }).pipe(Effect.provide(game.layer));
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
        yield* builds.recordTurn(THREAD, yield* game.addTurn(1, 0)); // A = oid(2)
        yield* builds.recordTurn(THREAD, yield* game.addTurn(2, 10)); // T = oid(3)
        // Undo of T: the folder is A again, T parked.
        park("r1", oid(3));
        yield* restored(game.records, "r1", oid(2), oid(3), 20);
        // A new turn U = oid(4), begun after the Undo, recorded as it lands.
        const u = yield* game.addTurn(3, 25);
        yield* builds.recordTurn(THREAD, u);
        // Undo of U: back to its base, U parked; this record replaces the first.
        park("r2", oid(4));
        yield* restored(game.records, "r2", oid(2), oid(4), 40);
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
