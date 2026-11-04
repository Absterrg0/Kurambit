// @effect-diagnostics nodeBuiltinImport:off -- The round's bot files are copied from the game folder into the build's checkout on disk.
// One bot-fact step: the round's tester bot plays one build in a fresh T3 worktree at its sha.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { GameOperationError } from "@kurambit/contracts";
import { botEnding, botFinalState } from "../GameBot.ts";
import { memoryEnded, waitOutLowMemory } from "./lowMemory.ts";
import type { StepResult } from "./policy.ts";
import type { RoleDeps } from "./roleRunner.ts";
import type { Step } from "./state.ts";

type BotStep = Extract<Step, { kind: "bot" }>;
type BotResult = Extract<StepResult, { kind: "bot" }>;

// Notes land in run.log and the comparison record: the cause, never a machine
// path. Only paths under these roots go; a game's own node or res:// paths stay.
const plain = (text: string, root: string): string => {
  const roots = [root, NodeOS.homedir(), NodeOS.tmpdir()]
    .filter((each) => each.length > 1)
    .map((each) => each.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text
    .replace(new RegExp(`(?:${roots.join("|")})[^\\s'"\`)]*`, "g"), "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
};

export const runBotFact = (
  deps: RoleDeps,
  ctx: {
    readonly root: string;
    readonly runId: string;
    readonly log: (line: string) => Effect.Effect<void>;
  },
  step: BotStep,
): Effect.Effect<BotResult | ReturnType<typeof memoryEnded>> => {
  const errorFact = (note: string): BotResult => ({
    kind: "bot",
    fact: { ending: "error", seconds: 0, final: {}, note: plain(note, ctx.root) },
  });
  const vcs = deps.vcs;
  const branch = `studio-wt/${ctx.runId}-${step.id}-bot`;
  // A resumed step reuses the name, so whatever an interrupted attempt left
  // under it goes first. Best effort: a leftover that stays makes the create fail.
  const clearStale = Effect.gen(function* () {
    yield* vcs.pruneWorktrees({ cwd: ctx.root }).pipe(Effect.ignore);
    const refs = yield* vcs.listRefs({
      cwd: ctx.root,
      query: branch,
      refKind: "local",
      refresh: true,
    });
    const stale = refs.refs.find((ref) => ref.name === branch);
    if (stale === undefined) return;
    if (stale.worktreePath !== null)
      yield* vcs.removeWorktree({ cwd: ctx.root, path: stale.worktreePath, force: true });
    yield* vcs.deleteLocalBranch({ cwd: ctx.root, refName: branch, force: true });
  }).pipe(Effect.catchCause(() => ctx.log(`bot checkout ${branch}: stale cleanup failed`)));
  const play = Effect.acquireUseRelease(
    clearStale.pipe(
      Effect.andThen(
        vcs.createWorktree({ cwd: ctx.root, refName: step.sha, newRefName: branch, path: null }),
      ),
    ),
    ({ worktree }) =>
      Effect.gen(function* () {
        // The bot was written after the build was committed, so it lives only
        // in the game folder; the checkout gets the folder's whole bot tree.
        yield* Effect.tryPromise({
          try: () =>
            NodeFSP.cp(
              NodePath.join(ctx.root, ".studio", "bot"),
              NodePath.join(worktree.path, ".studio", "bot"),
              { recursive: true, force: true },
            ),
          catch: (cause) =>
            new GameOperationError({
              operation: "Bot facts",
              path: ".studio/bot",
              reason: "io",
              detail: `could not copy the bot files into the build checkout (${cause instanceof Error && "code" in cause ? String(cause.code) : "copy failed"})`,
            }),
        });
        const result = yield* waitOutLowMemory(
          deps.game.botRunIn(worktree.path, {
            file: step.file,
            seconds: step.seconds,
            mode: "play",
            decider: step.decider,
          }),
          "bot run",
          ctx.log,
        );
        // The tester's decider is replayed; without its key the bot's own policy chose.
        const fallback =
          result.policyNote === null ? "" : "no Jev key here, so the bot's own policy chose; ";
        return {
          kind: "bot",
          fact: {
            ending: botEnding(result.status.state),
            seconds: result.gameSeconds,
            final: botFinalState(result.finalState),
            ...(result.perf === undefined ? {} : { perf: result.perf }),
            note: plain(`${fallback}${result.status.note}`, ctx.root),
          },
        } satisfies BotResult;
      }),
    ({ worktree }) =>
      vcs.removeWorktree({ cwd: ctx.root, path: worktree.path, force: true }).pipe(
        Effect.andThen(vcs.deleteLocalBranch({ cwd: ctx.root, refName: branch, force: true })),
        Effect.catchCause(() => ctx.log(`bot checkout ${branch} kept: cleanup failed`)),
      ),
  );
  // A bot that cannot run on a build withholds bot facts, never drops the round;
  // memory that stays short ends the run resumably, as it would for any step.
  // Error messages open with generic advice; detail carries the cause.
  return play.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error.reason === "low-memory"
          ? memoryEnded(error)
          : errorFact(error.detail ?? error.reason ?? "the bot run failed"),
      ),
    ),
  );
};
