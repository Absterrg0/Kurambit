// The turn loop plays only the person's own chat turns, and only on an engine
// whose turn builds are fast enough to play after every turn.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CheckpointRef,
  type GameEngineId,
  type GameManifest,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@kurambit/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as GameBuilds from "./GameBuilds.ts";
import * as GameBuildsReactor from "./GameBuildsReactor.ts";
import * as GameOperations from "./GameOperations.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";

const ROOT = "/games/arena";
const REF = CheckpointRef.make("refs/kurambit/orchestration-v2/checkpoints/scope/ordinal/1");
const OID = "a".repeat(40);

const manifest = (engine: GameEngineId): GameManifest => ({
  schemaVersion: 1,
  name: "Arena",
  brief: "A brief.",
  artDirection: "",
  engine: { name: engine, version: "1" },
  project: engine === "godot" ? "godot" : "web",
  assets: [],
});

// Only the fields the reactor reads: a captured, ready turn checkpoint that changed a file.
const captured = (threadId: string) =>
  ({
    type: "checkpoint.captured",
    threadId: ThreadId.make(threadId),
    payload: {
      ref: REF,
      runId: "run-1",
      status: "ready",
      files: [{ path: "web/main.js", additions: 3, deletions: 1 }],
    },
  }) as unknown as OrchestrationV2DomainEvent;

const run = (
  engine: GameEngineId,
  relationship: string | null,
  turnStatus: "completed" | "interrupted" = "completed",
) =>
  Effect.gen(function* () {
    const played: string[] = [];
    const measured: Array<{ build: string; supersede: boolean }> = [];
    const layer = GameBuildsReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(GameBuilds.GameBuilds)({
            recordTurn: () => Effect.void,
            measureIn: (_root, build, options) =>
              Effect.sync(() => {
                measured.push({ build, supersede: options?.supersede === true });
              }),
          }),
          Layer.mock(GameOperations.GameOperations)({
            current: () => null,
            events: Stream.empty,
            changed: () => Effect.void,
          }),
          Layer.mock(GameProjectService.GameProjectService)({
            resolve: () => Effect.succeed(ROOT),
            read: () => Effect.succeed(manifest(engine)),
            runHold: () => Effect.succeed(null),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed({
                lineage: { relationshipToParent: relationship },
              } as unknown as Effect.Success<
                ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
              >),
            // Generic over the fields asked; this test reads only the turn's run.
            getThreadRecords: (() =>
              Effect.succeed({
                runs: [{ id: "run-1", status: turnStatus }],
              })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
          }),
          Layer.mock(GameService.GameService)({
            playCurrent: (threadId) => Effect.sync(() => void played.push(threadId)),
          }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            listCheckpointRefs: () =>
              Effect.succeed([{ checkpointRef: REF, oid: OID, committedAt: 0 }]),
          }),
        ),
      ),
    );
    yield* Effect.flatMap(GameBuildsReactor.GameBuildsReactor, (reactor) =>
      reactor.handle(captured("chat")),
    ).pipe(Effect.provide(layer));
    return { played, measured };
  });

describe("GameBuildsReactor turn loop", () => {
  it.effect("plays and measures a chat turn's build on three.js", () =>
    Effect.gen(function* () {
      const { played, measured } = yield* run("three", null);
      assert.deepStrictEqual(played, ["chat"]);
      assert.deepStrictEqual(measured, [{ build: OID, supersede: true }]);
    }),
  );

  it.effect("leaves a role's or a subagent's turn to the run", () =>
    Effect.gen(function* () {
      for (const relationship of ["role", "subagent"]) {
        const { played, measured } = yield* run("three", relationship);
        assert.deepStrictEqual(played, []);
        assert.deepStrictEqual(measured, []);
      }
    }),
  );

  it.effect("measures but does not play a turn the person stopped", () =>
    Effect.gen(function* () {
      const { played, measured } = yield* run("three", null, "interrupted");
      assert.deepStrictEqual(played, []);
      assert.deepStrictEqual(measured, [{ build: OID, supersede: true }]);
    }),
  );

  it.effect("plays nothing on a parked engine", () =>
    Effect.gen(function* () {
      const { played, measured } = yield* run("godot", null);
      assert.deepStrictEqual(played, []);
      assert.deepStrictEqual(measured, []);
    }),
  );
});
