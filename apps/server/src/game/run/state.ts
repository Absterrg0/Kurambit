// The run policy's state: the run's records (packages/contracts gameRunRecords.ts)
// as one value the pure policy reads and returns. The run's decider folds
// a run's records into it and its answers back out (orchestration-v2/gameRun).
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GameRunBlock,
  GameRunBotFact,
  GameRunBotStep,
  GameRunCompare,
  GameRunDecided,
  GameRunDecideStep,
  GameRunEvidence,
  GameRunBuildOp,
  type GameRunHalfResult,
  GameRunJudge,
  GameRunLadder,
  GameRunLadderState,
  GameRunPairStep,
  GameRunPending,
  GameRunPicked,
  GameRunPlannedStep,
  GameRunPlayed,
  GameRunProfile,
  GameRunQuestion,
  GameRunRoleDone,
  GameRunRoleStep,
  GameRunRoundRecord,
  GameRunRoundTask,
  GameRunRung,
  type GameRunRungCheck,
  type GameRunRungChange,
  GameRunRungRecord,
  GameRunSample,
  GameRunSide,
  type GameRunStepResult,
  GameRunTask,
  GameRunVerdict,
} from "@kurambit/contracts";
import { MAX_INPUT_MS, inputMs, parseExpect } from "./checks.ts";

export type Verdict = GameRunVerdict;

// ── The demo ladder. The plan role submits it; code checks only its shape,
// the rungs are the model's judgment.
export type RungCheck = GameRunRungCheck;
export const isStateCheck = (c: RungCheck): boolean => c.kind === "state";
export type Rung = GameRunRung;
export type Ladder = GameRunLadderState;

// A creator's ladder edit arrives as the JSON of a ladder in a decision's notes.
const decodeLadderJson = Schema.decodeUnknownResult(Schema.fromJsonString(GameRunLadder), {
  errors: "all",
});

/** What is wrong with one check beyond its JSON shape, or null. */
const checkProblem = (c: RungCheck, where: string): string | null => {
  if (c.kind !== "state")
    return (c.how ?? "").trim().length === 0 ? `${where}: a look check needs "how"` : null;
  if (c.expect === undefined) return `${where}: a state check needs "expect"`;
  const parsed = parseExpect(c.expect);
  if ("error" in parsed) return `${where}: ${parsed.error}`;
  const input = c.input ?? [];
  if (input.some((s) => ("ms" in s && !(s.ms > 0)) || ("wait" in s && !(s.wait >= 0))))
    return `${where}: input times are positive milliseconds`;
  if (inputMs(input) > MAX_INPUT_MS)
    return `${where}: input adds up to more than ${MAX_INPUT_MS / 1000} s of game time`;
  return null;
};
/** What is wrong with a rung's checks beyond their shape, or null. */
const rungProblem = (r: { readonly checks: ReadonlyArray<RungCheck> }, where: string) =>
  r.checks.map((c, k) => checkProblem(c, `${where} check ${k + 1}`)).find((x) => x !== null) ??
  null;

type LadderRungs = GameRunLadder["rungs"];

/** A ladder's rungs as a fresh ladder, or what is wrong with them. */
export const ladderOf = (
  rungs: LadderRungs,
): { readonly ladder: Ladder } | { readonly error: string } => {
  const problem = rungs.map((r, i) => rungProblem(r, `rung ${i + 1}`)).find((x) => x !== null);
  if (problem !== undefined && problem !== null) return { error: problem };
  return {
    ladder: {
      rungs: rungs.map((r, i) => ({
        id: i + 1,
        ...r,
        status: "todo",
        fails: 0,
        back: false,
        why: "",
        from: "plan",
      })),
      note: "",
    },
  };
};

/** A ladder's JSON (a creator's edit) as a fresh ladder, or what is wrong with its shape. */
export const parseLadder = (
  text: string,
): { readonly ladder: Ladder } | { readonly error: string } => {
  if (text.trim().length === 0) return { error: "the ladder is empty" };
  const decoded = decodeLadderJson(text);
  if (Result.isFailure(decoded)) return { error: decoded.failure.message.slice(0, 1500) };
  return ladderOf(decoded.success.rungs);
};

/** A reviewer's proposed rung as a ladder rung, or what is wrong with it. */
export const rungOfChange = (
  change: GameRunRungChange,
  id: number,
): { readonly rung: Rung } | { readonly error: string } => {
  const problem = rungProblem(change, "the rung");
  if (problem !== null) return { error: problem };
  const { why, ...rung } = change;
  return { rung: { id, ...rung, status: "todo", fails: 0, back: false, why, from: "reviewer" } };
};

export type RungResult = GameRunRungRecord;
export type RoundRecord = GameRunRoundRecord;

const ThreadRef = Schema.Struct({
  role: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type ThreadRef = typeof ThreadRef.Type;

export type Pending = GameRunPending;
export type Evidence = GameRunEvidence;
export type Side = GameRunSide;

/**
 * A comparator's checkout: one parentless commit of the empty tree, so its
 * folder, HEAD and log hold nothing of either build or of the run.
 */
export const BLANK = "blank";

export type BuildOp = GameRunBuildOp;
export type RoleDone = GameRunRoleDone;
export type StepResult = GameRunStepResult;
export type HalfResult = GameRunHalfResult;
export type Decision = GameRunQuestion;
export type DecideStep = GameRunDecideStep;
export type Decided = GameRunDecided;
export type Step = GameRunPlannedStep;
export type RoleStep = GameRunRoleStep;
export type BotStep = GameRunBotStep;
export type PairStep = GameRunPairStep;
export type Half = PairStep["halves"][number];
export type Block = GameRunBlock;
export type Sample = GameRunSample;
export type Judge = GameRunJudge;
export type BotFact = GameRunBotFact;
export type Compare = GameRunCompare;
export type Played = GameRunPlayed;
export type Round = GameRunRoundTask;
export type Picked = GameRunPicked;
export type Task = GameRunTask;

const RunState = Schema.Struct({
  version: Schema.Literal(3),
  runId: Schema.String,
  profile: GameRunProfile,
  decided: Schema.Array(GameRunDecided),
  buildNotes: Schema.String,
  brief: Schema.String,
  artDirection: Schema.String,
  budgetMinutes: Schema.NullOr(Schema.Number),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  stage: Schema.String,
  ending: Schema.NullOr(Schema.String),
  stallStreak: Schema.Number,
  lastFailure: Schema.String,
  shipNoReasons: Schema.String,
  rounds: Schema.Array(GameRunRoundRecord),
  /** The role threads the run launched, from its step records; status views read their times. */
  threads: Schema.Array(ThreadRef),
  pending: Schema.NullOr(GameRunPending),
  seq: Schema.Number,
  budgetEndsAt: Schema.NullOr(Schema.Number),
  lane: Schema.String,
  best: Schema.String,
  protos: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      booted: Schema.Boolean,
      sha: Schema.optionalKey(Schema.String),
    }),
  ),
  pickNotes: Schema.String,
  picked: Schema.NullOr(GameRunPicked),
  // The last reviewer's ledger.
  next: Schema.String,
  lastDirection: Schema.String,
  // null until the plan submitted one.
  ladder: Schema.NullOr(GameRunLadderState),
  // The creator's notes for the next round.
  steer: Schema.Array(Schema.String),
  creator: Schema.String,
  played: Schema.NullOr(GameRunPlayed),
  task: GameRunTask,
  inFlight: Schema.NullOr(GameRunPlannedStep),
});
export type RunState = typeof RunState.Type;

export type NewRunInput = {
  readonly runId: string;
  readonly profile: RunState["profile"];
  readonly brief: string;
  readonly artDirection: string;
  readonly budgetMinutes: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly variant: string | null;
  readonly startedAt: string;
};

export const freshState = (
  input: NewRunInput,
  history: { readonly rounds: ReadonlyArray<RoundRecord>; readonly pending: Pending | null },
): RunState => ({
  version: 3,
  ...input,
  decided: [],
  buildNotes: "",
  stage: "starting",
  ending: null,
  stallStreak: 0,
  lastFailure: "",
  shipNoReasons: "",
  rounds: history.rounds,
  threads: [],
  pending: history.pending,
  seq: 0,
  budgetEndsAt: null,
  lane: "",
  best: "",
  protos: [],
  pickNotes: "",
  picked: null,
  next: "",
  lastDirection: "",
  ladder: null,
  steer: [],
  creator: "",
  played: null,
  task: { _tag: "init" },
  inFlight: null,
});
