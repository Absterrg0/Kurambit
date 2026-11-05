// @effect-diagnostics nodeBuiltinImport:off -- The round's bot files are copied from the game folder into the build's checkout on disk.
// One bot-fact step: the round's tester bot plays one build in a fresh plain copy of it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { CheckpointRef, GameOperationError } from "@kurambit/contracts";
import { botEnding, botFinalState } from "../gameBotRuntime.ts";
import { NOT_IN_SAMPLE } from "./builds.ts";
import { memoryEnded, waitOutLowMemory } from "./lowMemory.ts";
import type { StepResult } from "./policy.ts";
import type { RoleDeps } from "./roleWorkspace.ts";
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
    readonly copies: string;
    readonly log: (line: string) => Effect.Effect<void>;
  },
  step: BotStep,
): Effect.Effect<BotResult | ReturnType<typeof memoryEnded>> => {
  const errorFact = (note: string): BotResult => ({
    kind: "bot",
    fact: { ending: "error", seconds: 0, final: {}, note: plain(note, ctx.root) },
  });
  // A fresh copy every time: a resumed step's earlier copy is replaced whole.
  const copy = NodePath.join(ctx.copies, `bot-${step.id}`);
  const play = Effect.acquireUseRelease(
    deps.checkpoints
      .materializeCheckpoint({
        cwd: ctx.root,
        checkpointRef: CheckpointRef.make(step.sha),
        destination: copy,
        excludePaths: NOT_IN_SAMPLE,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GameOperationError({
              operation: "Bot facts",
              path: step.sha,
              reason: "io",
              detail: `could not copy the build (${cause.message})`,
            }),
        ),
        Effect.flatMap((made) =>
          made
            ? Effect.succeed({ worktree: { path: copy } })
            : Effect.fail(
                new GameOperationError({
                  operation: "Bot facts",
                  path: step.sha,
                  reason: "io",
                  detail: "the build is gone",
                }),
              ),
        ),
      ),
    ({ worktree }) =>
      Effect.gen(function* () {
        // The bot was written after the build was kept, so it lives only in
        // the game folder; the copy gets the folder's whole bot tree.
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
              detail: `could not copy the bot files into the build's copy (${cause instanceof Error && "code" in cause ? String(cause.code) : "copy failed"})`,
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
      Effect.promise(() =>
        NodeFSP.rm(worktree.path, { recursive: true, force: true }).catch(() => {}),
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
