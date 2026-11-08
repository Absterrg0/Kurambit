// At startup, the ProviderRuntimeRecoveryService way. A keep-going run whose
// step a restart cut off gets that step's job again, always through the
// outbox, so it runs behind whatever its thread still owes; every step is
// safe to repeat. A step turn T3 carried over a restart that its run no
// longer wants (the run ended, or moved past that step) is stopped, so
// nothing edits a game the person turned keep going off for.
import {
  CommandId,
  type GameRunId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { refusedOnly } from "../../game/run/inFlight.ts";
import { retrying } from "../../game/run/retrying.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { type StepTurn, parseStepTurn } from "./ids.ts";

export class GameRunRecovery extends Context.Service<
  GameRunRecovery,
  { readonly recover: () => Effect.Effect<void> }
>()("kurambit/orchestration-v2/gameRun/GameRunRecovery") {}

const LIVE_TURN: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

interface StopDeps {
  readonly projections: ProjectionStore.ProjectionStoreV2Shape;
  readonly engine: Orchestrator.OrchestratorV2["Service"];
}

/**
 * Stops every live step turn on the thread that `keep` does not want: a
 * queued one is cancelled, a running one interrupted, and its work still
 * becomes a build like any turn's. Only turns a step message started are
 * touched; the person's own turns never are.
 */
export const stopStepTurns = (
  deps: StopDeps,
  threadId: ThreadId,
  keep: (step: StepTurn) => boolean,
) =>
  Effect.gen(function* () {
    const { runs } = yield* deps.projections.getThreadRecords(threadId, ["runs"]);
    for (const turn of runs) {
      const step = parseStepTurn(turn.userMessageId);
      if (step === null || !LIVE_TURN.has(turn.status) || keep(step)) continue;
      const commandId = CommandId.make(`server:game-run-step-stop:${turn.id}`);
      yield* deps.engine.dispatch(
        turn.status === "queued"
          ? { type: "queued-run.cancel", commandId, threadId, runId: turn.id }
          : {
              type: "run.interrupt",
              commandId,
              threadId,
              runId: turn.id,
              reason: "Keep going no longer runs this step.",
            },
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("a keep-going step turn could not be stopped", {
        threadId,
        cause: Cause.pretty(cause),
      }),
    ),
  );

/** Every step turn but the one a live turns run holds in flight. */
const stepTurnsWanted =
  (
    run: { readonly id: GameRunId; readonly live: boolean } | null,
    inFlight: { readonly id: string; readonly attempt: number; readonly turn: boolean } | null,
  ) =>
  (step: StepTurn) =>
    run !== null &&
    run.live &&
    step.runId === run.id &&
    inFlight !== null &&
    inFlight.turn &&
    step.stepId === inFlight.id &&
    step.attempt === inFlight.attempt;

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  /** A step turn on a thread with a turn running, checked against that thread's run. */
  const stopUnwantedStepTurns = Effect.gen(function* () {
    const shell = yield* retrying(projections.getShellSnapshot({ location: "active" }));
    for (const thread of shell.threads) {
      if (thread.activeRunId === null) continue;
      const records = yield* retrying(
        projections.getGameRunRecords(thread.id, { steps: "in-flight" }),
      );
      const run = records.gameRuns.at(-1) ?? null;
      const step =
        run === null
          ? null
          : (records.gameRunSteps.find(
              (each) => each.runId === run.id && each.seq === run.inFlight,
            ) ?? null);
      yield* stopStepTurns(
        { projections, engine },
        thread.id,
        stepTurnsWanted(
          run === null ? null : { id: run.id, live: run.status !== "ended" },
          step === null
            ? null
            : { id: step.id, attempt: step.attempt, turn: step.step.kind === "turn" },
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("game run recovery could not check step turns", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const recoverThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1);
      if (run === undefined || run.status === "ended") return;
      // A live run on a chat deleted before deletion stopped its run: nothing
      // could reach it, so it stops now.
      const chat = yield* projections.getThread(threadId);
      if (chat.deletedAt !== null) {
        yield* engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-chat-deleted:${run.id}`),
          threadId,
          runId: run.id,
        });
        return;
      }
      if (run.inFlight === null) return;
      const step = records.gameRunSteps.find(
        (each) => each.runId === run.id && each.seq === run.inFlight,
      );
      if (step === undefined || (step.status !== "planned" && step.status !== "running")) return;
      // A proposal waits on its deadline effect, which the outbox kept.
      if (step.step.kind === "propose") return;
      // An effect still owed drives the step; otherwise a durable wake does,
      // in the outbox's order, never a job started from here.
      if (
        yield* outbox.hasUnsettled({
          threadId,
          effectTypes: ["game-run.step.execute", "game-run.step.wake", "game-run.step.resend"],
        })
      )
        return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      // A refusal is the run's own answer (it moved on or stopped): nothing to retry.
      yield* refusedOnly(
        engine.dispatch({
          type: "game-run.step.schedule",
          commandId: CommandId.make(
            `server:game-run-recover:${step.id}:attempt:${step.attempt}:${now}`,
          ),
          threadId,
          runId: run.id,
          stepId: step.id,
          attempt: step.attempt,
          at: now,
          timer: { kind: "recover" },
        }),
      );
    }).pipe(
      // Every part of it is safe to repeat.
      retrying,
      Effect.catchCause((cause) =>
        Effect.logWarning("game run recovery failed for a thread", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(pauseStuck(threadId, cause))),
      ),
    );

  /**
   * Nothing drives a step recovery could not schedule, so the run would sit
   * on it for good: it pauses instead, with the cause, and resumes from a
   * fresh look. A pause that cannot be written is left to the next startup.
   */
  const pauseStuck = (threadId: ThreadId, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const run = (yield* projections.getGameRunRecords(threadId, { steps: [] })).gameRuns.at(-1);
      if (run === undefined || run.status === "ended") return;
      // The failure's own lines and its causes', without the stack.
      const why = Cause.pretty(cause)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("at ") && line !== "}")
        .join(" ");
      yield* refusedOnly(
        engine.dispatch({
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-recover-paused:${run.id}:${run.seq}`),
          threadId,
          runId: run.id,
          ending: "tool-failed",
          reason:
            `keep going could not pick up step ${run.seq} after a restart: ${why || "no detail given"}`.slice(
              0,
              300,
            ),
        }),
      );
    }).pipe(
      Effect.catchCause((stuck) =>
        Effect.logWarning("a keep-going run recovery could not resume stays as it is", {
          threadId,
          cause: Cause.pretty(stuck),
        }),
      ),
    );

  const recover = () =>
    retrying(projections.listGameRunThreadsToRecover()).pipe(
      Effect.flatMap((threads) => Effect.forEach(threads, recoverThread, { discard: true })),
      Effect.andThen(stopUnwantedStepTurns),
      Effect.catchCause((cause) =>
        Effect.logWarning("game run recovery failed", { cause: Cause.pretty(cause) }),
      ),
    );

  return GameRunRecovery.of({ recover });
});

export const layer = Layer.effect(GameRunRecovery, make);
