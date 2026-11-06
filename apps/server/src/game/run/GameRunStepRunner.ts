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
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  gameRunStepCommandId,
  gameRunStepId,
  plainReason,
} from "@kurambit/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@kurambit/shared/atomicWrite";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { gitEra, RESUMABLE, toState } from "../../orchestration-v2/gameRun/decide.ts";
import * as GameRunJobs from "../../orchestration-v2/gameRun/GameRunJobs.ts";
import {
  gameRunOperationOwner,
  roleCapCommandId,
  roleThreadId,
  roleTurnCommandId,
  roleTurnMessageId,
} from "../../orchestration-v2/gameRun/ids.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { engineProfile, runEngine } from "../engineProfile.ts";
import * as GameOperations from "../GameOperations.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GameProjectService from "../GameProjectService.ts";
import * as GameService from "../GameService.ts";
import { causeText, logLine, refreshHarnessFiles } from "../runSetup.ts";
import { runBotFact } from "./botFacts.ts";
import { runStateChecks } from "./checkRunner.ts";
import { artAssetFacts, type ReviewBots, reviewerFacts, total } from "./facts.ts";
import { presentable } from "./decisionEvidence.ts";
import { finishExports } from "./finish.ts";
import { restoreBuild, type RestoreTarget } from "./restoreRound.ts";
import { BuildName, keptBuild } from "./buildNames.ts";
import { buildStep, type FolderLock, freeBy, pruneBuilds, withBuildInFolder } from "./builds.ts";
import * as GameRunRoleReactor from "./GameRunRoleReactor.ts";
import {
  type GameRunBuildFault,
  GameRunJobBroke,
  type NotMeasured,
  handBack,
  measuring,
  needed,
  toolFailed,
} from "./handBack.ts";
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
import { RETRIES, retrying } from "./retrying.ts";

const isJobBroke = (error: unknown): error is GameRunJobBroke => error instanceof GameRunJobBroke;

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

// Endings that leave nothing to export: a stop, a failure, or a machine too short of memory or
// too busy for the exports to start.
const NO_EXPORT: ReadonlySet<string> = new Set(["stopped", "failed", "low-memory", "busy"]);

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
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const deps: RoleDeps = { launches, threads, game, checkpoints };
  /** A record of the run's in the game folder, whole or not at all. */
  const writeRecord = (file: string, text: string) =>
    writeFileStringAtomically({ filePath: file, contents: text }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
  // Jobs read the run's step in flight and its role threads, never every step's prompts.
  const inFlightOf = (threadId: ThreadId) =>
    projections.getGameRunRecords(threadId, { steps: "in-flight" });
  /** Every thread the run's steps ran a role on, each once. */
  const runRoleThreads = (threadId: ThreadId, runId: GameRun["id"]) =>
    projections
      .listGameRunRoleThreads(threadId, runId)
      .pipe(Effect.map((roles) => [...new Set(roles.map((r) => r.threadId))]));

  /**
   * The record that frees an ended run from "finishing" or "restoring": until it
   * lands the run refuses every start, resume, steer and restore, so it is
   * tried again with backoff. One that still cannot be written is left to
   * recovery, which runs the finish or restore again at the next startup (its
   * record still says it is owed); the finish's and restore's effects were
   * spent when their jobs started, so nothing durable is left to retry sooner.
   */
  const recordEnd = <A, R>(
    what: "finish" | "restore",
    runId: GameRun["id"],
    dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>,
  ) =>
    dispatch.pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestratorGameRunRefusedError: (error) =>
          Effect.logInfo("game run report not taken", { detail: error.detail }),
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
      }),
      retrying,
      Effect.catch((error) =>
        Effect.logWarning(
          `game run ${what} could not be recorded after ${RETRIES + 1} tries; the run stays ${what === "finish" ? "finishing" : "restoring"} until recovery runs it again at the next startup`,
          { runId, error },
        ),
      ),
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

  // A report the run refuses is the answer; one that could not be written
  // breaks the job, which is tried again (executeJob).
  const reported = <A, R>(dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>) =>
    dispatch.pipe(
      Effect.asVoid,
      Effect.catchTags({
        OrchestratorGameRunRefusedError: (error) =>
          Effect.logInfo("game run report not taken", { detail: error.detail }),
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
      }),
      Effect.mapError((cause) => new GameRunJobBroke({ cause })),
    );

  const complete = (
    job: GameRunJobs.GameRunStepJob,
    stepId: GameRunStepId,
    result: GameRunStepResult,
  ) =>
    reported(
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
    reported(
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
  // Steps hand a busy game back to their timer; the end of a run and a restore wait it out, until `waitUntil`.
  const folderLock = (run: GameRun, waitUntil: number | null): FolderLock => ({
    operations,
    owner: gameRunOperationOwner(run.id),
    waitUntil,
  });

  /**
   * The one way a step's work, or one half of a pair, reports. A measurement
   * completes the step. What was not measured never does: memory short, the
   * game held or a tool failed hands the step back to a durable timer while
   * its waits last, else (or at once, for a fault waiting cannot clear) the
   * run pauses with why. A build fault that reached here has no verdict form
   * in its step (a capture of a folder the build broke): the step fails with
   * the build's reason, resumable once it is fixed. Any other failure of the
   * run's own code is a tool fault too, never an answer. A broken record
   * write breaks the job, which executeJob tries again; an interrupt is a
   * stop and reports nothing.
   */
  const measure = <E>(
    job: GameRunJobs.GameRunStepJob,
    record: GameRunStep,
    stepId: GameRunStepId,
    what: string,
    root: string,
    log: (line: string) => Effect.Effect<void>,
    work: Effect.Effect<GameRunStepResult | null, E>,
  ): Effect.Effect<void, GameRunJobBroke> => {
    const half = { ...job, stepId };
    const notMeasured = (cause: NotMeasured) =>
      handBack(
        engine,
        { creator: job.threadId, runId: job.runId, stepId, attempt: job.attempt, record },
        cause,
        (result) => complete(half, stepId, result),
        log,
      ).pipe(
        Effect.mapError((cause) => (isJobBroke(cause) ? cause : new GameRunJobBroke({ cause }))),
      );
    // Every failure is read once; only a broken record write stays the job's own.
    const read = work.pipe(measuring(what, [root])) as Effect.Effect<
      GameRunStepResult | null,
      NotMeasured | GameRunBuildFault | GameRunJobBroke
    >;
    return read.pipe(
      Effect.flatMap((result) =>
        result === null
          ? Effect.void
          : log(`  ${summarize(result)}`).pipe(Effect.andThen(complete(half, stepId, result))),
      ),
      Effect.catchTags({
        GameRunMemoryShort: notMeasured,
        GameRunGameBusy: notMeasured,
        GameRunToolFailed: notMeasured,
        GameRunBuildFault: (fault: GameRunBuildFault) =>
          fail(
            half,
            stepId,
            `the build cannot be kept: ${plainReason(fault.error.detail ?? fault.error.reason, [root])}`,
          ),
      }),
    );
  };

  /** The run and its step in flight, if this job's attempt still holds it. */
  const current = (job: GameRunJobs.GameRunStepJob) =>
    inFlightOf(job.threadId).pipe(
      Effect.map((records) => {
        const run = records.gameRuns.at(-1);
        if (run === undefined || run.id !== job.runId || run.status === "ended") return null;
        const record = records.gameRunSteps.find(
          (s) => s.runId === run.id && s.seq === run.inFlight,
        );
        if (record === undefined || record.id !== job.stepId || record.attempt !== job.attempt)
          return null;
        if (record.status !== "planned" && record.status !== "running") return null;
        return { run, record };
      }),
      // A read that fails is no answer: null would read as "the step moved on".
      Effect.mapError((cause) => new GameRunJobBroke({ cause })),
    );

  /**
   * What a landing asks of the game folder, from the effect its commit queued
   * before the run's next step: the copies no role needs, then the records the
   * next step may read. Releasing the same copies and writing the same files
   * again is harmless, so a re-run after a death is too. Records that still
   * cannot be written on the outbox's last try stop the run with why, which
   * cancels the next step in the same commit: it must not run without them.
   */
  const outputs = (job: GameRunJobs.GameRunOutputs & GameRunJobs.GameRunEffectTry) =>
    Effect.gen(function* () {
      const root = yield* projects
        .resolve(job.threadId, { deleted: "allowed" })
        .pipe(Effect.option);
      for (const thread of job.release)
        yield* releaseCopy(deps, { copies: copiesOf(job.runId), log: Effect.logInfo }, thread);
      if (job.files.length === 0) return;
      const writes = Effect.gen(function* () {
        if (Option.isNone(root))
          return yield* new GameRunJobs.GameRunEffectError({
            cause: "the game folder could not be found",
          });
        for (const file of job.files)
          yield* writeRecord(NodePath.join(root.value, file.path), file.text);
      });
      const stop = <E>(cause: Cause.Cause<E>) =>
        retrying(
          refusedOnly(
            engine.dispatch({
              type: "game-run.stop",
              commandId: CommandId.make(`server:game-run-outputs-failed:${job.effectId}`),
              threadId: job.threadId,
              runId: job.runId,
              // Not the creator's act: the run pauses as a tool that kept failing.
              ending: "tool-failed",
              reason: `the run's records could not be written (${causeText(cause).slice(0, 200)})`,
            }),
          ),
        );
      yield* job.final
        ? writes.pipe(Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), stop))
        : writes;
    });

  /**
   * A timer's work, given up its own way on the outbox's last try (`giveUp`),
   * so the effect's end loses nothing; an interrupt (a stop) is never given up.
   */
  const lastTry = <E, E2>(
    job: GameRunJobs.GameRunEffectTry,
    work: Effect.Effect<void, E>,
    giveUp: (cause: Cause.Cause<E>) => Effect.Effect<void, E2>,
  ): Effect.Effect<void, GameRunJobs.GameRunEffectError> =>
    (job.final
      ? work.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              // Giving up is a write too: tried again, and one that never gets
              // through fails the effect, so recovery owes the step at startup.
              Effect.logWarning("game run timer gave up on its last try", {
                effectId: job.effectId,
                cause,
              }).pipe(Effect.andThen(retrying(giveUp(cause)))),
          ),
        )
      : work
    ).pipe(Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })));

  /**
   * A spent run's copies, from the effect the commit that found them spent
   * queued on its thread: a resume committed after it runs its step behind
   * this, and makes fresh copies.
   */
  const releaseCopies = (job: { readonly threadId: ThreadId; readonly runId: GameRun["id"] }) =>
    Effect.gen(function* () {
      const roleThreads = yield* runRoleThreads(job.threadId, job.runId);
      const ctx = { copies: copiesOf(job.runId), log: Effect.logInfo };
      yield* dropRunCopies(deps, ctx, roleThreads, false);
    });

  // The art director judges files, so it gets the asset-list and measured
  // image facts; the redo that answers it sees the same measurements. The
  // readers are total (facts.ts): what they could not read they say.
  const promptOf = (run: GameRun, role: RoleStep, root: string) =>
    Effect.gen(function* () {
      const task = run.task;
      const redo = role.role === "art" && task._tag === "stage" && task.phase === "redo";
      const judged = role.role === "art-director" || redo;
      if (!judged) return role.prompt;
      const sprites = yield* Effect.promise(() =>
        total("Image facts", async () => (await spriteFacts(root, run.lane)).full),
      );
      const models = yield* Effect.promise(() =>
        total("Model facts", async () => (await modelFacts(root, run.lane)).full),
      );
      return role.role === "art-director"
        ? `${role.prompt}${artFacts(yield* Effect.promise(() => artAssetFacts(root, run.lane)), sprites)}${modelBlock(models)}`
        : `${role.prompt}${spriteBlock(sprites, true)}${modelBlock(models, true)}`;
    });

  /**
   * The reviewer's facts: the folder's code and art, and the bot runs of the
   * round's tester on its candidate with the report of exactly those runs,
   * never another round's or another build's. A record that cannot be read is
   * said so; these are facts for a prompt, never a verdict.
   */
  const reviewFacts = (root: string, run: GameRun, tester: ThreadId | null) =>
    Effect.gen(function* () {
      const bots: ReviewBots =
        tester === null
          ? { kind: "none" }
          : yield* game.botRuns(tester).pipe(
              Effect.flatMap((record) => {
                const runs = record.root === root ? record.runs : [];
                return game
                  .botReportText(
                    root,
                    runs.map((each) => each.runId),
                  )
                  .pipe(Effect.map((report): ReviewBots => ({ kind: "runs", runs, report })));
              }),
              Effect.catch((error) =>
                Effect.succeed<ReviewBots>({
                  kind: "not measured",
                  why: plainReason(error.detail ?? error.reason, [root]),
                }),
              ),
            );
      return yield* Effect.promise(() => reviewerFacts(root, run.lane, bots));
    });

  const copiesOf = (runId: string) => runCopies(config.worktreesDir, runId);
  const roleContext = (run: GameRun, root: string, log: RoleContext["log"]): RoleContext => ({
    root,
    engine: runEngine(run),
    runId: run.id,
    copies: copiesOf(run.id),
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
      const startStep = (target: ThreadId, replaces?: ThreadId) =>
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
            attempt: job.attempt,
            roleThreadId: target,
            ...(replaces === undefined ? {} : { replaces }),
          })
          .pipe(
            Effect.as(true),
            Effect.catchTags({
              OrchestratorGameRunRefusedError: (error) =>
                log(`${role.role}: the run did not take the step's start (${error.detail})`).pipe(
                  Effect.as(false),
                ),
              OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
            }),
            Effect.mapError((cause) => new GameRunJobBroke({ cause })),
          );
      // A sample's cap that cannot be kept breaks the job, which is tried
      // again, then fails the step: no sample is sent a turn without it.
      const limitInput = (target: ThreadId, folder: string) =>
        role.inputCapMs > 0
          ? needed(game.limitExploreInput(target, role.inputCapMs, folder))
          : Effect.void;

      const launchThread = (target: ThreadId, replaces: ThreadId | undefined, text: string) =>
        Effect.gen(function* () {
          // A deleted project takes no new threads; a read that fails is no
          // proof it lives, so the step fails rather than launching blind.
          const projectLive = yield* needed(projectStore.getById(run.projectId)).pipe(
            Effect.map(Option.isSome),
          );
          if (!projectLive)
            return yield* fail(half, stepId, `${role.role}: its project was deleted`);
          const ctx = roleContext(run, root, log);
          // An engine whose first editor open imports the whole project (minutes;
          // later opens take seconds) pays it here, before any role's clock.
          // Memory short waits; any other failure leaves the open to the role.
          const profile = engineProfile(ctx.engine);
          if (profile.run.warmEditor && role.at === null) {
            const from = Date.now();
            const skipped = (why: string) =>
              log(
                `${profile.displayName} warm-up skipped (${why}); the role opens the editor itself`,
              );
            yield* game.warmEditor(root).pipe(
              measuring(`${profile.displayName} warm-up`, [root]),
              Effect.flatMap((warmed) =>
                warmed
                  ? log(
                      `${profile.displayName} warm-up: first import took ${Math.round((Date.now() - from) / 1000)} s, before ${role.role}'s clock`,
                    )
                  : Effect.void,
              ),
              Effect.catchTags({
                GameRunGameBusy: (busy) => skipped(busy.error.detail ?? busy.error.reason),
                GameRunToolFailed: (tool) => skipped(tool.reason),
                GameRunBuildFault: (fault) => skipped(fault.error.detail ?? fault.error.reason),
              }),
            );
          }
          // A comparator's folder and a sample's copy that cannot be made are not
          // measured: they fail the step's work, never stand for a role's result.
          const blank = role.at === BLANK ? yield* blankFolder(deps, ctx, role) : null;
          if (role.at === null && replaces === undefined)
            for (const file of role.clear)
              yield* Effect.tryPromise(() =>
                NodeFSP.rm(NodePath.join(root, file), { force: true }),
              );
          // A blind sample plays a plain copy of its build: the same game, but no
          // git, round notes or bots that would tell the builds apart.
          const sample =
            role.at !== null && role.at !== BLANK
              ? yield* sampleCopy(deps, ctx, role, role.at)
              : null;
          const workspace = blank ?? sample;
          const dropWorkspace =
            workspace === null ? Effect.void : removeBlank(deps, ctx, workspace);
          if (!(yield* startStep(target, replaces))) return yield* dropWorkspace;
          yield* limitInput(target, workspace?.path ?? root);
          yield* launches
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
              // The run's chat is always live here: deleting it stops the run in the same commit.
              parentThreadId: run.threadId,
            })
            // No thread owns a checkout made here until a launch succeeds.
            .pipe(Effect.tapError(() => dropWorkspace));
          yield* log(`${role.role}: launched thread ${target}`);
        });

      // A read that fails is not a thread that is gone: it would launch a replacement.
      const shell = yield* needed(threads.getThreadShell(threadId));
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
          yield* limitInput(threadId, shell.worktreePath ?? root);
          if (!GameRunRoleReactor.isSettledRun(latest.run)) {
            yield* log(`${role.role}: reattaching to thread ${threadId}`);
            return yield* reported(capTurn(half, latest.run.id));
          }
          if (GameRunRoleReactor.isCutOff(latest.run)) {
            const attemptTurns = turns.filter((t) => t.turn.attempt === job.attempt);
            // Only turns that ran count: a continuation a shutdown cancelled
            // before it started cost the role nothing.
            const cut = attemptTurns.filter(
              (t) => GameRunRoleReactor.isCutOff(t.run) && t.run.startedAt !== null,
            ).length;
            // Neither the build nor the role: the server kept restarting during the turn.
            if (cut >= CUT_OFF_LIMIT)
              return yield* toolFailed(
                `${role.role}'s turn`,
                `the server restarted during this turn ${cut} times`,
                { standing: true },
              );
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
            return yield* reported(capTurn(half, `continue:${n}`));
          }
          if ((yield* needed(roles.settle(threadId, latest.run))) !== "fresh") return;
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
          // A resume's new attempt makes a new copy; this attempt cannot.
          if (threadId === own)
            return yield* toolFailed(`${role.role}'s copy of its build`, "its copy is gone", {
              standing: true,
            });
          return yield* launchThread(own, threadId, yield* promptOf(run, role, root));
        }
        if (!(yield* startStep(threadId))) return;
        yield* limitInput(threadId, shell.worktreePath ?? root);
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

  const execute = (job: GameRunJobs.GameRunStepJob) =>
    Effect.flatMap(current(job), (found) => (found === null ? Effect.void : work(job, found)));

  const work = (
    job: GameRunJobs.GameRunStepJob,
    found: NonNullable<Effect.Success<ReturnType<typeof current>>>,
  ) =>
    Effect.gen(function* () {
      const { run, record } = found;
      // The run's own folder: a read that fails is no answer about the build.
      const root = yield* projects
        .resolve(run.threadId)
        .pipe(Effect.mapError((cause) => new GameRunJobBroke({ cause })));
      const log = (line: string) => logLine(root, line);
      const step = record.step;
      yield* log(describe(step));
      const engineId = runEngine(run);
      const measured = <E>(what: string, effect: Effect.Effect<GameRunStepResult | null, E>) =>
        measure(job, record, record.id, what, root, log, effect);
      const botHalf = (stepId: GameRunStepId, bot: BotStep) =>
        measure(
          job,
          record,
          stepId,
          "the bot run on one compared build",
          root,
          log,
          runBotFact(deps, { root, copies: copiesOf(run.id) }, bot),
        );
      switch (step.kind) {
        case "build":
          return yield* measured(
            `build ${step.op._tag}`,
            // The base build includes the engine's harness files as this run ships them.
            (step.op._tag === "capture" && step.op.name === "base"
              ? refreshHarnessFiles(root, engineId, run.lane, log).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, pathService),
                )
              : Effect.void
            ).pipe(
              Effect.andThen(
                buildStep(
                  { game, checkpoints, lock: folderLock(run, null) },
                  { root, runId: run.id, lane: run.lane },
                  step.op,
                ),
              ),
            ),
          );
        case "boot":
          return yield* measured(
            "boot check",
            bootStep(game, {
              creator: run.threadId,
              owner: gameRunOperationOwner(run.id),
              root,
              engine: engineId,
              log,
            }),
          );
        case "facts":
          return yield* measured(
            "facts",
            Effect.gen(function* () {
              // No key reads as the bot's own policy deciding, which is what the tester then gets.
              const jev = yield* settings.getSettings.pipe(
                Effect.map(({ gameJevApiKey }) => gameJevApiKey !== ""),
                Effect.orElseSucceed(() => false),
              );
              // Only the review's facts state code and bots; the tester's step reads the key alone.
              if (step.bots === undefined) return { kind: "facts", jev, code: "" } as const;
              const code = yield* reviewFacts(root, run, step.bots);
              return { kind: "facts", jev, code } as const;
            }),
          );
        case "checks": {
          const rung = run.ladder?.rungs.find((x) => x.id === step.rung);
          return yield* measured(
            "state checks",
            (rung === undefined ? Effect.succeed([]) : runStateChecks(game, root, rung)).pipe(
              Effect.map((results) => ({ kind: "checks", results }) as const),
            ),
          );
        }
        case "bot":
          return yield* botHalf(record.id, step);
        case "note":
          return yield* measured(
            "the run's notes",
            Effect.forEach(step.files, (file) =>
              writeRecord(NodePath.join(root, file.path), file.text),
            ).pipe(Effect.as({ kind: "note" } as const)),
          );
        case "role":
          return yield* measured(
            `${step.role}'s turn`,
            roleHalf(job, run, record, step, root, log).pipe(Effect.as(null)),
          );
        case "pair": {
          // Both halves at once, each in its own worktree, launched in play
          // order (ids follow the coin) so neither side systematically starts
          // first; one not measured never cancels the other, which goes on
          // while the first waits on its timer.
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
              return h.kind === "role"
                ? measure(
                    job,
                    record,
                    stepId,
                    `${h.role}'s turn`,
                    root,
                    log,
                    roleHalf(job, run, record, h, root, log).pipe(Effect.as(null)),
                  )
                : botHalf(stepId, h);
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
      // Unread, the cap could interrupt a turn early: the effect tries again.
      const waited = yield* game
        .exploreMemoryWait(threadId)
        .pipe(Effect.map((mark) => mark.waitedMs));
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
      // A memory wait's turn counts its own explore marks (the landing's
      // replay, the cap's wait), from before it is sent: a repeat after the
      // send leaves the marks the turn has made.
      if (
        job.turn === "memory" &&
        (yield* threads.getCommandReceipt(
          roleTurnCommandId(roleTurnMessageId(job.stepId, job.attempt, job.turn, job.n)),
        )) === null
      )
        yield* game.finishExploration(threadId);
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
          // A stop has cancelled this effect by now, so the outbox never runs it
          // again: the interrupt is tried again here.
          if ((yield* roles.locate(job.threadId, job.stepId, job.attempt)) === null)
            return yield* retrying(
              threads.interruptThread({
                projectId,
                commandId: CommandId.make(
                  `server:game-run-resend-late:${job.stepId}:attempt:${job.attempt}:${job.turn}:${job.n}`,
                ),
                threadId,
                reason: "The production run moved on before this turn was sent.",
              }),
            );
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
      const records = yield* inFlightOf(job.threadId);
      const run = records.gameRuns.at(-1);
      if (
        run === undefined ||
        run.id !== job.runId ||
        run.status !== "ended" ||
        run.endedAt !== job.endedAt ||
        run.finished === job.endedAt
      )
        return;
      // Read up front with the run: a read that breaks tries the finish again whole.
      const roleThreads = yield* runRoleThreads(run.threadId, run.id);
      // The ending is recorded however its work went: a run left unfinished
      // refuses every resume, steer and restore until a restart. Only an
      // interrupt (a shutdown) leaves it to recovery, which finishes it again.
      yield* finishWork(job, run, records, roleThreads).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("game run finish broke; the ending is recorded anyway", {
                runId: run.id,
                cause,
              }),
        ),
      );
      yield* recordEnd(
        "finish",
        run.id,
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
    roleThreads: ReadonlyArray<ThreadId>,
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
            retrying,
            // A role turn left running on an ended run is T3's to cancel at the next restart.
            Effect.catch((error) =>
              Effect.logWarning("an ended run's role turn could not be interrupted", {
                threadId: role.threadId,
                error,
              }),
            ),
          );
      }
      const root = yield* projects.resolve(run.threadId, { deleted: "allowed" });
      const log = (line: string) => logLine(root, line);
      yield* log(
        `run ended: ${run.ending ?? "unknown"}${run.lastFailure ? ` (${run.lastFailure})` : ""}`,
      );
      if (run.ending !== null && !NO_EXPORT.has(run.ending)) {
        // The exports are of the best build, and the folder's work (an ending
        // mid-round leaves it unfinished) is kept once per ending and put back,
        // so a resume goes on from it. One bound for every wait of the ending.
        const waitUntil = yield* freeBy;
        const exports = finishExports(
          root,
          run.threadId,
          game,
          log,
          gameRunOperationOwner(run.id),
          waitUntil,
          roleThreads,
        ).pipe(
          // Total, defects included: an export that breaks is not the swap
          // breaking, which would put the work back and export it instead.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : log(`finishExports: the exports broke: ${causeText(cause)}`),
          ),
        );
        const name = BuildName.ending(job.endedAt);
        // A run from before checkpoints holds no builds: its folder is exported as it is.
        const ended = gitEra(run)
          ? null
          : yield* withBuildInFolder(
              { game, checkpoints, lock: folderLock(run, waitUntil) },
              { root, runId: run.id, lane: run.lane },
              { sha: run.best, park: name },
              () => exports.pipe(Effect.as({ value: undefined, putBack: true })),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : log(
                      `finishExports: the folder's work could not be kept (${causeText(cause)}); exporting the folder as it is`,
                    ).pipe(Effect.as(null)),
              ),
            );
        if (ended?.kind === "refused")
          yield* log(
            `finishExports: the best build could not be restored (${ended.detail}); exporting the folder as it is`,
          );
        if (ended === null || ended.kind === "refused") yield* exports;
        if (ended !== null && ended.back !== null)
          yield* log(
            `the run's unfinished work could not be put back (${ended.back}); it is ${keptBuild(run.id, name, run.lane, "")}`,
          );
      }
      // Last, so every build the ending used is still there for a finish a
      // restart repeats; a repeat finds fewer refs and removes nothing more.
      yield* pruneBuilds(checkpoints, root, toState(run, records.gameRunRounds, held ?? null)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : log(`the run's spent builds could not be cleared: ${causeText(cause)}`),
        ),
      );
      // Only a run something can still resume keeps its roles' copies: one
      // whose chat or project was deleted never runs again. A read that fails
      // is no proof of either, so the copies stay for storage cleanup's bound.
      const chatLive = yield* threads.getThreadShell(run.threadId).pipe(
        Effect.map((shell) => shell !== null && shell.deletedAt === null),
        Effect.orElseSucceed(() => true),
      );
      const projectLive = yield* projectStore.getById(run.projectId).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => true),
      );
      yield* dropRunCopies(
        deps,
        { copies: copiesOf(run.id), log },
        roleThreads,
        RESUMABLE.has(run.ending ?? "") && chatLive && projectLive,
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
      const records = yield* inFlightOf(job.threadId);
      const run = records.gameRuns.at(-1);
      const pending = run?.restore;
      if (run === undefined || run.id !== job.runId || pending?.requestId !== job.requestId) return;
      if (pending.outcome !== null) return;
      const held =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      const state = toState(run, records.gameRunRounds, held);
      const record =
        pending.round === null ? undefined : state.rounds.find((r) => r.round === pending.round);
      const target: RestoreTarget | null =
        record !== undefined
          ? { kind: "round", record }
          : pending.build !== null
            ? { kind: "saved", name: pending.build }
            : null;
      // A restore that broke is still answered: the run would otherwise stay
      // "restoring" until a restart. An interrupt leaves it to recovery.
      const outcome: GameRunRestoreOutcome = yield* (
        target === null
          ? Effect.succeed<GameRunRestoreOutcome>({
              kind: "refused",
              reason: "round-not-found",
              message: `Round ${pending.round ?? "?"} is not recorded.`,
            })
          : Effect.flatMap(
              Effect.all([projects.resolve(run.threadId, { deleted: "allowed" }), freeBy]),
              ([root, waitUntil]) =>
                restoreBuild({
                  game,
                  checkpoints,
                  lock: folderLock(run, waitUntil),
                  root,
                  run,
                  state,
                  target,
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
                message: `The restore broke (${causeText(cause)}).`,
              }),
        ),
      );
      yield* recordEnd(
        "restore",
        run.id,
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
      const records = yield* inFlightOf(run.threadId);
      const held =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      yield* operations.runChanged(root, currentStep(toState(run, records.gameRunRounds, held)));
    });

  const handle: GameRunStepRunner["Service"]["handle"] = (event) =>
    (event.type === "game-run.created" || event.type === "game-run.updated"
      ? showLive(event.payload)
      : Effect.void
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("game run live line failed", { threadId: event.threadId, cause }),
      ),
    );

  /**
   * A step's job whose report could not be written, or that broke outside its
   * work, is tried again (every step is safe to repeat); one that never gets
   * through fails the step, each owed half of a pair, so the run ends
   * resumably instead of waiting for a restart.
   */
  const executeJob = (job: GameRunJobs.GameRunStepJob) =>
    retrying(execute(job)).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("game run step job failed", { stepId: job.stepId, error });
          const reason = `the step's work could not be reported after ${RETRIES + 1} tries (${causeText(Cause.fail(error))})`;
          // The last resort is retried too. One that never gets through is
          // logged, and recovery owes the step at startup: it wakes it again.
          yield* retrying(
            Effect.gen(function* () {
              const found = yield* current(job);
              if (found === null) return;
              const step = found.record.step;
              const owed =
                step.kind === "pair"
                  ? step.halves
                      .filter(
                        (h) =>
                          !step.results.some((r) => r.id === h.id) &&
                          !found.record.endedHalves.some((r) => r.seq === h.id),
                      )
                      .map((h) => gameRunStepId(job.runId, h.id))
                  : [found.record.id];
              // A tool of ours kept failing (the store the reports go to): a pause, never a result.
              for (const stepId of owed)
                yield* complete({ ...job, stepId }, stepId, {
                  kind: "ended",
                  ending: "tool-failed",
                  reason: reason.slice(0, 300),
                });
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("game run step could not be failed; recovery owes it", {
                stepId: job.stepId,
                cause,
              }),
            ),
          );
        }),
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
        // On the outbox's last try a cap that could not be checked is set
        // again a minute on, under a command id of its own, so no turn goes
        // uncapped; the interrupt it sends keeps the cap's id, so a budget cut
        // still reads as one.
        deadline: (job) =>
          lastTry(job, deadline(job), () =>
            Effect.flatMap(DateTime.now, (now) =>
              refusedOnly(
                engine.dispatch({
                  type: "game-run.step.schedule",
                  commandId: CommandId.make(
                    `server:game-run-cap:${job.stepId}:attempt:${job.attempt}:rearm:${job.effectId}`,
                  ),
                  threadId: job.threadId,
                  runId: job.runId,
                  stepId: job.stepId,
                  attempt: job.attempt,
                  at: DateTime.toEpochMillis(now) + 60_000,
                  timer: { kind: "cap" },
                }),
              ),
            ),
          ),
        // A turn that could not be sent again on the last try fails its step.
        resend: (job) =>
          lastTry(job, resend(job), (cause) =>
            complete(job, job.stepId, {
              kind: "ended",
              ending: "tool-failed",
              reason:
                `${job.turn === "memory" ? "a memory wait's" : "a retry's"} turn could not be sent (${causeText(cause)})`.slice(
                  0,
                  300,
                ),
            }),
          ),
        outputs: (job) =>
          outputs(job).pipe(
            Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })),
          ),
        releaseCopies: (job) =>
          releaseCopies(job).pipe(
            Effect.mapError((cause) => new GameRunJobs.GameRunEffectError({ cause })),
          ),
        // A finish or restore is safe to run again whole, so one whose reads
        // break is tried again; one that never gets through is logged, and
        // recovery owes it at startup (the run still says it is owed).
        restore: (job) =>
          retrying(restore(job)).pipe(
            Effect.catch((error) =>
              Effect.logWarning("game run restore failed; recovery owes it", {
                runId: job.runId,
                error,
              }),
            ),
          ),
        finish: (job) =>
          retrying(finish(job)).pipe(
            Effect.catch((error) =>
              Effect.logWarning("game run finish failed; recovery owes it", {
                runId: job.runId,
                error,
              }),
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
