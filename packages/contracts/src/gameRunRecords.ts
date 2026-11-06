import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { GameEngineId } from "./game.ts";
import { GameBotDecider, GameBotPerf } from "./gameBot.ts";
import {
  GameRunDecisionKind,
  GameRunRestoreRefusal,
  GameRunProfile,
  GameRunRungFields,
  GameRunSubmission,
} from "./gameRun.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * The production run as records of the game's creator thread: the run, its
 * steps and its rounds. Each event carries the new full record of one entity.
 * The shapes below the ids are the run policy's own state; bulky evidence
 * (tester notes, sample reports, comparisons, frames) stays under `.studio/`
 * and is referenced by path.
 */

export const GameRunId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunId"));
export type GameRunId = typeof GameRunId.Type;
export const GameRunStepId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunStepId"));
export type GameRunStepId = typeof GameRunStepId.Type;
const GameRunRoundId = TrimmedNonEmptyString.pipe(Schema.brand("GameRunRoundId"));
export type GameRunRoundId = typeof GameRunRoundId.Type;

/** A step's id: its number within the run. A pair's halves have numbers of their own. */
export const gameRunStepId = (runId: GameRunId, seq: number): GameRunStepId =>
  GameRunStepId.make(`${runId}:step:${seq}`);
export const gameRunRoundId = (runId: GameRunId, round: number): GameRunRoundId =>
  GameRunRoundId.make(`${runId}:round:${round}`);
/**
 * The command id that reports a step's work. A step that runs again after a
 * resume is a new attempt, so its report never meets the receipt of an earlier one.
 */
export const gameRunStepCommandId = (
  stepId: GameRunStepId,
  attempt: number,
  action: "start" | "complete" | "fail",
): CommandId => CommandId.make(`game-run:${stepId}:attempt:${attempt}:${action}`);

// ── The demo ladder as the run holds it. ───────────────────────────────────
export const GameRunRung = Schema.Struct({
  // Stable across a reviewer's insertion, which shifts positions; round records name it.
  id: Schema.Number,
  ...GameRunRungFields,
  status: Schema.Literals(["todo", "done", "set-aside"]),
  // Rounds that built this rung without landing it since it last opened.
  fails: Schema.Number,
  // A set-aside rung comes back once, after the rest of the ladder.
  back: Schema.Boolean,
  // Why it was set aside, or why a reviewer added it.
  why: Schema.String,
  from: Schema.Literals(["plan", "reviewer"]),
});
export type GameRunRung = typeof GameRunRung.Type;
export const GameRunLadderState = Schema.Struct({
  rungs: Schema.Array(GameRunRung),
  // Why the ladder is empty when the plan never wrote a valid one; "" otherwise.
  note: Schema.String,
});
export type GameRunLadderState = typeof GameRunLadderState.Type;

export const GameRunVerdict = Schema.Struct({
  order: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
});
export type GameRunVerdict = typeof GameRunVerdict.Type;

const CheckVerdict = Schema.Struct({
  what: Schema.String,
  pass: Schema.Boolean,
  evidence: Schema.String,
});

// What one round did with its rung, check by check.
export const GameRunRungRecord = Schema.Struct({
  rung: Schema.Number,
  is: Schema.String,
  checks: Schema.Array(CheckVerdict),
  outcome: Schema.Literals(["landed", "failed", "set-aside"]),
  why: Schema.String,
});
export type GameRunRungRecord = typeof GameRunRungRecord.Type;

export const GameRunRoundRecord = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  verdicts: Schema.Array(GameRunVerdict),
  kept: Schema.Boolean,
  unjudged: Schema.optionalKey(Schema.Boolean),
  inconclusive: Schema.optionalKey(Schema.Boolean),
  // A creator's restore of another round dropped this one mid-way.
  abandoned: Schema.optionalKey(Schema.Boolean),
  durationMs: Schema.Number,
  linesChanged: Schema.Number,
  testerNote: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  steer: Schema.optionalKey(Schema.Array(Schema.String)),
  rung: Schema.optionalKey(GameRunRungRecord),
  // A finish round: the old fix-the-flaw shape, after the ladder.
  finish: Schema.optionalKey(Schema.Boolean),
  // The round's candidate build (checkpoint oid): a retry continues it, a kept one is restorable.
  build: Schema.optionalKey(Schema.String),
  // Its comparison record's id ("" before or without one), since round labels
  // repeat across a game's threads. Absent on rounds recorded before.
  comparison: Schema.optionalKey(Schema.String),
});
export type GameRunRoundRecord = typeof GameRunRoundRecord.Type;

// An inconclusive round's branch, refined by later rounds against the same
// judged best. Never merged without a decisive win.
export const GameRunPending = Schema.Struct({
  branch: Schema.String,
  // The pending candidate's build (checkpoint oid), which the next round continues.
  sha: Schema.optionalKey(Schema.String),
  round: Schema.Number,
  verdicts: Schema.Array(GameRunVerdict),
  streak: Schema.Number,
});
export type GameRunPending = typeof GameRunPending.Type;

export const GameRunEvidence = Schema.Struct({
  sessions: Schema.Number,
  actions: Schema.Number,
  executedInputSteps: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
});
export type GameRunEvidence = typeof GameRunEvidence.Type;

export const GameRunSide = Schema.Literals(["x", "y"]);
export type GameRunSide = typeof GameRunSide.Type;

// ── Steps the policy plans. ────────────────────────────────────────────────
export const GameRunRoleStep = Schema.Struct({
  kind: Schema.Literal("role"),
  id: Schema.Number,
  role: Schema.String,
  title: Schema.String,
  // null launches a fresh thread; otherwise a follow-up turn on that thread.
  thread: Schema.NullOr(ThreadId),
  // A build plays a plain copy of that build of its own (no git); "blank" an empty
  // folder of its own; null works in the game root. A build is a checkpoint
  // commit oid, or the name of one of the run's builds (`proto-1`).
  at: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  // A duration, not a deadline: a resumed step gets a fresh cap after a pause.
  capMs: Schema.Number,
  read: Schema.Array(Schema.String),
  clear: Schema.Array(Schema.String),
  source: Schema.Boolean,
  bots: Schema.Boolean,
  release: Schema.Boolean,
  // Game-root files a blank worktree gets before its first turn, under the names it reads them by.
  copy: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  // Where the runner draws this thread's explore frames as one sheet, game-relative; "" draws none.
  sheet: Schema.String,
  // Total explore input this thread may use across its sessions; 0 sets none.
  inputCapMs: Schema.Number,
  // A turn whose play is the evidence (a sample, the tester, the ship player):
  // one whose play a tool or the machine refused is played again, never landed
  // as "played nothing". Absent on older records: inputCapMs > 0 && !release.
  plays: Schema.optionalKey(Schema.Boolean),
  // A source role's build before this turn: its landing captures the folder
  // and diffs the two for game-code change.
  since: Schema.optionalKey(Schema.String),
});
export type GameRunRoleStep = typeof GameRunRoleStep.Type;

/**
 * The run's builds are T3 checkpoints under the run's refs; the run never
 * commits, checks out, merges or writes the user's index. A build is a
 * commit oid, or the name of one of the run's builds.
 */
export const GameRunBuildOp = Schema.Union([
  /** The game folder as the build `name`; `changed` and `lines` count game code against `base`. */
  Schema.TaggedStruct("capture", { name: Schema.String, base: Schema.String }),
  /**
   * The build's files back in the folder (engine project, art, ASSETS.md); `keep` names point at it too.
   * With `save`, the folder as it is first becomes that build, unless it already holds the one restored.
   */
  Schema.TaggedStruct("restore", {
    sha: Schema.String,
    keep: Schema.Array(Schema.String),
    save: Schema.optionalKey(Schema.String),
  }),
  /** The build is kept under these names; the folder already holds it. */
  Schema.TaggedStruct("keep", { names: Schema.Array(Schema.String), sha: Schema.String }),
]);
export type GameRunBuildOp = typeof GameRunBuildOp.Type;

/** Only a run that versioned on git branches planned these; its steps still decode. */
export const GameRunGitOp = Schema.Union([
  Schema.TaggedStruct("init", {}),
  Schema.TaggedStruct("enter", { branch: Schema.String }),
  Schema.TaggedStruct("start-round", {
    trunk: Schema.String,
    key: Schema.String,
    from: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("commit", { message: Schema.String, base: Schema.String }),
  Schema.TaggedStruct("branch-commit", { name: Schema.String, message: Schema.String }),
  Schema.TaggedStruct("reject", {
    label: Schema.String,
    why: Schema.String,
    trunk: Schema.String,
    best: Schema.String,
  }),
  Schema.TaggedStruct("to-trunk", { trunk: Schema.String, message: Schema.String }),
  Schema.TaggedStruct("adopt", { trunk: Schema.String, sha: Schema.String, label: Schema.String }),
  Schema.TaggedStruct("ff-merge", {
    trunk: Schema.String,
    branch: Schema.String,
    // The build of the blind play the run holds, checked against the merged tip; "" checks none.
    played: Schema.String,
  }),
  Schema.TaggedStruct("restore-commit", { sha: Schema.String, message: Schema.String }),
]);
export type GameRunGitOp = typeof GameRunGitOp.Type;

const BotFinal = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
);

// One scripted bot run on one build, in a checkout of its own at that sha.
export const GameRunBotStep = Schema.Struct({
  kind: Schema.Literal("bot"),
  id: Schema.Number,
  sha: Schema.String,
  file: Schema.String,
  decider: GameBotDecider,
  seconds: Schema.Number,
});
export type GameRunBotStep = typeof GameRunBotStep.Type;

// How the same bot ended on one build: an ending word ("error" when it could
// not run), the game's last primitive probe values and, from the Godot runner,
// its scene node counts.
const BotFactFields = {
  ending: Schema.String,
  seconds: Schema.Number,
  final: BotFinal,
  perf: Schema.optionalKey(GameBotPerf),
  note: Schema.String,
};
export const GameRunBotFact = Schema.Struct({ side: GameRunSide, ...BotFactFields });
export type GameRunBotFact = typeof GameRunBotFact.Type;

// ── What a step's execution hands back. ────────────────────────────────────
/** A role turn's end: the typed submission the role made, if any, and what the harness saw. */
export const GameRunRoleDone = Schema.Struct({
  kind: Schema.Literal("done"),
  threadId: ThreadId,
  /** Absent when the role made none, which its step's rule then reads as missing. */
  submission: Schema.optionalKey(GameRunSubmission),
  evidence: Schema.NullOr(GameRunEvidence),
  timedOut: Schema.Boolean,
  budgetCut: Schema.Boolean,
  elapsedMs: Schema.Number,
  sourceBefore: Schema.String,
  sourceAfter: Schema.String,
  /**
   * The bot runs the bot service recorded on this thread, never counted from
   * a file in the game folder. Results landed before the record read as none.
   */
  bots: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** The thread's latest play bot and its decider, null when it ran none. */
  bot: Schema.NullOr(Schema.Struct({ file: Schema.String, decider: GameBotDecider })),
  /** The step's sheet when the runner drew one, else "". */
  sheet: Schema.String,
  /** For a source role: whether its turn changed game code (an unknown reads as changed). */
  changed: Schema.optionalKey(Schema.Boolean),
});
export type GameRunRoleDone = typeof GameRunRoleDone.Type;

export const GameRunBuildOutcome = Schema.Struct({
  ok: Schema.Boolean,
  /** The build's commit oid. */
  sha: Schema.String,
  changed: Schema.Boolean,
  lines: Schema.Number,
  detail: Schema.String,
});
export type GameRunBuildOutcome = typeof GameRunBuildOutcome.Type;

/** One shape for every git op; each op fills the fields it knows. */
export const GameRunGitOutcome = Schema.Struct({
  ok: Schema.Boolean,
  sha: Schema.String,
  branch: Schema.String,
  changed: Schema.Boolean,
  entered: Schema.Boolean,
  lines: Schema.Number,
  detail: Schema.String,
  /** ff-merge: the merged tip is the same blind build as the op's `played` sha. */
  same: Schema.Boolean,
});
export type GameRunGitOutcome = typeof GameRunGitOutcome.Type;

export const GameRunCheckOutcome = Schema.Struct({
  /** Index into the rung's checks. */
  k: Schema.Number,
  what: Schema.String,
  pass: Schema.Boolean,
  evidence: Schema.String,
  /** The check run's last frame (where the scenario ended), "" when none was taken. */
  frame: Schema.String,
});
export type GameRunCheckOutcome = typeof GameRunCheckOutcome.Type;

const GameRunDecidedBy = Schema.Literals(["creator", "default"]);
export type GameRunDecidedBy = typeof GameRunDecidedBy.Type;

const FailedResult = Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String });
const BotResult = Schema.Struct({
  kind: Schema.Literal("bot"),
  fact: Schema.Struct(BotFactFields),
});

// Usage limits, a provider that stays down, memory that stays short, a busy
// machine and a tool of Kurambit's that keeps failing end the run resumably:
// nothing was measured, so nothing is judged.
const EndedResult = Schema.Struct({
  kind: Schema.Literal("ended"),
  ending: Schema.Literals(["usage-limit", "provider-down", "low-memory", "busy", "tool-failed"]),
  reason: Schema.String,
});

export const GameRunStepResult = Schema.Union([
  GameRunRoleDone,
  EndedResult,
  FailedResult,
  Schema.Struct({ kind: Schema.Literal("build"), build: GameRunBuildOutcome }),
  Schema.Struct({ kind: Schema.Literal("git"), git: GameRunGitOutcome }),
  Schema.Struct({ kind: Schema.Literal("boot"), ok: Schema.Boolean, detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("facts"), jev: Schema.Boolean, code: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("checks"), results: Schema.Array(GameRunCheckOutcome) }),
  BotResult,
  Schema.Struct({ kind: Schema.Literal("note") }),
  Schema.Struct({
    kind: Schema.Literal("decided"),
    answer: Schema.String,
    notes: Schema.String,
    by: GameRunDecidedBy,
  }),
]);
export type GameRunStepResult = typeof GameRunStepResult.Type;

// How a half of a pair finished, kept with the pair until its partner finishes
// too, so neither half ever runs twice.
export const GameRunHalfResult = Schema.Union([GameRunRoleDone, FailedResult, BotResult]);
export type GameRunHalfResult = typeof GameRunHalfResult.Type;

// A blind comparison's two independent steps, run at once: both builds'
// samples, or the bot on both builds. Halves are in x-then-y order, which is
// the order their results apply in; their ids follow the play order, so no
// id or launch order tells a player which build it has.
export const GameRunPairStep = Schema.Struct({
  kind: Schema.Literal("pair"),
  id: Schema.Number,
  halves: Schema.Array(Schema.Union([GameRunRoleStep, GameRunBotStep])),
  results: Schema.Array(Schema.Struct({ id: Schema.Number, result: GameRunHalfResult })),
});
export type GameRunPairStep = typeof GameRunPairStep.Type;

// A creator decision in a Guided run: what the creator's agent presents and the
// answers the run accepts. The policy names what it knows; the executor adds
// files it resolves on disk (the key art) and drops evidence that is missing.
export const GameRunQuestion = Schema.Struct({
  id: Schema.String,
  kind: GameRunDecisionKind,
  ask: Schema.String,
  // Game-relative files to show, with what each one is.
  evidence: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })),
  // What to say beside the files: the pitches' branches, the ladder.
  text: Schema.String,
  answers: Schema.Array(
    Schema.Struct({
      answer: Schema.String,
      means: Schema.String,
      // The prototype branch a pick answer continues from.
      branch: Schema.optionalKey(Schema.String),
    }),
  ),
  // The answer the run takes when nobody answers in time; one of `answers`.
  fallback: Schema.String,
  waitMs: Schema.Number,
});
export type GameRunQuestion = typeof GameRunQuestion.Type;

export const GameRunDecideStep = Schema.Struct({
  kind: Schema.Literal("decide"),
  id: Schema.Number,
  decision: GameRunQuestion,
  // When the creator's chat was woken (epoch ms); null until then.
  sent: Schema.NullOr(Schema.Number),
  // When the default fires: set once the question reached the creator's agent,
  // so a busy chat does not spend the wait.
  deadline: Schema.NullOr(Schema.Number),
});
export type GameRunDecideStep = typeof GameRunDecideStep.Type;

/** A decision the run took, by the creator's answer or its own default. */
export const GameRunDecided = Schema.Struct({
  id: Schema.String,
  kind: GameRunDecisionKind,
  answer: Schema.String,
  notes: Schema.String,
  by: GameRunDecidedBy,
});
export type GameRunDecided = typeof GameRunDecided.Type;

export const GameRunPlannedStep = Schema.Union([
  GameRunRoleStep,
  Schema.Struct({ kind: Schema.Literal("build"), id: Schema.Number, op: GameRunBuildOp }),
  Schema.Struct({ kind: Schema.Literal("git"), id: Schema.Number, op: GameRunGitOp }),
  Schema.Struct({ kind: Schema.Literal("boot"), id: Schema.Number }),
  // `bots` names the thread whose bot runs the facts state (the round's tester); absent on older records.
  Schema.Struct({
    kind: Schema.Literal("facts"),
    id: Schema.Number,
    bots: Schema.optionalKey(Schema.NullOr(ThreadId)),
  }),
  // Score a rung's state checks on the build that is checked out now.
  Schema.Struct({ kind: Schema.Literal("checks"), id: Schema.Number, rung: Schema.Number }),
  GameRunBotStep,
  Schema.Struct({
    kind: Schema.Literal("note"),
    id: Schema.Number,
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  }),
  GameRunPairStep,
  GameRunDecideStep,
]);
export type GameRunPlannedStep = typeof GameRunPlannedStep.Type;

// ── The policy's cursor. ───────────────────────────────────────────────────
export const GameRunBlock = Schema.Struct({
  tag: Schema.String,
  direction: Schema.String,
  whole: Schema.Boolean,
  msLeft: Schema.Number,
  thread: Schema.NullOr(ThreadId),
  quiet: Schema.Number,
  source: Schema.String,
  turns: Schema.Number,
});
export type GameRunBlock = typeof GameRunBlock.Type;

export const GameRunSample = Schema.Struct({
  side: GameRunSide,
  label: Schema.String,
  thread: Schema.NullOr(ThreadId),
  // "more": one extra play turn when the first used little of the budget.
  phase: Schema.Literals(["play", "more", "write", "done"]),
  notes: Schema.String,
  evidence: Schema.NullOr(GameRunEvidence),
  // The sheet of this player's own frames, game-relative; "" when it has none.
  sheet: Schema.String,
  // True once this sample was given its one extra play turn.
  extra: Schema.Boolean,
});
export type GameRunSample = typeof GameRunSample.Type;

export const GameRunJudge = Schema.Struct({
  aIs: GameRunSide,
  id: Schema.String,
  attempt: Schema.Number,
  aFirst: Schema.Boolean,
  thread: Schema.NullOr(ThreadId),
  phase: Schema.Literals(["compare", "correct", "done"]),
  verdict: Schema.String,
  reason: Schema.String,
  notes: Schema.String,
});
export type GameRunJudge = typeof GameRunJudge.Type;

// One blind comparison: x and y each played once by fresh worktree players,
// then the round's tester bot on each (when it has one), then fresh
// comparators on those two reports with A=x and (for rounds) A=y.
export const GameRunCompare = Schema.Struct({
  question: Schema.String,
  x: Schema.String,
  y: Schema.String,
  xFirst: Schema.Boolean,
  orders: Schema.Array(GameRunSide),
  samples: Schema.Array(GameRunSample),
  bot: Schema.String,
  botDecider: GameBotDecider,
  bots: Schema.Array(GameRunBotFact),
  // Why the comparators got no bot facts although the round had a bot; "" when they did.
  botWithheld: Schema.String,
  judges: Schema.Array(GameRunJudge),
  // The side whose sample is an earlier round's play of the same build, not played here.
  reused: Schema.NullOr(
    Schema.Struct({ side: GameRunSide, round: Schema.Number, branch: Schema.String }),
  ),
});
export type GameRunCompare = typeof GameRunCompare.Type;

// The best build's own blind play, kept so the next gate under the same
// question and sample budget plays only the candidate.
export const GameRunPlayed = Schema.Struct({
  sha: Schema.String,
  question: Schema.String,
  budget: Schema.String,
  round: Schema.Number,
  branch: Schema.String,
  sample: GameRunSample,
});
export type GameRunPlayed = typeof GameRunPlayed.Type;

const GameRunRoundPhase = Schema.Literals([
  "start",
  "block",
  "commit",
  "retry",
  "retry-commit",
  "stall",
  "boot",
  "reject",
  "checks",
  "tester-facts",
  "tester",
  "tester-write",
  "tester-duty",
  "restore",
  "compare",
  "outcome",
  "review-facts",
  "review",
  "review-write",
]);
export type GameRunRoundPhase = typeof GameRunRoundPhase.Type;

export const GameRunRoundTask = Schema.TaggedStruct("round", {
  n: Schema.Number,
  branch: Schema.String,
  phase: GameRunRoundPhase,
  direction: Schema.String,
  repeating: Schema.Boolean,
  move: Schema.String,
  base: Schema.String,
  candidate: Schema.String,
  startedAt: Schema.Number,
  block: Schema.NullOr(GameRunBlock),
  jev: Schema.Boolean,
  thread: Schema.NullOr(ThreadId),
  // The bot file the tester last ran this round.
  bot: Schema.String,
  botDecider: GameBotDecider,
  testerNotes: Schema.String,
  // The ladder rung this round builds (its id), null for a finish round.
  rung: Schema.NullOr(Schema.Number),
  // A rung retry that started from the previous try's branch, not from the best.
  continued: Schema.Boolean,
  // The harness's scoring of the rung's state checks on the latest build (index into the rung's checks).
  stateChecks: Schema.Array(
    Schema.Struct({
      k: Schema.Number,
      pass: Schema.Boolean,
      evidence: Schema.String,
      frame: Schema.String,
    }),
  ),
  // Fix turns the builder got this round after state checks failed.
  fixes: Schema.Number,
  // The tester's pass or fail per check, once it submitted them.
  checks: Schema.Array(CheckVerdict),
  cmp: Schema.NullOr(GameRunCompare),
  outcome: Schema.Literals(["", "merge", "drop", "hold"]),
  reviewed: Schema.String,
  facts: Schema.String,
  record: GameRunRoundRecord,
});
export type GameRunRoundTask = typeof GameRunRoundTask.Type;

export const GameRunPicked = Schema.Struct({
  branch: Schema.String,
  how: Schema.Literals(["won", "selected", "only-booted", "creator"]),
  comparison: Schema.NullOr(Schema.String),
});
export type GameRunPicked = typeof GameRunPicked.Type;

export const GameRunTask = Schema.Union([
  Schema.TaggedStruct("init", {}),
  Schema.TaggedStruct("stage", {
    name: Schema.Literals(["vision", "plan", "art", "build"]),
    // The art stage alone passes through an independent review and at most one redo;
    // "revise" is a vision or plan turn on the creator's notes.
    phase: Schema.Literals(["role", "review", "redo", "revise", "commit", "boot", "reject"]),
    thread: Schema.NullOr(ThreadId),
    block: Schema.NullOr(GameRunBlock),
    sha: Schema.String,
    why: Schema.String,
    // The art director's defect list or the creator's notes, the redo's direction.
    review: Schema.String,
  }),
  Schema.TaggedStruct("proto", {
    // Counts across pairs: a creator's retry builds prototypes 2 and 3.
    i: Schema.Number,
    phase: Schema.Literals(["role", "commit", "boot", "keep", "reject"]),
    branch: Schema.String,
    // The prototype's build (checkpoint oid), once captured.
    sha: Schema.optionalKey(Schema.String),
    why: Schema.String,
    // The creator's notes for a retried pair.
    notes: Schema.String,
  }),
  Schema.TaggedStruct("pick", {
    phase: Schema.Literals(["compare", "select", "adopt"]),
    cmp: GameRunCompare,
    chosen: Schema.String,
    notes: Schema.String,
    // The id of the comparison record this pick wrote ("" before it has one, or with no comparison).
    comparison: Schema.String,
  }),
  GameRunRoundTask,
  // A run that reached rounds without a ladder writes one first; "revise"
  // rewrites it once with the creator's notes from a Guided ladder review.
  Schema.TaggedStruct("ladder", {
    phase: Schema.Literals(["write", "fix", "revise"]),
    thread: Schema.NullOr(ThreadId),
    error: Schema.String,
    notes: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("ship", {
    n: Schema.Number,
    phase: Schema.Literals(["play", "write"]),
    thread: Schema.NullOr(ThreadId),
  }),
  // A budget end inside a round: the round's unfinished work is kept as a
  // build ("capture"), then the folder returns to the best ("trunk").
  // "restore" was a git-era phase.
  Schema.TaggedStruct("leave", {
    branch: Schema.String,
    candidate: Schema.String,
    phase: Schema.Literals(["capture", "restore", "trunk"]),
  }),
  // A Guided run waits for the creator here; the step carries the decision.
  Schema.TaggedStruct("decide", { decision: GameRunQuestion }),
]);
export type GameRunTask = typeof GameRunTask.Type;

// ── A creator's restore of a kept round or a saved build. ───────────────────
export const GameRunRestoreOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("restored"), sha: Schema.String, message: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: GameRunRestoreRefusal,
    message: Schema.String,
  }),
]);
export type GameRunRestoreOutcome = typeof GameRunRestoreOutcome.Type;
/** What a restore replaced in the run's state, so restoring its folder before undoes it. */
export const GameRunRestoreReplaced = Schema.Struct({
  best: Schema.String,
  pending: Schema.NullOr(GameRunPending),
  /** Rounds recorded once the restore landed; any later round makes it no undo. */
  rounds: Schema.Number,
  /** The round in progress the restore abandoned, which an undo cannot bring back. */
  abandoned: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type GameRunRestoreReplaced = typeof GameRunRestoreReplaced.Type;
export const GameRunRestore = Schema.Struct({
  requestId: Schema.String,
  /** A kept round's build, which becomes the run's judged best; null for a saved build. */
  round: Schema.NullOr(Schema.Number),
  /** A saved build by its name (`endings/…`), which leaves the judged best as it is. */
  build: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  requestedAt: IsoDateTime,
  /** Null while the job is moving the folder. */
  outcome: Schema.NullOr(GameRunRestoreOutcome),
  replaced: Schema.NullOr(GameRunRestoreReplaced).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** The earlier restore this one undoes, by what that one replaced; null when it undoes none. */
  undoes: Schema.NullOr(GameRunRestoreReplaced).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type GameRunRestore = typeof GameRunRestore.Type;

// ── The three records. ─────────────────────────────────────────────────────
/** `waiting`: the step in flight is a creator decision. */
const GameRunStatus = Schema.Literals(["running", "waiting", "ended"]);
export type GameRunStatus = typeof GameRunStatus.Type;

export const GameRunEnding = Schema.Literals([
  "ready",
  "done",
  "stopped",
  "stalled",
  /** The plan wrote no valid ladder: nothing to build without the creator's ask. */
  "no-ladder",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "low-memory",
  /** A sample's explore start kept waiting behind other starts on this machine. */
  "busy",
  /** A program Kurambit runs kept failing while measuring a build: nothing was judged. */
  "tool-failed",
]);
export type GameRunEnding = typeof GameRunEnding.Type;

export const GameRun = Schema.Struct({
  id: GameRunId,
  /** The game's creator thread: the chat that runs it and whose stream holds its records. */
  threadId: ThreadId,
  projectId: ProjectId,
  /** The engine project directory the manifest names (`godot`, `web`, `unity`). */
  lane: Schema.String,
  /** The game's engine; absent on runs started before it was recorded (read through runEngine). */
  engine: Schema.optionalKey(GameEngineId),
  brief: Schema.String,
  artDirection: Schema.String,
  profile: GameRunProfile,
  /** What every role thread runs on. */
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  budgetMinutes: Schema.NullOr(Schema.Number),
  /** Epoch ms; null without a budget. */
  budgetEndsAt: Schema.NullOr(Schema.Number),
  status: GameRunStatus,
  ending: Schema.NullOr(GameRunEnding),
  /** The last stage finished ("vision", "plan", "round-3"). */
  stage: Schema.String,
  /** Git-era runs only, kept so their records still read: the branch their rounds merged into. */
  trunk: Schema.optionalKey(Schema.String),
  /** The best build's checkpoint oid (a git-era run's: a commit on `trunk`). */
  best: Schema.String,
  /** Null until the plan wrote one. */
  ladder: Schema.NullOr(GameRunLadderState),
  /** The creator's notes for the next round. */
  steer: Schema.Array(Schema.String),
  decided: Schema.Array(GameRunDecided),
  /** The decision the run waits on now, as its decide step holds it. */
  pendingDecision: Schema.NullOr(
    Schema.Struct({
      stepId: GameRunStepId,
      question: GameRunQuestion,
      /** Epoch ms the creator's chat was woken. */
      sentAt: Schema.Number,
      /** Epoch ms the default fires; null until the question reached the creator's agent. */
      deadline: Schema.NullOr(Schema.Number),
    }),
  ),
  stallStreak: Schema.Number,
  lastFailure: Schema.String,
  shipNoReasons: Schema.String,
  /** The last reviewer's ledger of bugs and DO NOT REGRESS lines. */
  ledger: Schema.String,
  lastDirection: Schema.String,
  /** The creator's notes for the first full build, from a prototype pick. */
  buildNotes: Schema.String,
  pickNotes: Schema.String,
  /** The prototype the game became, once its adopt succeeded. */
  picked: Schema.NullOr(GameRunPicked),
  protos: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      booted: Schema.Boolean,
      sha: Schema.optionalKey(Schema.String),
    }),
  ),
  played: Schema.NullOr(GameRunPlayed),
  pending: Schema.NullOr(GameRunPending),
  task: GameRunTask,
  /** The number of the last step planned. */
  seq: NonNegativeInt,
  /** The number of the step the run holds in flight; null between steps and once ended. */
  inFlight: Schema.NullOr(Schema.Number),
  /** When the run last ended; its finish (stops, exports) is owed until `finished` names it. */
  endedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The `endedAt` whose finish completed. */
  finished: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The creator's latest restore of a kept round: pending while its job moves the folder. */
  restore: Schema.NullOr(GameRunRestore).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * Set by a resume (or a note that reopens the run): the name the folder is
   * kept under by the run's next step that moves it, so the creator's edits
   * while the run was stopped are never lost. Cleared by that step's commit.
   */
  resumeSave: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /**
   * How the run keeps its builds: "checkpoints" under its own refs. Absent on a
   * run from before, which versioned on git branches: such a run is history,
   * read but never continued.
   */
  versions: Schema.optionalKey(Schema.Literal("checkpoints")),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GameRun = typeof GameRun.Type;

const GameRunStepStatus = Schema.Literals([
  "planned",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type GameRunStepStatus = typeof GameRunStepStatus.Type;

export const GameRunStep = Schema.Struct({
  id: GameRunStepId,
  runId: GameRunId,
  threadId: ThreadId,
  seq: PositiveInt,
  /** Counts the times the step was planned: a resume runs an unfinished step again. */
  attempt: PositiveInt,
  kind: Schema.Literals([
    "role",
    "build",
    "git",
    "boot",
    "facts",
    "checks",
    "bot",
    "note",
    "pair",
    "decide",
  ]),
  step: GameRunPlannedStep,
  status: GameRunStepStatus,
  /** The step's role turns (two for a pair of samples), each with the thread it runs on once launched. */
  roles: Schema.Array(
    Schema.Struct({
      seq: PositiveInt,
      threadId: Schema.NullOr(ThreadId),
      submission: Schema.NullOr(GameRunSubmission),
    }),
  ),
  /** A pair keeps its halves' results in `step`; this is a single step's result, or an ending. */
  result: Schema.NullOr(GameRunStepResult),
  /** A pair's halves that ended the run, held until every half is in: then the first one lands. */
  endedHalves: Schema.Array(
    Schema.Struct({ seq: PositiveInt, result: Schema.Union([EndedResult, FailedResult]) }),
  ),
  /**
   * What landing this step's result asked of the game folder: records to write
   * and role threads whose copies go. The game-run.outputs effect each landing
   * commits does it, before the run's next step.
   */
  outputs: Schema.Struct({
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
    release: Schema.Array(ThreadId),
  }),
  /** The run's decisions about this step, in order, for the run log. */
  logs: Schema.Array(Schema.String),
  /** Times this attempt's work was handed back to wait for memory; bounds the waits across restarts. */
  memoryWaits: Schema.optionalKey(NonNegativeInt),
  /** Times this attempt's work was handed back because another operation held the game. */
  busyWaits: Schema.optionalKey(NonNegativeInt),
  /** Times this attempt's work was handed back because a tool of Kurambit's failed in a way waiting may clear. */
  toolWaits: Schema.optionalKey(NonNegativeInt),
  plannedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GameRunStep = typeof GameRunStep.Type;

export const GameRunRound = Schema.Struct({
  id: GameRunRoundId,
  runId: GameRunId,
  threadId: ThreadId,
  round: GameRunRoundRecord,
  recordedAt: IsoDateTime,
});
export type GameRunRound = typeof GameRunRound.Type;

// ── Refusals. ──────────────────────────────────────────────────────────────
