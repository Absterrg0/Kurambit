// A creator's restore of a kept round, as its job does it: the round's build
// comes back into the game folder (engine project, art, ASSETS.md) and becomes
// the best, and whatever the folder held before is kept as a build first, so a
// restore loses nothing. Every refusal is an outcome the run records, never a
// failure of the job.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  type GameRun,
  type GameRunRestoreOutcome,
  type GameRunRestoreRefusal,
} from "@kurambit/contracts";

import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import { RESUMABLE } from "../../orchestration-v2/gameRun/decide.ts";
import type * as GameService from "../GameService.ts";
import { causeText, logLine } from "../runSetup.ts";
import { buildStep, captureBuild, isRestored, measureChange, restoredPaths } from "./builds.ts";
import type { RoundRecord, RunState } from "./state.ts";

export const restoreKeptRound = (input: {
  readonly game: GameService.GameService["Service"];
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly root: string;
  readonly run: GameRun;
  readonly state: RunState;
  readonly record: RoundRecord;
  readonly requestId: string;
}): Effect.Effect<GameRunRestoreOutcome> => {
  const { game, checkpoints, root, run, state, record } = input;
  const round = record.round;
  const lane = run.lane || "godot";
  const no = (reason: GameRunRestoreRefusal, message: string): GameRunRestoreOutcome => ({
    kind: "refused",
    reason,
    message,
  });
  return Effect.gen(function* () {
    if (!record.kept)
      return no(
        "not-kept",
        `Round ${round} was not kept; only a kept round's build can be restored.`,
      );
    const resumable = run.ending !== null && RESUMABLE.has(run.ending);
    if (state.inFlight?.kind === "build" && resumable)
      return no(
        "mid-step",
        "The stopped run saved an unfinished build step and would replay it on resume. Resume the run and let that step finish, then restore.",
      );
    if (resumable && state.task._tag === "round" && state.task.phase !== "start")
      return no(
        "mid-round",
        `The stopped run is in the middle of round ${state.task.n}. Resume it and let the round finish, then restore.`,
      );
    const build = record.build;
    if (build === undefined || build.length === 0)
      return no(
        "commit-missing",
        `Round ${round}'s build is not recorded: the round is from before the run kept its builds on checkpoints, and its work is on branch ${record.branch}.`,
      );
    const log = (line: string) => logLine(root, line);
    const what = restoredPaths(lane).join(", ");
    // The folder as it is, kept once per request: a restore a restart cut
    // short must not keep its own half-restored folder as the creator's work.
    const beforeName = `restore-${input.requestId}/before`;
    const beforeRef = checkpointRefForGameRun(run.id, beforeName);
    if (!(yield* checkpoints.hasCheckpointRef({ cwd: root, checkpointRef: beforeRef })))
      yield* captureBuild(checkpoints, root, run.id, beforeName);
    const restorePaths = isRestored(lane);
    if (!(yield* measureChange(checkpoints, root, restorePaths, beforeRef, build)).changed)
      return {
        kind: "restored",
        sha: build,
        message: `Round ${round}'s build (${what}) is already the game's current build.`,
      } satisfies GameRunRestoreOutcome;
    const restored = yield* buildStep(
      { game, checkpoints },
      { root, runId: run.id, lane },
      { _tag: "restore", sha: build, keep: ["best"] },
    );
    if (!restored.build.ok)
      return no("commit-missing", `Round ${round}'s build is gone (${restored.build.detail}).`);
    const after = yield* captureBuild(
      checkpoints,
      root,
      run.id,
      `restore-${input.requestId}/after`,
    );
    if ((yield* measureChange(checkpoints, root, restorePaths, build, after)).changed)
      return no(
        "restore-incomplete",
        `Restoring round ${round} did not reproduce its build; see .studio/run.log.`,
      );
    yield* log(`creator restored round ${round} (${build.slice(0, 8)}): ${what}`);
    return {
      kind: "restored",
      sha: build,
      message: `Round ${round}'s ${what} are back in the game folder; notes, PLAN.md, VISION.md, bots and run records were left as they are. What the folder held before is kept as the run's build ${beforeName}, and restoring another kept round goes there in turn.`,
    } satisfies GameRunRestoreOutcome;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(
            no(
              "git-failed",
              `The restore could not finish (${causeText(cause)}); see .studio/run.log.`,
            ),
          ),
    ),
  );
};
