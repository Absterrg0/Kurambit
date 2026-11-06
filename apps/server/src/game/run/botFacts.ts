// @effect-diagnostics nodeBuiltinImport:off -- The round's bot files are copied from the game folder into the build's checkout on disk.
// One bot-fact step: the round's tester bot plays one build in a fresh plain copy of it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { plainReason } from "@kurambit/contracts";
import { botEnding, botFinalState } from "../gameBotRuntime.ts";
import { type NotMeasured, measuring, toolFailed } from "./handBack.ts";
import type { StepResult } from "./policy.ts";
import { playCopy, type RoleDeps } from "./roleWorkspace.ts";
import type { Step } from "./state.ts";

type BotStep = Extract<Step, { kind: "bot" }>;
type BotResult = Extract<StepResult, { kind: "bot" }>;

/**
 * The fact a comparison withholds from both reports: the bot itself did not
 * play (its module would not load, its child broke, the run was stopped).
 * The same bot fails the same way on both builds, so it says nothing about
 * either; the policy reads this one ending as "no fact".
 */
const WITHHELD = "error";

// Notes land in the step record and the comparison record: the cause, never a machine path.
const plain = (text: string, root: string) =>
  plainReason(text.replace(/\s+/g, " "), [root, NodeOS.homedir(), NodeOS.tmpdir()]).slice(0, 160);

/**
 * The bot on one build, measured: how it ended there (won, lost, timed out,
 * crashed, stopped answering, did not boot), or withheld when the bot itself
 * did not play. A copy, a tool or the machine that kept it from playing fails
 * as not measured: no fact is made of it.
 */
export const runBotFact = (
  deps: RoleDeps,
  ctx: {
    readonly root: string;
    readonly copies: string;
  },
  step: BotStep,
): Effect.Effect<BotResult, NotMeasured> => {
  const what = "the bot run on one compared build";
  const roots = [ctx.root, ctx.copies];
  const withheld = (note: string): BotResult => ({
    kind: "bot",
    fact: { ending: WITHHELD, seconds: 0, final: {}, note: plain(note, ctx.root) },
  });
  // A fresh copy every time: a resumed step's earlier copy is replaced whole.
  const copy = NodePath.join(ctx.copies, `bot-${step.id}`);
  const play = Effect.acquireUseRelease(
    playCopy(deps, ctx.root, step.sha, copy).pipe(
      measuring(what, roots),
      Effect.flatMap((made) =>
        made
          ? Effect.succeed(copy)
          : // The run's record names a build that is gone: no wait brings it back.
            Effect.fail(toolFailed(what, "the build is gone", { standing: true })),
      ),
    ),
    (path) =>
      Effect.gen(function* () {
        // The bot was written after the build was kept, so it lives only in
        // the game folder; the copy gets the folder's whole bot tree.
        yield* Effect.tryPromise(() =>
          NodeFSP.cp(
            NodePath.join(ctx.root, ".studio", "bot"),
            NodePath.join(path, ".studio", "bot"),
            { recursive: true, force: true },
          ),
        ).pipe(measuring(`${what} (its bot files)`, roots));
        // Two bots of a pair start one at a time: the second may queue behind the first's import.
        const result = yield* deps.game
          .botRunIn(path, {
            file: step.file,
            seconds: step.seconds,
            mode: "play",
            decider: step.decider,
          })
          .pipe(measuring(what, roots));
        if (result.played === false) return withheld(`the bot did not play: ${result.status.note}`);
        if (result.status.state === "bot-error" || result.status.state === "stopped")
          return withheld(`the bot did not finish: ${result.status.note}`);
        // The tester's decider is replayed; without its key the bot's own policy chose.
        const fallback =
          result.policyNote === null ? "" : "no Jev key here, so the bot's own policy chose; ";
        const ending = botEnding(result.status.state);
        return {
          kind: "bot",
          fact: {
            // A bot's own word "error" is its finding, never the withheld fact.
            ending: ending === WITHHELD ? "bot error" : ending,
            seconds: result.gameSeconds,
            final: botFinalState(result.finalState),
            ...(result.perf === undefined ? {} : { perf: result.perf }),
            note: plain(`${fallback}${result.status.note}`, ctx.root),
          },
        } satisfies BotResult;
      }),
    (path) =>
      Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true }).catch(() => {})),
  );
  return play.pipe(
    Effect.catchTags({
      // A game that would not boot under the bot is measured, about this build.
      // The copy is the run's own folder: a game.json or a link the copy did
      // not get right is ours, never the build's (boot read the root's).
      GameRunBuildFault: (fault) =>
        fault.error.reason !== "command-failed"
          ? Effect.fail(toolFailed(what, fault.error, { roots }))
          : Effect.succeed<BotResult>({
              kind: "bot",
              fact: {
                ending: "did not boot",
                seconds: 0,
                final: {},
                note: plain(fault.error.detail ?? fault.error.reason, ctx.root),
              },
            }),
    }),
  );
};
