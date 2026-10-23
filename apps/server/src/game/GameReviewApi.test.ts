import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_GAME_REVIEW_BUDGET,
  GameOperationError,
  RunId,
  ProviderInstanceId,
  ThreadId,
  type GameReviewRound,
  type GameRepairLoop as LoopRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GameReviewApi from "./GameReviewApi.ts";
import * as GameRepairLoop from "./GameRepairLoop.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameRoundStore from "./GameRoundStore.ts";
import * as GameReviewSessions from "./GameReviewSessions.ts";

const threadId = ThreadId.make("review-api");
const round = (id: string): GameReviewRound => ({
  schemaVersion: 1,
  id,
  threadId,
  status: "interrupted",
  startedAt: "2026-10-23T00:00:00Z",
  finishedAt: "2026-10-23T00:01:00Z",
  incumbentSnapshotId: "snapshot",
  incumbentSourceId: "source",
  incumbentBuildId: "build",
  postRepairSourceId: "repaired",
  candidate: null,
  budget: DEFAULT_GAME_REVIEW_BUDGET,
  loopId: "loop",
  decision: "interrupt",
  reason: "The server restarted.",
});
/** A round a user edit stopped: its fallback snapshot is still recorded. */
const stoppedRound = (id: string): GameReviewRound => ({
  ...round(id),
  status: "stopped",
  decision: "stop",
  reason: "The game folder changed after the repair; the snapshot and candidate are kept.",
});
const loop: LoopRecord = {
  schemaVersion: 2,
  id: "loop",
  root: "/games/api",
  threadId,
  originatingRunId: RunId.make("run"),
  originatingNodeId: "node",
  exportBuildId: "build",
  status: "interrupted",
  repairsUsed: 1,
  budget: DEFAULT_GAME_REVIEW_BUDGET,
  builderSelection: { instanceId: ProviderInstanceId.make("codex"), model: "builder" },
  reviewSelection: { instanceId: ProviderInstanceId.make("codex"), model: "reviewer" },
  inputs: { steps: [], viewport: null, seed: "unknown" },
  generation: 0,
  startedAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:01:00Z",
  finishedAt: "2026-10-23T00:01:00Z",
  promotedRounds: [],
  decision: "interrupt",
  reason: "The server restarted.",
  usage: { status: "unknown", providerTurns: 0, usedTokens: 0, inputTokens: 0, outputTokens: 0 },
};
/** The loop a user edit stopped before its round could be rejected. */
const stoppedLoop: LoopRecord = {
  ...loop,
  status: "stopped",
  decision: "stop",
  reason: "reject-blocked: the game folder changed after the repair finished.",
};
function fixture(
  options: {
    loop?: LoopRecord | null;
    held?: boolean;
    refuseStop?: boolean;
    /** The newest loop stopped because a user edit blocked its rejection. */
    blockedByEdit?: boolean;
  } = {},
) {
  let stopped = 0;
  let restored = 0;
  const stoppedByEdit = options.blockedByEdit === true;
  const rounds = stoppedByEdit
    ? [stoppedRound("three"), stoppedRound("two"), stoppedRound("one")]
    : [round("three"), round("two"), round("one")];
  const record = stoppedByEdit ? stoppedLoop : options.loop === undefined ? loop : options.loop;
  const layer = GameReviewApi.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed("/games/api"),
        }),
        Layer.mock(GameRoundStore.GameRoundStore)({
          read: () => Effect.succeed({ selected: null, rounds }),
        }),
        Layer.mock(GameReviewSessions.GameReviewSessions)({
          describe: (input) =>
            Effect.succeed(
              input.role === "critic"
                ? {
                    role: "critic",
                    order: 0,
                    directory: "/state/evidence",
                    childThreadId: threadId,
                    runId: "child-run",
                    taskId: "child-task",
                    hash: "evidence-hash",
                    frames: [{ id: "f1", label: "Action", path: "/state/evidence/frame.png" }],
                  }
                : null,
            ),
        }),
        Layer.mock(GameRepairLoop.GameRepairLoop)({
          read: () => Effect.succeed(record),
          activity: () => Effect.succeed({ held: options.held ?? false, phase: null }),
          interrupt: () =>
            options.refuseStop
              ? Effect.fail(
                  new GameOperationError({
                    operation: "stop review",
                    path: "/games/api",
                    reason: "io",
                    detail: "The child has not stopped.",
                  }),
                )
              : Effect.sync(() => {
                  stopped++;
                }),
          restore: () =>
            Effect.sync(() => {
              restored++;
              return {
                kind: "restored" as const,
                round: round("three"),
                restored: ["source.gd"],
                deleted: [],
                discarded: [],
                preservedSnapshotId: "saved-current-version",
              };
            }),
        }),
      ),
    ),
  );
  return { layer, calls: () => ({ stopped, restored }) };
}

describe("game review API", () => {
  it.effect("paginates newest-first with stable IDs and evidence references", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      const first = yield* api.history({ threadId, limit: 2 });
      expect(first.rounds.map((entry) => entry.round.id)).toEqual(["three", "two"]);
      expect(first.nextCursor).toBe("two");
      expect(first.rounds[0]?.evidence[0]).toMatchObject({
        hash: "evidence-hash",
        taskId: "child-task",
        frames: [{ id: "f1" }],
      });
      const second = yield* api.history({ threadId, limit: 2, before: first.nextCursor! });
      expect(second.rounds.map((entry) => entry.round.id)).toEqual(["one"]);
      expect(second.nextCursor).toBeNull();
      expect((yield* api.history({ threadId, before: "gone" }).pipe(Effect.flip)).reason).toBe(
        "invalid-input",
      );
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("reports held interruption, remaining budget and frozen models", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      const status = yield* api.status(threadId);
      expect(status).toMatchObject({
        held: true,
        phase: "held: waiting for a review session to stop",
        repairsLeft: 2,
        timeLeftMs: DEFAULT_GAME_REVIEW_BUDGET.elapsedMs - 60_000,
        budget: { repairs: 3, elapsedMs: 45 * 60_000 },
        restoreOffered: true,
        loop: { reviewSelection: { model: "reviewer" }, usage: { status: "unknown" } },
      });
    }).pipe(Effect.provide(fixture({ held: true }).layer)),
  );
  it.effect("a stop blocked by a user edit still offers Restore and it works", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      expect(yield* api.status(threadId)).toMatchObject({
        restoreOffered: true,
        loop: { status: "stopped" },
      });
      expect(yield* api.restore(threadId)).toMatchObject({ kind: "restored" });
    }).pipe(Effect.provide(fixture({ blockedByEdit: true }).layer)),
  );
  it.effect("existing games have no review and no fabricated win", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      expect(yield* api.status(threadId)).toMatchObject({
        loop: null,
        phase: "No review yet",
        restoreOffered: false,
      });
    }).pipe(Effect.provide(fixture({ loop: null }).layer)),
  );
  it.effect("stop and explicit restore use the loop service", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      yield* api.stop(threadId);
      expect(yield* api.restore(threadId)).toMatchObject({ kind: "restored" });
      expect(test.calls()).toEqual({ stopped: 1, restored: 1 });
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("surfaces a session that refused to stop", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      expect((yield* api.stop(threadId).pipe(Effect.flip)).detail).toBe(
        "The child has not stopped.",
      );
    }).pipe(Effect.provide(fixture({ refuseStop: true }).layer)),
  );
});
