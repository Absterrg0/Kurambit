// @effect-diagnostics nodeBuiltinImport:off -- The round's bot files are copied from the game folder into the build's checkout on disk.
// One bot-fact step: the round's tester bot plays one build in a fresh T3 worktree at its sha.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { botEnding, botFinalState } from "../GameBot.ts";
import type { StepResult } from "./policy.ts";
import type { RoleDeps } from "./roleRunner.ts";
import type { Step } from "./state.ts";

type BotStep = Extract<Step, { kind: "bot" }>;

const errorFact = (note: string): StepResult => ({
  kind: "bot",
  fact: { ending: "error", seconds: 0, final: {}, note: note.slice(0, 160) },
});

export const runBotFact = (
  deps: RoleDeps,
  ctx: {
    readonly root: string;
    readonly runId: string;
    readonly log: (line: string) => Effect.Effect<void>;
  },
  step: BotStep,
): Effect.Effect<StepResult> => {
  const vcs = deps.vcs;
  if (vcs === null) return Effect.succeed(errorFact("no git service to check out the build"));
  // A suffix per attempt: a resumed step never collides with a checkout an
  // interrupted attempt could not remove.
  const branch = `studio-wt/${ctx.runId}-${step.id}-bot-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const play = Effect.acquireUseRelease(
    vcs.createWorktree({ cwd: ctx.root, refName: step.sha, newRefName: branch, path: null }),
    ({ worktree }) =>
      Effect.gen(function* () {
        // The bot was written after the build was committed, so it lives only
        // in the game folder; the checkout gets the folder's whole bot tree.
        yield* Effect.promise(() =>
          NodeFSP.cp(
            NodePath.join(ctx.root, ".studio", "bot"),
            NodePath.join(worktree.path, ".studio", "bot"),
            { recursive: true, force: true },
          ),
        );
        const result = yield* deps.game.botRunIn(worktree.path, {
          file: step.file,
          seconds: step.seconds,
          mode: "play",
          decider: "policy",
        });
        return {
          kind: "bot",
          fact: {
            ending: botEnding(result.status.state),
            seconds: result.gameSeconds,
            final: botFinalState(result.finalState),
            note: result.status.note.slice(0, 160),
          },
        } satisfies StepResult;
      }),
    ({ worktree }) =>
      vcs.removeWorktree({ cwd: ctx.root, path: worktree.path, force: true }).pipe(
        Effect.andThen(vcs.deleteLocalBranch({ cwd: ctx.root, refName: branch, force: true })),
        Effect.catchCause(() => ctx.log(`bot checkout ${worktree.path} kept: cleanup failed`)),
      ),
  );
  // A bot that cannot run on a build is a fact for the comparators, never a
  // reason to drop the round.
  return play.pipe(
    Effect.catch((error) => Effect.succeed(errorFact(error.message))),
    Effect.catchDefect((defect) =>
      Effect.succeed(errorFact(defect instanceof Error ? defect.message : "the bot run failed")),
    ),
  );
};
