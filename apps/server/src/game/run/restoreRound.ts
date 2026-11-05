// A creator's restore of a kept round, as its job does it: the round's build
// comes back as a new commit on trunk, and only when nothing would be lost.
// Every refusal is an outcome the run records, never a failure of the job.
import * as Effect from "effect/Effect";
import type { GameRun, GameRunRestoreOutcome, GameRunRestoreRefusal } from "@kurambit/contracts";

import type * as GameService from "../GameService.ts";
import { logLine } from "../runSetup.ts";
import { makeGit, restoredPaths, type RunGitError } from "./git.ts";
import * as Policy from "./policy.ts";
import { RESUMABLE } from "../../orchestration-v2/gameRun/decide.ts";
import type { RoundRecord, RunState } from "./state.ts";

export const restoreKeptRound = (input: {
  readonly game: GameService.GameService["Service"];
  readonly root: string;
  readonly run: GameRun;
  readonly state: RunState;
  readonly record: RoundRecord;
  /** Clears what an earlier git call cut short left in the folder (repairGit). */
  readonly repair: (log: (line: string) => Effect.Effect<void>) => Effect.Effect<void, RunGitError>;
}): Effect.Effect<GameRunRestoreOutcome> => {
  const { game, root, run, state, record } = input;
  const round = record.round;
  const lane = run.lane || "godot";
  const trunk = run.trunk.length > 0 ? run.trunk : "main";
  const no = (reason: GameRunRestoreRefusal, message: string): GameRunRestoreOutcome => ({
    kind: "refused",
    reason,
    message,
  });
  return Effect.gen(function* () {
    if (!record.kept)
      return no(
        "not-kept",
        `Round ${round} was not kept; only a kept round's build can be restored. Its work stays on branch ${record.branch}.`,
      );
    const resumable = run.ending !== null && RESUMABLE.has(run.ending);
    if (state.inFlight?.kind === "git" && resumable)
      return no(
        "mid-step",
        "The stopped run saved an unfinished git step and would replay it on resume. Resume the run and let that step finish, then restore.",
      );
    const log = (line: string) => logLine(root, line);
    // A lock or a merge an earlier git call left would block the restore with git's raw error.
    yield* input.repair(log);
    const git = makeGit(root, lane, log);
    const on = yield* git.current;
    if (on !== trunk)
      return no(
        "off-trunk",
        `The game is on ${on === "HEAD" || on === "" ? "a detached commit" : `branch ${on}`}, not ${trunk}. Resume the run to let it return to ${trunk}, or switch back yourself, then restore.`,
      );
    const expected = Policy.expectedBranch(state);
    if (expected !== null && expected !== trunk && resumable)
      return no(
        "mid-round",
        `The stopped run is in the middle of its work on ${expected}. Resume it and let the round finish, then restore.`,
      );
    const dirty = yield* git.uncommitted;
    if (dirty.length > 0)
      return no(
        "uncommitted-work",
        `The game has uncommitted changes, so nothing was restored: ${git.summary(dirty.join("\n"))}. Commit or discard them first.`,
      );
    const sha = yield* git.keptCommit(record.branch, trunk);
    if (sha === null)
      return no(
        "commit-missing",
        `Round ${round}'s commit (branch ${record.branch}) is no longer on ${trunk}.`,
      );
    const what = restoredPaths(lane).join(", ");
    if (yield* git.sameBuild(sha))
      return {
        kind: "restored",
        sha,
        message: `Round ${round}'s build (${what}) is already the game's current build.`,
      } satisfies GameRunRestoreOutcome;
    // Closed first, so no live editor saves its in-memory scene over the restored files.
    yield* game.closeLiveEditors(root);
    const restored = yield* git.restoreBuild(sha, `restore round ${round} (creator)`);
    if (!(yield* git.sameBuild(sha)))
      return no(
        "restore-incomplete",
        `Restoring round ${round} did not reproduce its build; see .studio/run.log and the game's git status.`,
      );
    yield* log(
      `creator restored round ${round} (${sha.slice(0, 8)}) as ${restored.slice(0, 8)} on ${trunk}: ${what}`,
    );
    return {
      kind: "restored",
      sha: restored,
      message: `Round ${round}'s ${what} are back as commit ${restored.slice(0, 8)} on ${trunk}; notes, PLAN.md, VISION.md, bots and run records were left as they are. Later commits stay in git history, and restoring a later kept round goes forward again.`,
    } satisfies GameRunRestoreOutcome;
  }).pipe(
    Effect.catchTags({
      RunGitError: (cause) =>
        Effect.succeed(
          cause.op === "restore-apply"
            ? no(
                "local-changes",
                `Nothing was restored: git refused to apply it (${cause.reason}). Usually a change made meanwhile touches a restored file, or another git command is running; commit or discard the change, then restore again.`,
              )
            : no("git-failed", `${cause.message} See .studio/run.log and the game's git status.`),
        ),
    }),
  );
};
