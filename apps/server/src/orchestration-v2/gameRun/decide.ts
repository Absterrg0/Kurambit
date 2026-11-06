// PURE. The production run as an orchestration domain: for each game-run
// command, the thread's game-run records in, the events, outbox effects or a
// typed refusal out. Every run decision is the run policy's (game/run/policy.ts);
// this module only folds the records into its state and its answers back out.
import {
  type GameRun,
  GameRunEnding,
  type GameRunId,
  type GameRunRefusalReason,
  type GameRunRound,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  GameRunSubmission,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameRunCommand,
  type ProjectId,
  type ThreadId,
  gameRunRoundId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { BuildName, savedBuildOf } from "../../game/run/buildNames.ts";
import * as Policy from "../../game/run/policy.ts";
import * as State from "../../game/run/state.ts";
import type { OrchestrationEffectRequestV2 } from "../EffectOutbox.ts";

export interface GameRunRecords {
  readonly projectId: ProjectId;
  /** The game's latest run on any of its project's threads: the folder is the project's. */
  readonly projectRun: GameRun | null;
  /** The thread's runs, oldest first. */
  readonly runs: ReadonlyArray<GameRun>;
  /** The thread's rounds across its runs: a game's round numbers continue from run to run. */
  readonly rounds: ReadonlyArray<GameRunRound>;
  /** The latest run's step in flight, when it holds one. */
  readonly inFlight: GameRunStep | null;
  /** The thread was deleted: nothing resumes its runs. */
  readonly chatDeleted: boolean;
  /** The thread's step records, for a resume only (it writes what they still owe); else empty. */
  readonly steps: ReadonlyArray<GameRunStep>;
}

interface GameRunInputs {
  readonly at: DateTime.Utc;
  /** Uniform in [0, 1): the policy's coin for labels, play order and presentation. */
  readonly coin: number;
  /** Fresh and unguessable: sample labels and judge ids come from it. */
  readonly id: string;
}

type GameRunEventType =
  | "game-run.created"
  | "game-run.updated"
  | "game-run-step.updated"
  | "game-run-round.recorded";
export type GameRunDomainEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: GameRunEventType }
>;
type WithoutId<E> = E extends unknown ? Omit<E, "id"> : never;
/** An event the orchestrator gives an id when it commits it. */
export type GameRunEvent = WithoutId<GameRunDomainEvent>;
type GameRunEffectRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: `game-run.${string}` }
>;
export const GAME_RUN_EFFECT_TYPES = [
  "game-run.step.execute",
  "game-run.decision.wake",
  "game-run.decision.deadline",
  "game-run.step.deadline",
  "game-run.step.resend",
  "game-run.step.wake",
] as const satisfies ReadonlyArray<GameRunEffectRequest["type"]>;

interface GameRunEffect {
  readonly request: GameRunEffectRequest;
  /** Epoch ms; absent runs at once. */
  readonly availableAt?: number;
}

export interface GameRunDecision {
  readonly events: ReadonlyArray<GameRunEvent>;
  readonly effects: ReadonlyArray<GameRunEffect>;
  /** A stop: the run's unsettled effects are cancelled in the same commit. */
  readonly cancelEffects: boolean;
}

interface GameRunRefusal {
  readonly reason: GameRunRefusalReason;
  readonly message: string;
}

/** Endings a run continues from with game-run.resume; the run's status says so to clients. */
export const RESUMABLE: ReadonlySet<string> = new Set([
  "budget",
  "usage-limit",
  "provider-down",
  "low-memory",
  "stopped",
  "failed",
  // A resume starts a fresh stall count (Policy.resume).
  "stalled",
  // A resume plans the ladder again.
  "no-ladder",
]);
// A run with no rung left to build comes back for a creator's note, one round per note.
const REOPENED_BY_NOTE: ReadonlySet<string> = new Set(["done", "ready", "no-ladder"]);

const isEnding = Schema.is(GameRunEnding);

const refuse = (reason: GameRunRefusalReason, message: string) =>
  Result.fail<GameRunRefusal>({ reason, message });

// ── Records to the policy's state and back. ────────────────────────────────
/** The policy's state of a run, as its records hold it; status views and the run's executor read it too. */
export const toState = (
  run: GameRun,
  rounds: ReadonlyArray<GameRunRound>,
  inFlight: GameRunStep | null,
  /** The run's role threads, from its step records; only status views read them. */
  threads: State.RunState["threads"] = [],
): State.RunState => ({
  version: 3,
  runId: run.id,
  profile: run.profile,
  decided: run.decided,
  buildNotes: run.buildNotes,
  brief: run.brief,
  artDirection: run.artDirection,
  budgetMinutes: run.budgetMinutes,
  ...selectionKey(run.modelSelection),
  startedAt: run.startedAt,
  stage: run.stage,
  ending: run.ending,
  stallStreak: run.stallStreak,
  lastFailure: run.lastFailure,
  shipNoReasons: run.shipNoReasons,
  rounds: rounds.map((r) => r.round).toSorted((a, b) => a.round - b.round),
  threads,
  pending: run.pending,
  seq: run.seq,
  budgetEndsAt: run.budgetEndsAt,
  lane: run.lane,
  trunk: run.trunk,
  best: run.best,
  protos: run.protos,
  pickNotes: run.pickNotes,
  picked: run.picked,
  next: run.ledger,
  lastDirection: run.lastDirection,
  ladder: run.ladder,
  steer: run.steer,
  creator: run.threadId,
  played: run.played,
  task: run.task,
  inFlight: run.inFlight !== null && inFlight?.seq === run.inFlight ? inFlight.step : null,
});

// The policy keys a reusable blind play by the model that played it.
const selectionKey = (selection: GameRun["modelSelection"]) => ({
  provider: selection.instanceId,
  model: selection.model,
  variant: selection.options === undefined ? null : JSON.stringify(selection.options),
});

const fromState = (run: GameRun, state: State.RunState, at: string): GameRun => {
  const ending =
    state.ending === null ? null : isEnding(state.ending) ? state.ending : ("failed" as const);
  const step = ending === null ? state.inFlight : null;
  return {
    ...run,
    profile: state.profile,
    decided: state.decided,
    buildNotes: state.buildNotes,
    budgetEndsAt: state.budgetEndsAt,
    status: ending !== null ? "ended" : step?.kind === "decide" ? "waiting" : "running",
    ending,
    stage: state.stage,
    trunk: state.trunk,
    best: state.best,
    ladder: state.ladder,
    steer: state.steer,
    pendingDecision:
      step?.kind === "decide" && step.sent !== null
        ? {
            stepId: gameRunStepId(run.id, step.id),
            question: step.decision,
            sentAt: step.sent,
            deadline: step.deadline,
          }
        : null,
    stallStreak: state.stallStreak,
    lastFailure: state.lastFailure,
    shipNoReasons: state.shipNoReasons,
    ledger: state.next,
    lastDirection: state.lastDirection,
    pickNotes: state.pickNotes,
    picked: state.picked,
    protos: state.protos,
    played: state.played,
    pending: state.pending,
    task: state.task,
    seq: state.seq,
    // An ended run keeps its unfinished step for a resume to run again.
    inFlight: state.inFlight?.id ?? null,
    updatedAt: at,
  };
};

const rolesOf = (step: State.Step): GameRunStep["roles"] => {
  const role = (s: State.RoleStep) => ({ seq: s.id, threadId: s.thread, submission: null });
  if (step.kind === "role") return [role(step)];
  if (step.kind === "pair") return step.halves.flatMap((h) => (h.kind === "role" ? [role(h)] : []));
  return [];
};

/** The number of the step or pair half `stepId` names in this record, or null. */
const seqIn = (record: GameRunStep, stepId: GameRunStepId): number | null => {
  if (record.step.kind !== "pair") return record.id === stepId ? record.seq : null;
  return record.step.halves.find((h) => gameRunStepId(record.runId, h.id) === stepId)?.id ?? null;
};

const roleAt = (step: State.Step, seq: number): State.RoleStep | null => {
  if (step.kind === "role") return step.id === seq ? step : null;
  if (step.kind !== "pair") return null;
  const half = step.halves.find((h) => h.id === seq);
  return half?.kind === "role" ? half : null;
};

// A step's result must be one its kind can produce; the policy relies on it.
const RESULTS: Record<string, ReadonlyArray<GameRunStepResult["kind"]>> = {
  role: ["done", "failed", "ended"],
  build: ["build", "failed", "ended"],
  git: ["git", "failed", "ended"],
  boot: ["boot", "failed", "ended"],
  facts: ["facts", "failed", "ended"],
  checks: ["checks", "failed", "ended"],
  bot: ["bot", "failed", "ended"],
  note: ["note", "failed"],
};

// ── One command's work on one run. ─────────────────────────────────────────
interface Work {
  readonly command: OrchestrationV2GameRunCommand;
  readonly records: GameRunRecords;
  readonly input: GameRunInputs;
  readonly now: number;
  readonly at: string;
}

const effectFor = (request: GameRunEffectRequest, availableAt?: number): GameRunEffect =>
  availableAt === undefined ? { request } : { request, availableAt };

/**
 * What a landing asks of the game folder, as an effect of its own commit: the
 * outbox runs it before the run's next step, which that commit plans after it.
 */
const outputsEffect = (
  run: GameRun,
  stepId: GameRunStepId,
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
  release: ReadonlyArray<ThreadId>,
): GameRunEffect[] =>
  files.length === 0 && release.length === 0
    ? []
    : [effectFor({ type: "game-run.outputs", runId: run.id, stepId, files, release })];

/**
 * The records the landings since the run's last non-decision step wrote, in
 * order, with the latest of those steps: before landings had an outputs effect
 * of their own, the next step's job wrote them (walking back over decisions,
 * which have no job). Writing them again is harmless.
 */
export const owedOutputs = (
  run: GameRun,
  steps: ReadonlyArray<GameRunStep>,
): { readonly stepId: GameRunStepId; readonly files: GameRunStep["outputs"]["files"] } | null => {
  const landed = steps
    .filter(
      (s) =>
        s.runId === run.id &&
        s.completedAt !== null &&
        (run.inFlight === null || s.seq < run.inFlight),
    )
    .toSorted((a, b) => b.seq - a.seq);
  const owed: GameRunStep[] = [];
  for (const step of landed) {
    owed.unshift(step);
    if (step.kind !== "decide") break;
  }
  const latest = owed.at(-1);
  return latest === undefined
    ? null
    : { stepId: latest.id, files: owed.flatMap((s) => s.outputs.files) };
};

/** A role that plays a copy gives it back once its turn is its last, or the budget cut it short. */
const ownRelease = (role: State.RoleStep | null, result: GameRunStepResult | null): ThreadId[] =>
  role !== null && role.at !== null && result?.kind === "done" && (role.release || result.budgetCut)
    ? [result.threadId]
    : [];

const stepRecord = (
  work: Work,
  run: GameRun,
  step: State.Step,
  logs: ReadonlyArray<string>,
  existing: GameRunStep | null,
): GameRunStep =>
  existing !== null && existing.seq === step.id
    ? {
        ...existing,
        attempt: existing.attempt + 1,
        step,
        status: "planned",
        result: null,
        endedHalves: [],
        logs: [...existing.logs, ...logs],
        // A new attempt (a resume after the waits ran out) waits afresh.
        memoryWaits: 0,
        busyWaits: 0,
        completedAt: null,
      }
    : {
        id: gameRunStepId(run.id, step.id),
        runId: run.id,
        threadId: run.threadId,
        seq: step.id,
        attempt: 1,
        kind: step.kind,
        step,
        status: "planned",
        roles: rolesOf(step),
        result: null,
        endedHalves: [],
        outputs: { files: [], release: [] },
        logs,
        plannedAt: work.at,
        startedAt: null,
        completedAt: null,
      };

/** When a decide step's default is due: its deadline once presented, else the delivery bound. */
const decisionDue = (step: State.DecideStep): number =>
  step.deadline ?? (step.sent ?? 0) + Policy.DECISION_DELIVERY_MS;

/**
 * The policy plans the run's next step (or the step it holds in flight, on a
 * resume); a decide step wakes the creator's chat in the same commit.
 */
const advance = (
  work: Work,
  run: GameRun,
  state: State.RunState,
  existing: GameRunStep | null,
): {
  readonly state: State.RunState;
  readonly step: GameRunStep | null;
  readonly effects: GameRunEffect[];
} => {
  if (state.ending !== null) return { state, step: null, effects: [] };
  const planned = Policy.plan(state, { now: work.now, coin: work.input.coin, id: work.input.id });
  if (planned.kind === "end")
    return {
      state: {
        ...state,
        ending: planned.reason,
        ...(planned.why === undefined ? {} : { lastFailure: planned.why }),
      },
      step: null,
      effects: [],
    };
  const step: State.Step =
    planned.step.kind === "decide" && planned.step.sent === null
      ? { ...planned.step, sent: work.now }
      : planned.step;
  const next = { ...planned.state, inFlight: step };
  const record = stepRecord(work, run, step, planned.logs ?? [], existing);
  const effects =
    step.kind === "decide"
      ? [
          effectFor({
            type: "game-run.decision.wake",
            runId: run.id,
            stepId: record.id,
            decisionId: step.decision.id,
          }),
          effectFor(
            {
              type: "game-run.decision.deadline",
              runId: run.id,
              stepId: record.id,
              decisionId: step.decision.id,
            },
            Math.max(work.now, decisionDue(step)),
          ),
        ]
      : [
          effectFor({
            type: "game-run.step.execute",
            runId: run.id,
            stepId: record.id,
            attempt: record.attempt,
          }),
        ];
  return { state: next, step: record, effects };
};

const runEvent = (work: Work, created: boolean, payload: GameRun): GameRunEvent => ({
  type: created ? "game-run.created" : "game-run.updated",
  threadId: work.command.threadId,
  occurredAt: work.input.at,
  payload,
});
const stepEvent = (work: Work, payload: GameRunStep): GameRunEvent => ({
  type: "game-run-step.updated",
  threadId: work.command.threadId,
  occurredAt: work.input.at,
  payload,
});
const roundEvent = (work: Work, payload: GameRunRound): GameRunEvent => ({
  type: "game-run-round.recorded",
  threadId: work.command.threadId,
  occurredAt: work.input.at,
  payload,
});

/** The events for a run moving from `before` to `state`, with the step records it touched. */
const settle = (
  work: Work,
  run: GameRun,
  before: State.RunState,
  state: State.RunState,
  steps: ReadonlyArray<GameRunStep>,
  effects: ReadonlyArray<GameRunEffect>,
  created = false,
): GameRunDecision => {
  const settled = fromState(run, state, work.at);
  // The commit that ends a run owes its finish: an effect, so a restart cannot lose it.
  const ends = settled.status === "ended" && (created || run.status !== "ended");
  const record: GameRun = ends ? { ...settled, endedAt: work.at, finished: null } : settled;
  const finish = ends
    ? [effectFor({ type: "game-run.finish", runId: run.id, endedAt: work.at })]
    : [];
  const rounds = state.rounds.slice(before.rounds.length).map((round): GameRunRound => ({
    id: gameRunRoundId(run.id, round.round),
    runId: run.id,
    threadId: run.threadId,
    round,
    recordedAt: work.at,
  }));
  return {
    events: [
      ...steps.map((step) => stepEvent(work, step)),
      ...rounds.map((round) => roundEvent(work, round)),
      runEvent(work, created, record),
    ],
    effects: [...effects, ...finish],
    cancelEffects: false,
  };
};

/** Lands a step's result through the policy, then plans what comes next. */
const land = (
  work: Work,
  run: GameRun,
  state: State.RunState,
  record: GameRunStep,
  applied: Policy.Applied,
  result: GameRunStepResult | null,
  status: GameRunStep["status"],
  own: ReadonlyArray<ThreadId> = [],
): GameRunDecision => {
  // An ending keeps the step in flight for a resume to run again; a pair cut
  // short keeps only the halves still owed, which may be one half of its own.
  const held = applied.state.inFlight;
  const release = [...new Set([...own, ...applied.release])];
  const done: GameRunStep = {
    ...record,
    ...(held?.id === record.seq ? { step: held } : {}),
    status: held?.id === record.seq ? "cancelled" : status,
    result,
    outputs: {
      files: [...record.outputs.files, ...applied.files],
      release: [...record.outputs.release, ...release],
    },
    logs: [...record.logs, ...applied.logs],
    completedAt: work.at,
  };
  // An owed half's own record continues the pair's attempts: its reports so far used the pair's.
  const owed =
    held === null || held.id === record.seq
      ? []
      : [
          {
            ...stepRecord(work, run, held, [], null),
            attempt: record.attempt,
            status: "cancelled" as const,
          },
        ];
  const next = advance(work, run, applied.state, null);
  return settle(
    work,
    run,
    state,
    next.state,
    [done, ...owed, ...(next.step === null ? [] : [next.step])],
    [...outputsEffect(run, record.id, applied.files, release), ...next.effects],
  );
};

type Command<T extends OrchestrationV2GameRunCommand["type"]> = Extract<
  OrchestrationV2GameRunCommand,
  { readonly type: T }
>;

/**
 * Why an ended run cannot be moved on yet: its ending's finish (stops, outputs,
 * exports) or a creator's restore is still working the game folder.
 */
/**
 * A run from before builds on checkpoints versioned on git branches its steps
 * can no longer run: it is history, read but never continued.
 */
export const gitEra = (run: GameRun) => run.versions !== "checkpoints";
const gitEraRefusal = (run: GameRun) =>
  refuse(
    "not-resumable",
    `Run ${run.id} kept its builds on git branches (round-N), which this Kurambit no longer continues. Start a new run: it goes on from the game as it is, and the old branches stay as they are.`,
  );

/** Refuses a move while the run's ending or a restore still owns the game folder. */
export const settling = (run: GameRun) =>
  run.endedAt !== null && run.finished !== run.endedAt
    ? refuse("finishing", `Run ${run.id} is still finishing its ending; try again in a moment.`)
    : run.restore !== null && run.restore.outcome === null
      ? refuse("restoring", `A build of run ${run.id} is being restored; try again once it is.`)
      : null;

const start = (work: Work, command: Command<"game-run.start">) => {
  const prior = work.records.runs.at(-1) ?? null;
  if (prior !== null && prior.status !== "ended")
    return refuse("run-live", `Run ${prior.id} is still going on this thread; stop it first.`);
  // One run per game: another chat of the same project may hold it.
  const elsewhere = work.records.projectRun;
  if (elsewhere !== null && elsewhere.status !== "ended")
    return refuse("run-live", `Run ${elsewhere.id} is live in another chat of this game.`);
  const busy = prior === null ? null : settling(prior);
  if (busy !== null) return busy;
  if (work.records.runs.some((r) => r.id === command.runId))
    return refuse("stale-run", `Run ${command.runId} already exists on this thread.`);
  const fresh = State.freshState(
    {
      runId: command.runId,
      profile: command.profile ?? "guided",
      brief: command.brief,
      artDirection: command.artDirection ?? "",
      budgetMinutes: command.budgetMinutes ?? null,
      ...selectionKey(command.modelSelection),
      startedAt: work.at,
    },
    { rounds: work.records.rounds.map((r) => r.round), pending: null },
  );
  // Stages an earlier run on this game finished are not redone.
  const state: State.RunState = {
    ...fresh,
    rounds: fresh.rounds.toSorted((a, b) => a.round - b.round),
    // A game an earlier run built continues from what it is; stages a run on
    // this thread finished are not redone either.
    stage: command.stage ?? prior?.stage ?? fresh.stage,
    pickNotes: prior?.pickNotes ?? "",
    picked: prior?.picked ?? null,
    lastDirection: prior?.lastDirection ?? "",
    steer: prior?.steer ?? [],
    next: prior?.ledger ?? "",
    creator: command.threadId,
    lane: command.lane,
    budgetEndsAt:
      command.budgetMinutes === undefined ? null : work.now + command.budgetMinutes * 60_000,
  };
  const run: GameRun = {
    ...fromState(
      {
        id: command.runId,
        threadId: command.threadId,
        projectId: work.records.projectId,
        lane: command.lane,
        brief: command.brief,
        artDirection: command.artDirection ?? "",
        profile: state.profile,
        modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode,
        budgetMinutes: command.budgetMinutes ?? null,
        budgetEndsAt: null,
        status: "running",
        ending: null,
        stage: state.stage,
        trunk: "",
        best: "",
        ladder: null,
        steer: [],
        decided: [],
        pendingDecision: null,
        stallStreak: 0,
        lastFailure: "",
        shipNoReasons: "",
        ledger: "",
        lastDirection: "",
        buildNotes: "",
        pickNotes: "",
        picked: null,
        protos: [],
        played: null,
        pending: null,
        task: state.task,
        seq: 0,
        inFlight: null,
        endedAt: null,
        finished: null,
        restore: null,
        versions: "checkpoints",
        startedAt: work.at,
        updatedAt: work.at,
      },
      state,
      work.at,
    ),
  };
  const next = advance(work, run, state, null);
  return Result.succeed(
    settle(work, run, state, next.state, next.step === null ? [] : [next.step], next.effects, true),
  );
};

/** The command's run: the thread's latest, which the command must name. */
const current = (work: Work, runId: GameRunId) => {
  const run = work.records.runs.at(-1);
  if (run === undefined) return refuse("no-run", "This thread has no production run.");
  if (run.id !== runId)
    return refuse("stale-run", `Run ${runId} is not this thread's current run (${run.id} is).`);
  return Result.succeed(run);
};

const live = (work: Work, runId: GameRunId) =>
  Result.flatMap(current(work, runId), (run) =>
    run.status === "ended"
      ? refuse("run-ended", `Run ${run.id} ended (${run.ending ?? "unknown"}).`)
      : Result.succeed(run),
  );

const inFlightOf = (work: Work, run: GameRun) =>
  run.inFlight !== null && work.records.inFlight?.seq === run.inFlight
    ? work.records.inFlight
    : null;

const resume = (work: Work, command: Command<"game-run.resume">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status !== "ended") return refuse("run-live", `Run ${run.id} is still going.`);
    const busy = settling(run);
    if (busy !== null) return busy;
    if (gitEra(run)) return gitEraRefusal(run);
    if (run.ending === null || !RESUMABLE.has(run.ending))
      return refuse(
        "not-resumable",
        `Run ${run.id} ended ${run.ending ?? "unknown"}; start a new run instead.`,
      );
    const budgetMinutes =
      command.budgetMinutes === undefined ? run.budgetMinutes : command.budgetMinutes;
    const resumed: GameRun = {
      ...run,
      budgetMinutes,
      ...(command.modelSelection === undefined ? {} : { modelSelection: command.modelSelection }),
      ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
    };
    const inFlight = inFlightOf(work, run);
    const before = toState(resumed, work.records.rounds, inFlight);
    const state: State.RunState = {
      ...Policy.resume(before),
      ending: null,
      profile: command.profile ?? before.profile,
      budgetEndsAt: budgetMinutes === null ? null : work.now + budgetMinutes * 60_000,
    };
    const next = advance(work, resumed, state, inFlight);
    // The records the last landings wrote go again ahead of the next step: an
    // ending that stopped the run before they were written (an outputs effect
    // that gave up, the landing that ended it) would leave the step without them.
    const owed = owedOutputs(run, work.records.steps);
    return Result.succeed(
      settle(work, resumed, before, next.state, next.step === null ? [] : [next.step], [
        ...(owed === null ? [] : outputsEffect(resumed, owed.stepId, owed.files, [])),
        ...next.effects,
      ]),
    );
  });

const stop = (work: Work, command: Command<"game-run.stop">) =>
  Result.flatMap(live(work, command.runId), (run) => {
    const inFlight = inFlightOf(work, run);
    const state = toState(run, work.records.rounds, inFlight);
    const why = command.reason?.trim() ?? "";
    // The step in flight stays the run's: a resume runs it again.
    const steps =
      inFlight === null
        ? []
        : [
            {
              ...inFlight,
              status: "cancelled" as const,
              logs: [
                ...inFlight.logs,
                `run stopped by the creator${why.length > 0 ? `: ${why}` : ""}`,
              ],
              completedAt: work.at,
            },
          ];
    return Result.succeed({
      ...settle(work, run, state, { ...state, ending: "stopped" }, steps, []),
      cancelEffects: true,
    });
  });

const steer = (work: Work, command: Command<"game-run.steer">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    const busy = run.status === "ended" ? settling(run) : null;
    if (busy !== null) return busy;
    if (run.status === "ended" && gitEra(run)) return gitEraRefusal(run);
    const inFlight = inFlightOf(work, run);
    const before = toState(run, work.records.rounds, inFlight);
    const noted = { ...before, steer: [...before.steer, command.note.trim()] };
    if (run.status === "ended" && run.ending !== null && REOPENED_BY_NOTE.has(run.ending)) {
      // The round the note buys gets the run's budget afresh, as a resume does.
      const budgeted = {
        ...noted,
        budgetEndsAt: run.budgetMinutes === null ? null : work.now + run.budgetMinutes * 60_000,
      };
      const next = advance(work, run, Policy.reopen(budgeted, work.now), null);
      return Result.succeed(
        settle(work, run, before, next.state, next.step === null ? [] : [next.step], next.effects),
      );
    }
    // A live run reads it at its next round; a stopped or interrupted one keeps it for its resume.
    return Result.succeed(settle(work, run, before, noted, [], []));
  });

/** Lands a decide step with the creator's answer or the default, then plans on. */
const takeDecision = (
  work: Work,
  run: GameRun,
  record: GameRunStep,
  result: Extract<GameRunStepResult, { readonly kind: "decided" }>,
) => {
  const state = toState(run, work.records.rounds, record);
  const applied = Policy.applyResult(state, record.step, result, {
    now: work.now,
    coin: work.input.coin,
    id: work.input.id,
  });
  return land(work, run, state, record, applied, result, "completed");
};

const waitingDecision = (work: Work, run: GameRun, decisionId: string) => {
  const record = inFlightOf(work, run);
  if (run.status !== "waiting" || record === null || record.step.kind !== "decide")
    return refuse(
      "no-decision",
      "The run is not waiting for a decision now; it may have taken its default already.",
    );
  if (record.step.decision.id !== decisionId)
    return refuse(
      "stale-decision",
      `Decision ${decisionId} is not the one waiting; the run waits on ${record.step.decision.id}.`,
    );
  return Result.succeed({ record, step: record.step });
};

const profileSet = (work: Work, command: Command<"game-run.profile.set">) =>
  Result.flatMap(live(work, command.runId), (run) => {
    const switched = { ...run, profile: command.profile };
    const record = inFlightOf(work, run);
    // Nobody needs to answer an Autopilot run: the waiting question takes its default now.
    if (command.profile === "autopilot" && record?.step.kind === "decide")
      return Result.succeed(
        takeDecision(work, switched, record, {
          kind: "decided",
          answer: record.step.decision.fallback,
          notes: "",
          by: "default",
        }),
      );
    const state = toState(switched, work.records.rounds, record);
    return Result.succeed(settle(work, switched, state, state, [], []));
  });

/** A run whose copies nothing can use any more frees them, on its own thread's effects. */
const copiesSpend = (work: Work, command: Command<"game-run.copies.spend">) => {
  const run = work.records.runs.find((each) => each.id === command.runId);
  if (run === undefined) return refuse("no-run", `Run ${command.runId} is not this thread's.`);
  const spent = copiesSpent(run, {
    latest: work.records.runs.at(-1)?.id === run.id,
    chatDeleted: work.records.chatDeleted,
    now: work.now,
    keepMs: command.keepMs,
  });
  if (!spent) return refuse("copies-in-use", `Run ${run.id} may still use its copies.`);
  const latest = work.records.runs.at(-1)?.id === run.id;
  const state = toState(run, work.records.rounds, latest ? inFlightOf(work, run) : null);
  return Result.succeed(
    settle(
      work,
      run,
      state,
      state,
      [],
      [effectFor({ type: "game-run.copies.release", runId: run.id })],
    ),
  );
};

const decideCommand = (work: Work, command: Command<"game-run.decide">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(waitingDecision(work, run, command.decisionId), ({ record, step }) => {
      const checked = Policy.checkAnswer(step.decision, command.answer, command.notes ?? "");
      if ("error" in checked) return refuse("invalid-answer", checked.error);
      return Result.succeed(
        takeDecision(work, run, record, { kind: "decided", ...checked, by: "creator" }),
      );
    }),
  );

const expire = (work: Work, command: Command<"game-run.decision.expire">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(waitingDecision(work, run, command.decisionId), ({ record, step }) =>
      command.nothingToShow !== true && Policy.decisionWait(step, work.now).kind !== "default"
        ? refuse("not-due", `Decision ${step.decision.id} is not due yet.`)
        : Result.succeed(
            takeDecision(work, run, record, {
              kind: "decided",
              answer: step.decision.fallback,
              notes: "",
              by: "default",
            }),
          ),
    ),
  );

/** The run's current step that `stepId` names, with the number of the step or half. */
const currentStep = (work: Work, run: GameRun, stepId: GameRunStepId) => {
  const record = inFlightOf(work, run);
  const seq = record === null ? null : seqIn(record, stepId);
  if (record === null || seq === null)
    return refuse("stale-step", `Step ${stepId} is not the run's current step.`);
  return Result.succeed({ record, seq });
};

const isSubmission = Schema.is(GameRunSubmission);

/** Why a submission does not fit what its step asks for, or null when it does. */
const submissionProblem = (
  state: State.RunState,
  asked: Policy.Asked,
  submission: GameRunSubmission,
): { readonly reason: GameRunRefusalReason; readonly message: string } | null => {
  // The command was decoded at its transport; a ladder's rung count and every
  // length bound are checked again here, where the run relies on them.
  if (!isSubmission(submission))
    return {
      reason: "invalid-submission",
      message:
        "The submission does not have the shape its kind needs (a ladder has 4 to 7 rungs of 2 to 4 checks).",
    };
  if (asked.kind === null)
    return {
      reason: "wrong-kind",
      message: "This step takes no submission: just finish the turn.",
    };
  if (asked.kind !== submission._tag)
    return {
      reason: "wrong-kind",
      message: `This step asks for a ${asked.kind} submission, not ${submission._tag}.`,
    };
  if (submission._tag === "checks" && asked.kind === "checks") {
    const seen = new Set<number>();
    for (const { check } of submission.checks) {
      if (!asked.look.includes(check))
        return {
          reason: "invalid-submission",
          message:
            asked.look.length === 0
              ? "This round has no look checks to score: submit your notes with an empty checks list."
              : `Check ${check} is not a look check of this rung; score checks ${asked.look.join(", ")} (the harness scores the state checks).`,
        };
      if (seen.has(check))
        return { reason: "invalid-submission", message: `Check ${check} is scored twice.` };
      seen.add(check);
    }
  }
  if (submission._tag === "ladder") {
    const ladder = State.ladderOf(submission.rungs);
    if ("error" in ladder) return { reason: "invalid-submission", message: ladder.error };
  }
  if (submission._tag === "ledger" && submission.rungChange !== undefined) {
    const refused = Policy.rungChangeRefused(state, submission.rungChange);
    if (refused !== null)
      return {
        reason: "invalid-submission",
        message: `The ladder change is not taken: ${refused}. Submit the ledger without it.`,
      };
  }
  return null;
};

const submit = (work: Work, command: Command<"game-run.submit">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId), ({ record, seq }) => {
      const role = roleAt(record.step, seq);
      const entry = record.roles.find((r) => r.seq === seq);
      if (role === null || entry === undefined)
        return refuse("wrong-kind", "This step is not a role turn; it takes no submission.");
      // A role's thread is known from game-run.step.start, which its launch
      // dispatches before the role's first turn.
      if (entry.threadId !== command.roleThreadId)
        return refuse("wrong-thread", "This thread is not the role this step runs.");
      if (record.step.kind === "pair" && record.step.results.some((r) => r.id === seq))
        return refuse("stale-step", "This role's turn already finished.");
      const state = toState(run, work.records.rounds, record);
      const problem = submissionProblem(state, Policy.asked(state, role), command.submission);
      if (problem !== null) return refuse(problem.reason, problem.message);
      const updated: GameRunStep = {
        ...record,
        roles: record.roles.map((r) =>
          r.seq === seq ? { ...r, submission: command.submission } : r,
        ),
      };
      return Result.succeed(settle(work, run, state, state, [updated], []));
    }),
  );

/** The ending's finish completed: recovery owes it no more. */
const finished = (work: Work, command: Command<"game-run.finished">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status !== "ended" || run.endedAt !== command.endedAt)
      return refuse("stale-run", `Run ${run.id} no longer holds the ending of ${command.endedAt}.`);
    const state = toState(run, work.records.rounds, inFlightOf(work, run));
    return Result.succeed(
      settle(work, { ...run, finished: command.endedAt }, state, state, [], []),
    );
  });

/**
 * A creator asks for a build back, a kept round's or a saved one by its name:
 * the run records it, a job moves the folder.
 */
const restoreRequest = (work: Work, command: Command<"game-run.restore.request">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status !== "ended")
      return refuse("run-live", `Run ${run.id} is still going; stop it before restoring a build.`);
    const busy = settling(run);
    if (busy !== null) return busy;
    const round = command.round ?? null;
    const build = command.build ?? null;
    if ((round === null) === (build === null))
      return refuse("wrong-kind", "A restore names one kept round or one saved build.");
    if (build !== null && savedBuildOf(build) === null)
      return refuse("wrong-kind", `${build} is not a saved build a restore brings back.`);
    const state = toState(run, work.records.rounds, inFlightOf(work, run));
    const pending: GameRun = {
      ...run,
      restore: { requestId: command.requestId, round, build, requestedAt: work.at, outcome: null },
    };
    return Result.succeed(
      settle(
        work,
        pending,
        state,
        state,
        [],
        [
          effectFor({
            type: "game-run.restore.execute",
            runId: run.id,
            requestId: command.requestId,
          }),
        ],
      ),
    );
  });

/**
 * Whether no way back reaches a run's copies any more, so they may go: its
 * ending is finished, and the run cannot be resumed (its ending, a later run on
 * its chat, its chat deleted) or ended `keepMs` ago. A resume after that makes
 * its copies again.
 */
export const copiesSpent = (
  run: GameRun,
  input: {
    readonly latest: boolean;
    readonly chatDeleted: boolean;
    readonly now: number;
    readonly keepMs: number;
  },
): boolean => {
  if (run.status !== "ended" || run.endedAt === null || settling(run) !== null) return false;
  if (!input.latest || input.chatDeleted || !RESUMABLE.has(run.ending ?? "")) return true;
  return DateTime.toEpochMillis(DateTime.makeUnsafe(run.endedAt)) < input.now - input.keepMs;
};

/** A restore on a stopped run abandons the round it holds; a resume would continue it otherwise. */
export const abandonsRound = (run: GameRun, state: State.RunState): boolean =>
  run.ending !== null && RESUMABLE.has(run.ending) && Policy.holdsRound(state);

/**
 * The restore job's outcome. A restored round becomes the run's judged best; a
 * saved build was never judged better than the best, so the best stays and a
 * resume goes on from it. Either way the round a stopped run held is dropped,
 * its step with it: the folder it worked on is gone.
 */
const restore = (work: Work, command: Command<"game-run.restore">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.restore?.requestId !== command.requestId || run.restore.outcome !== null)
      return refuse("stale-step", `Restore ${command.requestId} is not the one pending.`);
    const landed: GameRun = { ...run, restore: { ...run.restore, outcome: command.outcome } };
    const held = inFlightOf(work, run);
    const state = toState(run, work.records.rounds, held);
    if (command.outcome.kind !== "restored")
      return Result.succeed(settle(work, landed, state, state, [], []));
    const round = run.restore.round;
    const best = round === null ? state : { ...state, best: command.outcome.sha, pending: null };
    if (!abandonsRound(run, state))
      return Result.succeed(settle(work, landed, state, best, [], []));
    const dropped = Policy.abandonRound(
      best,
      `the creator restored ${round === null ? `the saved build ${run.restore.build ?? ""}` : `round ${round}`} (the folder before is build ${BuildName.restoreBefore(command.requestId)})`,
      work.now,
    );
    if (held === null) return Result.succeed(settle(work, landed, state, dropped.state, [], []));
    // The dropped round's copies go with this commit, as a landing's do: the
    // comparison's threads, and the held step's own roles (a blind player still
    // playing is in the step, not yet in the comparison).
    const release = [
      ...new Set([
        ...dropped.release,
        ...held.roles.flatMap((r) => (r.threadId === null ? [] : [r.threadId])),
      ]),
    ];
    const step: GameRunStep = {
      ...held,
      status: "cancelled",
      logs: [...held.logs, ...dropped.logs],
      completedAt: held.completedAt ?? work.at,
    };
    return Result.succeed(
      settle(
        work,
        landed,
        state,
        dropped.state,
        [step],
        outputsEffect(landed, held.id, [], release),
      ),
    );
  });

/** A step's own timer: a role's cap at a later due time, a turn sent again, or its work after a wait for memory or for the game. */
const schedule = (work: Work, command: Command<"game-run.step.schedule">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId), ({ record }) => {
      if (command.attempt !== record.attempt)
        return refuse(
          "stale-attempt",
          `Attempt ${command.attempt} of step ${command.stepId} was superseded.`,
        );
      const state = toState(run, work.records.rounds, record);
      if (command.timer.kind === "recover")
        return Result.succeed(
          settle(
            work,
            run,
            state,
            state,
            [],
            [
              effectFor(
                {
                  type: "game-run.step.wake",
                  runId: run.id,
                  stepId: record.id,
                  attempt: command.attempt,
                },
                command.at,
              ),
            ],
          ),
        );
      if (command.timer.kind === "memory" || command.timer.kind === "busy") {
        const waited: GameRunStep =
          command.timer.kind === "memory"
            ? { ...record, memoryWaits: Math.max(record.memoryWaits ?? 0, command.timer.n) }
            : { ...record, busyWaits: Math.max(record.busyWaits ?? 0, command.timer.n) };
        const wake = effectFor(
          {
            type: "game-run.step.wake",
            runId: run.id,
            stepId: record.id,
            attempt: command.attempt,
          },
          command.at,
        );
        return Result.succeed(settle(work, run, state, state, [waited], [wake]));
      }
      const timer =
        command.timer.kind === "cap"
          ? effectFor(
              {
                type: "game-run.step.deadline",
                runId: run.id,
                stepId: command.stepId,
                attempt: command.attempt,
              },
              command.at,
            )
          : effectFor(
              {
                type: "game-run.step.resend",
                runId: run.id,
                stepId: command.stepId,
                attempt: command.attempt,
                turn: command.timer.turn,
                n: command.timer.n,
              },
              command.at,
            );
      return Result.succeed(settle(work, run, state, state, [], [timer]));
    }),
  );

const stepStart = (work: Work, command: Command<"game-run.step.start">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId), ({ record, seq }) => {
      const state = toState(run, work.records.rounds, record);
      const started = {
        ...record,
        status: "running" as const,
        startedAt: record.startedAt ?? work.at,
      };
      const step = record.step;
      // The question reached the creator's agent: the wait for an answer starts now.
      if (step.kind === "decide") {
        const presented: State.DecideStep = {
          ...step,
          deadline: step.deadline ?? work.now + step.decision.waitMs,
        };
        const deadline = {
          type: "game-run.decision.deadline" as const,
          runId: run.id,
          stepId: record.id,
          decisionId: step.decision.id,
        };
        return Result.succeed(
          settle(
            work,
            run,
            state,
            { ...state, inFlight: presented },
            [{ ...started, step: presented }],
            [effectFor(deadline, Math.max(work.now, decisionDue(presented)))],
          ),
        );
      }
      const role = roleAt(step, seq);
      if (role === null) return Result.succeed(settle(work, run, state, state, [started], []));
      const entry = record.roles.find((r) => r.seq === seq);
      const thread = command.roleThreadId ?? entry?.threadId ?? null;
      // A thread is replaced only by naming it: a deleted or broken thread
      // gives way to a fresh one, and the submission it made goes with it.
      const replacing =
        entry?.threadId != null &&
        command.roleThreadId !== undefined &&
        entry.threadId !== command.roleThreadId;
      if (replacing && command.replaces !== entry?.threadId)
        return refuse("wrong-thread", `Step ${command.stepId} already runs on another thread.`);
      const launched: GameRunStep = {
        ...started,
        roles: started.roles.map((r) =>
          r.seq === seq
            ? { ...r, threadId: thread, ...(replacing ? { submission: null } : {}) }
            : r,
        ),
      };
      const capAt = work.now + role.capMs;
      const cap = {
        type: "game-run.step.deadline" as const,
        runId: run.id,
        stepId: command.stepId,
        attempt: record.attempt,
      };
      return Result.succeed(
        settle(
          work,
          run,
          state,
          state,
          [launched],
          [effectFor(cap, run.budgetEndsAt === null ? capAt : Math.min(capAt, run.budgetEndsAt))],
        ),
      );
    }),
  );

const stepResult = (
  work: Work,
  runId: GameRunId,
  stepId: GameRunStepId,
  attempt: number,
  result: GameRunStepResult,
) =>
  Result.flatMap(live(work, runId), (run) =>
    Result.flatMap(currentStep(work, run, stepId), ({ record, seq }) => {
      if (attempt !== record.attempt)
        return refuse(
          "stale-attempt",
          `Attempt ${attempt} of step ${stepId} was superseded; the step runs as attempt ${record.attempt}.`,
        );
      const step = record.step;
      if (step.kind === "decide")
        return refuse("wrong-kind", "A decision is answered with game-run.decide.");
      const half = step.kind === "pair" ? step.halves.find((h) => h.id === seq) : undefined;
      const kind = half?.kind ?? step.kind;
      if (!(RESULTS[kind] ?? []).includes(result.kind))
        return refuse("wrong-kind", `A ${kind} step cannot finish with a ${result.kind} result.`);
      // The run's own record of the role's submission is the one it validated.
      const submission = record.roles.find((r) => r.seq === seq)?.submission ?? null;
      const landed: GameRunStepResult =
        result.kind === "done"
          ? (() => {
              const { submission: _ignored, ...rest } = result;
              return submission === null ? rest : { ...rest, submission };
            })()
          : result;
      const status = landed.kind === "failed" ? "failed" : "completed";
      const state = toState(run, work.records.rounds, record);
      const input = { now: work.now, coin: work.input.coin, id: work.input.id };
      const own = ownRelease(roleAt(step, seq), landed);
      if (step.kind !== "pair")
        return Result.succeed(
          land(
            work,
            run,
            state,
            record,
            Policy.applyResult(state, step, landed, input),
            landed,
            status,
            own,
          ),
        );
      if (landed.kind === "decided" || !["done", "failed", "bot", "ended"].includes(landed.kind))
        return refuse("wrong-kind", `A pair half cannot finish with a ${landed.kind} result.`);
      if (step.results.some((r) => r.id === seq) || record.endedHalves.some((r) => r.seq === seq))
        return refuse("stale-step", `Step ${stepId} already finished.`);
      // A half that ends the run waits for its partner like any other, so the
      // partner's finished work is recorded before the run ends.
      const endedHalves =
        landed.kind === "ended"
          ? [...record.endedHalves, { seq, result: landed }]
          : record.endedHalves;
      const pair: State.PairStep =
        landed.kind === "done" || landed.kind === "failed" || landed.kind === "bot"
          ? { ...step, results: [...step.results, { id: seq, result: landed }] }
          : step;
      const withPair = { ...state, inFlight: pair };
      const held = { ...record, step: pair, endedHalves };
      if (
        pair.halves.some(
          (h) =>
            !pair.results.some((r) => r.id === h.id) && !endedHalves.some((r) => r.seq === h.id),
        )
      )
        return Result.succeed(
          settle(
            work,
            run,
            state,
            withPair,
            [
              {
                ...held,
                status: "running",
                outputs: { ...held.outputs, release: [...held.outputs.release, ...own] },
              },
            ],
            outputsEffect(run, record.id, [], own),
          ),
        );
      const ended = endedHalves[0]?.result ?? null;
      return Result.succeed(
        land(
          work,
          run,
          withPair,
          held,
          ended === null
            ? Policy.applyPair(withPair, pair, input)
            : Policy.applyResult(withPair, pair, ended, input),
          ended,
          "completed",
          own,
        ),
      );
    }),
  );

export const decide = (
  command: OrchestrationV2GameRunCommand,
  records: GameRunRecords,
  input: GameRunInputs,
): Result.Result<GameRunDecision, GameRunRefusal> => {
  const work: Work = {
    command,
    records,
    input,
    now: DateTime.toEpochMillis(input.at),
    at: DateTime.formatIso(input.at),
  };
  switch (command.type) {
    case "game-run.start":
      return start(work, command);
    case "game-run.resume":
      return resume(work, command);
    case "game-run.stop":
      return stop(work, command);
    case "game-run.steer":
      return steer(work, command);
    case "game-run.profile.set":
      return profileSet(work, command);
    case "game-run.decide":
      return decideCommand(work, command);
    case "game-run.submit":
      return submit(work, command);
    case "game-run.step.start":
      return stepStart(work, command);
    case "game-run.step.complete":
      return stepResult(work, command.runId, command.stepId, command.attempt, command.result);
    case "game-run.step.fail":
      return stepResult(work, command.runId, command.stepId, command.attempt, {
        kind: "failed",
        reason: command.reason,
      });
    case "game-run.decision.expire":
      return expire(work, command);
    case "game-run.finished":
      return finished(work, command);
    case "game-run.restore.request":
      return restoreRequest(work, command);
    case "game-run.step.schedule":
      return schedule(work, command);
    case "game-run.restore":
      return restore(work, command);
    case "game-run.copies.spend":
      return copiesSpend(work, command);
  }
};
