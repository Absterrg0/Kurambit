// Undo restores a turn build's base, so the base must be the game as the turn
// began: turn 1's is the thread's start checkpoint, never its own build.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CheckpointScopeId,
  GameBuildId,
  type GameManifest,
  ProjectId,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GameBuildCopies from "./GameBuildCopies.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameFacts from "./GameFacts.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRunControl from "./GameRunControl.ts";
import * as GameService from "./GameService.ts";

const ROOT = "/games/arena";
const THREAD = ThreadId.make("chat");
const SCOPE = CheckpointScopeId.make("scope-chat-root");
const oid = (n: number) => GameBuildId.make(String(n).repeat(40));
const manifest: GameManifest = {
  schemaVersion: 1,
  name: "Arena",
  brief: "A brief.",
  artDirection: "",
  engine: { name: "three", version: "1" },
  project: "web",
  assets: [],
};

describe("GameBuilds base", () => {
  it.effect("is the start checkpoint for turn 1 and the turn before for turn 2", () =>
    Effect.gen(function* () {
      const refOf = (ordinal: number) =>
        checkpointRefForScopeOrdinal({ scopeId: SCOPE, ordinalWithinScope: ordinal });
      // Ordinal 0 is T3's capture as turn 1 began; it is no turn's row.
      const refs = yield* Effect.forEach([0, 1, 2], (n) =>
        Effect.map(refOf(n), (ref) => ({ checkpointRef: ref, oid: oid(n + 1), committedAt: n })),
      );
      const turn = (ordinal: number, minute: number) => ({
        threadId: THREAD,
        threadTitle: "Arena",
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        checkpoint: {
          ref: refs[ordinal]!.checkpointRef,
          scopeId: SCOPE,
          ordinalWithinScope: ordinal,
          status: "ready",
          files: [{ path: "web/main.js", additions: 4, deletions: 1 }],
          capturedAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 10, minute + 5)),
        },
        cwd: ROOT,
        request: `Turn ${ordinal}`,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 10, minute))),
      });
      const rows = [
        turn(2, 10),
        turn(1, 0),
      ] as unknown as ReadonlyArray<ProjectionStore.ProjectTurnCheckpoint>;
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
              listProjectTurnCheckpoints: () => Effect.succeed(rows),
            }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              listCheckpointRefs: ({ prefix }) =>
                Effect.succeed(refs.filter((ref) => ref.checkpointRef.startsWith(prefix))),
              resolveTrees: ({ revisions }) => Effect.succeed(revisions.map((id) => `tree-${id}`)),
            }),
            Layer.mock(GameFacts.GameFacts)({
              harness: "test",
              readMany: () => Effect.succeed(new Map()),
            }),
            Layer.mock(GameRunControl.GameRunControl)({ runBuilds: () => Effect.succeed(null) }),
            Layer.mock(GameService.GameService)({}),
            Layer.mock(GameOperations.GameOperations)({
              current: () => null,
              events: Stream.empty,
            }),
            Layer.mock(GameBuildCopies.GameBuildCopies)({ plays: () => [] }),
            SqlitePersistence.layerMemory,
          ),
        ),
      );
      const listed = yield* Effect.flatMap(GameBuilds.GameBuilds, (builds) =>
        builds.list(THREAD, {}),
      ).pipe(Effect.provide(layer));
      const baseOf = new Map(listed.builds.map((b) => [b.id, b.base]));
      assert.strictEqual(baseOf.get(oid(2)), oid(1));
      assert.strictEqual(baseOf.get(oid(3)), oid(2));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
