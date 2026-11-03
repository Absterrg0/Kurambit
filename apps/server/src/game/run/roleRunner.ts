// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A role turn is bounded by wall-clock caps; notes are read from the role's workspace on disk.
// Runs one role step as an ordinary T3 thread and returns a typed result.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@kurambit/contracts";
import { latestRootProviderFailure } from "@kurambit/shared/orchestrationV2ThreadError";
import type * as GitWorkflow from "../../git/GitWorkflowService.ts";
import type * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type * as GameService from "../GameService.ts";
import { snapshotBuildSource } from "../sourceSnapshot.ts";
import { botRunCount } from "./facts.ts";
import { blankCommit, neutralBuild } from "./git.ts";
import type { RoleDone, StepResult } from "./policy.ts";
import { CONTINUE } from "./roles.ts";
import { BLANK, type RoleStep } from "./state.ts";

class RoleRunError extends Schema.TaggedError<RoleRunError>()("RoleRunError", {
  op: Schema.String,
  threadId: Schema.String,
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `Game run role ${this.op} failed for thread ${this.threadId} (${this.reason}).`;
  }
}

export type RoleDeps = {
  readonly launches: ThreadLaunch.ThreadLaunchService["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly game: GameService.GameService["Service"];
  readonly vcs: GitWorkflow.GitWorkflowService["Service"] | null;
};
export type RoleContext = {
  readonly root: string;
  readonly lane: string;
  readonly projectId: ProjectId;
  /** Role threads group under the creator's chat, so they never read as sessions of the game. */
  readonly creator: ThreadId;
  readonly runId: string;
  readonly selection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly budgetEndsAt: number | null;
  /** Persists the live turn into the in-flight step before any wait. */
  readonly attach: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  readonly log: (line: string) => Effect.Effect<void>;
};

// An instantly failed turn never reached the model (provider or session
// failure, e.g. an unroutable model): back off and retry a few times, then the
// run ends resumably. Never loop hundreds of turns on these (T25 spun 1152).
const INSTANT_MS = 8_000;
const RETRIES = 3;
const STOP_WAIT_MS = 60_000;

const ms = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

const BotRow = Schema.Struct({
  file: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  decider: Schema.optionalKey(Schema.String),
});
const decodeBotRow = Schema.decodeUnknownOption(Schema.fromJsonString(BotRow));

// The bot the blind comparison replays: the latest play-mode run among the rows
// this turn added, with the decider it used. An exploration bot wanders on
// purpose and says nothing about how far scripted play gets, so it gives none.
const lastBotRun = async (root: string, after: number): Promise<RoleDone["bot"]> => {
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

export const runRole = Effect.fn("GameRun.runRole")(function* (
  deps: RoleDeps,
  ctx: RoleContext,
  step: RoleStep,
) {
  const { threads } = deps;
  const { projectId, root } = ctx;
  const roleError = (op: string, threadId: string, reason: string) => (cause: unknown) =>
    new RoleRunError({ op, threadId, reason, cause });

  const sourceId = () =>
    Effect.promise(() =>
      snapshotBuildSource(root, ctx.lane).then(
        (s) => (s.kind === "known" ? s.sourceId : ""),
        () => "",
      ),
    );
  const sourceBefore = step.source ? yield* sourceId() : "";
  const botsBefore = step.bots ? yield* Effect.promise(() => botRunCount(root)) : 0;

  const worktreeOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell?.worktreePath ?? null),
      Effect.orElseSucceed(() => null),
    );
  // A worktree role whose checkout is gone would resolve to the game root and
  // play the wrong build; it fails instead.
  const workspaceOk = (threadId: ThreadId) =>
    step.at === null
      ? Effect.succeed(true)
      : Effect.map(worktreeOf(threadId), (path) => path !== null);

  const send = (threadId: ThreadId, text: string) =>
    threads
      .sendToThread({
        projectId,
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        text,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.map((sent) => sent.run.id),
        Effect.mapError(roleError("send", threadId, "thread-send")),
      );

  // An interrupt only commits a command; the provider stops later. The next
  // step never runs while this role can still write.
  const stop = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* threads
        .interruptThread({
          projectId,
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          reason: "Studio role cap reached.",
        })
        .pipe(Effect.ignore);
      const waited = yield* threads
        .waitForThread({ projectId, threadId, timeoutMs: STOP_WAIT_MS })
        .pipe(Effect.mapError(roleError("stop", threadId, "thread-wait")));
      if (waited.timedOut)
        return yield* new RoleRunError({ op: "stop", threadId, reason: "stop-unconfirmed" });
    });

  const assistantText = (threadId: ThreadId, runId: RunId) =>
    threads
      .getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      })
      .pipe(
        Effect.map((records) =>
          records.messages
            .map((m) => m.text)
            .filter((t) => t.length > 0)
            .join("\n"),
        ),
        Effect.orElseSucceed(() => ""),
      );

  const failureOf = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["error"],
      })
      .pipe(
        Effect.map((records) => latestRootProviderFailure(run, records.turnItems)),
        Effect.orElseSucceed(() => null),
      );

  // Starting the turn: a launch carries a command id derived from the step, so
  // a resume after a crash mid-launch replays the same thread instead of a second.
  let threadId: ThreadId;
  let runId: RunId | undefined;
  // A role thread the creator deleted is replaced, never waited on forever.
  let target = step.attached?.threadId ?? step.thread;
  const gone =
    target !== null &&
    (yield* threads.getThreadShell(target).pipe(
      Effect.map((shell) => shell === null || shell.deletedAt !== null),
      Effect.orElseSucceed(() => true),
    ));
  if (gone) {
    if (step.at !== null)
      return { kind: "failed", reason: "worktree role thread was deleted" } satisfies StepResult;
    yield* ctx.log(`${step.role}: thread ${target} is gone; relaunching the step`);
    target = null;
  }
  const resumed = step.attached !== null && target !== null;
  if (resumed && step.attached !== null) {
    threadId = step.attached.threadId;
  } else if (target !== null) {
    threadId = target;
    if (!(yield* workspaceOk(threadId)))
      return { kind: "failed", reason: "worktree gone" } satisfies StepResult;
    runId = yield* send(threadId, step.prompt);
    yield* ctx.attach(threadId, runId);
  } else {
    const blank = step.at === BLANK ? yield* blankWorktree(deps, ctx, step) : null;
    if (step.at === BLANK && blank === null)
      return {
        kind: "failed",
        reason: `${step.role}: no worktree of its own`,
      } satisfies StepResult;
    if (blank === null)
      for (const file of step.clear)
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, file), { force: true }));
    // A deleted creator chat cannot be a parent; the role then stands alone rather than failing.
    const creatorLive = yield* threads.getThreadShell(ctx.creator).pipe(
      Effect.map((shell) => shell !== null && shell.deletedAt === null),
      Effect.orElseSucceed(() => false),
    );
    // A blind sample plays a neutral commit of its build: the same game, but
    // no round notes, bots or round-named HEAD that would tell the builds apart.
    const baseRef =
      blank === null && step.at !== null
        ? ((yield* neutralBuild(ctx.root, step.at)) ?? step.at)
        : step.at;
    if (blank === null && step.at !== null && baseRef === step.at)
      yield* ctx.log(
        `${step.role}: no neutral commit for ${step.at.slice(0, 12)}; playing the build's own`,
      );
    const sample =
      blank === null && step.at !== null && ctx.lane === "unity"
        ? yield* unitySampleWorktree(deps, ctx, step, baseRef ?? step.at)
        : null;
    const own = blank ?? sample;
    const launched = yield* deps.launches
      .launch({
        commandId: CommandId.make(`studio:${ctx.runId}:${step.id}${gone ? ":relaunch" : ""}`),
        projectId,
        title: step.title,
        modelSelection: ctx.selection,
        runtimeMode: ctx.runtimeMode,
        // Roles must edit files whatever mode the creator chats in.
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy:
          own !== null
            ? { type: "existing_worktree", worktreePath: own.path, branch: own.branch }
            : step.at === null
              ? { type: "root" }
              : {
                  type: "worktree",
                  baseRef: baseRef ?? step.at,
                  branch: `studio-wt/${ctx.runId}-${step.id}`,
                },
        initialMessage: { text: step.prompt, attachments: [] },
        createdBy: "user",
        creationSource: "server",
        ...(creatorLive ? { parentThreadId: ctx.creator } : {}),
      })
      .pipe(Effect.option);
    // No thread owns a checkout made here until a launch succeeds, so a failed
    // one removes it here or nothing ever will (the retry gets a new step id).
    const dropBlank = own === null ? Effect.void : removeBlank(deps, ctx, own);
    if (Option.isNone(launched)) {
      yield* dropBlank;
      return { kind: "failed", reason: `${step.role}: thread launch failed` } satisfies StepResult;
    }
    threadId = launched.value.threadId;
    const first = launched.value.projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (first === undefined) {
      yield* dropBlank;
      return { kind: "failed", reason: `${step.role}: launch made no run` } satisfies StepResult;
    }
    runId = first.id;
    yield* ctx.attach(threadId, runId);
  }
  const live = threadId;
  // The cap runs from the launch: a Unity sample's player is prepared before
  // it, outside the play time both sides of a comparison get alike.
  const started = Date.now();
  const capEnd = started + step.capMs;
  const budgetBound = ctx.budgetEndsAt !== null && ctx.budgetEndsAt < capEnd;
  const deadline = budgetBound ? ctx.budgetEndsAt! : capEnd;
  // The sample budget is enforced where input happens: an act past it is
  // refused, which costs nothing, where passing it would void the sample.
  if (step.inputCapMs > 0) yield* deps.game.limitExploreInput(live, step.inputCapMs);

  type Waited =
    | { readonly kind: "run"; readonly run: OrchestrationV2Run | null; readonly timedOut: boolean }
    | Extract<StepResult, { kind: "ended" | "failed" }>;
  const waitLoop = Effect.gen(function* () {
    let retries = 0;
    let continued = false;
    for (;;) {
      // A resume follows the thread's latest run: T3 may have resumed it
      // after a usage-limit reset on its own.
      const waited = yield* threads
        .waitForThread({
          projectId,
          threadId: live,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: Math.max(1, deadline - Date.now()),
        })
        .pipe(Effect.mapError(roleError("wait", live, "thread-wait")));
      if (waited.timedOut) {
        yield* stop(live);
        return { kind: "run", run: waited.run, timedOut: true } satisfies Waited;
      }
      const run = waited.run;
      if (run === null) return { kind: "run", run, timedOut: false } satisfies Waited;
      runId = run.id;
      // A turn cut off by a restart, a stop, a usage limit or a provider outage
      // resumes once with its prompt; its old failure says nothing about now.
      if (resumed && !continued && run.status !== "completed") {
        if (!(yield* workspaceOk(live)))
          return { kind: "failed", reason: "worktree gone" } satisfies Waited;
        continued = true;
        runId = yield* send(live, `${CONTINUE}\n\n${step.prompt}`);
        continue;
      }
      if (run.status === "failed") {
        const failure = yield* failureOf(live, run);
        if (failure?.class === "usage_limit")
          return {
            kind: "ended",
            ending: "usage-limit",
            reason:
              `usage limit${failure.resetAt ? ` until ${failure.resetAt}` : ""}: ${failure.message}`.slice(
                0,
                300,
              ),
          } satisfies Waited;
        const startedAt = ms(run.startedAt);
        const completedAt = ms(run.completedAt) ?? Date.now();
        const instant =
          (startedAt === null || completedAt - startedAt < INSTANT_MS) &&
          (yield* assistantText(live, run.id)).trim().length === 0;
        if (instant) {
          if (!(yield* workspaceOk(live)))
            return { kind: "failed", reason: "worktree was not provisioned" } satisfies Waited;
          const reason =
            failure === null
              ? "run failed with no provider message"
              : `${failure.class}: ${failure.message}`.slice(0, 300);
          retries += 1;
          if (retries > RETRIES)
            return { kind: "ended", ending: "provider-down", reason } satisfies Waited;
          yield* ctx.log(`${step.role}: instant-failed turn (${reason}) [${retries}/${RETRIES}]`);
          yield* Effect.sleep(`${15 * 2 ** (retries - 1)} seconds`);
          runId = yield* send(live, step.prompt);
          continue;
        }
      }
      return { kind: "run", run, timedOut: false } satisfies Waited;
    }
  }).pipe(Effect.onInterrupt(() => stop(live).pipe(Effect.ignore)));
  const waited = yield* waitLoop;
  if (waited.kind === "ended") return waited;
  const release =
    step.at !== null &&
    (step.release || waited.kind === "failed" || (waited.timedOut && budgetBound));

  // Evidence is cumulative per thread; closing here also releases the
  // thread's explorer so nothing stays open between roles.
  const evidence = yield* deps.game.finishExploration(live).pipe(
    Effect.map((e) => ({
      sessions: e.sessions,
      actions: e.actions,
      executedInputSteps: e.executedInputSteps,
      nominalMs: e.nominalMs,
      images: e.images,
    })),
    Effect.orElseSucceed(() => null),
  );
  // A missing sheet is no verdict: the comparators then see neither build's.
  const sheet =
    step.sheet === "" || waited.kind === "failed"
      ? ""
      : yield* deps.game.exploreSheet(live, NodePath.join(root, step.sheet)).pipe(
          Effect.flatMap((drawn) =>
            drawn > 0
              ? Effect.succeed(step.sheet)
              : ctx.log(`${step.role}: no frames to draw a sheet from`).pipe(Effect.as("")),
          ),
          Effect.catch((error) =>
            ctx
              .log(`${step.role}: frame sheet not drawn: ${error.detail ?? error.reason}`)
              .pipe(Effect.as("")),
          ),
        );
  const dir = step.at === null ? root : yield* worktreeOf(live);
  const files: Record<string, string> = {};
  for (const file of step.read)
    files[file] =
      dir === null
        ? ""
        : yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(dir, file), "utf8").then(
              (t) => t.slice(0, 20_000),
              () => "",
            ),
          );
  if (release) yield* releaseWorktree(deps, ctx, live);
  if (waited.kind === "failed") return waited;
  return {
    kind: "done",
    threadId: live,
    text: runId === undefined ? "" : yield* assistantText(live, runId),
    files,
    evidence,
    timedOut: waited.timedOut,
    budgetCut: waited.timedOut && budgetBound,
    elapsedMs: Date.now() - started,
    sourceBefore,
    sourceAfter: step.source ? yield* sourceId() : "",
    botsBefore,
    botsAfter: step.bots ? yield* Effect.promise(() => botRunCount(root)) : 0,
    bot: step.bots ? yield* Effect.promise(() => lastBotRun(root, botsBefore)) : null,
    sheet,
  } satisfies StepResult;
});

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
    if (vcs === null) return null;
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
const blankWorktree = (deps: RoleDeps, ctx: RoleContext, step: RoleStep) =>
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
const unitySampleWorktree = (deps: RoleDeps, ctx: RoleContext, step: RoleStep, ref: string) =>
  Effect.gen(function* () {
    const made = yield* stepWorktree(deps, ctx, step, Effect.succeed(ref)).pipe(
      Effect.catchCause(() =>
        ctx
          .log(`${step.role}: its Unity worktree could not be made; the launch makes one`)
          .pipe(Effect.as(null)),
      ),
    );
    if (made === null) return null;
    const from = Date.now();
    const seconds = () => `${Math.round((Date.now() - from) / 1000)} s`;
    yield* deps.game.unityPreparePlayer(made.path).pipe(
      Effect.matchEffect({
        onSuccess: (prepared) =>
          ctx.log(
            `${step.role}: Unity player ${prepared.origin} for ${prepared.sourceId.slice(0, 12)} in ${seconds()} before launch`,
          ),
        onFailure: (error) =>
          ctx.log(
            `${step.role}: Unity player not prepared after ${seconds()} (${(error.detail ?? error.reason).slice(0, 300)}); its first explore start builds one`,
          ),
      }),
      Effect.catchCause(() =>
        ctx.log(
          `${step.role}: Unity player preparation broke after ${seconds()}; its first explore start builds one`,
        ),
      ),
    );
    return made;
  });

const removeBlank = (
  deps: RoleDeps,
  ctx: RoleContext,
  blank: { readonly path: string; readonly branch: string },
) =>
  deps.vcs === null
    ? Effect.void
    : Effect.gen(function* () {
        yield* deps.vcs!.removeWorktree({ cwd: ctx.root, path: blank.path, force: true });
        yield* deps.vcs!.deleteLocalBranch({ cwd: ctx.root, refName: blank.branch, force: true });
      }).pipe(Effect.ignore);

// T3 removes a thread's worktree the way the client does after deleting a
// thread: the checkout goes, then the thread forgets it, then its branch.
// An editor still open on the checkout (a Unity sample's player build) closes
// first, so nothing writes into a folder being deleted.
// Any failure keeps the worktree for the creator to see; nothing is rm'd by hand.
export const releaseWorktree = (
  deps: RoleDeps,
  ctx: Pick<RoleContext, "root" | "log">,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const shell = yield* deps.threads.getThreadShell(threadId);
    if (shell === null || shell.worktreePath === null) return;
    if (deps.vcs === null || shell.activeRunId !== null)
      return yield* ctx.log(
        `worktree ${shell.worktreePath} kept (${deps.vcs === null ? "no git service" : "role still running"})`,
      );
    yield* deps.game.closeLiveEditors(shell.worktreePath);
    yield* deps.vcs.removeWorktree({ cwd: ctx.root, path: shell.worktreePath, force: true });
    yield* deps.threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      worktreePath: null,
      branch: null,
    });
    if (shell.branch?.startsWith("studio-wt/") === true)
      yield* deps.vcs.deleteLocalBranch({ cwd: ctx.root, refName: shell.branch, force: true });
  }).pipe(Effect.catchCause(() => ctx.log(`worktree for ${threadId} kept: cleanup failed`)));
