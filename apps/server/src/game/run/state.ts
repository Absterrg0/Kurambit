// PURE. A keep-going run as the loop policy reads it: the run record's own
// fields, and the step records its rounds hold. The decider folds the records
// into this and writes the policy's answer back.
import type {
  GameRun,
  GameRunEnding,
  GameRunProfile,
  GameRunRound,
  GameRunRoundRecord,
} from "@kurambit/contracts";

/** A round that is a keep-going step's record. */
export type StepRecord = GameRunRoundRecord & {
  readonly step: NonNullable<GameRunRoundRecord["step"]>;
};
export type SetAside = NonNullable<GameRun["setAside"]>[number];

export interface RunState {
  readonly profile: GameRunProfile;
  readonly budgetMinutes: number | null;
  /** Epoch ms; null without a budget. */
  readonly budgetEndsAt: number | null;
  readonly steer: ReadonlyArray<string>;
  readonly setAside: ReadonlyArray<SetAside>;
  /** Steps in a row that gained nothing. */
  readonly stallStreak: number;
  readonly lastFailure: string;
  readonly ending: GameRunEnding | null;
  /** This run's step records, oldest first. */
  readonly records: ReadonlyArray<StepRecord>;
  /** The number the chat's next step takes. */
  readonly n: number;
}

/** Every ending resumes but `done`; the ones only an earlier Kurambit wrote never do. */
export const RESUMABLE: ReadonlySet<GameRunEnding> = new Set<GameRunEnding>([
  "stopped",
  "stalled",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "tool-failed",
]);

export const isStepRecord = (round: GameRunRoundRecord): round is StepRecord =>
  round.step !== undefined;

/**
 * The number the chat's next step takes: steps are numbered per chat, across
 * its runs, so "Step 4" names one turn of the chat. A step that never reached
 * a record (superseded, paused) leaves its number to the next.
 */
export const stepNumber = (rounds: ReadonlyArray<GameRunRound>): number =>
  rounds.reduce((max, r) => (isStepRecord(r.round) ? Math.max(max, r.round.round) : max), 0) + 1;

export const toState = (run: GameRun, rounds: ReadonlyArray<GameRunRound>): RunState => ({
  profile: run.profile,
  budgetMinutes: run.budgetMinutes,
  budgetEndsAt: run.budgetEndsAt,
  steer: run.steer,
  setAside: run.setAside ?? [],
  stallStreak: run.stallStreak,
  lastFailure: run.lastFailure,
  ending: run.ending,
  records: rounds
    .filter((r) => r.runId === run.id)
    .map((r) => r.round)
    .filter(isStepRecord)
    .toSorted((a, b) => a.round - b.round),
  n: stepNumber(rounds),
});

/** The run record with the policy's fields; status, seq and inFlight are the decider's. */
export const withState = (run: GameRun, state: RunState): GameRun => ({
  ...run,
  profile: state.profile,
  budgetMinutes: state.budgetMinutes,
  budgetEndsAt: state.budgetEndsAt,
  steer: [...state.steer],
  setAside: [...state.setAside],
  stallStreak: state.stallStreak,
  lastFailure: state.lastFailure,
  ending: state.ending,
});
