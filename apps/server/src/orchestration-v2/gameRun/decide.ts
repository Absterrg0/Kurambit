// PURE. Keep going as an orchestration domain: for each game-run command, the
// thread's game-run records in, the events, outbox effects or a typed refusal
// out. Every keep-going choice is the loop policy's (game/run/loop.ts); this
// module folds the records into its state and its answers back out. A run
// without `loop: "turns"` was made by an earlier Kurambit (the stage era): it
// is only read and stopped.
import {
  GAME_ENGINES,
  type GameRun,
  type GameRunId,
  type GameRunRefusalReason,
  type GameRunRound,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type GameRunTurnStep,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameRunCommand,
  type ProjectId,
  gameRunRoundId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import * as Loop from "../../game/run/loop.ts";
import { STAGE_ERA_SENTENCE } from "../../game/run/runView.ts";
import * as State from "../../game/run/state.ts";
import type { OrchestrationEffectRequestV2 } from "../EffectOutbox.ts";

export interface GameRunRecords {
  readonly projectId: ProjectId;
  /** The game's latest run on any of its project's threads: the folder is the project's. */
  readonly projectRun: GameRun | null;
  /** The thread's runs, oldest first. */
  readonly runs: ReadonlyArray<GameRun>;
  /** The thread's rounds across its runs: a chat's step numbers continue from run to run. */
  readonly rounds: ReadonlyArray<GameRunRound>;
  /** The latest run's step in flight, when it holds one. */
  readonly inFlight: GameRunStep | null;
  /** The thread was deleted: nothing resumes its runs. */
  readonly chatDeleted: boolean;
  /**
   * The in-flight step's cycle: the two steps planned just before it (a
   * proposal's look, a judge's turn, an undo's judge and turn).
   */
  readonly steps: ReadonlyArray<GameRunStep>;
}

interface GameRunInputs {
  readonly at: DateTime.Utc;
  /** Uniform in [0, 1). */
  readonly coin: number;
  /** Fresh and unguessable. */
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
/** The effects a stop cancels: every live one keep going plans. */
export const GAME_RUN_EFFECT_TYPES = [
  "game-run.step.execute",
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

const refuse = (reason: GameRunRefusalReason, message: string) =>
  Result.fail<GameRunRefusal>({ reason, message });

interface Work {
  readonly command: OrchestrationV2GameRunCommand;
  readonly records: GameRunRecords;
  readonly input: GameRunInputs;
  readonly now: number;
  readonly at: string;
}

const runEvent = (work: Work, payload: GameRun, created = false): GameRunEvent => ({
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

type Command<T extends OrchestrationV2GameRunCommand["type"]> = Extract<
  OrchestrationV2GameRunCommand,
  { readonly type: T }
>;
type ResultOf<K extends string> = Extract<GameRunStepResult, { readonly kind: K }>;
const resultOf = <K extends GameRunStepResult["kind"] & string>(
  result: GameRunStepResult,
  kind: K,
): ResultOf<K> | null => (result.kind === kind ? (result as ResultOf<K>) : null);

const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/** The command's run: the thread's latest, which the command must name. */
const current = (work: Work, runId: GameRunId) => {
  const run = work.records.runs.at(-1);
  if (run === undefined) return refuse("no-run", "This chat has no keep-going run.");
  if (run.id !== runId)
    return refuse("stale-run", `Run ${runId} is not this chat's current run (${run.id} is).`);
  return Result.succeed(run);
};

const live = (work: Work, runId: GameRunId) =>
  Result.flatMap(current(work, runId), (run) =>
    run.status === "ended"
      ? refuse("run-ended", `Keep going ended (${run.ending ?? "unknown"}).`)
      : Result.succeed(run),
  );

const inFlightOf = (work: Work, run: GameRun) =>
  run.inFlight !== null && work.records.inFlight?.seq === run.inFlight
    ? work.records.inFlight
    : null;

/** The step `stepId` names, when it is the run's step in flight, for this attempt. */
const currentStep = (work: Work, run: GameRun, stepId: GameRunStepId, attempt?: number) => {
  const record = inFlightOf(work, run);
  if (record === null || record.id !== stepId)
    return refuse("stale-step", `Step ${stepId} is not keep going's current step.`);
  if (attempt !== undefined && attempt !== record.attempt)
    return refuse(
      "stale-attempt",
      `Attempt ${attempt} of step ${stepId} was superseded; the step runs as attempt ${record.attempt}.`,
    );
  return Result.succeed(record);
};

/** A step of the in-flight cycle, `back` steps before the one in flight. */
const cycleStep = (work: Work, record: GameRunStep, back: number) =>
  work.records.steps.find((s) => s.runId === record.runId && s.seq === record.seq - back) ?? null;

const planned = (seq: number, plan: Loop.Plan): GameRunStep["step"] => {
  switch (plan.kind) {
    case "look":
      return { kind: "look", id: seq };
    case "propose":
      return { kind: "propose", id: seq, proposal: plan.proposal, deadline: plan.deadline };
    case "turn":
      return { ...plan, id: seq };
    case "judge":
      return { kind: "judge", id: seq, build: plan.build, base: plan.base };
    case "undo":
      return { kind: "undo", id: seq, target: plan.target, expect: plan.expect };
  }
};

const newStep = (work: Work, run: GameRun, seq: number, plan: Loop.Plan, log: string) => {
  const step = planned(seq, plan);
  return {
    id: gameRunStepId(run.id, seq),
    runId: run.id,
    threadId: run.threadId,
    seq,
    attempt: 1,
    kind: plan.kind,
    step,
    status: "planned",
    result: null,
    logs: log === "" ? [] : [log],
    plannedAt: work.at,
    startedAt: null,
    completedAt: null,
  } satisfies GameRunStep;
};

/** A planned step's effect: a proposal's deadline, or the job that does the step's work. */
const effectsOf = (record: GameRunStep): GameRunEffect[] =>
  record.step.kind === "propose"
    ? record.step.deadline === null
      ? []
      : [
          {
            request: {
              type: "game-run.decision.deadline",
              runId: record.runId,
              stepId: record.id,
              decisionId: record.id,
            },
            availableAt: record.step.deadline,
          },
        ]
    : [
        {
          request: {
            type: "game-run.step.execute",
            runId: record.runId,
            stepId: record.id,
            attempt: record.attempt,
          },
        },
      ];

/** A judge or an undo cut off by a pause runs again on resume; any other step looks afresh. */
const keptOnPause = (record: GameRunStep | null) =>
  record !== null && (record.step.kind === "judge" || record.step.kind === "undo");

/**
 * The policy's answer becomes the run's records: the step records it touched,
 * the step's round when one finished, the next step and its effect, and the run.
 */
const land = (
  work: Work,
  run: GameRun,
  next: Loop.Next,
  touched: ReadonlyArray<GameRunStep>,
  options: { readonly created?: boolean; readonly held?: GameRunStep | null } = {},
): GameRunDecision => {
  const ended = next.state.ending !== null;
  const seq = next.plan === null ? run.seq : run.seq + 1;
  const step = next.plan === null ? null : newStep(work, run, seq, next.plan, next.log);
  const held = ended && keptOnPause(options.held ?? null) ? (options.held?.seq ?? null) : null;
  const updated: GameRun = {
    ...State.withState(run, next.state),
    status: ended ? "ended" : step?.step.kind === "propose" ? "waiting" : "running",
    seq,
    inFlight: ended ? held : (step?.seq ?? null),
    endedAt: ended ? work.at : run.endedAt,
    updatedAt: work.at,
  };
  const round: GameRunRound[] =
    next.record === null
      ? []
      : [
          {
            id: gameRunRoundId(run.id, next.record.round),
            runId: run.id,
            threadId: run.threadId,
            round: next.record,
            recordedAt: work.at,
          },
        ];
  return {
    events: [
      ...touched.map((each) => stepEvent(work, each)),
      ...(step === null ? [] : [stepEvent(work, step)]),
      ...round.map((each) => roundEvent(work, each)),
      runEvent(work, updated, options.created === true),
    ],
    effects: step === null ? [] : effectsOf(step),
    cancelEffects: false,
  };
};

const finished = (
  work: Work,
  record: GameRunStep,
  result: GameRunStepResult,
  log: string,
): GameRunStep => ({
  ...record,
  status: result.kind === "failed" ? "failed" : "completed",
  result,
  logs: log === "" ? record.logs : [...record.logs, log],
  completedAt: work.at,
});

const stateOf = (work: Work, run: GameRun) => State.toState(run, work.records.rounds);

// ── Commands. ───────────────────────────────────────────────────────────────
const start = (work: Work, command: Command<"game-run.start">) => {
  const prior = work.records.runs.at(-1) ?? null;
  if (prior !== null && prior.status !== "ended")
    return refuse("run-live", "Keep going is already on in this chat.");
  // One run per game: another chat of the same project may hold it.
  const elsewhere = work.records.projectRun;
  if (elsewhere !== null && elsewhere.status !== "ended")
    return refuse("run-live", "Keep going is on in another chat of this game.");
  if (!GAME_ENGINES[command.engine].turnLoop)
    return refuse(
      "no-turn-loop",
      "Keep going needs an engine Kurambit plays after every turn (three.js).",
    );
  if (work.records.runs.some((r) => r.id === command.runId))
    return refuse("stale-run", `Run ${command.runId} already exists in this chat.`);
  // The person's waiting notes outlive a run: a new one on the game takes them up.
  const carried =
    elsewhere !== null && !State.stageEra(elsewhere)
      ? elsewhere.steer
      : prior !== null && !State.stageEra(prior)
        ? prior.steer
        : [];
  const run: GameRun = {
    id: command.runId,
    threadId: command.threadId,
    loop: "turns",
    projectId: work.records.projectId,
    lane: command.lane,
    engine: command.engine,
    profile: command.profile,
    budgetMinutes: command.budgetMinutes,
    budgetEndsAt: command.budgetMinutes === null ? null : work.now + command.budgetMinutes * 60_000,
    status: "running",
    ending: null,
    steer: [...carried],
    setAside: [],
    stallStreak: 0,
    lastFailure: "",
    seq: 0,
    inFlight: null,
    endedAt: null,
    startedAt: work.at,
    updatedAt: work.at,
  };
  const state = stateOf(work, run);
  return Result.succeed(
    land(
      work,
      run,
      { state, plan: { kind: "look" }, record: null, log: "keep going started" },
      [],
      {
        created: true,
      },
    ),
  );
};

const resume = (work: Work, command: Command<"game-run.resume">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status !== "ended") return refuse("run-live", "Keep going is already on.");
    if (State.stageEra(run)) return refuse("not-resumable", STAGE_ERA_SENTENCE);
    if (run.ending === null || !State.RESUMABLE.has(run.ending))
      return refuse(
        "not-resumable",
        "Keep going finished on this game; turning it on starts it afresh.",
      );
    const elsewhere = work.records.projectRun;
    if (elsewhere !== null && elsewhere.id !== run.id && elsewhere.status !== "ended")
      return refuse("run-live", "Keep going is on in another chat of this game.");
    const budgetMinutes =
      command.budgetMinutes === undefined ? run.budgetMinutes : command.budgetMinutes;
    const resumed: GameRun = {
      ...run,
      profile: command.profile ?? run.profile,
      budgetMinutes,
      budgetEndsAt: budgetMinutes === null ? null : work.now + budgetMinutes * 60_000,
      ending: null,
      lastFailure: "",
      // A resume starts the stall count afresh, so it always takes a step.
      stallStreak: 0,
    };
    const state = stateOf(work, resumed);
    const held = inFlightOf(work, run);
    if (keptOnPause(held) && held !== null) {
      // The judge or undo the pause cut off runs again, as a new attempt.
      const again: GameRunStep = {
        ...held,
        attempt: held.attempt + 1,
        status: "planned",
        result: null,
        logs: [...held.logs, "keep going resumed: this step runs again"],
        toolWaits: 0,
        startedAt: null,
        completedAt: null,
      };
      return Result.succeed<GameRunDecision>({
        events: [
          stepEvent(work, again),
          runEvent(work, {
            ...resumed,
            status: "running",
            inFlight: held.seq,
            updatedAt: work.at,
          }),
        ],
        effects: effectsOf(again),
        cancelEffects: false,
      });
    }
    return Result.succeed(
      land(
        work,
        resumed,
        {
          state,
          plan: { kind: "look" },
          record: null,
          log: "keep going resumed",
        },
        [],
      ),
    );
  });

/**
 * Off, or the server's own pause for a tool that kept failing. The step in
 * flight is cancelled; a judge or undo stays the run's for a resume to run
 * again. A step turn that had started gives its notes back (K14). A
 * stage-era run takes this and nothing else.
 */
const stop = (work: Work, command: Command<"game-run.stop">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status === "ended")
      return refuse("run-ended", `Keep going ended (${run.ending ?? "unknown"}).`);
    const inFlight = inFlightOf(work, run);
    const why = command.reason?.trim() ?? "";
    // The server's own stop for a tool that kept failing is a pause with its
    // reason, never the person's act.
    const paused = command.ending === "tool-failed";
    const line = paused ? `paused: ${why}` : `stopped${why.length > 0 ? `: ${why}` : ""}`;
    const steps =
      inFlight === null
        ? []
        : [
            {
              ...inFlight,
              status: "cancelled" as const,
              logs: [...inFlight.logs, line],
              completedAt: work.at,
            },
          ];
    const turn = inFlight?.step.kind === "turn" ? inFlight.step : null;
    const giveBack = turn !== null && inFlight?.status === "running" && turn.steer.length > 0;
    const ended: GameRun = {
      ...run,
      status: "ended",
      ending: paused ? "tool-failed" : "stopped",
      // A stage-era run keeps its last failure when stopped without a reason.
      lastFailure: why.length > 0 ? why.slice(0, 600) : State.stageEra(run) ? run.lastFailure : "",
      steer: giveBack ? [...turn.steer, ...run.steer] : run.steer,
      inFlight: !State.stageEra(run) && keptOnPause(inFlight) ? run.inFlight : null,
      endedAt: work.at,
      updatedAt: work.at,
    };
    return Result.succeed<GameRunDecision>({
      events: [...steps.map((step) => stepEvent(work, step)), runEvent(work, ended)],
      effects: [],
      cancelEffects: true,
    });
  });

/**
 * The look before a pending proposal: the folder its turn starts from. A
 * proposal is planned right after its look.
 */
const proposalBase = (work: Work, record: GameRunStep) => {
  const look = cycleStep(work, record, 1);
  const result = look?.result == null ? null : resultOf(look.result, "look");
  return result?.current ?? null;
};

/** The pending proposal gives way: it is answered, then the policy goes on from `next`. */
const answerProposal = (
  work: Work,
  run: GameRun,
  record: GameRunStep,
  result: ResultOf<"decided">,
  next: Loop.Next,
) => land(work, run, next, [finished(work, record, result, next.log)]);

/**
 * The person's note for the next step, from any chat of the game. A live run
 * takes it at its next look; a pending Guided proposal gives way to it at
 * once, since the person asked for it. An ended run keeps it for its resume.
 */
const steer = (work: Work, command: Command<"game-run.steer">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (State.stageEra(run)) return refuse("not-resumable", STAGE_ERA_SENTENCE);
    const noted: GameRun = { ...run, steer: [...run.steer, command.note.trim()] };
    const state = stateOf(work, noted);
    const record = run.status === "ended" ? null : inFlightOf(work, run);
    if (record?.step.kind === "propose") {
      const proposal = Loop.steerProposal(state);
      if (proposal !== null && !state.setAside.some((entry) => entry.key === proposal.key))
        return Result.succeed(
          answerProposal(
            work,
            noted,
            record,
            { kind: "decided", answer: "superseded", by: "creator" },
            Loop.startTurn(state, proposal, proposalBase(work, record), "creator", work.now),
          ),
        );
    }
    return Result.succeed<GameRunDecision>({
      events: [runEvent(work, { ...noted, updatedAt: work.at })],
      effects: [],
      cancelEffects: false,
    });
  });

const profileSet = (work: Work, command: Command<"game-run.profile.set">) =>
  Result.flatMap(live(work, command.runId), (run) => {
    if (State.stageEra(run)) return refuse("not-resumable", STAGE_ERA_SENTENCE);
    const switched: GameRun = { ...run, profile: command.profile };
    const record = inFlightOf(work, run);
    // Nobody needs to answer Autopilot: the pending proposal starts now.
    if (command.profile === "autopilot" && record?.step.kind === "propose")
      return Result.succeed(
        answerProposal(
          work,
          switched,
          record,
          { kind: "decided", answer: "start", by: "server" },
          Loop.startTurn(
            stateOf(work, switched),
            record.step.proposal,
            proposalBase(work, record),
            "autopilot",
            work.now,
          ),
        ),
      );
    return Result.succeed<GameRunDecision>({
      events: [runEvent(work, { ...switched, updatedAt: work.at })],
      effects: [],
      cancelEffects: false,
    });
  });

const pendingProposal = (work: Work, run: GameRun, decisionId: string) => {
  const record = inFlightOf(work, run);
  if (record === null || record.step.kind !== "propose")
    return refuse(
      "no-decision",
      "Keep going has no proposal waiting now; it may have started already.",
    );
  if (record.id !== decisionId)
    return refuse(
      "stale-decision",
      `Proposal ${decisionId} is not the one waiting; ${record.id} is.`,
    );
  return Result.succeed({ record, step: record.step });
};

/** K9: Start now, Skip, or hold the proposal while the person edits it. */
const decideCommand = (work: Work, command: Command<"game-run.decide">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(pendingProposal(work, run, command.decisionId), ({ record, step }) => {
      if (command.answer === "hold") {
        // The deadline effect still fires, and finds nothing due.
        const held: GameRunStep = {
          ...record,
          step: { ...step, deadline: null },
          logs: [...record.logs, "held for the person"],
        };
        return Result.succeed<GameRunDecision>({
          events: [stepEvent(work, held), runEvent(work, { ...run, updatedAt: work.at })],
          effects: [],
          cancelEffects: false,
        });
      }
      return Result.succeed(
        answerProposal(
          work,
          run,
          record,
          { kind: "decided", answer: command.answer, by: "creator" },
          Loop.applyDecided(
            stateOf(work, run),
            step.proposal,
            proposalBase(work, record),
            command.answer,
            "creator",
            work.now,
          ),
        ),
      );
    }),
  );

/** The proposal's deadline fired: the default starts it, unless it was held or answered. */
const expire = (work: Work, command: Command<"game-run.decision.expire">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(pendingProposal(work, run, command.decisionId), ({ record, step }) =>
      step.deadline === null || work.now < step.deadline
        ? refuse("not-due", `Proposal ${record.id} is not due.`)
        : Result.succeed(
            answerProposal(
              work,
              run,
              record,
              { kind: "decided", answer: "start", by: "default" },
              Loop.applyDecided(
                stateOf(work, run),
                step.proposal,
                proposalBase(work, record),
                "start",
                "default",
                work.now,
              ),
            ),
          ),
    ),
  );

/** A step's timer, set by its own work: the turn's cap again, a resend, or its work again later. */
const schedule = (work: Work, command: Command<"game-run.step.schedule">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId, command.attempt), (record) => {
      const base = { runId: run.id, stepId: record.id, attempt: record.attempt };
      const timer = command.timer;
      const effect: GameRunEffect =
        timer.kind === "cap"
          ? { request: { type: "game-run.step.deadline", ...base }, availableAt: command.at }
          : timer.kind === "resend"
            ? {
                request: { type: "game-run.step.resend", ...base, turn: timer.turn, n: timer.n },
                availableAt: command.at,
              }
            : { request: { type: "game-run.step.wake", ...base }, availableAt: command.at };
      const waited =
        timer.kind === "tool"
          ? [{ ...record, toolWaits: Math.max(record.toolWaits ?? 0, timer.n) }]
          : [];
      return Result.succeed<GameRunDecision>({
        events: waited.map((each) => stepEvent(work, each)),
        effects: [effect],
        cancelEffects: false,
      });
    }),
  );

/**
 * A step's work began. A turn step's turn is running: it takes the notes it
 * carries off the front of the run's steer (K14) and starts its cap.
 */
const stepStart = (work: Work, command: Command<"game-run.step.start">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId, command.attempt), (record) => {
      if (record.status === "running")
        return Result.succeed<GameRunDecision>({ events: [], effects: [], cancelEffects: false });
      const started: GameRunStep = { ...record, status: "running", startedAt: work.at };
      if (record.step.kind !== "turn")
        return Result.succeed<GameRunDecision>({
          events: [stepEvent(work, started)],
          effects: [],
          cancelEffects: false,
        });
      const turn = record.step;
      return Result.succeed<GameRunDecision>({
        events: [
          stepEvent(work, started),
          runEvent(work, {
            ...run,
            steer: run.steer.slice(turn.steer.length),
            updatedAt: work.at,
          }),
        ],
        effects: [
          {
            request: {
              type: "game-run.step.deadline",
              runId: run.id,
              stepId: record.id,
              attempt: record.attempt,
            },
            availableAt: work.now + turn.capMs,
          },
        ],
        cancelEffects: false,
      });
    }),
  );

/** A turn and what it landed, read back from the turn step's record. */
const cycleOf = (work: Work, turnRecord: GameRunStep | null): Loop.Cycle | null => {
  if (turnRecord === null || turnRecord.step.kind !== "turn" || turnRecord.result === null)
    return null;
  const result = resultOf(turnRecord.result, "turn");
  return result === null
    ? null
    : {
        turn: turnRecord.step,
        result,
        since: epoch(turnRecord.startedAt ?? turnRecord.plannedAt),
      };
};

/** What a step's result leads to, by the kind of step it reports on. */
const nextOf = (
  work: Work,
  run: GameRun,
  record: GameRunStep,
  result: GameRunStepResult,
): Result.Result<Loop.Next, GameRunRefusal> => {
  // A started turn that ends without landing gives back the notes its start
  // took (K14), whichever way it ends.
  const state =
    (result.kind === "ended" || result.kind === "failed") &&
    record.step.kind === "turn" &&
    record.status === "running"
      ? Loop.giveBackSteer(stateOf(work, run), record.step, true)
      : stateOf(work, run);
  // Nothing was measured: the run pauses with why, and judges nothing (a
  // judge or undo runs again on resume).
  const ended = resultOf(result, "ended");
  if (ended !== null)
    return Result.succeed({
      state: { ...state, ending: ended.ending, lastFailure: ended.reason.slice(0, 600) },
      plan: null,
      record: null,
      log: `paused (${ended.ending}): ${ended.reason}`,
    });
  const failed = resultOf(result, "failed");
  if (failed !== null)
    return Result.succeed({
      state: { ...state, ending: "failed", lastFailure: failed.reason.slice(0, 600) },
      plan: null,
      record: null,
      log: `failed: ${failed.reason}`,
    });
  const wrong = () =>
    refuse("wrong-kind", `A ${record.step.kind} step cannot finish with a ${result.kind} result.`);
  const step = record.step;
  switch (step.kind) {
    case "look": {
      const look = resultOf(result, "look");
      return look === null ? wrong() : Result.succeed(Loop.applyLook(state, look, work.now));
    }
    case "propose": {
      // Only the server reports on a proposal: a turn started on the game (K2.4).
      const decided = resultOf(result, "decided");
      return decided === null || decided.answer !== "superseded"
        ? refuse("wrong-kind", "A proposal is answered with game-run.decide.")
        : Result.succeed(
            Loop.applyDecided(state, step.proposal, null, "superseded", "server", work.now),
          );
    }
    case "turn": {
      const turn = resultOf(result, "turn");
      return turn === null
        ? wrong()
        : Result.succeed(
            Loop.applyTurn(state, step as GameRunTurnStep, turn, {
              now: work.now,
              since: epoch(record.startedAt ?? record.plannedAt),
              started: record.status === "running",
            }),
          );
    }
    case "judge": {
      const judge = resultOf(result, "judge");
      const cycle = cycleOf(work, cycleStep(work, record, 1));
      if (judge === null) return wrong();
      if (cycle === null)
        return refuse("stale-step", `Step ${record.id} has no turn record to judge.`);
      return Result.succeed(Loop.applyJudge(state, cycle, judge, work.now));
    }
    case "undo": {
      const undo = resultOf(result, "undo");
      const judgeRecord = cycleStep(work, record, 1);
      const judge = judgeRecord?.result == null ? null : resultOf(judgeRecord.result, "judge");
      const cycle = cycleOf(work, cycleStep(work, record, 2));
      if (undo === null) return wrong();
      if (judge === null || cycle === null)
        return refuse("stale-step", `Step ${record.id} has no judged turn to undo.`);
      return Result.succeed(Loop.applyUndo(state, { ...cycle, judge }, undo, work.now));
    }
    default:
      return refuse("not-resumable", STAGE_ERA_SENTENCE);
  }
};

const stepResult = (
  work: Work,
  runId: GameRunId,
  stepId: GameRunStepId,
  attempt: number,
  result: GameRunStepResult,
) =>
  Result.flatMap(live(work, runId), (run) =>
    Result.flatMap(currentStep(work, run, stepId, attempt), (record) =>
      Result.map(nextOf(work, run, record, result), (next) =>
        land(work, run, next, [finished(work, record, result, next.log)], {
          // Only a pause keeps its judge or undo for the resume; an ending the
          // step's own result led to (stalled, budget) has nothing left owed.
          held: result.kind === "ended" || result.kind === "failed" ? record : null,
        }),
      ),
    ),
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
  if (command.type === "game-run.stop") return stop(work, command);
  if (command.type === "game-run.start") return start(work, command);
  // A stage-era run takes only a stop (K12).
  const latest = records.runs.at(-1);
  if (latest !== undefined && latest.id === command.runId && State.stageEra(latest))
    return refuse("not-resumable", STAGE_ERA_SENTENCE);
  switch (command.type) {
    case "game-run.resume":
      return resume(work, command);
    case "game-run.steer":
      return steer(work, command);
    case "game-run.profile.set":
      return profileSet(work, command);
    case "game-run.decide":
      return decideCommand(work, command);
    case "game-run.decision.expire":
      return expire(work, command);
    case "game-run.step.start":
      return stepStart(work, command);
    case "game-run.step.complete":
      return stepResult(work, command.runId, command.stepId, command.attempt, command.result);
    case "game-run.step.fail":
      return stepResult(work, command.runId, command.stepId, command.attempt, {
        kind: "failed",
        reason: command.reason,
      });
    case "game-run.step.schedule":
      return schedule(work, command);
  }
};
