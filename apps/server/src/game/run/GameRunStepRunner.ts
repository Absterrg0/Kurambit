// The game layer's side of GameRunJobs: the work of each keep-going step kind
// (look, turn, judge, undo) and a step turn's cap and resend. Phase 3's turns
// builder (T) replaces this stub; until then every job fails "not built".
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";

export class GameRunStepRunner extends Context.Service<
  GameRunStepRunner,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("kurambit/game/run/GameRunStepRunner") {}

const notBuilt = (what: string) =>
  new GameRunJobs.GameRunEffectError({
    cause: new Error(`not built: keep going's ${what} job is the turns builder's (phase 3, T).`),
  });

const make = Effect.gen(function* () {
  const jobs = yield* GameRunJobs.GameRunJobs;
  const start: GameRunStepRunner["Service"]["start"] = () =>
    jobs.attach({
      runStep: () => Effect.die(notBuilt("step")),
      deadline: () => Effect.fail(notBuilt("cap")),
      resend: () => Effect.fail(notBuilt("resend")),
    });
  return GameRunStepRunner.of({ start });
});

export const layer = Layer.effect(GameRunStepRunner, make);
