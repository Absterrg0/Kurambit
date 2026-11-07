// @effect-diagnostics globalDate:off -- A saved build's time comes from its ref's commit time.
// What the game_keep_going* tools and the Game panel's keep-going RPCs reach:
// thin over the run's commands and its records (getGameRunRecords). One run
// per game, on the chat that turned it on; every chat of the game sees it.
// Stage-era runs are read only: their rounds for the round cards and Past
// runs, their builds for the timeline.
import {
  CommandId,
  GAME_ENGINES,
  GameRunId,
  type OrchestrationV2GameRunCommand,
  type GameRunStep,
  type GameRunStepResult,
  gameRunStepId,
  manifestProject,
  type GameKeepGoingDecideInput,
  type GameKeepGoingDecideResult,
  type GameKeepGoingInput,
  type GameKeepGoingStatus,
  type GameKeepGoingSteerInput,
  type GameKeepGoingSteerResult,
  type GameRun,
  type GameRunRound,
  type GameRunRoundRecord,
  type GameRunRoundsResult,
  type GameStepVerdict,
  GameOperationError,
  GameRunErrorReason,
  type RunId,
  ThreadId,
} from "@kurambit/contracts";
import * as KeyedLock from "@kurambit/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { gameRunRefsFolder } from "../checkpointing/Utils.ts";
import { stopStepTurns } from "../orchestration-v2/gameRun/GameRunRecovery.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { savedBuildOf } from "./run/buildNames.ts";
import * as Loop from "./run/loop.ts";
import { NO_TURN_LOOP_SENTENCE, keepGoingStatus } from "./run/runView.ts";
import { RESUMABLE, isStepRecord, stageEra, stepNumber } from "./run/state.ts";
import { ensureScaffold } from "./runSetup.ts";
import * as GameTemplates from "./GameTemplates.ts";

export class GameRunError extends Schema.TaggedError<GameRunError>()("GameRunError", {
  operation: Schema.String,
  path: Schema.String,
  reason: GameRunErrorReason,
  detail: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail ?? `Keep going ${this.operation} failed (${this.reason}).`;
  }

  /** The one way a run failure reaches agents and the UI: the game error, with the run's reason. */
  static toOperationError(operation: string, cause: GameRunError): GameOperationError {
    return new GameOperationError({
      operation,
      path: cause.path,
      reason: cause.reason === "empty-note" ? "invalid-input" : "command-failed",
      detail: cause.message,
      runReason: cause.reason,
      cause,
    });
  }
}

type Fails<A> = Effect.Effect<A, GameRunError>;

/** A build a stage-era run keeps under a name, with its commit. */
export interface RunNamedBuild {
  readonly name: string;
  readonly label: string;
  readonly oid: string;
  readonly at: string;
}
/** A stage-era run's builds by commit, for the build timeline (GameBuilds). */
export interface RunBuilds {
  readonly runId: string;
  /** The run is still live: only until recovery stops it at startup. */
  readonly live: boolean;
  readonly best: string | null;
  readonly rounds: ReadonlyArray<{
    readonly round: number;
    readonly build: string | null;
    readonly move: string;
    readonly rung: string | null;
    readonly outcome: "kept" | "not-kept" | "abandoned";
    readonly durationMs: number;
    readonly linesChanged: number;
    readonly endedAt: string | null;
  }>;
  /** Prototypes and stages, and the run's saved builds. */
  readonly saved: ReadonlyArray<RunNamedBuild>;
  /** Stage era: the run's own restore, which no longer exists. Always null. */
  readonly restore: {
    readonly requestId: string;
    readonly target: string | null;
    readonly label: string;
    readonly requestedAt: string;
    readonly outcome: { readonly restored: boolean; readonly message: string } | null;
    /** The folder before it, which restoring undoes it. */
    readonly before: string | null;
  } | null;
}

/** A turn build's keep-going step, for its strip and its timeline mark. */
export interface GameRunStepMark {
  readonly n: number;
  readonly verdict: GameStepVerdict | null;
  readonly reason: string;
}

type Service = {
  /** Off, Guided or Autopilot for the caller's chat: starts, resumes, switches or stops keep going. */
  readonly set: (threadId: ThreadId, input: GameKeepGoingInput) => Fails<GameKeepGoingStatus>;
  readonly status: (threadId: ThreadId) => Fails<GameKeepGoingStatus>;
  /** The person's answer to the Guided proposal. */
  readonly decide: (
    threadId: ThreadId,
    input: GameKeepGoingDecideInput,
  ) => Fails<GameKeepGoingDecideResult>;
  /** The person's words for the next step, from any chat of the game. */
  readonly steer: (
    threadId: ThreadId,
    input: GameKeepGoingSteerInput,
  ) => Fails<GameKeepGoingSteerResult>;
  /** Every stage-era run whose chat is this thread, newest first (at most 10), with its rounds, for the round cards. */
  readonly rounds: (threadId: ThreadId) => Fails<GameRunRoundsResult>;
  /** The game's latest stage-era run as the build timeline lists it; null when it has none. */
  readonly runBuilds: (threadId: ThreadId) => Fails<RunBuilds | null>;
  /** The keep-going step each turn of this chat was, by its T3 run. */
  readonly steps: (threadId: ThreadId) => Effect.Effect<ReadonlyMap<RunId, GameRunStepMark>>;
};

export class GameRunControl extends Context.Service<GameRunControl, Service>()(
  "kurambit/game/GameRunControl",
) {}

const runError = (operation: string, path: string, reason: GameRunErrorReason, detail: string) =>
  new GameRunError({ operation, path, reason, detail });

/** The T3 run a step turn's result names, once it landed. */
const turnRunOf = (record: GameRunStep): RunId | null => resultOf(record, "turn")?.runId ?? null;

/** A step's result of the kind its step reports, or null. */
const resultOf = <K extends "turn" | "judge">(
  record: GameRunStep | null,
  kind: K,
): Extract<GameRunStepResult, { readonly kind: K }> | null =>
  record?.result != null && record.result.kind === kind
    ? (record.result as Extract<GameRunStepResult, { readonly kind: K }>)
    : null;

/** How a stage-era round ended, as its card says. */
const roundOutcome = (r: GameRunRoundRecord) =>
  r.kept
    ? ("kept" as const)
    : r.inconclusive === true
      ? ("inconclusive" as const)
      : r.unjudged === true
        ? ("unjudged" as const)
        : r.abandoned === true
          ? ("abandoned" as const)
          : ("rejected" as const);

/** The stage-era rounds of a run, in order: keep-going steps never make round cards. */
const stageRounds = (records: ReadonlyArray<GameRunRound>, runId: string) =>
  records
    .filter((r) => r.runId === runId && r.round.step === undefined)
    .toSorted((a, b) => a.round.round - b.round.round);

const savedLabel = (name: string): string | null => {
  const saved = savedBuildOf(name);
  if (saved === null) return null;
  switch (saved.kind) {
    case "ending":
      return "The game as the run left it";
    case "restore-before":
      return "The game before an earlier restore";
    case "resume-before":
      return "The game as it was when the run resumed";
    case "unfinished":
      return `Round ${saved.round}'s unfinished work`;
    case "candidate":
      return `Round ${saved.round}'s build, not kept`;
  }
};

const STAGE_LABELS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^base$/, () => "The game as the run found it"],
  [/^proto-([0-9]+)$/, (m) => `Prototype ${m[1]}`],
  [/^stage-(.+)$/, (m) => `The run's ${m[1]} stage`],
];

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* GameProjectService.GameProjectService;
  const templates = yield* GameTemplates.GameTemplates;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;

  /**
   * The caller's game: its folder, and the thread its latest run lives on. The
   * folder is the project's, so every chat of the game reaches the same run.
   */
  const resolveGame = Effect.fn("GameRunControl.resolveGame")(function* (threadId: ThreadId) {
    const root = yield* projects
      .resolve(threadId)
      .pipe(
        Effect.mapError((cause) =>
          runError("resolve-game", threadId, "project-not-found", cause.message),
        ),
      );
    // A read that fails is no answer: it is never "the thread is gone" or "no run".
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((cause) =>
          runError("resolve-game", threadId, "thread-read", String(cause.message)),
        ),
      );
    if (shell === null || shell.deletedAt !== null)
      return yield* runError("resolve-game", threadId, "project-not-found", "The thread is gone.");
    const projectRun = yield* projections
      .getProjectGameRun(shell.projectId)
      .pipe(
        Effect.mapError((cause) =>
          runError("resolve-game", threadId, "records-unreadable", String(cause.message)),
        ),
      );
    const runThread = projectRun?.threadId ?? threadId;
    // The run's builds live in its own thread's folder; a chat on another
    // checkout of the game reads them there.
    const runRoot =
      runThread === threadId
        ? root
        : yield* projects
            .resolve(runThread, { deleted: "allowed" })
            .pipe(
              Effect.mapError((cause) =>
                runError("resolve-game", runThread, "project-not-found", cause.message),
              ),
            );
    return { root, runRoot, projectId: shell.projectId, runThread, projectRun, shell };
  });

  // A finished role thread's tokens never change, so each is read once.
  const threadTokens = new Map<string, number | null>();
  const tokensOf = (threadId: string) =>
    Effect.gen(function* () {
      const known = threadTokens.get(threadId);
      if (known !== undefined) return known;
      const records = yield* projections
        .getThreadRecords(ThreadId.make(threadId), ["providerTurns"])
        .pipe(Effect.orElseSucceed(() => null));
      if (records === null) return null;
      let sum: number | null = null;
      let open = false;
      for (const turn of records.providerTurns) {
        if (turn.status === "pending" || turn.status === "running") open = true;
        const usage = turn.turnTokenUsage;
        if (usage === undefined) continue;
        const used = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
          sum = (sum ?? 0) + used;
      }
      if (!open) {
        if (threadTokens.size > 2000) threadTokens.clear();
        threadTokens.set(threadId, sum);
      }
      return sum;
    });

  /**
   * A stage-era run's rounds as the round cards show them: when each ended,
   * the best it was built on (the last kept round before it), and the tokens
   * its role threads used: every role thread started from its builder's first
   * turn to its end, since a round's roles ran one after another.
   */
  const roundRefs = (run: GameRun, records: ReadonlyArray<GameRunRound>) =>
    Effect.gen(function* () {
      const rounds = stageRounds(records, run.id);
      const roles = yield* projections
        .listGameRunRoleThreads(run.threadId, run.id)
        .pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(rounds, ({ round: r, recordedAt }, i) =>
        Effect.gen(function* () {
          const base =
            rounds
              .slice(0, i)
              .findLast((earlier) => earlier.round.kept && earlier.round.build !== undefined)?.round
              .build ?? null;
          const builders = roles.filter(
            (t) => t.role === `builder-${r.round}` || t.role === `builder-${r.round}b`,
          );
          const from = builders.map((t) => t.startedAt).toSorted()[0];
          const inRound =
            from === undefined
              ? []
              : roles.filter((t) => t.startedAt >= from && t.startedAt <= recordedAt);
          const counted = yield* Effect.forEach(
            [...new Set(inRound.map((t) => t.threadId))],
            tokensOf,
          );
          const known = counted.filter((n): n is number => n !== null);
          return {
            round: r.round,
            move: r.move,
            branch: r.branch,
            kept: r.kept,
            current: r.kept && r.build !== undefined && r.build === run.best,
            outcome: roundOutcome(r),
            verdicts: r.verdicts.map(({ order, verdict }) => ({ order, verdict })),
            linesChanged: r.linesChanged,
            durationMs: r.durationMs,
            note: r.note ?? null,
            steer: r.steer ?? [],
            rung:
              r.rung === undefined
                ? null
                : {
                    is: r.rung.is,
                    checks: r.rung.checks,
                    outcome: r.rung.outcome,
                    why: r.rung.why,
                  },
            build: r.build ?? null,
            base,
            endedAt: recordedAt,
            tokens: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
          };
        }),
      );
    });

  const rounds: Service["rounds"] = Effect.fn("GameRunControl.rounds")(function* (
    threadId: ThreadId,
  ) {
    const { projectId } = yield* resolveGame(threadId);
    const unreadable = (cause: { readonly message: string }) =>
      runError("run-read", threadId, "records-unreadable", String(cause.message));
    // Every stage-era run of the game whose chat is this one, on whichever thread its records live.
    const runsOfChat = (yield* projections
      .listProjectGameRuns(projectId, 50)
      .pipe(Effect.mapError(unreadable)))
      .filter((run) => stageEra(run) && (run.chat ?? run.threadId) === threadId)
      .slice(0, 10);
    const roundsByThread = new Map<ThreadId, ReadonlyArray<GameRunRound>>();
    const runs = [];
    for (const run of runsOfChat) {
      const records =
        roundsByThread.get(run.threadId) ??
        (yield* projections
          .getGameRunRecords(run.threadId, { steps: [] })
          .pipe(Effect.mapError(unreadable))).gameRunRounds;
      roundsByThread.set(run.threadId, records);
      runs.push({
        runId: run.id,
        active: run.status !== "ended",
        best: run.best === undefined || run.best.length === 0 ? null : run.best,
        rounds: yield* roundRefs(run, records),
      });
    }
    return { runs };
  });

  const runBuilds: Service["runBuilds"] = Effect.fn("GameRunControl.runBuilds")(function* (
    threadId: ThreadId,
  ) {
    const { runRoot: root, runThread } = yield* resolveGame(threadId);
    const records = yield* projections
      .getGameRunRecords(runThread, { steps: [] })
      .pipe(
        Effect.mapError((cause) =>
          runError("run-read", threadId, "records-unreadable", String(cause.message)),
        ),
      );
    const run = records.gameRuns.findLast(stageEra) ?? null;
    if (run === null) return null;
    const folder = gameRunRefsFolder(run.id);
    const refs = yield* checkpoints
      .listCheckpointRefs({ cwd: root, prefix: folder })
      .pipe(Effect.orElseSucceed(() => []));
    const kept = new Set(
      stageRounds(records.gameRunRounds, run.id).flatMap((r) =>
        r.round.kept && r.round.build !== undefined ? [r.round.build] : [],
      ),
    );
    const saved = refs
      .toSorted((a, b) => b.committedAt - a.committedAt)
      .flatMap((ref): ReadonlyArray<RunNamedBuild> => {
        const name = ref.checkpointRef.slice(folder.length);
        const at = new Date(ref.committedAt * 1000).toISOString();
        for (const [pattern, label] of STAGE_LABELS) {
          const match = pattern.exec(name);
          if (match !== null) return [{ name, label: label(match), oid: ref.oid, at }];
        }
        // An ended run's saved builds; a kept round's candidate is its round.
        const label = run.status === "ended" && !kept.has(ref.oid) ? savedLabel(name) : null;
        return label === null ? [] : [{ name, label, oid: ref.oid, at }];
      });
    return {
      runId: run.id,
      live: run.status !== "ended",
      best: run.best === undefined || run.best.length === 0 ? null : run.best,
      rounds: stageRounds(records.gameRunRounds, run.id).map(({ round: r, recordedAt }) => ({
        round: r.round,
        build: r.build ?? null,
        move: r.move,
        rung: r.rung?.is ?? null,
        outcome: r.abandoned === true ? "abandoned" : r.kept ? "kept" : "not-kept",
        durationMs: r.durationMs,
        linesChanged: r.linesChanged,
        endedAt: recordedAt,
      })),
      saved,
      restore: null,
    } satisfies RunBuilds;
  });

  const unreadable =
    (operation: string, threadId: ThreadId) => (cause: { readonly message: string }) =>
      runError(operation, threadId, "records-unreadable", String(cause.message));

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
  // id is scoped to the chat and the run it acts on.
  const fresh = Effect.map(Random.nextIntBetween(0, 2 ** 48), (n) => n.toString(36));
  const commandId = (kind: string, given: string | undefined, thread: ThreadId, run: string) =>
    given === undefined
      ? Effect.map(fresh, (id) => CommandId.make(`server:game-run:${kind}:${id}`))
      : Effect.succeed(CommandId.make(`client:${kind}:${thread}:${run}:${given}`));

  /**
   * The game's run as the status reads it: its step records with when each
   * landed, the step in flight, and the turn an in-flight judge or undo is
   * judging (planned one or two steps before it).
   */
  const readRun = (operation: string, threadId: ThreadId, run: GameRun | null) =>
    Effect.gen(function* () {
      if (run === null || stageEra(run))
        return { records: [], inFlight: null, turn: null, turnRun: null, undoing: null, n: 1 };
      const fail = unreadable(operation, threadId);
      const records = yield* projections
        .getGameRunRecords(run.threadId, { steps: "in-flight" })
        .pipe(Effect.mapError(fail));
      const inFlight =
        records.gameRunSteps.find((step) => step.runId === run.id && step.seq === run.inFlight) ??
        null;
      const judging =
        inFlight !== null && (inFlight.step.kind === "judge" || inFlight.step.kind === "undo");
      const cycle = judging
        ? (yield* projections
            .getGameRunRecords(run.threadId, {
              steps: [inFlight.seq - 1, inFlight.seq - 2]
                .filter((seq) => seq > 0)
                .map((seq) => gameRunStepId(run.id, seq)),
            })
            .pipe(Effect.mapError(fail))).gameRunSteps
        : [];
      const turnRecord = cycle.find((step) => step.step.kind === "turn") ?? null;
      const turnResult = resultOf(turnRecord, "turn");
      const judge = resultOf(cycle.find((step) => step.step.kind === "judge") ?? null, "judge");
      const undoing =
        inFlight?.step.kind === "undo" &&
        turnRecord?.step.kind === "turn" &&
        turnResult !== null &&
        judge !== null
          ? Loop.undoReason({ turn: turnRecord.step, result: turnResult, since: 0, judge })
          : null;
      return {
        records: records.gameRunRounds.flatMap((r) =>
          r.runId === run.id && isStepRecord(r.round)
            ? [{ record: r.round, at: r.recordedAt }]
            : [],
        ),
        inFlight,
        turn: turnRecord?.step.kind === "turn" ? turnRecord.step : null,
        turnRun: turnRecord === null ? null : turnRunOf(turnRecord),
        undoing,
        n: stepNumber(records.gameRunRounds),
      };
    });

  /** Why keep going cannot run from this chat, or null when it can. */
  const blockedFor = (
    threadId: ThreadId,
    root: string,
    run: GameRun | null,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const manifest = yield* projects.read(root).pipe(Effect.orElseSucceed(() => null));
      if (manifest !== null && !GAME_ENGINES[manifest.engine.name].turnLoop)
        return NO_TURN_LOOP_SENTENCE;
      if (run === null || run.status === "ended" || run.threadId === threadId) return null;
      const shell = yield* threads
        .getThreadShell(run.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      return `Keep going is on in ${shell?.title.trim() || "another chat"}.`;
    });

  const status: Service["status"] = Effect.fn("GameRunControl.status")(function* (
    threadId: ThreadId,
  ) {
    const { root, projectRun } = yield* resolveGame(threadId);
    const read = yield* readRun("status", threadId, projectRun);
    return keepGoingStatus({
      run: projectRun,
      records: read.records,
      inFlight: read.inFlight,
      turn: read.turn,
      n: read.n,
      undoing: read.undoing,
      blocked: yield* blockedFor(threadId, root, projectRun),
    });
  });

  const scaffold = (
    threadId: ThreadId,
    root: string,
    engineId: GameRun["engine"],
    fresh: boolean,
  ) =>
    engineId === undefined
      ? Effect.void
      : templates.directory.pipe(
          Effect.flatMap((directory) => ensureScaffold(directory, root, engineId, fresh)),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError((cause) =>
            runError(
              "set",
              threadId,
              "command-failed",
              `Keep going's skills and bot kit could not be put in the game (${cause.detail ?? cause.reason}).`,
            ),
          ),
        );

  // One run per game: every change reads the game's run and dispatches under
  // its project's lock, so two chats turning it on at once cannot both find none.
  const gameLock = yield* KeyedLock.make<string>();

  const set: Service["set"] = Effect.fn("GameRunControl.set")(function* (
    threadId: ThreadId,
    input: GameKeepGoingInput,
  ) {
    const { projectId } = yield* resolveGame(threadId);
    yield* gameLock.withLock(projectId, setOnce(threadId, input));
    return yield* status(threadId);
  });

  const setOnce = (threadId: ThreadId, input: GameKeepGoingInput) =>
    Effect.gen(function* () {
      const { root, projectRun: run, shell } = yield* resolveGame(threadId);
      const live = run !== null && run.status !== "ended" ? run : null;
      if (input.mode === "off") {
        // Stopping is always allowed, from any chat of the game.
        if (live === null) return;
        yield* dispatch("set", {
          type: "game-run.stop",
          commandId: yield* commandId("keep-going-off", input.commandId, threadId, live.id),
          threadId: live.threadId,
          runId: live.id,
        });
        // Off interrupts the step turn in flight (K11); the person's own turns are untouched.
        yield* stopStepTurns(
          { projections, engine },
          live.threadId,
          (step) => step.runId !== live.id,
        );
        return;
      }
      const profile = input.mode;
      if (live !== null && !stageEra(live)) {
        if (live.threadId !== threadId)
          return yield* runError(
            "set",
            threadId,
            "run-live",
            (yield* blockedFor(threadId, root, live)) ?? "Keep going is on in another chat.",
          );
        if (live.profile === profile) return;
        yield* dispatch("set", {
          type: "game-run.profile.set",
          commandId: yield* commandId("keep-going-mode", input.commandId, threadId, live.id),
          threadId,
          runId: live.id,
          profile,
        });
        return;
      }
      if (shell.archivedAt !== null)
        return yield* runError(
          "set",
          threadId,
          "chat-unavailable",
          "This chat is archived: keep going runs in an open chat.",
        );
      // Recovery stops a stage-era run at startup; one still live is stopped
      // here, and keep going starts beside it.
      if (live !== null)
        yield* dispatch("set", {
          type: "game-run.stop",
          commandId: CommandId.make(`server:game-run-stage-era:${live.id}`),
          threadId: live.threadId,
          runId: live.id,
          reason: "This run was made by an earlier Kurambit.",
        });
      const manifest = yield* projects
        .read(root)
        .pipe(
          Effect.mapError((cause) =>
            runError(
              "set",
              threadId,
              "project-not-found",
              `The game's manifest could not be read (${cause.detail ?? cause.reason}).`,
            ),
          ),
        );
      const engineId = manifest.engine.name;
      if (!GAME_ENGINES[engineId].turnLoop)
        return yield* runError("set", threadId, "no-turn-loop", NO_TURN_LOOP_SENTENCE);
      // A paused run in this chat resumes, keeping its set-aside steps and notes.
      if (
        run !== null &&
        !stageEra(run) &&
        run.threadId === threadId &&
        run.ending !== null &&
        RESUMABLE.has(run.ending)
      ) {
        yield* scaffold(threadId, root, engineId, false);
        yield* dispatch("set", {
          type: "game-run.resume",
          commandId: yield* commandId("keep-going-on", input.commandId, threadId, run.id),
          threadId,
          runId: run.id,
          profile,
          ...(input.budgetMinutes === undefined ? {} : { budgetMinutes: input.budgetMinutes }),
        });
        return;
      }
      yield* scaffold(threadId, root, engineId, true);
      yield* dispatch("set", {
        type: "game-run.start",
        commandId: yield* commandId("keep-going-on", input.commandId, threadId, run?.id ?? "new"),
        threadId,
        runId: GameRunId.make(
          `run_${DateTime.toEpochMillis(yield* DateTime.now).toString(36)}${yield* fresh}`,
        ),
        engine: engineId,
        lane: manifestProject(manifest),
        profile,
        budgetMinutes: input.budgetMinutes === undefined ? 60 : input.budgetMinutes,
      });
    });

  /** The game's keep-going run, which the person's answer or note is for. */
  const turnsRun = (operation: string, threadId: ThreadId) =>
    Effect.flatMap(resolveGame(threadId), ({ projectRun }) =>
      projectRun === null || stageEra(projectRun)
        ? Effect.fail(
            runError(
              operation,
              threadId,
              "no-run",
              "Keep going has not run on this game yet: turn it on first.",
            ),
          )
        : Effect.succeed(projectRun),
    );

  const decide: Service["decide"] = Effect.fn("GameRunControl.decide")(function* (
    threadId: ThreadId,
    input: GameKeepGoingDecideInput,
  ) {
    const run = yield* turnsRun("decide", threadId);
    yield* dispatch("decide", {
      type: "game-run.decide",
      commandId: yield* commandId("keep-going-decide", input.commandId, threadId, run.id),
      threadId: run.threadId,
      runId: run.id,
      decisionId: input.stepId,
      answer: input.answer,
      chat: threadId,
    });
    return {
      message:
        input.answer === "start"
          ? "The step starts now."
          : input.answer === "skip"
            ? "Skipped: keep going sets that step aside and proposes the next one."
            : "The proposal waits for you. A message you send goes first.",
    };
  });

  const steer: Service["steer"] = Effect.fn("GameRunControl.steer")(function* (
    threadId: ThreadId,
    input: GameKeepGoingSteerInput,
  ) {
    const text = input.text.trim();
    if (text.length === 0)
      return yield* runError("steer", threadId, "empty-note", "The note is empty.");
    const run = yield* turnsRun("steer", threadId);
    yield* dispatch("steer", {
      type: "game-run.steer",
      commandId: yield* commandId("keep-going-steer", input.commandId, threadId, run.id),
      threadId: run.threadId,
      runId: run.id,
      note: text,
      chat: threadId,
    });
    const after = yield* projections
      .getGameRunRecords(run.threadId, { steps: [] })
      .pipe(Effect.mapError(unreadable("steer", threadId)));
    const now = after.gameRuns.find((each) => each.id === run.id) ?? run;
    return {
      pending: now.steer.length,
      message:
        now.status === "ended"
          ? "Keep going keeps your note for when it next runs."
          : "Keep going takes your note as its next step.",
    };
  });

  const steps: Service["steps"] = (threadId) =>
    Effect.gen(function* () {
      const records = yield* projections.getGameRunRecords(threadId, { steps: "in-flight" });
      const marks = new Map<RunId, GameRunStepMark>();
      for (const { round } of records.gameRunRounds)
        if (isStepRecord(round) && round.step.turn !== null)
          marks.set(round.step.turn, {
            n: round.round,
            verdict: round.step.verdict,
            reason: round.step.reason,
          });
      const run = records.gameRuns.at(-1);
      if (run !== undefined && run.status !== "ended" && !stageEra(run)) {
        const read = yield* readRun("steps", threadId, run);
        if (read.turnRun !== null && read.turnRun !== undefined)
          marks.set(read.turnRun, {
            n: read.n,
            verdict: null,
            reason:
              read.inFlight?.step.kind === "undo"
                ? `undoing it: ${read.undoing ?? "it made a fact worse"}`
                : "measuring before keeping it",
          });
      }
      return marks as ReadonlyMap<RunId, GameRunStepMark>;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("keep-going step marks could not be read", { threadId, cause }).pipe(
          Effect.as(new Map<RunId, GameRunStepMark>() as ReadonlyMap<RunId, GameRunStepMark>),
        ),
      ),
    );

  return GameRunControl.of({
    set,
    status,
    decide,
    steer,
    rounds,
    runBuilds,
    steps,
  });
});

export const layer = Layer.effect(GameRunControl, make);
