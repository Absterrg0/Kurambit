import { assert, it, vi } from "@effect/vitest";
import { CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes workspace and local Git after a turn without hosted lookups", () => {
  const refreshed: string[] = [];
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({
      cwd: "/repo",
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
    });
    assert.deepEqual(refreshed.toSorted(), ["git:/repo", "workspace:/repo"]);
  }).pipe(
    Effect.provide(
      RunFinalization.layerObserver.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({
              refresh: (cwd) =>
                Effect.sync(() => {
                  refreshed.push(`workspace:${cwd}`);
                }),
            }),
            Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
              refreshLocalStatus: (cwd) =>
                Effect.sync(() => {
                  refreshed.push(`git:${cwd}`);
                  return {
                    isRepo: false,
                    hasPrimaryRemote: false,
                    isDefaultRef: false,
                    refName: null,
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                  };
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          ),
        ),
      ),
    ),
  );
});
