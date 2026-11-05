// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A step's work is the game folder's: notes written on disk, build copies, wall-clock caps.
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { checkpointRefForGameRun } from "../../checkpointing/Utils.ts";
import { gitEra, RESUMABLE, toState } from "../../orchestration-v2/gameRun/decide.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  gameRunOperationOwner,
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
import * as ProjectService from "../../project/ProjectService.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameService from "../GameService.ts";
import { causeText, logLine, refreshHarnessFiles, writeAtomic } from "../runSetup.ts";
import { runBotFact } from "./botFacts.ts";
import { runStateChecks } from "./checkRunner.ts";
import { artAssetFacts, botRunCount, reviewerFacts } from "./facts.ts";
import { presentable } from "./decisionEvidence.ts";
import { finishExports } from "./finish.ts";
import { restoreKeptRound } from "./restoreRound.ts";
import { BuildName, keptBuild } from "./buildNames.ts";
import { buildStep, captureBuild, type FolderLock, freeBy, pruneBuilds } from "./builds.ts";
import * as GameRunRoleReactor from "./GameRunRoleReactor.ts";
import {
  BUSY_PAUSE,
  BUSY_WAITS,
  busyEnded,
  type GameRunGameBusy,
  type GameRunMemoryShort,
  MEMORY_PAUSE,
  MEMORY_WAITS,
  handBackOnBusy,
  handBackOnLowMemory,
  isContention,
  lastLine,
} from "./lowMemory.ts";
import { modelFacts } from "./modelFacts.ts";
import {
  blankFolder,
  dropRunCopies,
  releaseCopy,
  removeBlank,
  runCopies,
  sampleCopy,
  type RoleContext,
  type RoleDeps,
} from "./roleWorkspace.ts";
import { CONTINUE, MEMORY_RETRY, artFacts, modelBlock, spriteBlock } from "./roles.ts";
import { currentStep, describe, summarize } from "./runView.ts";
import { spriteFacts } from "./spriteFacts.ts";
import { BLANK, type BotStep, type RoleStep } from "./state.ts";
import { bootStep } from "./steps.ts";

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
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const config = yield* ServerConfig.ServerConfig;
  const projectStore = yield* ProjectService.ProjectService;
  const operations = yield* GameOperations.GameOperations;
  const settings = yield* ServerSettings.ServerSettingsService;
  const jobs = yield* GameRunJobs.GameRunJobs;
  const roles = yield* GameRunRoleReactor.GameRunRoleReactor;
  const deps: RoleDeps = { launches, threads, game, checkpoints };

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

  // A refusal is the timer's answer (the run moved on or stopped); any other
  // failure is left to the timer's effect, which runs again.
  const refusedOnly = <A, R>(dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>) =>
    dispatch.pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestratorGameRunRefusedError: () => Effect.void,
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
      }),
    );

  /**
   * A role turn's cap as a durable timer due now, keyed by what the step just
   * sent or found at work: its effect sets it again at the turn's due time, so
   * every turn of the step is capped whatever became of an earlier timer.
   */
  const capTurn = (half: GameRunJobs.GameRunStepJob, key: string) =>
    Effect.flatMap(DateTime.now, (now) =>
      engine.dispatch({
        type: "game-run.step.schedule",
        commandId: CommandId.make(
          `server:game-run-cap:${half.stepId}:attempt:${half.attempt}:watch:${key}`,
        ),
        threadId: half.threadId,
        runId: half.runId,
        stepId: half.stepId,
        attempt: half.attempt,
        at: DateTime.toEpochMillis(now),
        timer: { kind: "cap" },
      }),
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
  /**
   * Memory short, or the game held by another operation: the step's job ends
   * and a durable timer runs its work again, so no job holds one of the
   * shared step slots while it waits. The waits are counted on the step's
   * record, each kind on its own, so a restart does not reset them. Both
   * halves of a pair refused at once make one wait, whatever each was refused
   * for: the command id counts every wait the step made, not each kind. The run
   * finds a pair's step by a half's id, so the timer names the half refused.
   * A timer that could not be written fails the step: a step left running
   * with neither job nor timer would wait for a restart.
   */
  const waitForMemory = (
    job: GameRunJobs.GameRunStepJob,
    record: GameRunStep,
    stepId: GameRunStepId,
    short: GameRunMemoryShort | GameRunGameBusy,
    log: (line: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const kind = short._tag === "GameRunGameBusy" ? "busy" : "memory";
      const n = ((kind === "busy" ? record.busyWaits : record.memoryWaits) ?? 0) + 1;
      const pause = kind === "busy" ? BUSY_PAUSE : MEMORY_PAUSE;
      yield* log(
        kind === "busy"
          ? `${short.what} found the game busy (${lastLine(short.error)}); the step waits ${BUSY_PAUSE} (${n} of ${BUSY_WAITS})`
          : `${short.what} refused, memory short (${lastLine(short.error)}); the step waits ${MEMORY_PAUSE} (${n} of ${MEMORY_WAITS})`,
      );
      const at =
        DateTime.toEpochMillis(yield* DateTime.now) +
        Duration.toMillis(Duration.fromInputUnsafe(pause));
      yield* engine
        .dispatch({
          type: "game-run.step.schedule",
          commandId: CommandId.make(
            `server:game-run-wait:${record.id}:attempt:${job.attempt}:${(record.memoryWaits ?? 0) + (record.busyWaits ?? 0) + 1}`,
          ),
          threadId: job.threadId,
          runId: job.runId,
          stepId,
          attempt: job.attempt,
          at,
          timer: { kind, n },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTags({
            // The run moved on or stopped, or the other half's wait already holds this one.
            OrchestratorGameRunRefusedError: (error) =>
              Effect.logInfo("game run wait not taken", { kind, detail: error.detail }),
            OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
          }),
          Effect.catch((error) =>
            fail(
              { ...job, stepId },
              stepId,
              `${kind} wait could not be scheduled (${error.message})`,
            ),
          ),
        );
    });
  const memoryWaitsLeft = (record: GameRunStep) => (record.memoryWaits ?? 0) < MEMORY_WAITS;
  const busyWaitsLeft = (record: GameRunStep) => (record.busyWaits ?? 0) < BUSY_WAITS;
  // Steps hand a busy game back to their timer; the end of a run and a restore wait it out, until `waitUntil`.
  const folderLock = (run: GameRun, waitUntil: number | null): FolderLock => ({
    operations,
    owner: gameRunOperationOwner(run.id),
    waitUntil,
  });

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

  /**
   * What a landing asks of the game folder, from the effect its commit queued
   * before the run's next step: the records first (the next step may read
   * them), then the copies no role needs. Writing the same files and releasing
   * the same copies again is harmless, so a re-run after a death is too.
   */
  const outputs = (job: GameRunJobs.GameRunOutputs) =>
    Effect.gen(function* () {
      const root = yield* projects.resolve(job.threadId, { deleted: "allowed" });
      for (const file of job.files)
        yield* Effect.tryPromise(() => writeAtomic(NodePath.join(root, file.path), file.text));
      const log = (line: string) => logLine(root, line);
      for (const thread of job.release)
        yield* releaseCopy(deps, { copies: copiesOf(job.runId), log }, thread);
    });

  // A source role's change is measured at its landing against the build its step names.
  const measure = (role: RoleStep, root: string) =>
    Effect.promise(async (): Promise<GameRunRoleBefore> => ({
      source: "",
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

  const copiesOf = (runId: string) => runCopies(config.worktreesDir, runId);
  const roleContext = (
    run: GameRun,
    record: GameRunStep,
    root: string,
    log: RoleContext["log"],
  ): RoleContext => ({
    root,
    lane: run.lane,
    runId: run.id,
    copies: copiesOf(run.id),
    log,
    memoryWaitsLeft: memoryWaitsLeft(record),
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
  // A role turn a server restart keeps cutting off would otherwise be
  // continued forever; the run ends resumably instead.
  const CUT_OFF_LIMIT = 3;
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
        entry?.before === undefined ? measure(role, root) : Effect.succeed(entry.before);
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
          // A deleted project takes no new threads; a read that fails is no
          // proof it lives, so the step fails rather than launching blind.
          const projectLive = yield* projectStore.getById(run.projectId).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          );
          if (!projectLive)
            return yield* fail(half, stepId, `${role.role}: its project was deleted`);
          const measured = yield* before();
          const ctx = roleContext(run, record, root, log);
          // An engine whose first editor open imports the whole project (minutes;
          // later opens take seconds) pays it here, before any role's clock.
          const engineProfile = laneProfile(run.lane);
          if (engineProfile.run.warmEditor && role.at === null) {
            const from = Date.now();
            yield* handBackOnLowMemory(
              game.warmEditor(root),
              `${engineProfile.displayName} warm-up`,
              ctx.memoryWaitsLeft,
            ).pipe(
              Effect.matchEffect({
                onSuccess: (warmed) =>
                  warmed
                    ? log(
                        `${engineProfile.displayName} warm-up: first import took ${Math.round((Date.now() - from) / 1000)} s, before ${role.role}'s clock`,
                      )
                    : Effect.void,
                onFailure: (error) =>
                  error._tag === "GameRunMemoryShort"
                    ? Effect.fail(error)
                    : log(
                        `${engineProfile.displayName} warm-up skipped (${(error.detail ?? error.reason).slice(0, 200)}); the role opens the editor itself`,
                      ),
              }),
            );
          }
          const blank = role.at === BLANK ? yield* blankFolder(deps, ctx, role) : null;
          if (role.at === BLANK && blank === null)
            return yield* fail(half, stepId, `${role.role}: no folder of its own`);
          if (role.at === null && replaces === undefined)
            for (const file of role.clear)
              yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, file), { force: true }));
          // A blind sample plays a plain copy of its build: the same game, but no
          // git, round notes or bots that would tell the builds apart.
          const sample =
            role.at !== null && role.at !== BLANK
              ? yield* sampleCopy(deps, ctx, role, role.at)
              : null;
          if (role.at !== null && role.at !== BLANK && sample === null)
            return yield* fail(half, stepId, `${role.role}: no copy of its build`);
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
                  ? { type: "existing_worktree", worktreePath: workspace.path }
                  : { type: "root" },
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
        // An archived role thread refuses every turn, so each resume would fail
        // the same way; the run owns its roles and brings the thread back.
        if (shell.archivedAt !== null) {
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(
              `server:game-run-role-unarchive:${stepId}:attempt:${job.attempt}:${threadId}`,
            ),
            threadId,
          });
          yield* log(`${role.role}: thread ${threadId} was archived; brought it back for the run`);
        }
        const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
        const turns = GameRunRoleReactor.stepTurns(runs, stepId);
        const latest = turns.findLast((t) => t.turn.attempt === job.attempt);
        if (latest !== undefined) {
          yield* limitInput(threadId);
          if (!GameRunRoleReactor.isSettledRun(latest.run)) {
            yield* log(`${role.role}: reattaching to thread ${threadId}`);
            return yield* refused(capTurn(half, latest.run.id));
          }
          if (GameRunRoleReactor.isCutOff(latest.run)) {
            const attemptTurns = turns.filter((t) => t.turn.attempt === job.attempt);
            // Only turns that ran count: a continuation a shutdown cancelled
            // before it started cost the role nothing.
            const cut = attemptTurns.filter(
              (t) => GameRunRoleReactor.isCutOff(t.run) && t.run.startedAt !== null,
            ).length;
            if (cut >= CUT_OFF_LIMIT)
              return yield* fail(half, stepId, `${role.role}: role turn cut off repeatedly`);
            yield* log(`${role.role}: turn on ${threadId} was cut off; continuing it`);
            const n = Math.max(...attemptTurns.map((t) => t.turn.n)) + 1;
            yield* roles.sendTurn({
              projectId: run.projectId,
              threadId,
              stepId,
              attempt: job.attempt,
              kind: "continue",
              n,
              text: `${CONTINUE}\n\n${yield* promptOf(run, role, root)}`,
            });
            return yield* refused(capTurn(half, `continue:${n}`));
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
          if (threadId === own) return yield* fail(half, stepId, `${role.role}: its copy is gone`);
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
    }).pipe(
      Effect.catchTags({
        GameRunMemoryShort: (short) =>
          waitForMemory(
            job,
            record,
            record.step.kind === "pair" ? gameRunStepId(run.id, role.id) : record.id,
            short,
            log,
          ),
      }),
    );

  const botHalf = (
    job: GameRunJobs.GameRunStepJob,
    run: GameRun,
    record: GameRunStep,
    stepId: GameRunStepId,
    step: BotStep,
    root: string,
    log: (line: string) => Effect.Effect<void>,
  ) =>
    runBotFact(
      deps,
      {
        root,
        runId: run.id,
        copies: copiesOf(run.id),
        log,
        memoryWaitsLeft: memoryWaitsLeft(record),
      },
      step,
    ).pipe(
      Effect.tap((result) => log(`  step ${step.id}: ${summarize(result)}`)),
      Effect.flatMap((result) => complete({ ...job, stepId }, stepId, result)),
      Effect.catchTags({
        GameRunMemoryShort: (short) => waitForMemory(job, record, stepId, short, log),
      }),
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
      const { run, record } = found;
      const root = yield* projects.resolve(run.threadId);
      const log = (line: string) => logLine(root, line);
      const step = record.step;
      yield* log(describe(step));
      const done = (result: GameRunStepResult) =>
        log(`  ${summarize(result)}`).pipe(Effect.andThen(complete(job, record.id, result)));
      switch (step.kind) {
        case "build":
          return yield* reporting(
            job,
            record.id,
            // The base build includes the engine's harness files as this run ships them.
            (step.op._tag === "capture" && step.op.name === "base"
              ? refreshHarnessFiles(root, run.lane, log)
              : Effect.void
            ).pipe(
              Effect.andThen(
                handBackOnBusy(
                  buildStep(
                    { game, checkpoints, lock: folderLock(run, null) },
                    { root, runId: run.id, lane: run.lane },
                    step.op,
                  ),
                  `build ${step.op._tag}`,
                  busyWaitsLeft(record),
                ),
              ),
              Effect.flatMap(done),
              Effect.catchTags({
                GameRunGameBusy: (busy) => waitForMemory(job, record, record.id, busy, log),
                GameOperationError: (error) =>
                  isContention(error)
                    ? fail(job, record.id, busyEnded(`build ${step.op._tag}`, error).reason)
                    : Effect.fail(error),
              }),
            ),
          );
        case "git":
          // Only a run from before builds on checkpoints planned one; it is never continued.
          return yield* fail(job, record.id, "this run versions on git branches and cannot go on");
        case "boot":
          return yield* reporting(
            job,
            record.id,
            bootStep(game, {
              creator: run.threadId,
              owner: gameRunOperationOwner(run.id),
              root,
              lane: run.lane,
              log,
              memoryWaitsLeft: memoryWaitsLeft(record),
              busyWaitsLeft: busyWaitsLeft(record),
            }).pipe(
              Effect.flatMap(done),
              Effect.catchTags({
                GameRunMemoryShort: (short) => waitForMemory(job, record, record.id, short, log),
                GameRunGameBusy: (busy) => waitForMemory(job, record, record.id, busy, log),
              }),
            ),
          );
        case "facts":
          return yield* reporting(
            job,
            record.id,
            Effect.gen(function* () {
              const jev = yield* settings.getSettings.pipe(
                Effect.map(({ gameJevApiKey }) => gameJevApiKey !== ""),
                Effect.orElseSucceed(() => false),
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
          return yield* reporting(
            job,
            record.id,
            botHalf(job, run, record, record.id, step, root, log),
          );
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
                  : botHalf(job, run, record, stepId, h, root, log),
              );
            },
            { concurrency: 2, discard: true },
          );
        }
        case "decide":
          return;
      }
    });

  /**
   * A role turn's cap, from its turn's start, plus the time its explore
   * starts waited for memory, never past the run's budget. It runs inside its
   * effect, which stays unsettled until the interrupt is sent or the timer is
   * set again, so a server death in between runs it again.
   */
  const deadline = (job: GameRunJobs.GameRunStepJob) =>
    Effect.gen(function* () {
      const at = yield* roles.locate(job.threadId, job.stepId, job.attempt);
      if (at === null || at.role === null) return;
      const threadId = at.record.roles.find((r) => r.seq === at.seq)?.threadId ?? null;
      if (threadId === null) return;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const attemptTurns = GameRunRoleReactor.stepTurns(runs, job.stepId).filter(
        (t) => t.turn.attempt === job.attempt,
      );
      const live = attemptTurns.at(-1);
      if (live === undefined || GameRunRoleReactor.isSettledRun(live.run)) return;
      // A continued turn (a restart cut the one before) carries on that turn's
      // work, so its cap runs from where the work began, as the step's elapsed
      // time does; a turn sent afresh (a retry, a memory wait) has its own.
      const fresh = (t: GameRunRoleReactor.AttributedTurn) => t.sent && t.turn.kind !== "continue";
      const anchor = attemptTurns.findLast(fresh) ?? attemptTurns[0] ?? live;
      const startedAt = anchor.run.startedAt ?? anchor.run.requestedAt;
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
        return yield* refusedOnly(
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
        .pipe(Effect.asVoid);
    });

  /**
   * A role turn sent again once its pause is over, if its step is still where
   * it was, inside its effect: a server death before the turn is queued runs
   * it again under the same ids. The send and the look after it are one act a
   * stop cannot cut: the ending's finish then either finds the turn to
   * interrupt, or the turn, sent after the ending, is interrupted here.
   */
  const resend = (job: GameRunJobs.GameRunResend) =>
    Effect.gen(function* () {
      const at = yield* roles.locate(job.threadId, job.stepId, job.attempt);
      if (at === null || at.role === null) return;
      const threadId = at.record.roles.find((r) => r.seq === at.seq)?.threadId ?? null;
      if (threadId === null) return;
      const prompt = at.role.prompt;
      const projectId = at.run.projectId;
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* roles.sendTurn({
            projectId,
            threadId,
            stepId: job.stepId,
            attempt: job.attempt,
            kind: job.turn,
            n: job.n,
            text: job.turn === "memory" ? `${MEMORY_RETRY}\n\n${prompt}` : prompt,
          });
          if ((yield* roles.locate(job.threadId, job.stepId, job.attempt)) === null)
            return yield* threads.interruptThread({
              projectId,
              commandId: CommandId.make(
                `server:game-run-resend-late:${job.stepId}:attempt:${job.attempt}:${job.turn}:${job.n}`,
              ),
              threadId,
              reason: "The production run moved on before this turn was sent.",
            });
          // A turn sent again is capped like the first.
          yield* refusedOnly(capTurn(job, `${job.turn}:${job.n}`));
        }),
      );
    });

  // ── A run's end, from the game-run.finish effect its ending committed: its
  // jobs and live role turns stop, and the game folder gets its exports (the
  // ending's outputs effect ran before it). Every part is safe to repeat, so a finish a
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
      // The ending is recorded however its work went: a run left unfinished
      // refuses every resume, steer and restore until a restart. Only an
      // interrupt (a shutdown) leaves it to recovery, which finishes it again.
      yield* finishWork(job, run, records).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : projects.resolve(run.threadId, { deleted: "allowed" }).pipe(
                Effect.flatMap((root) =>
                  logLine(
                    root,
                    `run finish broke (${causeText(cause)}); the ending is recorded anyway`,
                  ),
                ),
                Effect.catchCause(() =>
                  Effect.logWarning("game run finish broke", { runId: run.id, cause }),
                ),
              ),
        ),
      );
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

  const finishWork = (
    job: GameRunJobs.GameRunFinishJob,
    run: GameRun,
    records: ProjectionStore.GameRunThreadRecords,
  ) =>
    Effect.gen(function* () {
      // The run's jobs, then its live role turns, before anything that can
      // fail: a finish that breaks later is still recorded, so nothing of the
      // run may be left working. Each interrupt needs no folder, and one that
      // breaks never keeps the others from being sent.
      yield* jobs.stopRun(run.id);
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
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
            ),
          );
      }
      const root = yield* projects.resolve(run.threadId, { deleted: "allowed" });
      const log = (line: string) => logLine(root, line);
      yield* log(
        `run ended: ${run.ending ?? "unknown"}${run.lastFailure ? ` (${run.lastFailure})` : ""}`,
      );
      if (run.ending !== null && !NO_EXPORT.has(run.ending)) {
        // An ending mid-round (a usage limit, a provider outage) leaves the
        // round's unfinished work in the folder. The exports are of the best
        // build, and the folder is left as the run left it, so a resume goes on
        // from that work. The work is kept once per ending: a finish a restart
        // cut after the best was restored must not keep the best as the work.
        // A run from before checkpoints holds no builds to park or restore:
        // its folder is exported as it is and left untouched.
        // One bound for every wait of the ending, however many moves and exports it makes.
        const waitUntil = yield* freeBy;
        const ops = { game, checkpoints, lock: folderLock(run, waitUntil) };
        const ctx = { root, runId: run.id, lane: run.lane };
        const name = BuildName.ending(job.endedAt);
        const parked = yield* Effect.gen(function* () {
          if (gitEra(run)) return null;
          const ref = checkpointRefForGameRun(run.id, name);
          const kept = yield* checkpoints.hasCheckpointRef({ cwd: root, checkpointRef: ref });
          if (!kept) {
            const sha = yield* captureBuild(ops, root, run.id, name);
            yield* log(
              `the folder's work at the ending is kept as ${keptBuild(run.id, name, run.lane, sha)}`,
            );
          }
          const best = yield* buildStep(ops, ctx, { _tag: "restore", sha: run.best, keep: [] });
          if (!best.build.ok)
            yield* log(
              `finishExports: the best build could not be restored (${best.build.detail}); exporting the folder as it is`,
            );
          return best.build.ok ? ref : null;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : log(
                  `finishExports: the best build could not be restored (${causeText(cause)}); exporting the folder as it is`,
                ).pipe(Effect.as(null)),
          ),
        );
        yield* finishExports(
          root,
          run.threadId,
          game,
          log,
          gameRunOperationOwner(run.id),
          waitUntil,
        ).pipe(Effect.ignore);
        if (parked !== null)
          yield* buildStep(ops, ctx, { _tag: "restore", sha: parked, keep: [] }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : log(
                    `the run's unfinished work could not be put back (${causeText(cause)}); it is ${keptBuild(run.id, name, run.lane, "")}`,
                  ),
            ),
          );
      }
      // Last, so every build the ending used is still there for a finish a
      // restart repeats; a repeat finds fewer refs and removes nothing more.
      if (!gitEra(run))
        yield* pruneBuilds(
          checkpoints,
          root,
          toState(run, records.gameRunRounds, held ?? null),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : log(`the run's spent builds could not be cleared: ${causeText(cause)}`),
          ),
        );
      const roleThreads = new Set(
        records.gameRunSteps
          .filter((s) => s.runId === run.id)
          .flatMap((s) => s.roles.flatMap((r) => (r.threadId === null ? [] : [r.threadId]))),
      );
      yield* dropRunCopies(
        deps,
        { copies: copiesOf(run.id), log },
        [...roleThreads],
        RESUMABLE.has(run.ending ?? ""),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : log(`the run's copies could not be removed: ${causeText(cause)}`),
        ),
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
      // A restore that broke is still answered: the run would otherwise stay
      // "restoring" until a restart. An interrupt leaves it to recovery.
      const outcome: GameRunRestoreOutcome = yield* (
        record === undefined
          ? Effect.succeed<GameRunRestoreOutcome>({
              kind: "refused",
              reason: "round-not-found",
              message: `Round ${pending.round} is not recorded.`,
            })
          : Effect.flatMap(
              Effect.all([projects.resolve(run.threadId, { deleted: "allowed" }), freeBy]),
              ([root, waitUntil]) =>
                restoreKeptRound({
                  game,
                  checkpoints,
                  lock: folderLock(run, waitUntil),
                  root,
                  run,
                  state,
                  record,
                  requestId: job.requestId,
                }),
            )
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed<GameRunRestoreOutcome>({
                kind: "refused",
                reason: "git-failed",
                message: `The restore broke (${causeText(cause)}); see .studio/run.log and the game's git status.`,
              }),
        ),
      );
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
      // A step that completed with nothing to say only restates its record.
      if (step.status === "completed" && step.logs.length === 0) return;
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
            Effect.flatMap((root) => Effect.tryPromise(() => presentable(root, lane, decision))),
            Effect.map((evidence) => evidence.length > 0),
            Effect.orElseSucceed(() => true),
          ),
        execute: executeJob,
        deadline: (job) =>
          deadline(job).pipe(
            Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })),
          ),
        resend: (job) =>
          resend(job).pipe(
            Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })),
          ),
        outputs: (job) =>
          outputs(job).pipe(
            Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })),
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
