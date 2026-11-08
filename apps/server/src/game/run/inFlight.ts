// A keep-going run's step in flight, as the turn reactor, the step runner and
// the game's builds read it, and the one way a pending proposal is superseded:
// anything that changes the game before a Guided step starts (a turn in any
// chat, a restore) means the proposal read a folder that is gone.
import {
  type GameRun,
  type GameRunStep,
  type ProjectId,
  gameRunStepCommandId,
} from "@kurambit/contracts";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

/** The run's step in flight, while it is the attempt's. */
export interface Located {
  readonly run: GameRun;
  readonly record: GameRunStep;
}

export const locateIn = (
  records: ProjectionStore.GameRunThreadRecords,
  stepId: string,
  attempt: number,
): Located | null => {
  const run = records.gameRuns.at(-1);
  if (run === undefined || run.status === "ended" || run.inFlight === null) return null;
  const record = records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight);
  if (record === undefined || record.id !== stepId || record.attempt !== attempt) return null;
  if (record.status !== "planned" && record.status !== "running") return null;
  return { run, record };
};

// A refusal is the run's answer (it moved on or stopped); a receipt is a repeat.
export const refusedOnly = <A, R>(
  dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>,
) =>
  dispatch.pipe(
    Effect.asVoid,
    Effect.catchTags({
      OrchestratorGameRunRefusedError: (error) =>
        Effect.logInfo("keep going's report not taken", { detail: error.detail }),
      OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
    }),
  );

/** The game's live keep-going run and its step in flight; null when none is. */
export const projectStep = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  projectId: ProjectId,
) =>
  Effect.gen(function* () {
    const run = yield* projections.getProjectGameRun(projectId);
    if (run === null || run.status === "ended" || run.inFlight === null) return null;
    const records = yield* projections.getGameRunRecords(run.threadId, { steps: "in-flight" });
    const record = records.gameRunSteps.find(
      (each) => each.runId === run.id && each.seq === run.inFlight,
    );
    return record === undefined || (record.status !== "planned" && record.status !== "running")
      ? null
      : ({ run, record } satisfies Located);
  });

/** A pending proposal is superseded, since the person goes first: the run looks again once the game is idle. */
export const supersedeProposal = (
  engine: Orchestrator.OrchestratorV2["Service"],
  located: Located,
) =>
  located.record.step.kind !== "propose"
    ? Effect.void
    : refusedOnly(
        engine.dispatch({
          type: "game-run.step.complete",
          commandId: gameRunStepCommandId(located.record.id, located.record.attempt, "complete"),
          threadId: located.run.threadId,
          runId: located.run.id,
          stepId: located.record.id,
          attempt: located.record.attempt,
          result: { kind: "decided", answer: "superseded", by: "server" },
        }),
      );
