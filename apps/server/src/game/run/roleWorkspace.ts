// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A role's copy and evidence are files on disk; preparation is timed on the wall clock for the run log.
// A role's workspace around its turns: the plain copy of a build a role that
// plays one gets before its thread exists, the bot run its turn left on record,
// and the copy's release once the role has no turn left.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CheckpointRef, CommandId, type ThreadId } from "@kurambit/contracts";
import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { GAME_RUN_COPIES } from "../../config.ts";
import type * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as GameService from "../GameService.ts";
import { laneProfile } from "../engineProfile.ts";
import { COPY_OF } from "../unityPlayerCache.ts";
import { NOT_IN_SAMPLE } from "./builds.ts";
import { handBackOnLowMemory } from "./lowMemory.ts";
import type { RoleDone, RoleStep } from "./state.ts";

export type RoleDeps = {
  readonly launches: ThreadLaunch.ThreadLaunchService["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly game: GameService.GameService["Service"];
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
};
export type RoleContext = {
  readonly root: string;
  readonly lane: string;
  readonly runId: string;
  /** Where this run's copies live: a folder of Kurambit's own, outside the game repository. */
  readonly copies: string;
  readonly log: (line: string) => Effect.Effect<void>;
  /** The step may still hand itself back to wait for memory. */
  readonly memoryWaitsLeft: boolean;
};

const BotRow = Schema.Struct({
  file: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  decider: Schema.optionalKey(Schema.String),
});
const decodeBotRow = Schema.decodeUnknownOption(Schema.fromJsonString(BotRow));

// The bot the blind comparison replays: the latest play-mode run among the rows
// this turn added, with the decider it used. An exploration bot wanders on
// purpose and says nothing about how far scripted play gets, so it gives none.
export const lastBotRun = async (root: string, after: number): Promise<RoleDone["bot"]> => {
  const text = await NodeFSP.readFile(
    NodePath.join(root, ".studio", "bot-results.jsonl"),
    "utf8",
  ).catch(() => "");
  const row = text
    .split("\n")
    .filter(Boolean)
    .slice(after)
    .flatMap((line) => {
      const decoded = decodeBotRow(line);
      return decoded._tag === "Some" ? [decoded.value] : [];
    })
    .findLast((each) => each.mode !== "explore");
  if (row === undefined) return null;
  return { file: row.file, decider: row.decider === "jev" ? "jev" : "policy" };
};

/** A run's copies: under Kurambit's own worktrees folder, never in the game repository. */
export const runCopies = (worktreesDir: string, runId: string) =>
  NodePath.join(worktreesDir, GAME_RUN_COPIES, runId);

/** A step's own folder, by its step number: a resumed step finds the one an earlier attempt made. */
const copyPath = (ctx: RoleContext, step: RoleStep) => NodePath.join(ctx.copies, `step-${step.id}`);

/**
 * A blind player's copy of `build` at `destination`: the build without what
 * differs by round, naming its game folder in COPY_OF so a Unity copy shares
 * that folder's import cache and player. Every copy of the game names the same
 * folder, so it tells nothing about which build it is. False when the build is gone.
 */
export const playCopy = (deps: RoleDeps, root: string, build: string, destination: string) =>
  Effect.gen(function* () {
    const made = yield* deps.checkpoints.materializeCheckpoint({
      cwd: root,
      checkpointRef: CheckpointRef.make(build),
      destination,
      excludePaths: NOT_IN_SAMPLE,
    });
    if (made)
      yield* Effect.tryPromise(() =>
        NodeFSP.writeFile(NodePath.join(destination, COPY_OF), `${root}\n`),
      );
    return made;
  });

/**
 * A plain copy of `build` with no git at all, so nothing in it (history,
 * dates, notes) tells a blind player which build it plays. It is written
 * beside its folder and moved in whole, so a folder that exists is a complete
 * copy, and a resumed step reuses it as it is, with what its role wrote there.
 */
const stepCopy = (deps: RoleDeps, ctx: RoleContext, step: RoleStep, build: string) =>
  Effect.gen(function* () {
    const path = copyPath(ctx, step);
    const exists = yield* Effect.promise(() =>
      NodeFSP.access(path).then(
        () => true,
        () => false,
      ),
    );
    if (exists) return path;
    const staging = `${path}.making`;
    if (!(yield* playCopy(deps, ctx.root, build, staging))) return null;
    yield* Effect.tryPromise(() => NodeFSP.rename(staging, path));
    return path;
  });

// A blind comparator's folder, made before its thread so the model's first
// look finds its files in place: empty but for the step's copies, with no git.
export const blankFolder = (_deps: RoleDeps, ctx: RoleContext, step: RoleStep) =>
  Effect.tryPromise(async () => {
    const dir = copyPath(ctx, step);
    await NodeFSP.mkdir(dir, { recursive: true });
    for (const file of step.clear) await NodeFSP.rm(NodePath.join(dir, file), { force: true });
    for (const { from, to } of step.copy) {
      const target = NodePath.join(dir, to);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(NodePath.join(ctx.root, from), target);
    }
    return { path: dir };
  }).pipe(
    Effect.catchCause(() =>
      ctx.log(`${step.role}: its folder could not be made`).pipe(Effect.as(null)),
    ),
  );

/**
 * A player's copy of its build, made before its thread. An engine whose games
 * play as a built player (Unity) gets that player prepared here, so both sides
 * of a comparison start on a ready player before the play clock starts: copied
 * from the main checkout when that holds one of the same sources, else built.
 * A failed preparation still plays (its first explore start builds, as it
 * always could), and only this log, which comparators never read, says which.
 * Memory short hands the step back to wait, before either side's clock; the
 * copy stays and the step's next try reuses it.
 */
export const sampleCopy = (deps: RoleDeps, ctx: RoleContext, step: RoleStep, build: string) =>
  Effect.gen(function* () {
    const engine = laneProfile(ctx.lane);
    const path = yield* stepCopy(deps, ctx, step, build).pipe(
      Effect.catchCause(() =>
        ctx.log(`${step.role}: its copy of the build could not be made`).pipe(Effect.as(null)),
      ),
    );
    if (path === null) return null;
    if (engine.play !== "player") return { path };
    const name = engine.displayName;
    const from = Date.now();
    const seconds = () => `${Math.round((Date.now() - from) / 1000)} s`;
    yield* handBackOnLowMemory(
      deps.game.preparePlayer(path),
      `${step.role}: ${name} player preparation`,
      ctx.memoryWaitsLeft,
    ).pipe(
      Effect.flatMap((prepared) =>
        ctx.log(
          `${step.role}: ${name} player ${prepared.origin} for ${prepared.sourceId.slice(0, 12)} in ${seconds()} before launch`,
        ),
      ),
      Effect.catchTags({
        GameOperationError: (error) =>
          ctx.log(
            `${step.role}: ${name} player not prepared after ${seconds()} (${(error.detail ?? error.reason).slice(0, 300)}); its first explore start builds one`,
          ),
      }),
      Effect.catchDefect(() =>
        ctx.log(
          `${step.role}: ${name} player preparation broke after ${seconds()}; its first explore start builds one`,
        ),
      ),
    );
    return { path };
  });

/** A copy no thread was launched into: gone again. */
export const removeBlank = (_deps: RoleDeps, _ctx: RoleContext, blank: { readonly path: string }) =>
  Effect.promise(() => NodeFSP.rm(blank.path, { recursive: true, force: true }).catch(() => {}));

// A role's copy goes once its role has no turn left: the folder, then the
// thread's binding to it. An editor still open on it (a Unity sample's player
// build) closes first, so nothing writes into a folder being deleted. Only a
// folder of the run's own copies is ever removed; anything else stays.
export const releaseCopy = (
  deps: Pick<RoleDeps, "threads" | "game">,
  ctx: Pick<RoleContext, "copies" | "log">,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const shell = yield* deps.threads.getThreadShell(threadId);
    if (shell === null || shell.worktreePath === null) return;
    if (shell.activeRunId !== null)
      return yield* ctx.log(`copy ${shell.worktreePath} kept (role still running)`);
    const path = shell.worktreePath;
    if (NodePath.dirname(NodePath.resolve(path)) !== NodePath.resolve(ctx.copies))
      return yield* ctx.log(`folder ${path} kept: it is not one of the run's copies`);
    yield* deps.game.closeLiveEditors(path);
    yield* Effect.tryPromise(() => NodeFSP.rm(path, { recursive: true, force: true }));
    yield* deps.threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`server:game-run-release:${threadId}:${path}`),
      threadId,
      worktreePath: null,
      branch: null,
    });
  }).pipe(Effect.catchCause(() => ctx.log(`copy for ${threadId} kept: cleanup failed`)));
