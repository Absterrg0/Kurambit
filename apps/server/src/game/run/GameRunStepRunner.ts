// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A step's work is the game folder's: notes written on disk, worktrees, wall-clock caps.
// The work behind a game run's step effects, as GameRunJobs runs it: each job
// reads the step from the run's records, does what the step asks through the
// existing executors (git ops, boot, checks, facts, bots, role launches) and
// reports with game-run.step.complete or game-run.step.fail under the step's
// attempt. A job that finds its step already moved on does nothing, so a
// repeat after a restart is harmless. A role step's job only launches the
// role: GameRunRoleReactor lands its result when the role's turn ends.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type GameRun,
  type GameRunRestoreOutcome,
  type GameRunRoleBefore,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  gameRunStepCommandId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { toState } from "../../orchestration-v2/gameRun/decide.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  roleCapCommandId,
  roleThreadId,
  roleTurnMessageId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { laneProfile } from "../engineProfile.ts";
import * as GameOperations from "../GameOperations.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameService from "../GameService.ts";
import { causeText, logLine, refreshHarnessFiles, writeAtomic } from "../runSetup.ts";
import { snapshotBuildSource } from "../sourceSnapshot.ts";
import { runBotFact } from "./botFacts.ts";
import { runStateChecks } from "./checkRunner.ts";
import { artAssetFacts, botRunCount, reviewerFacts } from "./facts.ts";
import { presentable } from "./decisionEvidence.ts";
import { finishExports } from "./finish.ts";
import { restoreKeptRound } from "./restoreRound.ts";
import { makeGit, neutralBuild } from "./git.ts";
import * as GameRunRoleReactor from "./GameRunRoleReactor.ts";
import { waitOutLowMemory } from "./lowMemory.ts";
import { modelFacts } from "./modelFacts.ts";
import * as Policy from "./policy.ts";
import {
  blankWorktree,
  playerSampleWorktree,
  releaseWorktree,
  removeBlank,
  type RoleContext,
  type RoleDeps,
} from "./roleWorkspace.ts";
import { CONTINUE, MEMORY_RETRY, artFacts, modelBlock, spriteBlock } from "./roles.ts";
import { currentStep, describe, summarize } from "./runView.ts";
import { spriteFacts } from "./spriteFacts.ts";
import { BLANK, type BotStep, type GitOp, type RoleStep } from "./state.ts";
import { bootStep, gitStep as runGitStep } from "./steps.ts";

export class GameRunStepRunner extends Context.Service<
  GameRunStepRunner,
  {
    /** Gives GameRunJobs its work and follows the runs' records for their ends and the Game panel. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One step's job, run to its end in the caller's fiber. */
    readonly execute: (job: GameRunJobs.GameRunStepJob) => Effect.Effect<void>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("kurambit/game/run/GameRunStepRunner") {}

// Endings that leave nothing to export: a stop, a failure, or memory too short for the exports.
const NO_EXPORT: ReadonlySet<string> = new Set(["stopped", "failed", "low-memory"]);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const game = yield* GameService.GameService;
  const projects = yield* GameProjectService.GameProjectService;
  const operations = yield* GameOperations.GameOperations;
  const vcs = yield* GitWorkflow.GitWorkflowService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
  const deps: RoleDeps = { launches, threads, game, vcs };

  // A report the run refuses (the step moved on, the run stopped) is the
  // answer; one that could not be written leaves the step for recovery.
  const refused = <A, R>(dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>) =>
    dispatch.pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestratorGameRunRefusedError: (error) =>
          Effect.logInfo("game run report not taken", { detail: error.detail }),
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
      }),
      Effect.catch((error) => Effect.logWarning("game run report failed", { error })),
    );

  const complete = (
    job: GameRunJobs.GameRunStepJob,
    stepId: GameRunStepId,
    result: GameRunStepResult,
  ) =>
    refused(
      engine.dispatch({
        type: "game-run.step.complete",
        commandId: gameRunStepCommandId(stepId, job.attempt, "complete"),
        threadId: job.threadId,
        runId: job.runId,
        stepId,
        attempt: job.attempt,
        result,
      }),
    );
  const fail = (job: GameRunJobs.GameRunStepJob, stepId: GameRunStepId, reason: string) =>
    refused(
      engine.dispatch({
        type: "game-run.step.fail",
        commandId: gameRunStepCommandId(stepId, job.attempt, "fail"),
        threadId: job.threadId,
        runId: job.runId,
        stepId,
        attempt: job.attempt,
        reason: reason.slice(0, 300),
      }),
    );
  // A step's work that broke reports it, so the run ends resumably with why;
  // an interrupt is a stop and reports nothing.
  const reporting = <E>(
    job: GameRunJobs.GameRunStepJob,
    stepId: GameRunStepId,
    work: Effect.Effect<void, E>,
  ) =>
    work.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.interrupt : fail(job, stepId, causeText(cause)),
      ),
    );

  /** The run and its step in flight, if this job's attempt still holds it. */
  const current = (job: GameRunJobs.GameRunStepJob) =>
    projections.getGameRunRecords(job.threadId).pipe(
      Effect.map((records) => {
        const run = records.gameRuns.at(-1);
        if (run === undefined || run.id !== job.runId || run.status === "ended") return null;
        const record = records.gameRunSteps.find(
          (s) => s.runId === run.id && s.seq === run.inFlight,
        );
        if (record === undefined || record.id !== job.stepId || record.attempt !== job.attempt)
          return null;
        if (record.status !== "planned" && record.status !== "running") return null;
        return { run, record, records };
      }),
      Effect.orElseSucceed(() => null),
    );

  // What the steps landed since the last job asks of the game folder: a
  // decision has no job of its own, so the walk back passes over decisions.
  // Writing the same files and releasing the same worktrees again is harmless.
  const performOutputs = (
    run: GameRun,
    steps: ReadonlyArray<GameRunStep>,
    upTo: number,
    root: string,
    log: (line: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const landed = steps
        .filter((s) => s.runId === run.id && s.seq < upTo && s.completedAt !== null)
        .toSorted((a, b) => b.seq - a.seq);
      const owed: GameRunStep[] = [];
      for (const step of landed) {
        owed.unshift(step);
        if (step.kind !== "decide") break;
      }
      for (const step of owed) {
        for (const file of step.outputs.files)
          yield* Effect.promise(() => writeAtomic(NodePath.join(root, file.path), file.text)).pipe(
            Effect.ignore,
          );
        for (const thread of step.outputs.release)
          yield* releaseWorktree(deps, { root, log }, thread);
      }
    });

  const measure = (role: RoleStep, root: string, lane: string) =>
    Effect.promise(async (): Promise<GameRunRoleBefore> => ({
      source: role.source
        ? await snapshotBuildSource(root, lane).then(
            (s) => (s.kind === "known" ? s.sourceId : ""),
            () => "",
          )
        : "",
      bots: role.bots ? await botRunCount(root) : 0,
    }));

  // The art director judges files, so it gets the asset-list and measured
  // image facts; the redo that answers it sees the same measurements.
  const promptOf = (run: GameRun, role: RoleStep, root: string) =>
    Effect.gen(function* () {
      const task = run.task;
      const redo = role.role === "art" && task._tag === "stage" && task.phase === "redo";
      const judged = role.role === "art-director" || redo;
      if (!judged) return role.prompt;
      const sprites = (yield* Effect.promise(() => spriteFacts(root, run.lane))).full;
      const models = (yield* Effect.promise(() => modelFacts(root, run.lane))).full;
      return role.role === "art-director"
        ? `${role.prompt}${artFacts(yield* Effect.promise(() => artAssetFacts(root, run.lane)), sprites)}${modelBlock(models)}`
        : `${role.prompt}${spriteBlock(sprites, true)}${modelBlock(models, true)}`;
    });

  const roleContext = (run: GameRun, root: string, log: RoleContext["log"]): RoleContext => ({
    root,
    lane: run.lane,
    runId: run.id,
    log,
  });

  /**
   * One role turn of the step: its thread is recorded (game-run.step.start)
   * before the role's first turn, so its submission finds the step, and
   * nothing is launched or sent when the run refuses that (it ended, the step
   * moved on). A thread the step already has is reattached: a turn of this
   * attempt that ended lands now, one still running gets its cap watched, and
   * a thread with no turn of this attempt continues where an earlier try left
   * off. A thread that is gone is replaced by the attempt's own.
   */
  const roleHalf = (
    job: GameRunJobs.GameRunStepJob,
    run: GameRun,
    record: GameRunStep,
    role: RoleStep,
    root: string,
    log: (line: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const stepId = record.step.kind === "pair" ? gameRunStepId(run.id, role.id) : record.id;
      const half = { ...job, stepId };
      const entry = record.roles.find((r) => r.seq === role.id);
      const own = roleThreadId(stepId, job.attempt);
      const threadId = entry?.threadId ?? role.thread ?? own;
      const before = () =>
        entry?.before === undefined ? measure(role, root, run.lane) : Effect.succeed(entry.before);
      const startStep = (target: ThreadId, measured: GameRunRoleBefore, replaces?: ThreadId) =>
        engine
          .dispatch({
            type: "game-run.step.start",
            // A start per thread: a replacement is a start of its own, not a replay.
            commandId: CommandId.make(
              `${gameRunStepCommandId(stepId, job.attempt, "start")}:${target}`,
            ),
            threadId: job.threadId,
            runId: run.id,
            stepId,
            roleThreadId: target,
            before: measured,
            ...(replaces === undefined ? {} : { replaces }),
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              log(`${role.role}: the run did not take the step's start (${error.message})`).pipe(
                Effect.as(false),
              ),
            ),
          );
      const limitInput = (target: ThreadId) =>
        role.inputCapMs > 0 ? game.limitExploreInput(target, role.inputCapMs) : Effect.void;

      const launchThread = (target: ThreadId, replaces: ThreadId | undefined, text: string) =>
        Effect.gen(function* () {
          const measured = yield* before();
          const ctx = roleContext(run, root, log);
          // An engine whose first editor open imports the whole project (minutes;
          // later opens take seconds) pays it here, before any role's clock.
          const engineProfile = laneProfile(run.lane);
          if (engineProfile.run.warmEditor && role.at === null) {
            const from = Date.now();
            yield* waitOutLowMemory(
              game.warmEditor(root),
              `${engineProfile.displayName} warm-up`,
              log,
            ).pipe(
              Effect.matchEffect({
                onSuccess: (warmed) =>
                  warmed
                    ? log(
                        `${engineProfile.displayName} warm-up: first import took ${Math.round((Date.now() - from) / 1000)} s, before ${role.role}'s clock`,
                      )
                    : Effect.void,
                onFailure: (error) =>
                  log(
                    `${engineProfile.displayName} warm-up skipped (${(error.detail ?? error.reason).slice(0, 200)}); the role opens the editor itself`,
                  ),
              }),
            );
          }
          const blank = role.at === BLANK ? yield* blankWorktree(deps, ctx, role) : null;
          if (role.at === BLANK && blank === null)
            return yield* fail(half, stepId, `${role.role}: no worktree of its own`);
          if (blank === null && replaces === undefined)
            for (const file of role.clear)
              yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, file), { force: true }));
          // A blind sample plays a neutral commit of its build: the same game, but
          // no round notes, bots or round-named HEAD that would tell the builds apart.
          const baseRef =
            blank === null && role.at !== null
              ? ((yield* neutralBuild(root, role.at)) ?? role.at)
              : role.at;
          if (blank === null && role.at !== null && baseRef === role.at)
            yield* log(
              `${role.role}: no neutral commit for ${role.at.slice(0, 12)}; playing the build's own`,
            );
          const sample =
            blank === null && role.at !== null && engineProfile.play === "player"
              ? yield* playerSampleWorktree(deps, ctx, role, baseRef ?? role.at)
              : null;
          const workspace = blank ?? sample;
          const dropWorkspace =
            workspace === null ? Effect.void : removeBlank(deps, ctx, workspace);
          // A deleted creator chat cannot be a parent; the role then stands alone rather than failing.
          const creatorLive = yield* threads.getThreadShell(run.threadId).pipe(
            Effect.map((s) => s !== null && s.deletedAt === null),
            Effect.orElseSucceed(() => false),
          );
          if (!(yield* startStep(target, measured, replaces))) return yield* dropWorkspace;
          yield* limitInput(target);
          const launched = yield* launches
            .launch({
              commandId: CommandId.make(
                `server:game-run-role:${stepId}:attempt:${job.attempt}:launch:${target}`,
              ),
              threadId: target,
              projectId: run.projectId,
              title: role.title,
              modelSelection: run.modelSelection,
              runtimeMode: run.runtimeMode,
              // Roles must edit files whatever mode the creator chats in.
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              workspaceStrategy:
                workspace !== null
                  ? {
                      type: "existing_worktree",
                      worktreePath: workspace.path,
                      branch: workspace.branch,
                    }
                  : role.at === null
                    ? { type: "root" }
                    : {
                        type: "worktree",
                        baseRef: baseRef ?? role.at,
                        // A thread launched again for the step gets a branch of its own.
                        branch: `studio-wt/${run.id}-${role.id}${target === roleThreadId(stepId, 1) ? "" : `-${target.slice(0, 8)}`}`,
                      },
              initialMessage: {
                messageId: roleTurnMessageId(stepId, job.attempt, "turn", 1),
                text,
                attachments: [],
              },
              createdBy: "user",
              creationSource: "server",
              launchedBy: "game_run",
              ...(creatorLive ? { parentThreadId: run.threadId } : {}),
            })
            .pipe(Effect.option);
          if (Option.isNone(launched)) {
            // No thread owns a checkout made here until a launch succeeds.
            yield* dropWorkspace;
            return yield* fail(half, stepId, `${role.role}: thread launch failed`);
          }
          yield* log(`${role.role}: launched thread ${target}`);
        });

      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.deletedAt === null) {
        if (shell.projectId !== run.projectId)
          return yield* fail(half, stepId, `${role.role}: its thread belongs to another project`);
        const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
        const turns = GameRunRoleReactor.stepTurns(runs, stepId);
        const latest = turns.findLast((t) => t.turn.attempt === job.attempt);
        if (latest !== undefined) {
          yield* limitInput(threadId);
          if (!GameRunRoleReactor.isSettledRun(latest.run)) {
            yield* log(`${role.role}: reattaching to thread ${threadId}`);
            return yield* jobs.deadline(half);
          }
          if ((yield* roles.settle(threadId, latest.run)) !== "fresh") return;
          // Its own provider session refuses the reused thread: the work is in the
          // files, so the role continues once in a thread of its own.
          const prompt = yield* promptOf(run, role, root);
          return yield* launchThread(
            roleThreadId(stepId, job.attempt, "fresh"),
            threadId,
            `${CONTINUE}\n\n${prompt}`,
          );
        }
        if (role.at !== null && shell.worktreePath === null) {
          if (threadId === own)
            return yield* fail(half, stepId, `${role.role}: its worktree is gone`);
          return yield* launchThread(own, threadId, yield* promptOf(run, role, root));
        }
        if (!(yield* startStep(threadId, yield* before()))) return;
        yield* limitInput(threadId);
        // A turn an earlier try started and a restart or an ending cut off continues.
        const resumed = turns.length > 0;
        const prompt = yield* promptOf(run, role, root);
        return yield* roles.sendTurn({
          projectId: run.projectId,
          threadId,
          stepId,
          attempt: job.attempt,
          kind: resumed ? "continue" : "turn",
          n: 1,
          text: resumed ? `${CONTINUE}\n\n${prompt}` : prompt,
        });
      }
      const prompt = yield* promptOf(run, role, root);
      if (threadId === own) {
        if (shell !== null)
          return yield* fail(half, stepId, `${role.role}: its thread was deleted`);
        return yield* launchThread(own, undefined, prompt);
      }
      // A thread the creator deleted is replaced, never waited on.
      yield* log(`${role.role}: thread ${threadId} is gone; launching the step again`);
      return yield* launchThread(own, entry?.threadId ?? undefined, prompt);
    });

  const botHalf = (
    job: GameRunJobs.GameRunStepJob,
    run: GameRun,
    stepId: GameRunStepId,
    step: BotStep,
    root: string,
    log: (line: string) => Effect.Effect<void>,
  ) =>
    runBotFact(deps, { root, runId: run.id, log }, step).pipe(
      Effect.tap((result) => log(`  step ${step.id}: ${summarize(result)}`)),
      Effect.flatMap((result) => complete({ ...job, stepId }, stepId, result)),
    );

  const execute = (job: GameRunJobs.GameRunStepJob) =>
    Effect.flatMap(current(job), (found) =>
      found === null ? Effect.void : reporting(job, found.record.id, work(job, found)),
    );

  const work = (
    job: GameRunJobs.GameRunStepJob,
    found: NonNullable<Effect.Success<ReturnType<typeof current>>>,
  ) =>
    Effect.gen(function* () {
      const { run, record, records } = found;
      const root = yield* projects.resolve(run.threadId);
      const log = (line: string) => logLine(root, line);
      const git = makeGit(root, run.lane, log);
      yield* performOutputs(run, records.gameRunSteps, record.seq, root, log);
      const state = toState(run, records.gameRunRounds, record);
      const step = record.step;
      // The checkout follows the run: through gitStep, so live editors close before it moves.
      const expected = Policy.expectedBranch(state);
      if (expected !== null && step.kind !== "git" && (yield* git.current) !== expected) {
        const entered = yield* gitStep(git, root, { _tag: "enter", branch: expected }).pipe(
          Effect.option,
        );
        if (Option.isNone(entered) || !entered.value.git.ok)
          yield* log(`could not enter ${expected}; continuing where HEAD is`);
      }
      yield* log(describe(step));
      const done = (result: GameRunStepResult) =>
        log(`  ${summarize(result)}`).pipe(Effect.andThen(complete(job, record.id, result)));
      switch (step.kind) {
        case "git":
          return yield* reporting(
            job,
            record.id,
            gitStep(git, root, step.op).pipe(
              Effect.flatMap((result) =>
                step.op._tag !== "init" || !result.git.ok
                  ? Effect.succeed(result)
                  : refreshHarnessFiles(git, root, run.lane, log).pipe(
                      Effect.map((sha) =>
                        sha === null ? result : { ...result, git: { ...result.git, sha } },
                      ),
                    ),
              ),
              Effect.flatMap(done),
            ),
          );
        case "boot":
          return yield* reporting(
            job,
            record.id,
            bootStep(game, { creator: run.threadId, root, lane: run.lane, log }).pipe(
              Effect.flatMap(done),
            ),
          );
        case "facts":
          return yield* reporting(
            job,
            record.id,
            Effect.gen(function* () {
              const jev = Option.isSome(
                yield* secrets
                  .get("game-bot-jev-api-key")
                  .pipe(Effect.orElseSucceed(() => Option.none())),
              );
              const code = yield* Effect.promise(() => reviewerFacts(root, run.lane));
              yield* done({ kind: "facts", jev, code });
            }),
          );
        case "checks": {
          const rung = run.ladder?.rungs.find((x) => x.id === step.rung);
          return yield* reporting(
            job,
            record.id,
            (rung === undefined ? Effect.succeed([]) : runStateChecks(game, root, rung)).pipe(
              Effect.flatMap((results) => done({ kind: "checks", results })),
            ),
          );
        }
        case "bot":
          return yield* reporting(job, record.id, botHalf(job, run, record.id, step, root, log));
        case "note":
          return yield* reporting(
            job,
            record.id,
            Effect.promise(async () => {
              for (const file of step.files)
                await writeAtomic(NodePath.join(root, file.path), file.text);
            }).pipe(Effect.andThen(done({ kind: "note" }))),
          );
        case "role":
          return yield* reporting(job, record.id, roleHalf(job, run, record, step, root, log));
        case "pair": {
          // Both halves at once, each in its own worktree, launched in play
          // order (ids follow the coin) so neither side systematically starts
          // first; one failing never cancels the other.
          const owed = step.halves
            .filter(
              (h) =>
                !step.results.some((r) => r.id === h.id) &&
                !record.endedHalves.some((r) => r.seq === h.id),
            )
            .toSorted((a, b) => a.id - b.id);
          return yield* Effect.forEach(
            owed,
            (h) => {
              const stepId = gameRunStepId(run.id, h.id);
              return reporting(
                { ...job, stepId },
                stepId,
                h.kind === "role"
                  ? roleHalf(job, run, record, h, root, log)
                  : botHalf(job, run, stepId, h, root, log),
              );
            },
            { concurrency: 2, discard: true },
          );
        }
        case "decide":
          return;
      }
    });

  const gitStep = (git: ReturnType<typeof makeGit>, root: string, op: GitOp) =>
    runGitStep(game, git, root, op);

  /**
   * A role turn's cap, from its turn's start, plus the time its explore
   * starts waited for memory, never past the run's budget. The effect that
   * starts this fires at the plain cap, so this only ever waits longer.
   */
  const deadline = (job: GameRunJobs.GameRunStepJob) =>
    Effect.gen(function* () {
      const at = yield* roles.locate(job.threadId, job.stepId, job.attempt);
      if (at === null || at.role === null) return;
      const threadId = at.record.roles.find((r) => r.seq === at.seq)?.threadId ?? null;
      if (threadId === null) return;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const live = GameRunRoleReactor.stepTurns(runs, job.stepId).findLast(
        (t) => t.turn.attempt === job.attempt,
      );
      if (live === undefined || GameRunRoleReactor.isSettledRun(live.run)) return;
      const startedAt = live.run.startedAt ?? live.run.requestedAt;
      const waited = yield* game.exploreMemoryWait(threadId).pipe(
        Effect.map((mark) => mark.waitedMs),
        Effect.orElseSucceed(() => 0),
      );
      const cap = DateTime.toEpochMillis(startedAt) + at.role.capMs + waited;
      const due = at.run.budgetEndsAt === null ? cap : Math.min(cap, at.run.budgetEndsAt);
      // Not due yet (memory waits extend it, a later turn restarts it): the cap
      // is set again as a durable timer at its due time, never held by a fiber.
      // The outbox's clock decides when timers are due, so this one does too.
      if (DateTime.toEpochMillis(yield* DateTime.now) < due)
        return yield* refused(
          engine.dispatch({
            type: "game-run.step.schedule",
            commandId: CommandId.make(
              `server:game-run-cap:${job.stepId}:attempt:${job.attempt}:${live.run.id}:${due}`,
            ),
            threadId: job.threadId,
            runId: job.runId,
            stepId: job.stepId,
            attempt: job.attempt,
            at: due,
            timer: { kind: "cap" },
          }),
        );
      yield* threads
        .interruptThread({
          projectId: at.run.projectId,
          commandId: roleCapCommandId(job.stepId, job.attempt, live.run.id),
          threadId,
          runId: live.run.id,
          reason: "Studio role cap reached.",
        })
        .pipe(Effect.ignore);
    });

  /** A role turn sent again once its pause is over, if its step is still where it was. */
  const resend = (job: GameRunJobs.GameRunResendJob) =>
    Effect.gen(function* () {
      const at = yield* roles.locate(job.threadId, job.stepId, job.attempt);
      if (at === null || at.role === null) return;
      const threadId = at.record.roles.find((r) => r.seq === at.seq)?.threadId ?? null;
      if (threadId === null) return;
      const prompt = at.role.prompt;
      yield* roles.sendTurn({
        projectId: at.run.projectId,
        threadId,
        stepId: job.stepId,
        attempt: job.attempt,
        kind: job.turn,
        n: job.n,
        text: job.turn === "memory" ? `${MEMORY_RETRY}\n\n${prompt}` : prompt,
      });
      // A turn sent again is capped like the first.
      yield* jobs.deadline(job);
    });

  // ── A run's end, from the game-run.finish effect its ending committed: its
  // jobs and live role turns stop, and the game folder gets its last outputs
  // and exports. Every part is safe to repeat, so a finish a
  // restart cut short runs again whole; game-run.finished records it done.
  const finish = (job: GameRunJobs.GameRunFinishJob) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(job.threadId);
      const run = records.gameRuns.at(-1);
      if (
        run === undefined ||
        run.id !== job.runId ||
        run.status !== "ended" ||
        run.endedAt !== job.endedAt ||
        run.finished === job.endedAt
      )
        return;
      yield* jobs.stopRun(run.id);
      const root = yield* projects.resolve(run.threadId);
      const log = (line: string) => logLine(root, line);
      const held = records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight);
      for (const role of held?.roles ?? []) {
        if (role.threadId === null) continue;
        yield* threads
          .interruptThread({
            projectId: run.projectId,
            commandId: CommandId.make(
              `server:game-run-ended:${run.id}:${job.endedAt}:${role.threadId}`,
            ),
            threadId: role.threadId,
            reason: `The production run ended (${run.ending ?? "unknown"}).`,
          })
          .pipe(Effect.ignore);
      }
      yield* performOutputs(run, records.gameRunSteps, Number.MAX_SAFE_INTEGER, root, log);
      yield* log(
        `run ended: ${run.ending ?? "unknown"}${run.lastFailure ? ` (${run.lastFailure})` : ""}`,
      );
      if (run.ending !== null && !NO_EXPORT.has(run.ending)) {
        // An ending mid-round (a usage limit, a provider outage) leaves the
        // round's branch checked out with its unfinished work. The export is of
        // the best build: that work is committed to its branch (a resume enters
        // it again) and trunk is checked out first.
        if (run.trunk.length > 0) {
          const git = makeGit(root, run.lane, log);
          const parked = yield* gitStep(git, root, {
            _tag: "to-trunk",
            trunk: run.trunk,
            message: `unfinished: the run ended (${run.ending})`,
          }).pipe(Effect.option);
          if (Option.isNone(parked) || !parked.value.git.ok)
            yield* log(`finishExports: could not return to ${run.trunk}; exporting where HEAD is`);
        }
        yield* finishExports(root, run.threadId, game, log).pipe(Effect.ignore);
      }
      yield* refused(
        engine.dispatch({
          type: "game-run.finished",
          commandId: CommandId.make(`server:game-run-finished:${run.id}:${job.endedAt}`),
          threadId: run.threadId,
          runId: run.id,
          endedAt: job.endedAt,
        }),
      );
    });

  // A creator's restore, from the effect its request committed. Every check is
  // made against the folder now, so a restore a restart cut short runs again safely.
  const restore = (job: GameRunJobs.GameRunRestoreJob) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(job.threadId);
      const run = records.gameRuns.at(-1);
      const pending = run?.restore;
      if (run === undefined || run.id !== job.runId || pending?.requestId !== job.requestId) return;
      if (pending.outcome !== null) return;
      const held =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      const state = toState(run, records.gameRunRounds, held);
      const record = state.rounds.find((r) => r.round === pending.round);
      const root = yield* projects.resolve(run.threadId);
      const outcome: GameRunRestoreOutcome =
        record === undefined
          ? {
              kind: "refused",
              reason: "round-not-found",
              message: `Round ${pending.round} is not recorded.`,
            }
          : yield* restoreKeptRound({ game, root, run, state, record });
      yield* refused(
        engine.dispatch({
          type: "game-run.restore",
          commandId: CommandId.make(`server:game-run-restore:${job.requestId}`),
          threadId: run.threadId,
          runId: run.id,
          requestId: job.requestId,
          outcome,
        }),
      );
    });

  // Every move of the run is news to the library and the Run view, which
  // reread the run's records; the step label rides along for the push.
  const showLive = (run: GameRun) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(run.threadId);
      if (run.status === "ended") return yield* operations.runChanged(root, null);
      const records = yield* projections.getGameRunRecords(run.threadId, { steps: "in-flight" });
      const held =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      yield* operations.runChanged(root, currentStep(toState(run, records.gameRunRounds, held)));
    });

  // The run log is for people: each step's decisions, written once it settles.
  // Nothing reads it back; the step records are the run's history.
  // Steps in flight, by id, with the attempt that is: a landed step is written
  // once and dropped, so the set holds only what the runs are doing now.
  const inFlightSteps = new Map<string, number>();
  const logStep = (step: GameRunStep) =>
    Effect.gen(function* () {
      if (step.status === "planned" || step.status === "running") {
        inFlightSteps.set(step.id, step.attempt);
        return;
      }
      // A step seen only landed (a restart in between) is written too.
      const held = inFlightSteps.get(step.id);
      if (held !== undefined && held !== step.attempt) return;
      if (held === undefined && step.completedAt === null) return;
      inFlightSteps.delete(step.id);
      const root = yield* projects.resolve(step.threadId);
      yield* logLine(root, `${describe(step.step)} (${step.status})`);
      for (const line of step.logs) yield* logLine(root, `  ${line}`);
    });

  const handle: GameRunStepRunner["Service"]["handle"] = (event) =>
    (event.type === "game-run.created" || event.type === "game-run.updated"
      ? showLive(event.payload)
      : event.type === "game-run-step.updated"
        ? logStep(event.payload)
        : Effect.void
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("game run live line failed", { threadId: event.threadId, cause }),
      ),
    );

  const executeJob = (job: GameRunJobs.GameRunStepJob) =>
    execute(job).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("game run step job failed", { stepId: job.stepId, cause }),
      ),
    );

  const start: GameRunStepRunner["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* jobs.attach({
        // A folder that cannot be read is no reason to skip the question.
        showable: (threadId, lane, decision) =>
          projects.resolve(threadId).pipe(
            Effect.flatMap((root) => Effect.promise(() => presentable(root, lane, decision))),
            Effect.map((evidence) => evidence.length > 0),
            Effect.orElseSucceed(() => true),
          ),
        execute: executeJob,
        deadline: (job) =>
          deadline(job).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("game run cap watch failed", { stepId: job.stepId, cause }),
            ),
          ),
        resend: (job) =>
          resend(job).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("game run resend failed", { stepId: job.stepId, cause }),
            ),
          ),
        restore: (job) =>
          restore(job).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("game run restore failed", { runId: job.runId, cause }),
            ),
          ),
        finish: (job) =>
          finish(job).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("game run finish failed", { runId: job.runId, cause }),
            ),
          ),
      });
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("game run step runner stream failed", { cause }),
          ),
        ),
      );
    });

  return GameRunStepRunner.of({ start, execute: executeJob, handle });
});

export const layer = Layer.effect(GameRunStepRunner, make);
