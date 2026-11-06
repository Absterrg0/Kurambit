// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A role's copy and evidence are files on disk; preparation is timed on the wall clock for the server log.
// A role's workspace around its turns: the plain copy of a build a role that
// plays one gets before its thread exists, and the copy's release once the
// role has no turn left.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { CheckpointRef, CommandId, type ThreadId } from "@kurambit/contracts";
import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { GAME_RUN_COPIES } from "../../config.ts";
import type * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as GameService from "../GameService.ts";
import type { GameEngineId } from "@kurambit/contracts";
import { engineProfile } from "../engineProfile.ts";
import { COPY_OF } from "../unityPlayerCache.ts";
import { NOT_IN_SAMPLE } from "./builds.ts";
import { measuring, toolFailed } from "./handBack.ts";
import type { RoleStep } from "./state.ts";

export type RoleDeps = {
  readonly launches: ThreadLaunch.ThreadLaunchService["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly game: GameService.GameService["Service"];
  readonly checkpoints: CheckpointStore.CheckpointStore["Service"];
};
export type RoleContext = {
  readonly root: string;
  readonly engine: GameEngineId;
  readonly runId: string;
  /** Where this run's copies live: a folder of Kurambit's own, outside the game repository. */
  readonly copies: string;
  readonly log: (line: string) => Effect.Effect<void>;
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
    const exists = yield* Effect.tryPromise(() =>
      NodeFSP.access(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    );
    if (exists) return path;
    const staging = `${path}.making`;
    // The run's record names a build that is gone: no wait brings it back.
    if (!(yield* playCopy(deps, ctx.root, build, staging)))
      return yield* toolFailed(`${step.role}'s copy of its build`, "the build is gone", {
        standing: true,
      });
    yield* Effect.tryPromise(() => NodeFSP.rename(staging, path));
    return path;
  }).pipe(measuring(`${step.role}'s copy of its build`, [ctx.root, ctx.copies]));

// A blind comparator's folder, made before its thread so the model's first
// look finds its files in place: empty but for the step's copies, with no git.
// One that cannot be made is not measured, never a comparator without a verdict.
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
  }).pipe(measuring(`${step.role}'s folder`, [ctx.root, ctx.copies]));

/**
 * A player's copy of its build, made before its thread. An engine whose games
 * play as a built player (Unity) gets that player prepared here, so both sides
 * of a comparison start on a ready player before the play clock starts: copied
 * from the main checkout when that holds one of the same sources, else built.
 * A preparation that fails is not measured: a side that built its player
 * inside its play clock would not be played as the other was. Boot already
 * built this build's player, so even its build fault is ours. Memory short
 * hands the step back to wait, before either side's clock; the copy stays and
 * the step's next try reuses it.
 */
export const sampleCopy = (deps: RoleDeps, ctx: RoleContext, step: RoleStep, build: string) =>
  Effect.gen(function* () {
    const engine = engineProfile(ctx.engine);
    const path = yield* stepCopy(deps, ctx, step, build);
    if (engine.play !== "player") return { path };
    const what = `${step.role}: ${engine.displayName} player preparation`;
    const from = Date.now();
    const prepared = yield* deps.game.preparePlayer(path).pipe(
      measuring(what, [ctx.root, ctx.copies]),
      Effect.catchTags({
        GameRunBuildFault: (fault) => Effect.fail(toolFailed(what, fault.error)),
      }),
    );
    yield* ctx.log(
      `${what}: ${prepared.origin} for ${prepared.sourceId.slice(0, 12)} in ${Math.round((Date.now() - from) / 1000)} s before launch`,
    );
    return { path };
  });

/** A copy no thread was launched into: gone again. */
export const removeBlank = (_deps: RoleDeps, _ctx: RoleContext, blank: { readonly path: string }) =>
  Effect.promise(() => NodeFSP.rm(blank.path, { recursive: true, force: true }).catch(() => {}));

/**
 * An ended run's copies go: each role's copy through releaseCopy, so a role
 * still running keeps its folder and a released thread loses its binding;
 * then whatever no role thread is bound to (bot copies, half-made copies,
 * folders whose thread is gone). An ending a resume can continue from keeps its
 * roles' copies (`step-*`), since the resumed step plays on in them, until
 * storage cleanup finds them spent (`copiesSpent`). Only folders inside the
 * run's own copies folder are ever removed.
 */
export const dropRunCopies = (
  deps: Pick<RoleDeps, "threads" | "game">,
  ctx: Pick<RoleContext, "copies" | "log">,
  roleThreads: ReadonlyArray<ThreadId>,
  keepRoleCopies: boolean,
) =>
  Effect.gen(function* () {
    if (!keepRoleCopies)
      for (const threadId of roleThreads) yield* releaseCopy(deps, ctx, threadId);
    const bound = new Set<string>();
    for (const threadId of roleThreads) {
      const shell = yield* deps.threads
        .getThreadShell(threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
      // A thread that cannot be read may still be bound: its folder stays.
      if (shell === undefined)
        return yield* ctx.log("the run's copies kept: a role thread could not be read");
      if (shell?.worktreePath) bound.add(NodePath.resolve(shell.worktreePath));
    }
    const names = yield* Effect.promise(() => NodeFSP.readdir(ctx.copies).catch(() => []));
    const gone = names.filter((name) => {
      const making = name.endsWith(".making");
      if (keepRoleCopies && name.startsWith("step-") && !making) return false;
      return making || !bound.has(NodePath.resolve(ctx.copies, name));
    });
    for (const name of gone) {
      const path = NodePath.join(ctx.copies, name);
      yield* deps.game.closeLiveEditors(path);
      yield* Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true }));
    }
    // Empty once nothing is kept; rmdir refuses a folder that still holds one.
    yield* Effect.promise(() => NodeFSP.rmdir(ctx.copies).catch(() => undefined));
  });

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
