// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A role's checkout and evidence are files in the game folder; preparation is timed on the wall clock for the run log.
// A role's workspace around its turns: the checkout a worktree role gets
// before its thread exists, the bot run its turn left on record, and the
// worktree's release once the role has no turn left.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CommandId, type ThreadId } from "@kurambit/contracts";
import type * as GitWorkflow from "../../git/GitWorkflowService.ts";
import type * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as GameService from "../GameService.ts";
import { laneProfile } from "../engineProfile.ts";
import { blankCommit, repairGit } from "./git.ts";
import { waitOutLowMemory } from "./lowMemory.ts";
import type { RoleDone, RoleStep } from "./state.ts";

export type RoleDeps = {
  readonly launches: ThreadLaunch.ThreadLaunchService["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly game: GameService.GameService["Service"];
  readonly vcs: GitWorkflow.GitWorkflowService["Service"];
};
export type RoleContext = {
  readonly root: string;
  readonly lane: string;
  readonly runId: string;
  readonly log: (line: string) => Effect.Effect<void>;
  /** Who of Kurambit's works in `dir` now (a live turn there), for repairGit. */
  readonly working: (dir: string) => Effect.Effect<string | null>;
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

// A worktree step's own checkout, made before its thread: the one its branch
// already has, or a new one at `ref`. A resumed step reuses the checkout an
// interrupted attempt left under the same branch, since a replayed launch is
// bound to that path.
const stepWorktree = (
  deps: RoleDeps,
  ctx: RoleContext,
  step: RoleStep,
  ref: Effect.Effect<string | null>,
) =>
  Effect.gen(function* () {
    const vcs = deps.vcs;
    const branch = `studio-wt/${ctx.runId}-${step.id}`;
    yield* vcs.pruneWorktrees({ cwd: ctx.root }).pipe(Effect.ignore);
    const refs = yield* vcs.listRefs({
      cwd: ctx.root,
      query: branch,
      refKind: "local",
      refresh: true,
    });
    const found = refs.refs.find((each) => each.name === branch);
    let path = found?.worktreePath ?? null;
    if (found !== undefined && path === null)
      yield* vcs.deleteLocalBranch({ cwd: ctx.root, refName: branch, force: true });
    // A checkout an earlier attempt left may hold what its role's git was cut
    // short in; its role turn ended, and the step's next role works in it.
    if (path !== null) yield* repairGit(path, ctx.working(path), ctx.log);
    if (path === null) {
      const sha = yield* ref;
      if (sha === null) return null;
      path = (yield* vcs.createWorktree({
        cwd: ctx.root,
        refName: sha,
        newRefName: branch,
        path: null,
      })).worktree.path;
    }
    return { path, branch };
  });

// A blind comparator's checkout, made before its thread so the model's first
// look finds its files in place: the BLANK commit, outside the game root,
// holding only the step's copies. Any failure leaves no checkout behind.
export const blankWorktree = (deps: RoleDeps, ctx: RoleContext, step: RoleStep) =>
  Effect.gen(function* () {
    const made = yield* stepWorktree(deps, ctx, step, blankCommit(ctx.root));
    if (made === null) return null;
    const { path: dir, branch } = made;
    const placed = yield* Effect.promise(() =>
      (async () => {
        for (const file of step.clear) await NodeFSP.rm(NodePath.join(dir, file), { force: true });
        for (const { from, to } of step.copy) {
          const target = NodePath.join(dir, to);
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          await NodeFSP.copyFile(NodePath.join(ctx.root, from), target);
        }
      })().then(
        () => true,
        () => false,
      ),
    );
    if (placed) return { path: dir, branch };
    yield* ctx.log(`${step.role}: could not copy its files into ${dir}`);
    yield* removeBlank(deps, ctx, { path: dir, branch });
    return null;
  }).pipe(
    Effect.catchCause(() =>
      ctx.log(`${step.role}: its worktree could not be made`).pipe(Effect.as(null)),
    ),
  );

// A Unity sample's checkout at its neutral build commit, made before its
// thread so its player is ready before the play clock starts: copied from the
// main checkout when that holds one of the same sources, else built here.
// Either way both sides of a comparison start on a ready player. A failed
// preparation still plays (its first explore start builds, as it always
// could), and only this log, which comparators never read, says which.
export const playerSampleWorktree = (
  deps: RoleDeps,
  ctx: RoleContext,
  step: RoleStep,
  ref: string,
) =>
  Effect.gen(function* () {
    const engine = laneProfile(ctx.lane).displayName;
    const made = yield* stepWorktree(deps, ctx, step, Effect.succeed(ref)).pipe(
      Effect.catchCause(() =>
        ctx
          .log(`${step.role}: its ${engine} worktree could not be made; the launch makes one`)
          .pipe(Effect.as(null)),
      ),
    );
    if (made === null) return null;
    const from = Date.now();
    const seconds = () => `${Math.round((Date.now() - from) / 1000)} s`;
    // Memory short is waited out here, before either side's clock.
    yield* waitOutLowMemory(
      deps.game.preparePlayer(made.path),
      `${step.role}: ${engine} player preparation`,
      ctx.log,
    ).pipe(
      Effect.matchEffect({
        onSuccess: (prepared) =>
          ctx.log(
            `${step.role}: ${engine} player ${prepared.origin} for ${prepared.sourceId.slice(0, 12)} in ${seconds()} before launch`,
          ),
        onFailure: (error) =>
          ctx.log(
            `${step.role}: ${engine} player not prepared after ${seconds()} (${(error.detail ?? error.reason).slice(0, 300)}); its first explore start builds one`,
          ),
      }),
      Effect.catchCause(() =>
        ctx.log(
          `${step.role}: ${engine} player preparation broke after ${seconds()}; its first explore start builds one`,
        ),
      ),
    );
    return made;
  });

export const removeBlank = (
  deps: RoleDeps,
  ctx: RoleContext,
  blank: { readonly path: string; readonly branch: string },
) =>
  Effect.gen(function* () {
    yield* deps.vcs.removeWorktree({ cwd: ctx.root, path: blank.path, force: true });
    yield* deps.vcs.deleteLocalBranch({ cwd: ctx.root, refName: blank.branch, force: true });
  }).pipe(Effect.ignore);

// T3 removes a thread's worktree the way the client does after deleting a
// thread: the checkout goes, then the thread forgets it, then its branch.
// An editor still open on the checkout (a Unity sample's player build) closes
// first, so nothing writes into a folder being deleted.
// Any failure keeps the worktree for the creator to see; nothing is rm'd by hand.
export const releaseWorktree = (
  deps: Pick<RoleDeps, "threads" | "game" | "vcs">,
  ctx: Pick<RoleContext, "root" | "log">,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const shell = yield* deps.threads.getThreadShell(threadId);
    if (shell === null || shell.worktreePath === null) return;
    if (shell.activeRunId !== null)
      return yield* ctx.log(`worktree ${shell.worktreePath} kept (role still running)`);
    yield* deps.game.closeLiveEditors(shell.worktreePath);
    yield* deps.vcs.removeWorktree({ cwd: ctx.root, path: shell.worktreePath, force: true });
    yield* deps.threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`server:game-run-release:${threadId}:${shell.worktreePath}`),
      threadId,
      worktreePath: null,
      branch: null,
    });
    if (shell.branch?.startsWith("studio-wt/") === true)
      yield* deps.vcs.deleteLocalBranch({ cwd: ctx.root, refName: shell.branch, force: true });
  }).pipe(Effect.catchCause(() => ctx.log(`worktree for ${threadId} kept: cleanup failed`)));
