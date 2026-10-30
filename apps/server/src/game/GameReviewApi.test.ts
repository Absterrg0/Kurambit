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
import * as GameRepairStudio from "./GameRepairStudio.ts";
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
    selected?: boolean;
    refuseStop?: boolean;
    /** The newest loop stopped because a user edit blocked its rejection. */
    blockedByEdit?: boolean;
    /** Newest-first rounds; defaults to three interrupted rounds without quality. */
    rounds?: GameReviewRound[];
  } = {},
) {
  let stopped = 0;
  let restored = 0;
  const factsCalls: string[] = [];
  const stoppedByEdit = options.blockedByEdit === true;
  const rounds =
    options.rounds ??
    (stoppedByEdit
      ? [stoppedRound("three"), stoppedRound("two"), stoppedRound("one")]
      : [round("three"), round("two"), round("one")]);
  const record = stoppedByEdit ? stoppedLoop : options.loop === undefined ? loop : options.loop;
  const layer = GameReviewApi.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GameProjectService.GameProjectService)({
          resolve: () => Effect.succeed("/games/api"),
          read: () =>
            Effect.succeed({
              schemaVersion: 1 as const,
              name: "Review probe",
              brief: "Make a small platformer.",
              artDirection: "",
              engine: { name: "godot" as const, version: "4.7.2" },
              godotProject: "godot",
              assets: [],
            }),
          activeRun: () => Effect.succeed(null),
        }),
        Layer.mock(GameRoundStore.GameRoundStore)({
          read: () =>
            Effect.succeed({
              selected: options.selected
                ? {
                    buildId: "a".repeat(64),
                    directory: "builds/candidates/selected",
                    sourceId: "old-sources",
                    engine: "godot" as const,
                    target: "Web" as const,
                    entry: "index.html",
                    roundId: null,
                    promotedAt: "2026-10-23T00:00:00Z",
                  }
                : null,
              rounds,
              production: {
                firstPlayableAt: "2026-10-23T00:00:00.000Z",
                firstPlayableBuildId: "b".repeat(64),
                runId: null,
                turnFirstSubmitAt: "2026-10-23T00:00:00.000Z",
                turnLastSubmitAt: "2026-10-23T00:03:00.000Z",
                submissions: 2,
              },
            }),
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
        Layer.mock(GameRepairStudio.GameRepairStudio)({
          submissionFacts: (_root, buildId) =>
            Effect.sync(() => {
              factsCalls.push(buildId!);
              return {
                buildId: buildId!,
                directory: "builds/candidates/selected",
                checks: [{ id: "boot", status: "passed" as const }],
                passed: true,
                reason: null,
              };
            }),
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
  return { layer, factsCalls, calls: () => ({ stopped, restored }) };
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
        production: {
          firstPlayableAt: "2026-10-23T00:00:00.000Z",
          submissions: 2,
          elapsedMs: 3 * 60_000,
          remainingMs: DEFAULT_GAME_REVIEW_BUDGET.elapsedMs - 3 * 60_000,
        },
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
  it.effect("status omits quality coverage when no round assessed it", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      // No round assessed quality: the status carries no coverage, never a zero.
      expect((yield* api.status(threadId)).qualityCoverage).toBeUndefined();
    }).pipe(Effect.provide(fixture().layer)),
  );
  it.effect("status reports the newest frozen quality coverage", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      const status = yield* api.status(threadId);
      expect(status.qualityCoverage).toEqual({
        rubricVersion: 1,
        assessed: 7,
        total: 7,
        unknowns: 4,
      });
    }).pipe(
      Effect.provide(
        fixture({
          rounds: [
            {
              ...round("four"),
              qualityRubricVersion: 1,
              qualityCoverage: { rubricVersion: 1, assessed: 7, total: 7, unknowns: 4 },
            },
            round("three"),
          ],
        }).layer,
      ),
    ),
  );
  it.effect("history returns the frozen quality coverage with the round", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      const history = yield* api.history({ threadId, limit: 5 });
      expect(history.rounds).toHaveLength(1);
      expect(history.rounds[0]?.round.qualityCoverage).toEqual({
        rubricVersion: 1,
        assessed: 7,
        total: 7,
        unknowns: 7,
      });
      expect(history.rounds[0]?.round.qualityRubricVersion).toBe(1);
    }).pipe(
      Effect.provide(
        fixture({
          rounds: [
            {
              ...round("one"),
              qualityRubricVersion: 1,
              qualityCoverage: { rubricVersion: 1, assessed: 7, total: 7, unknowns: 7 },
            },
          ],
        }).layer,
      ),
    ),
  );
  it.effect("history leaves legacy rounds without quality unknown", () =>
    Effect.gen(function* () {
      const api = yield* GameReviewApi.GameReviewApi;
      const history = yield* api.history({ threadId, limit: 5 });
      for (const entry of history.rounds) {
        expect(entry.round.quality).toBeUndefined();
        expect(entry.round.qualityCoverage).toBeUndefined();
      }
    }).pipe(Effect.provide(fixture().layer)),
  );
});

it.effect("verifies only the selected build on explicit completion reads", () => {
  const test = fixture({ selected: true });
  return Effect.gen(function* () {
    const api = yield* GameReviewApi.GameReviewApi;
    expect((yield* api.status(threadId)).selectedBuildFacts).toBeUndefined();
    expect(test.factsCalls).toEqual([]);
    const read = yield* api.status(threadId, true);
    expect(read.selectedBuildFacts).toMatchObject({ buildId: "a".repeat(64), passed: true });
    expect(test.factsCalls).toEqual(["a".repeat(64)]);
  }).pipe(Effect.provide(test.layer));
});
