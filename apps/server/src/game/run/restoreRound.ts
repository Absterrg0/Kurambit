// A creator's restore, as its job does it: a kept round's build or a saved one
// comes back into the game folder (engine project, art, ASSETS.md), and
// whatever the folder held before is kept as a saved build first, so a restore
// loses nothing. A kept round becomes the best; a saved build leaves the best
// as it is (decide.ts). Every refusal is an outcome the run records, never a
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
import { savedBuildLabel } from "./runView.ts";
import type { RoundRecord, RunState } from "./state.ts";

/** What a restore brings back: a kept round, or a saved build by its name. */
export type RestoreTarget =
  | { readonly kind: "round"; readonly record: RoundRecord }
  | { readonly kind: "saved"; readonly name: string };

export const restoreBuild = (input: {
  readonly game: GameService.GameService["Service"];
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
  readonly lock: FolderLock;
  readonly root: string;
  readonly run: GameRun;
  readonly state: RunState;
  readonly target: RestoreTarget;
  readonly requestId: string;
}): Effect.Effect<GameRunRestoreOutcome> => {
  const { game, checkpoints, root, run, state, target } = input;
  const deps = { game, checkpoints, lock: input.lock };
  const lane = run.lane || "godot";
  const isRound = target.kind === "round";
  // How the build reads in the outcome: "Round 3's build", "Round 4's unfinished work".
  const named =
    target.kind === "round"
      ? `Round ${target.record.round}'s build`
      : (savedBuildLabel(target.name, state, run) ?? `The saved build ${target.name}`);
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
    if (target.kind === "round" && !target.record.kept)
      return no(
        "not-kept",
        `Round ${target.record.round} was not kept; only a kept round's build can be restored.`,
      );
    // The round a stopped run holds is abandoned once the restore lands (decide.ts).
    const abandons = abandonsRound(run, state);
    if (state.inFlight?.kind === "build" && RESUMABLE.has(run.ending ?? "") && !abandons)
      return no(
        "mid-step",
        "The stopped run saved an unfinished build step and would replay it on resume. Resume the run and let that step finish, then restore.",
      );
    const build =
      target.kind === "round"
        ? (target.record.build ?? "")
        : ((yield* checkpoints.listCheckpointRefs({
            cwd: root,
            prefix: checkpointRefForGameRun(run.id, target.name),
          })).find((entry) => entry.checkpointRef === checkpointRefForGameRun(run.id, target.name))
            ?.oid ?? "");
    if (build.length === 0)
      return target.kind === "round"
        ? no(
            "commit-missing",
            `Round ${target.record.round}'s build is not recorded: the round is from before the run kept its builds on checkpoints, and its work is on branch ${target.record.branch}.`,
          )
        : no("commit-missing", `${named} is no longer kept.`);
    const log = (line: string) => logLine(root, line);
    const ctx = { root, runId: run.id, lane };
    const what = restoredPaths(lane).join(", ");
    const logged = target.kind === "round" ? `round ${target.record.round}` : target.name;
    // The folder as it is, kept once per request: a restore a restart cut
    // short must not keep its own half-restored folder as the creator's work.
    const beforeName = BuildName.restoreBefore(input.requestId);
    const beforeRef = checkpointRefForGameRun(run.id, beforeName);
    // A repeat after a restart finds the build by name; only a first attempt has its commit.
    const beforeSha = (yield* checkpoints.hasCheckpointRef({ cwd: root, checkpointRef: beforeRef }))
      ? ""
      : yield* captureBuild(deps, root, run.id, beforeName);
    const before = keptBuild(run.id, beforeName, lane, beforeSha);
    // The run's pending restore is this one, so the label names what it restores.
    const kept = ` What the folder held before is saved as "${savedBuildLabel(beforeName, state, run) ?? beforeName}"; the Run tab's saved builds bring it back.`;
    const task = state.task;
    const from = target.kind === "round" ? `round ${target.record.round}'s build` : "the best";
    const dropped = !abandons
      ? ""
      : ` ${task._tag === "round" ? `Round ${task.n}` : "The round"}, in progress when the run stopped, is abandoned: a resume starts the next round from ${from}, and the abandoned round's work is saved with the folder before.`;
    // An undo of the latest restore puts back the best and pending line it replaced (decide.ts).
    const undoes =
      target.kind === "saved" && run.restore?.requestId === input.requestId
        ? run.restore.undoes
        : null;
    // A saved build was never judged better than the best, so the run goes on from the best.
    const judged = isRound
      ? ""
      : undoes !== null
        ? ` This undoes the latest restore: the run's best and the line it was continuing are back as they were before it, so a resume goes on from there.${undoes.abandoned === null ? "" : ` Round ${undoes.abandoned}, which that restore abandoned, stays abandoned: an undo cannot bring a round in progress back, but its work is in this build.`}`
        : " The run's judged best stays as it was: a resume starts its next round from the best, not from this build, which stays saved.";
    // The best's build name follows the run's state.
    const keepBest =
      undoes === null || undoes.best.length === 0
        ? Effect.succeed(true)
        : Effect.map(
            buildStep(deps, ctx, { _tag: "keep", names: [BuildName.best], sha: undoes.best }),
            (kept) => kept.build.ok,
          );
    const abandoned = abandons ? "; the round in progress is abandoned" : "";
    const restorePaths = isRestored(lane);
    if (!(yield* measureChange(checkpoints, root, restorePaths, beforeRef, build)).changed) {
      // A saved build already in the folder changes nothing, so it must not
      // drop the round a stopped run holds either; its "before" is the same
      // folder and is not kept. An undo still puts the run's state back.
      if (target.kind === "saved" && undoes === null) {
        yield* checkpoints.deleteCheckpointRefs({ cwd: root, checkpointRefs: [beforeRef] });
        return no(
          "already-current",
          `The folder already holds ${named}; nothing was restored, and the run stays as it was.`,
        );
      }
      if (!(yield* keepBest))
        return no("commit-missing", "The best build the undo puts back is gone.");
      if (abandons)
        yield* log(
          `creator restored ${logged}, already the current build${abandoned}; the folder before is ${before}`,
        );
      return {
        kind: "restored",
        sha: build,
        message: `${named} (${what}) is already the game's current build.${judged}${dropped.length > 0 ? `${dropped}${kept}` : ""}`,
      } satisfies GameRunRestoreOutcome;
    }
    const afterName = BuildName.restoreAfter(input.requestId);
    // From here the folder moves; any refusal puts the folder before back first.
    const moving = Effect.gen(function* () {
      const restored = yield* buildStep(deps, ctx, {
        _tag: "restore",
        sha: build,
        keep: isRound ? [BuildName.best] : [],
      });
      if (!restored.build.ok)
        return no("commit-missing", `${named} is gone (${restored.build.detail}).`);
      const after = yield* captureBuild(deps, root, run.id, afterName);
      if ((yield* measureChange(checkpoints, root, restorePaths, build, after)).changed)
        return no("restore-incomplete", `Restoring ${named} did not reproduce it.`);
      if (!(yield* keepBest))
        return no("commit-missing", "The best build the undo puts back is gone.");
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
          : `Putting the folder back failed too (${failed}), so its ${what} may be partly restored.${kept}`;
      yield* log(
        `creator's restore of ${logged} refused: ${refused.message} ${said} The folder before is ${before}`,
      );
      return { ...refused, message: `${refused.message} ${said}` } satisfies GameRunRestoreOutcome;
    }
    yield* log(
      `creator restored ${logged} (${build.slice(0, 8)}): ${what}${abandoned}; the folder before is ${before}`,
    );
    return {
      kind: "restored",
      sha: build,
      message: `${named}: its ${what} are back in the game folder; notes, PLAN.md, VISION.md, bots and run records were left as they are.${judged}${dropped}${kept}`,
    } satisfies GameRunRestoreOutcome;
  }).pipe(
    Effect.catchCause(refusedOn("git-failed", "The restore could not finish")),
    Effect.map((outcome) => outcome ?? no("git-failed", "The restore left no outcome.")),
  );
};
