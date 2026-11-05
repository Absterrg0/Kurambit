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
import { RESUMABLE, abandonsRound } from "../../orchestration-v2/gameRun/decide.ts";
import type * as GameService from "../GameService.ts";
import { causeText, logLine } from "../runSetup.ts";
import { buildStep, captureBuild, type FolderLock, isRestored, measureChange } from "./builds.ts";
import { BuildName, keptBuild, restoredPaths } from "./buildNames.ts";
import type { RoundRecord, RunState } from "./state.ts";

export const restoreKeptRound = (input: {
  readonly game: GameService.GameService["Service"];
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly lock: FolderLock;
  readonly root: string;
  readonly run: GameRun;
  readonly state: RunState;
  readonly record: RoundRecord;
  readonly requestId: string;
}): Effect.Effect<GameRunRestoreOutcome> => {
  const { game, checkpoints, root, run, state, record } = input;
  const deps = { game, checkpoints, lock: input.lock };
  const round = record.round;
  const lane = run.lane || "godot";
  const no = (reason: GameRunRestoreRefusal, message: string): GameRunRestoreOutcome => ({
    kind: "refused",
    reason,
    message,
  });
  // A failure is a refusal the run records; an interrupt is left to recovery, which runs the job again.
  const refusedOn =
    (reason: GameRunRestoreRefusal, what: string) =>
    (cause: Cause.Cause<unknown>): Effect.Effect<GameRunRestoreOutcome | null> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(no(reason, `${what} (${causeText(cause)}); see .studio/run.log.`));
  return Effect.gen(function* () {
    if (!record.kept)
      return no(
        "not-kept",
        `Round ${round} was not kept; only a kept round's build can be restored.`,
      );
    // The round a stopped run holds is abandoned once the restore lands (decide.ts).
    const abandons = abandonsRound(run, state);
    if (state.inFlight?.kind === "build" && RESUMABLE.has(run.ending ?? "") && !abandons)
      return no(
        "mid-step",
        "The stopped run saved an unfinished build step and would replay it on resume. Resume the run and let that step finish, then restore.",
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
    const beforeName = BuildName.restoreBefore(input.requestId);
    const beforeRef = checkpointRefForGameRun(run.id, beforeName);
    // A repeat after a restart finds the build by name; only a first attempt has its commit.
    const beforeSha = (yield* checkpoints.hasCheckpointRef({ cwd: root, checkpointRef: beforeRef }))
      ? ""
      : yield* captureBuild(deps, root, run.id, beforeName);
    const before = keptBuild(run.id, beforeName, lane, beforeSha);
    const task = state.task;
    const dropped = !abandons
      ? ""
      : ` ${task._tag === "round" ? `Round ${task.n}` : "The round"}, in progress when the run stopped, is abandoned: a resume starts the next round from round ${round}'s build, and the abandoned round's work is in the build named next.`;
    const abandoned = abandons ? "; the round in progress is abandoned" : "";
    const restorePaths = isRestored(lane);
    if (!(yield* measureChange(checkpoints, root, restorePaths, beforeRef, build)).changed) {
      if (abandons)
        yield* log(
          `creator restored round ${round}, already the current build${abandoned}; the folder before is ${before}`,
        );
      return {
        kind: "restored",
        sha: build,
        message: `Round ${round}'s build (${what}) is already the game's current build.${dropped.length > 0 ? `${dropped} What the folder held is kept as ${before}` : ""}`,
      } satisfies GameRunRestoreOutcome;
    }
    const ctx = { root, runId: run.id, lane };
    const afterName = BuildName.restoreAfter(input.requestId);
    // From here the folder moves; any refusal puts the folder before back first.
    const moving = Effect.gen(function* () {
      const restored = yield* buildStep(deps, ctx, {
        _tag: "restore",
        sha: build,
        keep: [BuildName.best],
      });
      if (!restored.build.ok)
        return no("commit-missing", `Round ${round}'s build is gone (${restored.build.detail}).`);
      const after = yield* captureBuild(deps, root, run.id, afterName);
      if ((yield* measureChange(checkpoints, root, restorePaths, build, after)).changed)
        return no("restore-incomplete", `Restoring round ${round} did not reproduce its build.`);
      return null;
    }).pipe(Effect.catchCause(refusedOn("git-failed", "The restore could not finish")));
    const refused = yield* moving;
    if (refused !== null) {
      // The run's best stays what it was, so its build name goes back with the folder.
      const putBack = Effect.gen(function* () {
        const back = yield* buildStep(deps, ctx, { _tag: "restore", sha: beforeRef, keep: [] });
        if (state.best.length > 0)
          yield* buildStep(deps, ctx, { _tag: "keep", names: [BuildName.best], sha: state.best });
        if (!back.build.ok) return back.build.detail;
        const now = yield* captureBuild(deps, root, run.id, afterName);
        return (yield* measureChange(checkpoints, root, restorePaths, beforeRef, now)).changed
          ? "the folder still differs from it"
          : null;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(causeText(cause)),
        ),
      );
      const failed = yield* putBack;
      const said =
        failed === null
          ? `The folder is back as it was before the restore.`
          : `Putting the folder back failed too (${failed}), so its ${what} may be partly restored. What it held before is kept as ${before}`;
      yield* log(`creator's restore of round ${round} refused: ${refused.message} ${said}`);
      return { ...refused, message: `${refused.message} ${said}` } satisfies GameRunRestoreOutcome;
    }
    yield* log(
      `creator restored round ${round} (${build.slice(0, 8)}): ${what}${abandoned}; the folder before is ${before}`,
    );
    return {
      kind: "restored",
      sha: build,
      message: `Round ${round}'s ${what} are back in the game folder; notes, PLAN.md, VISION.md, bots and run records were left as they are.${dropped} What the folder held before is kept as ${before}`,
    } satisfies GameRunRestoreOutcome;
  }).pipe(
    Effect.catchCause(refusedOn("git-failed", "The restore could not finish")),
    Effect.map((outcome) => outcome ?? no("git-failed", "The restore left no outcome.")),
  );
};
