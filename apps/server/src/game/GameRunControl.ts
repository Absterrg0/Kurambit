// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off -- A run's id carries its start time; status reads the run's evidence files in the game folder.
// What the game_run_* tools and the Game panel's run RPCs reach: thin over the
// production run's commands and its records (getGameRunRecords).
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CheckpointRef,
  CommandId,
  type GameCreateInput,
  type GameProjectResult,
  type GameRunChecksResult,
  type GameRun,
  type GameRunDecideInput,
  type GameRunDecideResult,
  GameRunId,
  type GameRunPickDetail,
  type GameRunProfile,
  type GameRunProfileResult,
  type GameRunRestoreInput,
  type GameRunRestoreResult,
  type GameRunSavedBuild,
  type GameRunRoundDetail,
  type GameRunStartInput,
  type GameRunStartResult,
  type GameRunStatusResult,
  type GameRunSteerResult,
  type GameRunStopResult,
  type GameRunSubmission,
  type GameRunSubmitResult,
  type OrchestrationV2GameRunCommand,
  ThreadId,
  GameOperationError,
  GameRunErrorReason,
} from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { gameRunRefsFolder } from "../checkpointing/Utils.ts";
import { gitEra, RESUMABLE, settling, toState } from "../orchestration-v2/gameRun/decide.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { BuildName } from "./run/buildNames.ts";
import { withRoleGroups } from "./run/roleGroup.ts";
import * as GameService from "./GameService.ts";
import { runStateChecks } from "./run/checkRunner.ts";
import { presentable } from "./run/decisionEvidence.ts";
import { roleTurns } from "./run/GameRunRoleReactor.ts";
import { ladderRefs, pickRef, runProgress } from "./run/progress.ts";
import {
  readPickEvidence,
  readRoundEvidence,
  roundBotThreads,
  roundOutcome,
} from "./run/roundDetail.ts";
import {
  DECISION_LABEL,
  currentStep,
  decisionOf,
  lowerFirst,
  restoreLabel,
  savedBuildLabel,
  selectionFor,
  steerWhen,
} from "./run/runView.ts";
import type { RunState } from "./run/state.ts";
import { ensureScaffold, logLine } from "./runSetup.ts";

export class GameRunError extends Schema.TaggedError<GameRunError>()("GameRunError", {
  operation: Schema.String,
  path: Schema.String,
  reason: GameRunErrorReason,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Game run ${this.operation} failed (${this.reason}).`;
  }

  /** The one way a run failure reaches agents and the UI: the game error, with the run's reason. */
  static toOperationError(operation: string, cause: GameRunError): GameOperationError {
    return new GameOperationError({
      operation,
      path: cause.path,
      reason:
        cause.reason === "brief-required" || cause.reason === "empty-note"
          ? "invalid-input"
          : "command-failed",
      detail: cause.message,
      runReason: cause.reason,
      cause,
    });
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
  readonly runStop: (threadId: ThreadId, commandId?: string) => Fails<GameRunStopResult>;
  /** The creator's answer to the decision the live run waits on; refused when it does not fit. */
  readonly runDecide: (input: GameRunDecideInput) => Fails<GameRunDecideResult>;
  readonly runProfile: (
    threadId: ThreadId,
    profile: GameRunProfile,
    commandId?: string,
  ) => Fails<GameRunProfileResult>;
  /** A creator note for the run's next round; on a finished run it buys one round. */
  readonly runSteer: (
    threadId: ThreadId,
    text: string,
    commandId?: string,
  ) => Fails<GameRunSteerResult>;
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
   * Puts a build back in the game folder, keeping what the folder held first:
   * a kept round's, which becomes the stopped run's judged best, or a saved
   * one by its name, which leaves the best as it is. Refused while a run is
   * live; a stopped run's round in progress is abandoned.
   */
  readonly runRestore: (
    input: GameRunRestoreInput,
    /** How long to wait for the outcome; without it the call returns once the request is recorded. */
    options?: { readonly waitFor?: Duration.Input },
  ) => Fails<GameRunRestoreResult>;
  /** A run role's typed result; the refusal's reason comes back in-turn. */
  readonly runSubmit: (
    roleThreadId: ThreadId,
    submission: GameRunSubmission,
  ) => Fails<GameRunSubmitResult>;
};

export class GameRunControl extends Context.Service<GameRunControl, Service>()(
  "kurambit/game/GameRunControl",
) {}

const runError = (operation: string, path: string, reason: GameRunErrorReason, detail: string) =>
  new GameRunError({ operation, path, reason, detail });

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* GameProjectService.GameProjectService;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const game = yield* GameService.GameService;

  /**
   * The caller's game: its folder, and the thread its run lives on. The folder
   * is the project's, so every chat of the game reaches the same run; a thread
   * the run launched for a role reaches none of the run's controls.
   */
  const resolveGame = Effect.fn("GameRunControl.resolveGame")(function* (
    threadId: ThreadId,
    options: { readonly role?: "allowed" } = {},
  ) {
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
    if (options.role !== "allowed") {
      // Fails closed: a thread whose record cannot be read reaches no run control.
      const launched = yield* threads.getThreadRecords(threadId, []).pipe(
        Effect.map(({ thread }) => thread.launchedBy === "game_run"),
        Effect.mapError((cause) =>
          runError("resolve-game", threadId, "thread-read", String(cause.message)),
        ),
      );
      if (launched)
        return yield* runError(
          "resolve-game",
          threadId,
          "role-thread",
          "This thread is one of the production run's roles; the run's controls belong to the game's chat.",
        );
    }
    const projectRun = yield* projections
      .getProjectGameRun(shell.projectId)
      .pipe(Effect.orElseSucceed(() => null));
    return { root, projectId: shell.projectId, runThread: projectRun?.threadId ?? threadId };
  });

  // A resume keeps the folder before the run next moves it (decide.ts resumeSave).
  const SAVES_FOLDER =
    ' Before it next moves the game folder, it saves the folder as it is then under Saved builds ("The game as it was when the run resumed"), so changes made while the run was stopped are kept.';

  // The game's latest run as the policy sees it, with its step in flight and its
  // role threads: narrow reads, since every run push rereads the status.
  const recordsOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const run = records.gameRuns.at(-1) ?? null;
      if (run === null) return { run, inFlight: null, state: null, threads: [] };
      const inFlight =
        records.gameRunSteps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null;
      const threads = threadRefs(yield* projections.listGameRunRoleThreads(threadId, run.id));
      return {
        run,
        inFlight,
        state: toState(run, records.gameRunRounds, inFlight, threads),
        threads,
      };
    }).pipe(
      Effect.mapError((cause) =>
        runError("run-read", threadId, "records-unreadable", String(cause.message)),
      ),
    );
  const latestOf = (callerThreadId: ThreadId) =>
    Effect.flatMap(resolveGame(callerThreadId), ({ runThread }) => recordsOf(runThread));

  const dispatch = (operation: string, command: OrchestrationV2GameRunCommand) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause._tag === "OrchestratorGameRunRefusedError"
          ? runError(operation, command.threadId, cause.reason, cause.detail)
          : runError(operation, command.threadId, "command-failed", cause.message),
      ),
    );
  // A caller's own id makes its retry the same command; the orchestrator's
  // receipt answers it without applying it again. Receipts are global, so the
  // id is scoped to the run it acts on: the same id from another game or a
  // later run is a command of its own, never an earlier receipt's answer.
  const commandId = (
    kind?: string,
    given?: string,
    scope?: { readonly thread: ThreadId; readonly run: GameRun | null },
  ) =>
    CommandId.make(
      given === undefined || kind === undefined || scope === undefined
        ? `server:game-run:${NodeCrypto.randomUUID()}`
        : `client:${kind}:${scope.thread}:${scope.run?.id ?? "new"}:${given}`,
    );

  const runStart: Service["runStart"] = Effect.fn("GameRunControl.runStart")(function* (
    input: GameRunStartInput,
  ) {
    const { root, runThread } = yield* resolveGame(input.threadId);
    const { run } = yield* latestOf(input.threadId);
    if (run !== null && run.status !== "ended")
      return {
        runId: run.id,
        root,
        stage: run.stage,
        resumed: true,
        message: `The run is already going (${run.stage}); watch it on the Run tab.`,
      } satisfies GameRunStartResult;
    // An ending still exporting or a restore still moving the folder owns it:
    // refuse before the scaffold below writes there, not after, at the decider.
    const busy = run === null ? null : settling(run);
    if (busy !== null && Result.isFailure(busy))
      return yield* runError(
        "run-start",
        input.threadId,
        busy.failure.reason,
        busy.failure.message,
      );
    // The lane is the whole run's engine: a manifest that cannot be read is no Godot game.
    const lane = (yield* projects
      .read(root)
      .pipe(
        Effect.mapError((cause) =>
          runError(
            "run-start",
            input.threadId,
            "project-not-found",
            `The game's manifest could not be read (${cause.detail ?? cause.reason}).`,
          ),
        ),
      )).godotProject;
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
    if (run !== null && run.ending !== null && RESUMABLE.has(run.ending) && !gitEra(run)) {
      yield* ensureScaffold(root, lane, false);
      yield* dispatch("run-start", {
        type: "game-run.resume",
        commandId: commandId("game-run.start", input.commandId, { thread: run.threadId, run }),
        threadId: run.threadId,
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
        message: `The run resumed where it left off (${run.stage}).${SAVES_FOLDER}`,
      } satisfies GameRunStartResult;
    }
    // A game an earlier Kurambit ran keeps its files and git history, but its
    // run record is not this run's. The one fact taken from it is that the game
    // was built already: the new run continues from the game as it is.
    // So does a run that kept its builds on git branches.
    const earlier =
      (run !== null && gitEra(run)) ||
      (run === null &&
        (yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(root, ".studio", "run.json")).then(
            () => true,
            () => false,
          ),
        )));
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
    yield* ensureScaffold(root, lane, true);
    yield* dispatch("run-start", {
      type: "game-run.start",
      commandId: commandId("game-run.start", input.commandId, { thread: runThread, run }),
      threadId: runThread,
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

  // The role threads each step ran on, each once, for the Run tab.
  const threadRefs = (roles: ReadonlyArray<ProjectionStore.GameRunRoleThread>) =>
    withRoleGroups(
      roles.filter((entry, i) => roles.findIndex((r) => r.threadId === entry.threadId) === i),
    );

  /**
   * An ended run's saved builds, latest first, read from its refs: what a
   * restore by name may bring back. A live run has none to offer, and a run
   * from before checkpoints keeps no refs.
   */
  const savedBuilds = (
    root: string,
    run: GameRun,
    state: RunState,
  ): Effect.Effect<ReadonlyArray<GameRunSavedBuild>> => {
    if (run.status !== "ended") return Effect.succeed([]);
    const folder = gameRunRefsFolder(run.id);
    return checkpoints.listCheckpointRefs({ cwd: root, prefix: folder }).pipe(
      Effect.map((listed) => {
        const entries = listed.map((entry) => ({
          ...entry,
          name: entry.checkpointRef.slice(folder.length),
        }));
        // An earlier restore is named by what its folder after it held: a kept
        // round's build, or another saved build's.
        const known = new Map<string, string>();
        for (const r of state.rounds) if (r.kept && r.build) known.set(r.build, `round ${r.round}`);
        for (const entry of entries) {
          const label = savedBuildLabel(entry.name, state, run);
          if (label !== null && !known.has(entry.oid)) known.set(entry.oid, lowerFirst(label));
        }
        const restored = (requestId: string) => {
          const after = entries.find((e) => e.name === BuildName.restoreAfter(requestId));
          return after === undefined ? null : (known.get(after.oid) ?? null);
        };
        return entries
          .flatMap((entry) => {
            const label = savedBuildLabel(entry.name, state, run, restored);
            return label === null ? [] : [{ name: entry.name, label, seconds: entry.committedAt }];
          })
          .toSorted((a, b) => b.seconds - a.seconds)
          .map(({ name, label, seconds }) => ({
            name,
            label,
            at: new Date(seconds * 1000).toISOString(),
          }));
      }),
      Effect.catch((error) =>
        Effect.logWarning("A run's saved builds could not be listed.", {
          runId: run.id,
          error,
        }).pipe(Effect.as([])),
      ),
    );
  };

  const runStatus: Service["runStatus"] = Effect.fn("GameRunControl.runStatus")(function* (
    threadId: ThreadId,
  ) {
    const { root } = yield* resolveGame(threadId);
    const { run, state, threads } = yield* latestOf(threadId);
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
        builds: [],
        restore: null,
        message: "No run recorded for this game.",
        resumable: false,
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
      threads,
      builds: yield* savedBuilds(root, run, state),
      restore:
        run.restore === null
          ? null
          : {
              requestId: run.restore.requestId,
              round: run.restore.round,
              build: run.restore.build,
              label: restoreLabel(run.restore, state, run),
              requestedAt: run.restore.requestedAt,
              outcome:
                run.restore.outcome === null
                  ? null
                  : {
                      restored: run.restore.outcome.kind === "restored",
                      message: run.restore.outcome.message,
                    },
            },
      message: !running
        ? `The run ended: ${run.ending ?? "unknown"}.${failure}`
        : run.status === "waiting" && state.inFlight?.kind === "decide"
          ? `Waiting for the creator's answer on ${DECISION_LABEL[state.inFlight.decision.kind]}; answer in the game's chat.`
          : `${step ?? run.stage}, ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"} done.${failure}`,
      resumable: !running && run.ending !== null && RESUMABLE.has(run.ending),
    } satisfies GameRunStatusResult;
  });

  const runStop: Service["runStop"] = Effect.fn("GameRunControl.runStop")(function* (
    threadId: ThreadId,
    given?: string,
  ) {
    yield* resolveGame(threadId);
    const { run } = yield* latestOf(threadId);
    if (run === null || run.status === "ended")
      return { stopped: false, message: "No live run for this game." } satisfies GameRunStopResult;
    yield* dispatch("run-stop", {
      type: "game-run.stop",
      commandId: commandId("game-run.stop", given, { thread: run.threadId, run }),
      threadId: run.threadId,
      runId: run.id,
      reason: "stopped by the creator",
    });
    return {
      stopped: true,
      message: "The run was stopped; game_run_start with an empty brief resumes it.",
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
      commandId: commandId("game-run.decide", input.commandId, { thread: run.threadId, run }),
      threadId: run.threadId,
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
    given?: string,
  ) {
    const run = yield* liveRun(
      "run-profile",
      threadId,
      "No live run for this game. Start or resume the run with the profile you want.",
    );
    yield* dispatch("run-profile", {
      type: "game-run.profile.set",
      commandId: commandId("game-run.profile.set", given, { thread: run.threadId, run }),
      threadId: run.threadId,
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
    given?: string,
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
      commandId: commandId("game-run.steer", given, { thread: run.threadId, run }),
      threadId: run.threadId,
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
          ? `The run resumes to work on this note for one round, then stops. Ask again for more.${SAVES_FOLDER}`
          : `Noted. The run ended (${run.ending ?? "unknown"}) and reads it when it resumes with game_run_start.`,
    } satisfies GameRunSteerResult;
  });

  const runChecks: Service["runChecks"] = Effect.fn("GameRunControl.runChecks")(function* (
    threadId: ThreadId,
  ) {
    // The run's builder scores its rung in its own folder (its worktree, when it
    // has one), against the rung the run's records hold open.
    const { root, runThread } = yield* resolveGame(threadId, { role: "allowed" });
    const { state } = yield* recordsOf(runThread);
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
    // A check that cannot run now (memory short, the game held) is no score: the role is told to try again.
    const outcomes = yield* runStateChecks(game, root, rung).pipe(
      Effect.mapError((error) =>
        runError(
          "run-checks",
          root,
          "command-failed",
          `The checks could not run now (${error.reason}: ${(error.detail ?? "").slice(0, 200)}); try again in a minute.`,
        ),
      ),
    );
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
    return { ...target, run, state, record, lane: run.lane || "godot" };
  });

  const roundDetail: Service["roundDetail"] = Effect.fn("GameRunControl.roundDetail")(function* (
    threadId: ThreadId,
    round: number,
  ) {
    const found = yield* findRound("run-round", threadId, round);
    // A record that cannot be read leaves its runs off the round, and says so in the log.
    const records = yield* Effect.forEach(
      roundBotThreads(found.state, found.record.round),
      (roleThread) =>
        game.botRuns(ThreadId.make(roleThread)).pipe(
          Effect.map((bots) => (bots.root === found.root ? bots.runs : [])),
          Effect.catch((error) =>
            Effect.logWarning("A round's bot runs could not be read.", {
              threadId: roleThread,
              error,
            }).pipe(Effect.as([])),
          ),
        ),
    );
    const evidence = yield* Effect.promise(() =>
      readRoundEvidence(found.root, found.state, found.record, records.flat()),
    );
    // A kept round's build, while it still exists; it is the current one when it is the best.
    const build = found.record.kept ? (found.record.build ?? null) : null;
    const restorable =
      build !== null &&
      (yield* checkpoints
        .hasCheckpointRef({ cwd: found.root, checkpointRef: CheckpointRef.make(build) })
        .pipe(Effect.orElseSucceed(() => false)));
    return {
      detail: {
        ...evidence.detail,
        restorable,
        current: restorable && build === found.run.best,
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

  // A restore, command first: the run records the request and holds every
  // start, resume and steer until its job lands the outcome, so the folder is
  // never moved under a run. The call returns once the request is recorded; the
  // outcome reaches the Run tab through the run's push and its status. A caller's
  // commandId names the request too, so its retry is the same restore.
  const runRestore: Service["runRestore"] = Effect.fn("GameRunControl.runRestore")(function* (
    input: GameRunRestoreInput,
    options: { readonly waitFor?: Duration.Input } = {},
  ) {
    const { threadId, round, build } = input;
    const { root } = yield* resolveGame(threadId);
    const { run, state } = yield* latestOf(threadId);
    if (run === null || state === null)
      return yield* runError("run-restore", root, "no-run", "No run recorded for this game.");
    if ((round === undefined) === (build === undefined))
      return yield* runError(
        "run-restore",
        root,
        "wrong-kind",
        "Name one build: a kept round by `round`, or a saved build by `build`.",
      );
    if (round !== undefined) {
      const { record } = yield* findRound("run-restore", threadId, round);
      if (!record.kept)
        return yield* runError(
          "run-restore",
          root,
          "not-kept",
          `Round ${round} was not kept (${roundOutcome(record)}); only a kept round's build can be restored. A round's build that was not kept may still be among the saved builds game_run_status lists.`,
        );
    } else if (!(yield* savedBuilds(root, run, state)).some((b) => b.name === build))
      return yield* runError(
        "run-restore",
        root,
        "commit-missing",
        `${build} is not one of the run's saved builds${run.status === "ended" ? "" : " (a live run offers none: stop it first)"}; game_run_status lists them.`,
      );
    const id = commandId("game-run.restore.request", input.commandId, {
      thread: run.threadId,
      run,
    });
    const requestId =
      input.commandId === undefined
        ? NodeCrypto.randomUUID()
        : NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
    const unreadable = (cause: { readonly message: string }) =>
      runError("run-restore", root, "records-unreadable", cause.message);
    // Taken before the request, so an outcome the caller waits for cannot land unseen.
    const after = yield* engine
      .getThreadEventSequence(run.threadId)
      .pipe(Effect.mapError(unreadable));
    yield* dispatch("run-restore", {
      type: "game-run.restore.request",
      commandId: id,
      threadId: run.threadId,
      runId: run.id,
      requestId,
      ...(round === undefined ? {} : { round }),
      ...(build === undefined ? {} : { build }),
    });
    const what =
      round !== undefined
        ? `round ${round}'s build`
        : `"${savedBuildLabel(build ?? "", state, run) ?? build}"`;
    // A retry finds its restore already landed; a first call may wait, within its bound.
    const recorded = (yield* latestOf(threadId)).run?.restore;
    // The request is recorded, so another as the run's latest means this one was
    // handled before it: a retry of a request answered long ago.
    if (recorded != null && recorded.requestId !== requestId)
      return {
        requestId,
        done: true,
        message: `This request was handled earlier, and a later restore (${restoreLabel(recorded, state, run)}) has run since; game_run_status shows where the game stands.`,
      } satisfies GameRunRestoreResult;
    const known =
      recorded?.requestId === requestId && recorded.outcome !== null
        ? Option.some(recorded.outcome)
        : Option.none();
    const landed =
      Option.isSome(known) || options.waitFor === undefined
        ? known
        : yield* engine
            .streamStoredEventsFrom({
              threadId: run.threadId,
              afterSequence: after,
              eventType: "game-run.updated",
            })
            .pipe(
              Stream.map(({ event }) =>
                event.type === "game-run.updated" && event.payload.restore?.requestId === requestId
                  ? event.payload.restore.outcome
                  : null,
              ),
              Stream.filter((outcome) => outcome !== null),
              Stream.runHead,
              Effect.timeoutOption(options.waitFor),
              Effect.map(Option.flatten),
              Effect.mapError(unreadable),
            );
    if (Option.isNone(landed))
      return {
        requestId,
        done: false,
        message: `Restoring ${what}: the run is moving the game folder; the Run tab and game_run_status show the outcome.`,
      } satisfies GameRunRestoreResult;
    const outcome = landed.value;
    if (outcome.kind === "refused")
      return yield* runError("run-restore", root, outcome.reason, outcome.message);
    return { requestId, done: true, message: outcome.message } satisfies GameRunRestoreResult;
  });

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
    runRestore,
    runSubmit,
  });
});

export const layer = Layer.effect(GameRunControl, make);
