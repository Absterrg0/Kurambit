// What a restart leaves behind: a stage-era run still live, a keep-going step
// whose job died with the server, and a step turn T3 carried over that its run
// no longer wants (K11, K12).
import { assert, it } from "@effect/vitest";
import {
  type GameRun,
  GameRunId,
  type GameRunStep,
  MessageId,
  RunId,
  ThreadId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as GameRunRecovery from "./GameRunRecovery.ts";
import { stepTurnMessageId } from "./ids.ts";

const live = ThreadId.make("thread:live");
const ended = ThreadId.make("thread:ended");
const legacy = ThreadId.make("thread:legacy");
const liveRun = GameRunId.make("run_live");
const endedRun = GameRunId.make("run_ended");

const run = (id: GameRunId, threadId: ThreadId, patch: Partial<GameRun>) =>
  ({
    id,
    threadId,
    loop: "turns",
    status: "running",
    ending: null,
    inFlight: 4,
    steer: [],
    ...patch,
  }) as unknown as GameRun;
const step = (runId: GameRunId, threadId: ThreadId, seq: number, kind: GameRunStep["kind"]) =>
  ({
    id: gameRunStepId(runId, seq),
    runId,
    threadId,
    seq,
    attempt: 1,
    kind,
    step: { kind, id: seq },
    status: "running",
  }) as unknown as GameRunStep;
const t3Run = (id: string, message: string, status: string) => ({
  id: RunId.make(id),
  userMessageId: MessageId.make(message),
  status,
});

it.effect("recovery stops what a restart left behind, and runs the cut-off step again", () =>
  Effect.gen(function* () {
    const runs: Record<string, GameRun> = {
      [live]: run(liveRun, live, {}),
      [ended]: run(endedRun, ended, { status: "ended", ending: "stopped", inFlight: null }),
      [legacy]: run(GameRunId.make("run_legacy"), legacy, { loop: undefined } as never),
    };
    const steps: Record<string, GameRunStep[]> = {
      [live]: [step(liveRun, live, 4, "judge")],
      [ended]: [],
      [legacy]: [],
    };
    const t3Runs: Record<string, unknown[]> = {
      [live]: [
        // A late turn of the live run's earlier step: no longer wanted.
        t3Run("t3-old", stepTurnMessageId(gameRunStepId(liveRun, 2), 1), "running"),
        // The person's own turn: never touched.
        t3Run("t3-person", "message:person-1", "running"),
      ],
      [ended]: [
        t3Run("t3-ended", stepTurnMessageId(gameRunStepId(endedRun, 3), 1), "running"),
        t3Run("t3-queued", stepTurnMessageId(gameRunStepId(endedRun, 3), 2), "queued"),
      ],
    };
    const sent: Array<{ type: string; threadId?: string; runId?: string; reason?: string }> = [];
    const layer = GameRunRecovery.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            listLiveGameRunRoleTurns: () => Effect.succeed([]),
            listGameRunThreadsToRecover: () => Effect.succeed([live, legacy]),
            getThread: () => Effect.succeed({ deletedAt: null } as never),
            getGameRunRecords: (threadId) =>
              Effect.succeed({
                gameRuns: [runs[threadId]!],
                gameRunSteps: steps[threadId] ?? [],
                gameRunRounds: [],
              }),
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [
                  { id: live, activeRunId: RunId.make("t3-old") },
                  { id: ended, activeRunId: RunId.make("t3-ended") },
                ],
              } as never),
            getThreadRecords: (threadId) =>
              Effect.succeed({ runs: t3Runs[threadId] ?? [] } as never),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({ hasUnsettled: () => Effect.succeed(false) }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                sent.push(command as never);
                return {} as never;
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const recovery = yield* GameRunRecovery.GameRunRecovery;
      yield* recovery.recover();
    }).pipe(Effect.provide(layer));

    assert.deepStrictEqual(
      sent.map((c) => [c.type, c.threadId, c.runId ?? null]),
      [
        ["game-run.step.schedule", live, liveRun],
        ["game-run.stop", legacy, "run_legacy"],
        ["run.interrupt", live, "t3-old"],
        ["run.interrupt", ended, "t3-ended"],
        ["queued-run.cancel", ended, "t3-queued"],
      ],
    );
    assert.strictEqual(sent[1]?.reason, STAGE_ERA_SENTENCE);
  }),
);
