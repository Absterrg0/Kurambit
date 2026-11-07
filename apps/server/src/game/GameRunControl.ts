// @effect-diagnostics globalDate:off -- A saved build's time comes from its ref's commit time.
// What the game_keep_going* tools and the Game panel's keep-going RPCs reach:
// thin over the run's commands and its records (getGameRunRecords). Stage-era
// runs are read only: their rounds for the round cards and Past runs, their
// builds for the timeline.
import {
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { gameRunRefsFolder } from "../checkpointing/Utils.ts";
import { stageEra } from "./run/state.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { savedBuildOf } from "./run/buildNames.ts";

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

// Phase 3's run core (builder R) replaces these.
const notBuilt = (operation: string, threadId: ThreadId) =>
  Effect.fail(
    runError(
      operation,
      threadId,
      "command-failed",
      `not built: keep going's ${operation} is the run core's (phase 3, R).`,
    ),
  );

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
  const checkpoints = yield* CheckpointStore.CheckpointStore;

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
    return { root: runRoot, projectId: shell.projectId, runThread };
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
    const { root, runThread } = yield* resolveGame(threadId);
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

  return GameRunControl.of({
    set: (threadId) => notBuilt("set", threadId),
    status: (threadId) => notBuilt("status", threadId),
    decide: (threadId) => notBuilt("decide", threadId),
    steer: (threadId) => notBuilt("steer", threadId),
    rounds,
    runBuilds,
    steps: () =>
      Effect.die(new Error("not built: keep going's steps is the run core's (phase 3, R).")),
  });
});

export const layer = Layer.effect(GameRunControl, make);
