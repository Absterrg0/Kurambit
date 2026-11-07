// A Guided proposal's timed default: the deadline effect, due when the default
// would fire (the outbox's availableAt), asks the run for it with
// game-run.decision.expire. No fiber holds a proposal, so a restart keeps it.
import { CommandId, type GameRunId, type GameRunStepId, type ThreadId } from "@kurambit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../Orchestrator.ts";

interface DecisionEffect {
  /** The effect's own id: each deadline asks under a command id of its own. */
  readonly effectId: string;
  readonly threadId: ThreadId;
  readonly runId: GameRunId;
  readonly stepId: GameRunStepId;
  readonly decisionId: string;
}

export class GameRunDecisions extends Context.Service<
  GameRunDecisions,
  {
    readonly expire: (
      effect: DecisionEffect,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  }
>()("kurambit/orchestration-v2/gameRun/GameRunDecisions") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;

  // The run refuses an expire that no longer fits (the proposal was answered,
  // the run stopped); that refusal is the answer, not a failure of the effect.
  const expire: GameRunDecisions["Service"]["expire"] = (effect) =>
    engine
      .dispatch({
        type: "game-run.decision.expire",
        commandId: CommandId.make(`server:game-run-expire:${effect.effectId}`),
        threadId: effect.threadId,
        runId: effect.runId,
        decisionId: effect.decisionId,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTags({
          OrchestratorGameRunRefusedError: () => Effect.void,
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );

  return GameRunDecisions.of({ expire });
});

export const layer = Layer.effect(GameRunDecisions, make);
