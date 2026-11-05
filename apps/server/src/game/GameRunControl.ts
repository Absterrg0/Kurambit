// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A run's id carries its start time; status reads the run's evidence files in the game folder.
// What the game_run_* tools and the Game panel's run RPCs reach: thin over the
// production run's commands and its records (getGameRunRecords).
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  type GameCreateInput,
  type GameProjectResult,
  type GameRunChecksResult,
  type GameRunDecideInput,
  type GameRunDecideResult,
  GameRunId,
  type GameRunPickDetail,
  type GameRunProfile,
  type GameRunProfileResult,
  type GameRunRestoreResult,
  type GameRunRoundDetail,
  type GameRunStartInput,
  type GameRunStartResult,
  type GameRunStatusResult,
  type GameRunSteerResult,
  type GameRunStopResult,
  type GameRunSubmission,
  type GameRunSubmitResult,
  type GameRunThreadRef,
  type OrchestrationV2GameRunCommand,
  type ThreadId,
  GameOperationError,
} from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { toState } from "../orchestration-v2/gameRun/decide.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import * as GameService from "./GameService.ts";
import { runStateChecks } from "./run/checkRunner.ts";
import { presentable } from "./run/decisionEvidence.ts";
import { makeGit, restoredPaths } from "./run/git.ts";
import { roleAt, roleTurns } from "./run/GameRunRoleReactor.ts";
import * as Policy from "./run/policy.ts";
import { ladderRefs, pickRef, runProgress } from "./run/progress.ts";
import { readPickEvidence, readRoundEvidence, roundOutcome } from "./run/roundDetail.ts";
import { DECISION_LABEL, currentStep, decisionOf, selectionFor, steerWhen } from "./run/runView.ts";
import { ensureScaffold, logLine } from "./runSetup.ts";

export class GameRunError extends Schema.TaggedError<GameRunError>()("GameRunError", {
  operation: Schema.String,
  path: Schema.String,
  reason: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Game run ${this.operation} failed (${this.reason}).`;
  }
}

type Fails<A> = Effect.Effect<A, GameRunError>;
type FrameSheets = ReadonlyArray<{ readonly build: string; readonly path: string }>;

type Service = {
  readonly runStart: (input: GameRunStartInput) => Fails<GameRunStartResult>;
  /** A new game is a production run: create the project, then run the brief. */
  readonly createGame: (
    input: GameCreateInput,
  ) => Effect.Effect<typeof GameProjectResult.Type, GameOperationError>;
  readonly runStatus: (threadId: ThreadId) => Fails<GameRunStatusResult>;
  readonly runStop: (threadId: ThreadId) => Fails<GameRunStopResult>;
  /** The creator's answer to the decision the live run waits on; refused when it does not fit. */
  readonly runDecide: (input: GameRunDecideInput) => Fails<GameRunDecideResult>;
  readonly runProfile: (threadId: ThreadId, profile: GameRunProfile) => Fails<GameRunProfileResult>;
  /** A creator note for the run's next round; on a finished run it buys one round. */
  readonly runSteer: (threadId: ThreadId, text: string) => Fails<GameRunSteerResult>;
  /** Scores the open rung's state checks on the build in the game root now. */
  readonly runChecks: (threadId: ThreadId) => Fails<GameRunChecksResult>;
  /** One round's evidence; `videoFile` and `sheetFiles` are files the transport may sign. */
  readonly roundDetail: (
    threadId: ThreadId,
    round: number,
  ) => Fails<{
    detail: GameRunRoundDetail;
    videoFile: string | null;
    sheetFiles: FrameSheets;
  }>;
  readonly pickDetail: (
    threadId: ThreadId,
  ) => Fails<{ detail: GameRunPickDetail; sheetFiles: FrameSheets }>;
  /**
   * Makes a kept round's build the game's sources again with a new commit on
   * trunk, and the ended run's judged best. Refused while a run is live,
   * mid-round, off trunk or with uncommitted work.
   */
  readonly restoreRound: (threadId: ThreadId, round: number) => Fails<GameRunRestoreResult>;
  /** A run role's typed result; the refusal's reason comes back in-turn. */
  readonly runSubmit: (
    roleThreadId: ThreadId,
    submission: GameRunSubmission,
  ) => Fails<GameRunSubmitResult>;
};

export class GameRunControl extends Context.Service<GameRunControl, Service>()(
  "kurambit/game/GameRunControl",
) {}

const RESUMABLE: ReadonlySet<string> = new Set([
  "budget",
  "usage-limit",
  "provider-down",
  "low-memory",
  "stopped",
  "failed",
]);

const runError = (operation: string, path: string, reason: string, detail: string) =>
  new GameRunError({ operation, path, reason, detail });

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* GameProjectService.GameProjectService;
  const game = yield* GameService.GameService;
  // Games whose tree a restore is moving; a run cannot start or resume under one.
  const restoring = new Set<string>();

  const resolveGame = Effect.fn("GameRunControl.resolveGame")(function* (threadId: ThreadId) {
    const root = yield* projects
      .resolve(threadId)
      .pipe(
        Effect.mapError((cause) =>
          runError("resolve-game", threadId, "project-not-found", cause.message),
        ),
      );
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null)
      return yield* runError("resolve-game", threadId, "project-not-found", "The thread is gone.");
    return { root, projectId: shell.projectId };
  });

  const recordsOf = (threadId: ThreadId) =>
    projections
      .getGameRunRecords(threadId)
      .pipe(
        Effect.mapError((cause) =>
          runError("run-read", threadId, "records-unreadable", String(cause.message)),
        ),
      );

  /** The thread's latest run as the policy sees it, with its step in flight. */
  const latestOf = (threadId: ThreadId) =>
    Effect.map(recordsOf(threadId), (records) => {
      const run = records.gameRuns.at(-1) ?? null;
      const inFlight =
        run === null
          ? null
          : (records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ??
            null);
      return {
        records,
        run,
        inFlight,
        state:
          run === null
            ? null
            : toState(run, records.gameRunRounds, inFlight, threadRefs(records, run.id)),
      };
    });

  const dispatch = (operation: string, command: OrchestrationV2GameRunCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause._tag === "OrchestratorGameRunRefusedError"
          ? runError(operation, command.threadId, cause.reason, cause.detail)
          : runError(operation, command.threadId, "command-failed", cause.message),
      ),
    );
  const commandId = () => CommandId.make(`server:game-run:${NodeCrypto.randomUUID()}`);

  const runStart: Service["runStart"] = Effect.fn("GameRunControl.runStart")(function* (
    input: GameRunStartInput,
  ) {
    const { root } = yield* resolveGame(input.threadId);
    if (restoring.has(root))
      return yield* runError(
        "run-start",
        root,
        "restoring",
        "A round is being restored for this game. Start the run once it finishes.",
      );
    const { run } = yield* latestOf(input.threadId);
    if (run !== null && run.status !== "ended")
      return {
        runId: run.id,
        root,
        stage: run.stage,
        resumed: true,
        message: `The run is already going (${run.stage}); watch it on the Run tab.`,
      } satisfies GameRunStartResult;
    const manifest = yield* projects.read(root).pipe(Effect.option);
    const lane = Option.isSome(manifest) ? manifest.value.godotProject : "godot";
    const projection = yield* threads
      .getThreadProjection(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          runError("run-start", input.threadId, "thread-read", cause.message),
        ),
      );
    const current =
      ThreadManagement.latestRun(projection)?.modelSelection ?? projection.thread.modelSelection;
    const chosen = {
      provider: input.provider ?? null,
      model: input.model ?? null,
      variant: input.variant ?? null,
    };
    const overridden = input.provider !== undefined || input.model !== undefined;
    const budgetMinutes =
      input.budgetMinutes === undefined ? undefined : Math.max(1, Math.round(input.budgetMinutes));
    const git = makeGit(root, lane, (line) => logLine(root, line));
    if (run !== null && run.ending !== null && RESUMABLE.has(run.ending)) {
      yield* ensureScaffold(root, lane, git.untrack, false);
      yield* dispatch("run-start", {
        type: "game-run.resume",
        commandId: commandId(),
        threadId: input.threadId,
        runId: run.id,
        ...(budgetMinutes === undefined ? {} : { budgetMinutes }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(overridden ? { modelSelection: selectionFor(current, chosen) } : {}),
      });
      yield* logLine(root, `resuming run ${run.id} from stage ${run.stage}`);
      return {
        runId: run.id,
        root,
        stage: run.stage,
        resumed: true,
        message: `The run resumed where it left off (${run.stage}).`,
      } satisfies GameRunStartResult;
    }
    // A game an earlier Kurambit ran keeps its files and git history, but its
    // run record is not this run's. The one fact taken from it is that the game
    // was built already: the new run continues from the game as it is.
    const earlier =
      run === null &&
      (yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(root, ".studio", "run.json")).then(
          () => true,
          () => false,
        ),
      ));
    const brief = input.brief.trim();
    if (brief.length === 0)
      return yield* runError(
        "run-start",
        root,
        "brief-required",
        earlier
          ? "This game's earlier run is from an older Kurambit and cannot be resumed: its state was not carried over. Start a new run with a brief: it continues from the game as it is now (a plan and ladder, then rounds), and the earlier history stays in git."
          : "A new run needs a brief.",
      );
    const runId = GameRunId.make(
      `run_${Date.now().toString(36)}${NodeCrypto.randomBytes(3).toString("hex")}`,
    );
    yield* ensureScaffold(root, lane, git.untrack, true);
    yield* dispatch("run-start", {
      type: "game-run.start",
      commandId: commandId(),
      threadId: input.threadId,
      runId,
      lane,
      brief,
      ...(input.artDirection === undefined ? {} : { artDirection: input.artDirection }),
      ...(budgetMinutes === undefined ? {} : { budgetMinutes }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      modelSelection: selectionFor(current, chosen),
      runtimeMode: projection.thread.runtimeMode,
      ...(earlier ? { stage: "build" as const } : {}),
    });
    const started = (yield* latestOf(input.threadId)).run;
    yield* logLine(
      root,
      run === null
        ? `starting run ${runId}`
        : `run ${run.id} ended ${run.ending}; starting ${runId} from stage ${started?.stage ?? run.stage}`,
    );
    return {
      runId,
      root,
      stage: started?.stage ?? "starting",
      resumed: false,
      message: earlier
        ? "A new run started from the brief and continues from the game as it is now: no new vision or prototypes; the plan writes a ladder for this game, then rounds build it. This game's earlier run is from an older Kurambit: its rounds, ladder and decisions were not carried over, and its history stays in git."
        : "The run started; watch it on the Run tab.",
    } satisfies GameRunStartResult;
  });

  // The role threads each step ran on, for the Run tab.
  const threadRefs = (
    records: ProjectionStore.GameRunThreadRecords,
    runId: string,
  ): GameRunThreadRef[] => {
    const seen = new Set<string>();
    return records.gameRunSteps.flatMap((step) =>
      step.runId !== runId
        ? []
        : step.roles.flatMap((entry) => {
            if (entry.threadId === null || seen.has(entry.threadId)) return [];
            seen.add(entry.threadId);
            return [
              {
                role: roleAt(step.step, entry.seq)?.role ?? step.kind,
                threadId: entry.threadId,
                startedAt: step.startedAt ?? step.plannedAt,
              },
            ];
          }),
    );
  };

  const runStatus: Service["runStatus"] = Effect.fn("GameRunControl.runStatus")(function* (
    threadId: ThreadId,
  ) {
    const { root } = yield* resolveGame(threadId);
    const { run, state, records } = yield* latestOf(threadId);
    if (run === null || state === null)
      return {
        active: false,
        runId: null,
        profile: null,
        decision: null,
        stage: "none",
        step: null,
        ending: null,
        startedAt: null,
        progress: null,
        pick: null,
        ladder: [],
        rounds: [],
        steer: [],
        threads: [],
        message: "No run recorded for this game.",
      } satisfies GameRunStatusResult;
    const running = run.status !== "ended";
    const shown = running ? decisionOf(root, state) : null;
    const asked = state.inFlight?.kind === "decide" ? state.inFlight.decision : null;
    // Evidence the run named that is not on disk is left out; a style call adds the key art.
    const decision =
      shown === null || asked === null
        ? null
        : {
            ...shown,
            evidence: (yield* Effect.promise(() => presentable(root, run.lane, asked))).map(
              (e) => ({
                label: e.label,
                path: NodePath.join(root, e.path),
              }),
            ),
          };
    const failure = run.lastFailure.length > 0 ? ` Last failure: ${run.lastFailure}` : "";
    const step = running ? currentStep(state) : null;
    return {
      active: running,
      runId: run.id,
      profile: run.profile,
      decision,
      stage: run.stage,
      step,
      ending: run.ending,
      startedAt: run.startedAt,
      progress: runProgress(state),
      pick: pickRef(state),
      ladder: ladderRefs(state),
      rounds: state.rounds.map((r) => ({
        round: r.round,
        move: r.move,
        branch: r.branch,
        kept: r.kept,
        outcome: roundOutcome(r),
        verdicts: r.verdicts,
        linesChanged: r.linesChanged,
        testerNote: r.testerNote ?? null,
        durationMs: r.durationMs,
        note: r.note ?? null,
        steer: r.steer ?? [],
        rung:
          r.rung === undefined
            ? null
            : { is: r.rung.is, checks: r.rung.checks, outcome: r.rung.outcome, why: r.rung.why },
      })),
      steer: [...run.steer],
      threads: threadRefs(records, run.id),
      message: !running
        ? `The run ended: ${run.ending ?? "unknown"}.${failure}`
        : run.status === "waiting" && state.inFlight?.kind === "decide"
          ? `Waiting for the creator's answer on ${DECISION_LABEL[state.inFlight.decision.kind]}; answer in the game's chat.`
          : `${step ?? run.stage}, ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done.${failure}`,
    } satisfies GameRunStatusResult;
  });

  const runStop: Service["runStop"] = Effect.fn("GameRunControl.runStop")(function* (
    threadId: ThreadId,
  ) {
    yield* resolveGame(threadId);
    const { run } = yield* latestOf(threadId);
    if (run === null || run.status === "ended")
      return { stopped: false, message: "No live run for this game." } satisfies GameRunStopResult;
    yield* dispatch("run-stop", {
      type: "game-run.stop",
      commandId: commandId(),
      threadId,
      runId: run.id,
      reason: "stopped by the creator",
    });
    return {
      stopped: true,
      message:
        "The run was stopped. Rejected work stays on its branch; game_run_start with an empty brief resumes it.",
    } satisfies GameRunStopResult;
  });

  const liveRun = (operation: string, threadId: ThreadId, none: string) =>
    Effect.flatMap(latestOf(threadId), ({ run }) =>
      run === null || run.status === "ended"
        ? Effect.fail(runError(operation, threadId, "no-live-run", none))
        : Effect.succeed(run),
    );

  const runDecide: Service["runDecide"] = Effect.fn("GameRunControl.runDecide")(function* (
    input: GameRunDecideInput,
  ) {
    const run = yield* liveRun(
      "run-decide",
      input.threadId,
      "No live run for this game, so it waits on no decision.",
    );
    yield* dispatch("run-decide", {
      type: "game-run.decide",
      commandId: commandId(),
      threadId: input.threadId,
      runId: run.id,
      decisionId: input.decisionId,
      answer: input.answer,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    }).pipe(
      Effect.mapError((error) =>
        error.reason === "no-decision"
          ? runError(
              "run-decide",
              input.threadId,
              "no-decision",
              "The run is not waiting for a decision now; it may have taken its default already. game_run_status shows where it stands. If the user was answering a question the run already decided, pass their words on with game_run_steer so they shape the next steps.",
            )
          : error,
      ),
    );
    return {
      message: `Recorded: ${input.answer.trim().toLowerCase()}. The run goes on with it; game_run_status shows its next step.`,
    } satisfies GameRunDecideResult;
  });

  const runProfile: Service["runProfile"] = Effect.fn("GameRunControl.runProfile")(function* (
    threadId: ThreadId,
    profile: GameRunProfile,
  ) {
    const run = yield* liveRun(
      "run-profile",
      threadId,
      "No live run for this game. Start or resume the run with the profile you want.",
    );
    yield* dispatch("run-profile", {
      type: "game-run.profile.set",
      commandId: commandId(),
      threadId,
      runId: run.id,
      profile,
    });
    return {
      profile,
      message:
        profile === "guided"
          ? "The run is Guided from its next decision point: it asks in the chat and takes its default when nobody answers."
          : "The run is on Autopilot: it decides everything itself from now on.",
    } satisfies GameRunProfileResult;
  });

  const runSteer: Service["runSteer"] = Effect.fn("GameRunControl.runSteer")(function* (
    threadId: ThreadId,
    text: string,
  ) {
    const { root } = yield* resolveGame(threadId);
    const note = text.trim().slice(0, 4000);
    if (note.length === 0)
      return yield* runError("run-steer", root, "empty-note", "The note is empty.");
    const { run } = yield* latestOf(threadId);
    if (run === null)
      return yield* runError(
        "run-steer",
        root,
        "no-live-run",
        "No run for this game yet. Work on the game directly, or start a run first.",
      );
    yield* dispatch("run-steer", {
      type: "game-run.steer",
      commandId: commandId(),
      threadId,
      runId: run.id,
      note,
    });
    const after = yield* latestOf(threadId);
    const pending = after.run?.steer.length ?? 0;
    if (run.status !== "ended")
      return {
        pending,
        message: `Noted for the production run. ${steerWhen(after.state)}`,
      } satisfies GameRunSteerResult;
    return {
      pending,
      message:
        after.run?.status !== "ended"
          ? "The run resumes to work on this note for one round, then stops. Ask again for more."
          : `Noted. The run ended (${run.ending ?? "unknown"}) and reads it when it resumes with game_run_start.`,
    } satisfies GameRunSteerResult;
  });

  const runChecks: Service["runChecks"] = Effect.fn("GameRunControl.runChecks")(function* (
    threadId: ThreadId,
  ) {
    const { root } = yield* resolveGame(threadId);
    const { state } = yield* latestOf(threadId);
    const ladder = state?.ladder ?? null;
    // The rung the round in progress builds, else the next open one.
    const building =
      state?.task._tag === "round" && state.task.rung !== null ? state.task.rung : null;
    const rung =
      ladder?.rungs.find((x) => x.id === building) ??
      ladder?.rungs.find((x) => x.status === "todo") ??
      null;
    if (ladder === null || rung === null)
      return {
        rung: null,
        is: "",
        results: [],
        message: "The run has no open rung to score.",
      } satisfies GameRunChecksResult;
    const outcomes = yield* runStateChecks(game, root, rung);
    const passed = outcomes.filter((o) => o.pass).length;
    return {
      rung: ladder.rungs.indexOf(rung) + 1,
      is: rung.is,
      results: outcomes.map((o) => ({
        check: o.k + 1,
        what: o.what,
        pass: o.pass,
        evidence: o.evidence,
        frame: o.frame,
      })),
      message:
        outcomes.length === 0
          ? "This rung has no state checks; its checks are look checks a tester judges."
          : `${passed} of ${outcomes.length} state checks pass on the build in the game folder now.`,
    } satisfies GameRunChecksResult;
  });

  const findRound = Effect.fn("GameRunControl.findRound")(function* (
    operation: string,
    threadId: ThreadId,
    round: number,
  ) {
    const target = yield* resolveGame(threadId);
    const { run, state } = yield* latestOf(threadId);
    if (run === null || state === null)
      return yield* runError(operation, target.root, "no-run", "No run recorded for this game.");
    const record = state.rounds.find((r) => r.round === round);
    if (record === undefined)
      return yield* runError(
        operation,
        target.root,
        "round-not-found",
        `Round ${round} is not recorded; the run has ${state.rounds.length} finished round${state.rounds.length === 1 ? "" : "s"}.`,
      );
    const trunk = run.trunk.length > 0 ? run.trunk : "main";
    return { ...target, run, state, record, lane: run.lane || "godot", trunk };
  });

  const roundDetail: Service["roundDetail"] = Effect.fn("GameRunControl.roundDetail")(function* (
    threadId: ThreadId,
    round: number,
  ) {
    const found = yield* findRound("run-round", threadId, round);
    const evidence = yield* Effect.promise(() =>
      readRoundEvidence(found.root, found.state, found.record),
    );
    const git = makeGit(found.root, found.lane, () => Effect.void);
    const sha = found.record.kept ? yield* git.keptCommit(found.record.branch, found.trunk) : null;
    const now = sha === null ? false : yield* git.sameBuild(sha);
    return {
      detail: {
        ...evidence.detail,
        restorable: sha !== null,
        current: now,
      } satisfies GameRunRoundDetail,
      videoFile: evidence.videoFile,
      sheetFiles: evidence.sheetFiles,
    };
  });

  const pickDetail: Service["pickDetail"] = Effect.fn("GameRunControl.pickDetail")(function* (
    threadId: ThreadId,
  ) {
    const { root } = yield* resolveGame(threadId);
    const { state } = yield* latestOf(threadId);
    if (state === null)
      return yield* runError("run-pick", root, "no-run", "No run recorded for this game.");
    const evidence: {
      detail: GameRunPickDetail;
      sheetFiles: ReadonlyArray<{ readonly build: string; readonly path: string }>;
    } = yield* Effect.promise(() => readPickEvidence(root, state));
    return evidence;
  });

  // A kept round's restore; the restored build becomes
  // the run's judged best, so a resumed run compares its next round with it.
  const restoreRound: Service["restoreRound"] = (threadId, round) =>
    Effect.flatMap(resolveGame(threadId), ({ root }) =>
      // Checked and claimed with no yield between, like a run's start.
      restoring.has(root)
        ? Effect.fail(
            runError(
              "run-restore",
              root,
              "restoring",
              "A round is being restored for this game already.",
            ),
          )
        : Effect.suspend(() => {
            restoring.add(root);
            return restoreClaimed(threadId, round).pipe(
              Effect.ensuring(Effect.sync(() => restoring.delete(root))),
            );
          }),
    );
  const restoreClaimed = Effect.fn("GameRunControl.restoreRound")(
    function* (threadId: ThreadId, round: number) {
      const found = yield* findRound("run-restore", threadId, round);
      const { root, run, state, record, trunk, lane } = found;
      const no = (reason: string, detail: string) => runError("run-restore", root, reason, detail);
      if (run.status !== "ended")
        return yield* no(
          "run-live",
          "A production run is live for this game. Stop it before restoring a round.",
        );
      if (!record.kept)
        return yield* no(
          "not-kept",
          `Round ${round} was not kept (${roundOutcome(record)}); only a kept round's build can be restored. Its work stays on branch ${record.branch}.`,
        );
      const resumable = run.ending !== null && RESUMABLE.has(run.ending);
      if (state.inFlight?.kind === "git" && resumable)
        return yield* no(
          "mid-step",
          "The stopped run saved an unfinished git step and would replay it on resume. Resume the run and let that step finish, then restore.",
        );
      const log = (line: string) => logLine(root, line);
      const git = makeGit(root, lane, log);
      const on = yield* git.current;
      if (on !== trunk)
        return yield* no(
          "off-trunk",
          `The game is on ${on === "HEAD" || on === "" ? "a detached commit" : `branch ${on}`}, not ${trunk}. Resume the run to let it return to ${trunk}, or switch back yourself, then restore.`,
        );
      const expected = Policy.expectedBranch(state);
      if (expected !== null && expected !== trunk && resumable)
        return yield* no(
          "mid-round",
          `The stopped run is in the middle of its work on ${expected}. Resume it and let the round finish, then restore.`,
        );
      const dirty = yield* git.uncommitted;
      if (dirty.length > 0)
        return yield* no(
          "uncommitted-work",
          `The game has uncommitted changes, so nothing was restored: ${git.summary(dirty.join("\n"))}. Commit or discard them first.`,
        );
      const sha = yield* git.keptCommit(record.branch, trunk);
      if (sha === null)
        return yield* no(
          "commit-missing",
          `Round ${round}'s commit (branch ${record.branch}) is no longer on ${trunk}.`,
        );
      const what = restoredPaths(lane).join(", ");
      if (yield* git.sameBuild(sha))
        return {
          sha,
          message: `Round ${round}'s build (${what}) is already the game's current build.`,
        } satisfies GameRunRestoreResult;
      // Closed first, so no live editor saves its in-memory scene over the restored files.
      yield* game.closeLiveEditors(root);
      const restored = yield* git.restoreBuild(sha, `restore round ${round} (creator)`);
      if (!(yield* git.sameBuild(sha)))
        return yield* no(
          "restore-incomplete",
          `Restoring round ${round} did not reproduce its build; see .studio/run.log and the game's git status.`,
        );
      yield* dispatch("run-restore", {
        type: "game-run.restore",
        commandId: commandId(),
        threadId,
        runId: run.id,
        best: restored,
      });
      yield* log(
        `creator restored round ${round} (${sha.slice(0, 8)}) as ${restored.slice(0, 8)} on ${trunk}: ${what}`,
      );
      return {
        sha: restored,
        message: `Round ${round}'s ${what} are back as commit ${restored.slice(0, 8)} on ${trunk}; notes, PLAN.md, VISION.md, bots and run records were left as they are. Later commits stay in git history, and restoring a later kept round goes forward again.`,
      } satisfies GameRunRestoreResult;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchTags({
          RunGitError: (cause) =>
            Effect.fail(
              runError(
                "run-restore",
                threadId,
                cause.op === "restore-apply" ? "local-changes" : "git-failed",
                cause.op === "restore-apply"
                  ? `Nothing was restored: git refused to apply it (${cause.reason}). Usually a change made meanwhile touches a restored file, or another git command is running; commit or discard the change, then restore again.`
                  : `${cause.message} See .studio/run.log and the game's git status.`,
              ),
            ),
        }),
      ),
  );

  const createGame: Service["createGame"] = Effect.fn("GameRunControl.createGame")(function* (
    input: GameCreateInput,
  ) {
    const created: typeof GameProjectResult.Type = yield* projects.create(input);
    // The game exists either way; a run that cannot start shows as not
    // started in the Run tab, where the creator can start it again.
    yield* runStart({
      threadId: created.threadId,
      brief: input.brief,
      ...(input.artDirection === undefined ? {} : { artDirection: input.artDirection }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("game run did not start after create", { reason: cause.message }),
      ),
    );
    return created;
  });

  const runSubmit: Service["runSubmit"] = Effect.fn("GameRunControl.runSubmit")(function* (
    roleThreadId: ThreadId,
    submission: GameRunSubmission,
  ) {
    const not = (detail: string) => runError("run-submit", roleThreadId, "not-a-role", detail);
    const { thread, runs } = yield* threads
      .getThreadRecords(roleThreadId, ["runs"])
      .pipe(Effect.mapError((cause) => not(`This thread could not be read: ${cause.message}`)));
    const creator = thread.lineage.parentThreadId;
    if (thread.launchedBy !== "game_run" || creator === null)
      return yield* not("This thread is not a role of a production run.");
    // The turn this submission belongs to names its step.
    const turn = roleTurns(runs).at(-1)?.turn;
    if (turn === undefined)
      return yield* not("This thread has no turn of a production run's step.");
    yield* dispatch("run-submit", {
      type: "game-run.submit",
      commandId: commandId(),
      threadId: creator,
      runId: turn.runId,
      stepId: turn.stepId,
      roleThreadId,
      submission,
    });
    return {
      message:
        "Submitted. The run takes it when your turn ends; finish now unless the prompt asks for more.",
    } satisfies GameRunSubmitResult;
  });

  return GameRunControl.of({
    runStart,
    createGame,
    runStatus,
    runStop,
    runDecide,
    runProfile,
    runSteer,
    runChecks,
    roundDetail,
    pickDetail,
    restoreRound,
    runSubmit,
  });
});

export const layer = Layer.effect(GameRunControl, make);

/** The submission tool's failure, in the toolkit's error shape. */
export const submitFailure = (cause: GameRunError) =>
  new GameOperationError({
    operation: "game-run-submit",
    path: cause.path,
    reason: "invalid-input",
    detail: cause.message,
    cause,
  });
