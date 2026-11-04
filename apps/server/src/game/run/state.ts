// The run's persisted record: `.studio/run.json` holds one RunState, decoded on every load.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GameBotDecider,
  GameBotPerf,
  GameRunDecisionKind,
  GameRunProfile,
  RunId,
  ThreadId,
} from "@kurambit/contracts";

const Verdict = Schema.Struct({
  order: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
});
export type Verdict = typeof Verdict.Type;

// ── The demo ladder. The plan role writes `.studio/ladder.json`; code checks
// only its shape, the rungs are the model's judgment.
const Line = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(600));
const RungCheck = Schema.Struct({ what: Line, how: Line });
const rungFields = {
  is: Line,
  checks: Schema.Array(RungCheck).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
};
export const LadderFile = Schema.Struct({
  rungs: Schema.Array(Schema.Struct(rungFields)).check(
    Schema.isMinLength(4),
    Schema.isMaxLength(7),
  ),
});
/** A reviewer's one ladder change: a rung that unblocks the ladder, and why. */
export const RungChange = Schema.Struct({ why: Line, ...rungFields });

const Rung = Schema.Struct({
  // Stable across a reviewer's insertion, which shifts positions; round records name it.
  id: Schema.Number,
  ...rungFields,
  status: Schema.Literals(["todo", "done", "set-aside"]),
  // Rounds that built this rung without landing it since it last opened.
  fails: Schema.Number,
  // A set-aside rung comes back once, after the rest of the ladder.
  back: Schema.Boolean,
  // Why it was set aside, or why a reviewer added it.
  why: Schema.String,
  from: Schema.Literals(["plan", "reviewer"]),
});
export type Rung = typeof Rung.Type;
const Ladder = Schema.Struct({
  rungs: Schema.Array(Rung),
  // Why the ladder is empty when the plan never wrote a valid one; "" otherwise.
  note: Schema.String,
});
export type Ladder = typeof Ladder.Type;

const decodeLadderFile = Schema.decodeUnknownResult(Schema.fromJsonString(LadderFile), {
  errors: "all",
});
const decodeRungChange = Schema.decodeUnknownResult(Schema.fromJsonString(RungChange));

/** The plan's ladder file as a fresh ladder, or what is wrong with its shape. */
export const parseLadder = (
  text: string,
): { readonly ladder: Ladder } | { readonly error: string } => {
  if (text.trim().length === 0) return { error: "the file is missing or empty" };
  const decoded = decodeLadderFile(text);
  if (Result.isFailure(decoded)) return { error: decoded.failure.message.slice(0, 1500) };
  return {
    ladder: {
      rungs: decoded.success.rungs.map((r, i) => ({
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

/** A reviewer's proposed rung, what is wrong with its shape, or null when it wrote none. */
export const parseRungChange = (
  text: string,
  id: number,
): { readonly rung: Rung } | { readonly error: string } | null => {
  if (text.trim().length === 0) return null;
  const decoded = decodeRungChange(text);
  if (Result.isFailure(decoded)) return { error: decoded.failure.message.slice(0, 300) };
  const { why, ...rung } = decoded.success;
  return { rung: { id, ...rung, status: "todo", fails: 0, back: false, why, from: "reviewer" } };
};

// What one round did with its rung, check by check, in the round record.
const RungResult = Schema.Struct({
  rung: Schema.Number,
  is: Schema.String,
  checks: Schema.Array(
    Schema.Struct({ what: Schema.String, pass: Schema.Boolean, evidence: Schema.String }),
  ),
  outcome: Schema.Literals(["landed", "failed", "set-aside"]),
  why: Schema.String,
});
export type RungResult = typeof RungResult.Type;

const RoundRecord = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  verdicts: Schema.Array(Verdict),
  kept: Schema.Boolean,
  unjudged: Schema.optionalKey(Schema.Boolean),
  inconclusive: Schema.optionalKey(Schema.Boolean),
  durationMs: Schema.Number,
  linesChanged: Schema.Number,
  testerNote: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  steer: Schema.optionalKey(Schema.Array(Schema.String)),
  rung: Schema.optionalKey(RungResult),
  // A finish round: the old fix-the-flaw shape, after the ladder.
  finish: Schema.optionalKey(Schema.Boolean),
});
export type RoundRecord = typeof RoundRecord.Type;

const ThreadRef = Schema.Struct({
  role: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type ThreadRef = typeof ThreadRef.Type;

// An inconclusive round's branch, refined by later rounds against the same
// judged best. Never merged without a decisive win.
const Pending = Schema.Struct({
  branch: Schema.String,
  round: Schema.Number,
  verdicts: Schema.Array(Verdict),
  streak: Schema.Number,
});
export type Pending = typeof Pending.Type;

const Evidence = Schema.Struct({
  sessions: Schema.Number,
  actions: Schema.Number,
  executedInputSteps: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
});
export type Evidence = typeof Evidence.Type;

const Side = Schema.Literals(["x", "y"]);
export type Side = typeof Side.Type;

/**
 * A comparator's checkout: one parentless commit of the empty tree, so its
 * folder, HEAD and log hold nothing of either build or of the run.
 */
export const BLANK = "blank";

const RoleStep = Schema.Struct({
  kind: Schema.Literal("role"),
  id: Schema.Number,
  role: Schema.String,
  title: Schema.String,
  // null launches a fresh thread; otherwise a follow-up turn on that thread.
  thread: Schema.NullOr(ThreadId),
  // A sha plays a T3 worktree at that commit; BLANK an empty one of its own; null works in the game root.
  at: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  // A duration, not a deadline: a resumed step gets a fresh cap after a pause.
  capMs: Schema.Number,
  read: Schema.Array(Schema.String),
  clear: Schema.Array(Schema.String),
  source: Schema.Boolean,
  bots: Schema.Boolean,
  release: Schema.Boolean,
  // Game-root files a BLANK worktree gets before its first turn, under the names it reads them by.
  copy: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  // Where the runner draws this thread's explore frames as one sheet, game-relative; "" draws none.
  sheet: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  // Total explore input this thread may use across its sessions; 0 sets none.
  inputCapMs: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Older run.json files: the driver's own copy of the turn it launched, read
  // by a resume only when T3 holds no record of it. Never written now.
  attached: Schema.optionalKey(Schema.NullOr(Schema.Struct({ threadId: ThreadId, runId: RunId }))),
});

const GitOp = Schema.Union([
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
    // Older run.json files have none.
    played: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  Schema.TaggedStruct("restore-commit", { sha: Schema.String, message: Schema.String }),
]);
export type GitOp = typeof GitOp.Type;

// The decider the tester's bot ran with. Older run.json files have none: policy.
const BotDecider = GameBotDecider.pipe(Schema.withDecodingDefaultKey(Effect.succeed("policy")));
const BotFinal = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
);

// One scripted bot run on one build, in a checkout of its own at that sha.
const BotStep = Schema.Struct({
  kind: Schema.Literal("bot"),
  id: Schema.Number,
  sha: Schema.String,
  file: Schema.String,
  decider: BotDecider,
  seconds: Schema.Number,
});

// How a half of a pair finished, kept in run.json until its partner finishes
// too, so a resume never re-runs a half that already played.
const HalfResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("done"),
    threadId: ThreadId,
    text: Schema.String,
    files: Schema.Record(Schema.String, Schema.String),
    evidence: Schema.NullOr(Evidence),
    timedOut: Schema.Boolean,
    budgetCut: Schema.Boolean,
    elapsedMs: Schema.Number,
    sourceBefore: Schema.String,
    sourceAfter: Schema.String,
    botsBefore: Schema.Number,
    botsAfter: Schema.Number,
    bot: Schema.NullOr(Schema.Struct({ file: Schema.String, decider: GameBotDecider })),
    sheet: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("bot"),
    fact: Schema.Struct({
      ending: Schema.String,
      seconds: Schema.Number,
      final: BotFinal,
      perf: Schema.optionalKey(GameBotPerf),
      note: Schema.String,
    }),
  }),
]);
export type HalfResult = typeof HalfResult.Type;

// A blind comparison's two independent steps, run at once: both builds'
// samples, or the bot on both builds. Halves are in x-then-y order, which is
// the order their results apply in; their ids follow the play order, so no
// id or launch order tells a player which build it has.
const PairStep = Schema.Struct({
  kind: Schema.Literal("pair"),
  id: Schema.Number,
  halves: Schema.Array(Schema.Union([RoleStep, BotStep])),
  results: Schema.Array(Schema.Struct({ id: Schema.Number, result: HalfResult })),
});

// A creator decision in a Guided run: what the creator's agent presents and the
// answers the run accepts. The policy names what it knows; the executor adds
// files it resolves on disk (the key art) and drops evidence that is missing.
const Decision = Schema.Struct({
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
export type Decision = typeof Decision.Type;

const DecideStep = Schema.Struct({
  kind: Schema.Literal("decide"),
  id: Schema.Number,
  decision: Decision,
  // When the creator's chat was woken; null until then.
  sent: Schema.NullOr(Schema.Number),
  // When the default fires: set once the message reaches the creator's agent, so a
  // busy chat does not spend the wait. A resume waits out what is left.
  deadline: Schema.NullOr(Schema.Number),
});
export type DecideStep = typeof DecideStep.Type;

/** A decision the run took, by the creator's answer or its own default. */
const Decided = Schema.Struct({
  id: Schema.String,
  kind: GameRunDecisionKind,
  answer: Schema.String,
  notes: Schema.String,
  by: Schema.Literals(["creator", "default"]),
});
export type Decided = typeof Decided.Type;

const Step = Schema.Union([
  RoleStep,
  Schema.Struct({ kind: Schema.Literal("git"), id: Schema.Number, op: GitOp }),
  Schema.Struct({ kind: Schema.Literal("boot"), id: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("facts"), id: Schema.Number }),
  BotStep,
  Schema.Struct({
    kind: Schema.Literal("note"),
    id: Schema.Number,
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  }),
  PairStep,
  DecideStep,
]);
export type Step = typeof Step.Type;
export type RoleStep = typeof RoleStep.Type;
export type BotStep = typeof BotStep.Type;
export type PairStep = typeof PairStep.Type;
export type Half = PairStep["halves"][number];

const Block = Schema.Struct({
  tag: Schema.String,
  direction: Schema.String,
  whole: Schema.Boolean,
  msLeft: Schema.Number,
  thread: Schema.NullOr(ThreadId),
  quiet: Schema.Number,
  source: Schema.String,
  turns: Schema.Number,
});
export type Block = typeof Block.Type;

const Sample = Schema.Struct({
  side: Side,
  label: Schema.String,
  thread: Schema.NullOr(ThreadId),
  // "more": one extra play turn when the first used little of the budget.
  phase: Schema.Literals(["play", "more", "write", "done"]),
  notes: Schema.String,
  evidence: Schema.NullOr(Evidence),
  // The sheet of this player's own frames, game-relative; "" when it has none.
  sheet: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  // True once this sample was given its one extra play turn (the floor's, or
  // catching up with the other build's exposure).
  extra: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type Sample = typeof Sample.Type;

const Judge = Schema.Struct({
  aIs: Side,
  id: Schema.String,
  attempt: Schema.Number,
  aFirst: Schema.Boolean,
  thread: Schema.NullOr(ThreadId),
  phase: Schema.Literals(["compare", "correct", "done"]),
  verdict: Schema.String,
  reason: Schema.String,
  notes: Schema.String,
});
export type Judge = typeof Judge.Type;

// How the same bot ended on one build: an ending word ("error" when it could
// not run), the game's last primitive probe values and, from the Godot runner,
// its scene node counts.
const BotFact = Schema.Struct({
  side: Side,
  ending: Schema.String,
  seconds: Schema.Number,
  final: BotFinal,
  perf: Schema.optionalKey(GameBotPerf),
  note: Schema.String,
});
export type BotFact = typeof BotFact.Type;

// One blind comparison: x and y each played once by fresh worktree players,
// then the round's tester bot on each (when it has one), then fresh
// comparators on those two reports with A=x and (for rounds) A=y.
const Compare = Schema.Struct({
  question: Schema.String,
  x: Schema.String,
  y: Schema.String,
  xFirst: Schema.Boolean,
  orders: Schema.Array(Side),
  samples: Schema.Array(Sample),
  // Older run.json files have no bot facts.
  bot: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  botDecider: BotDecider,
  bots: Schema.Array(BotFact).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // Why the comparators got no bot facts although the round had a bot; "" when they did.
  botWithheld: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  judges: Schema.Array(Judge),
  // The side whose sample is an earlier round's play of the same build, not played here.
  // Older run.json files have none.
  reused: Schema.NullOr(
    Schema.Struct({ side: Side, round: Schema.Number, branch: Schema.String }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type Compare = typeof Compare.Type;

// The best build's own blind play, kept so the next gate under the same
// question and sample budget plays only the candidate.
const Played = Schema.Struct({
  sha: Schema.String,
  question: Schema.String,
  budget: Schema.String,
  round: Schema.Number,
  branch: Schema.String,
  sample: Sample,
});
export type Played = typeof Played.Type;

const RoundPhase = Schema.Literals([
  "start",
  "block",
  "commit",
  "retry",
  "retry-commit",
  "stall",
  "boot",
  "reject",
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

const Round = Schema.TaggedStruct("round", {
  n: Schema.Number,
  branch: Schema.String,
  phase: RoundPhase,
  direction: Schema.String,
  repeating: Schema.Boolean,
  move: Schema.String,
  base: Schema.String,
  candidate: Schema.String,
  startedAt: Schema.Number,
  block: Schema.NullOr(Block),
  jev: Schema.Boolean,
  thread: Schema.NullOr(ThreadId),
  botsBefore: Schema.Number,
  // The bot file the tester last ran this round. Older run.json files have none.
  bot: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  botDecider: BotDecider,
  testerNotes: Schema.String,
  // The ladder rung this round builds (an index into the ladder), null for a finish
  // round. Older run.json files have none.
  rung: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  // A rung retry that started from the previous try's branch, not from the best.
  continued: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // The tester's pass or fail per check, once it wrote them.
  checks: Schema.Array(
    Schema.Struct({ what: Schema.String, pass: Schema.Boolean, evidence: Schema.String }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  cmp: Schema.NullOr(Compare),
  outcome: Schema.Literals(["", "merge", "drop", "hold"]),
  reviewed: Schema.String,
  facts: Schema.String,
  record: RoundRecord,
});
export type Round = typeof Round.Type;

const Picked = Schema.Struct({
  branch: Schema.String,
  how: Schema.Literals(["won", "selected", "only-booted", "creator"]),
  comparison: Schema.NullOr(Schema.String),
});
export type Picked = typeof Picked.Type;

const Task = Schema.Union([
  Schema.TaggedStruct("init", {}),
  Schema.TaggedStruct("stage", {
    name: Schema.Literals(["vision", "plan", "art", "build"]),
    // The art stage alone passes through an independent review and at most one redo;
    // "revise" is a vision or plan turn on the creator's notes.
    phase: Schema.Literals(["role", "review", "redo", "revise", "commit", "boot", "reject"]),
    thread: Schema.NullOr(ThreadId),
    block: Schema.NullOr(Block),
    sha: Schema.String,
    why: Schema.String,
    // The art director's defect list or the creator's notes, the redo's direction.
    // Older run.json files have none.
    review: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  Schema.TaggedStruct("proto", {
    // Counts across pairs: a creator's retry builds prototypes 2 and 3.
    i: Schema.Number,
    phase: Schema.Literals(["role", "commit", "boot", "keep", "reject"]),
    branch: Schema.String,
    why: Schema.String,
    // The creator's notes for a retried pair. Older run.json files have none.
    notes: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  Schema.TaggedStruct("pick", {
    phase: Schema.Literals(["compare", "select", "adopt"]),
    cmp: Compare,
    chosen: Schema.String,
    notes: Schema.String,
    // The id of the comparison record this pick wrote ("" before it has one, or with no comparison).
    // Older run.json files have none.
    comparison: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  Round,
  // A run that reached rounds without a ladder (older run.json files) writes one first.
  Schema.TaggedStruct("ladder", {
    phase: Schema.Literals(["write", "fix"]),
    thread: Schema.NullOr(ThreadId),
    error: Schema.String,
  }),
  Schema.TaggedStruct("ship", {
    n: Schema.Number,
    phase: Schema.Literals(["play", "write"]),
    thread: Schema.NullOr(ThreadId),
  }),
  // A budget end inside a round: the candidate (when one exists) is put back
  // and committed on its branch, then the tree returns to trunk.
  Schema.TaggedStruct("leave", {
    branch: Schema.String,
    candidate: Schema.String,
    phase: Schema.Literals(["restore", "trunk"]),
  }),
  // A Guided run waits for the creator here; the step carries the decision.
  Schema.TaggedStruct("decide", { decision: Decision }),
]);
export type Task = typeof Task.Type;

const RunState = Schema.Struct({
  version: Schema.Literal(3),
  runId: Schema.String,
  // Older run.json files decided everything themselves.
  profile: GameRunProfile.pipe(Schema.withDecodingDefaultKey(Effect.succeed("autopilot"))),
  // The creator decisions this run took, in order. Older run.json files have none.
  decided: Schema.Array(Decided).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // The creator's notes for the first full build, from a prototype pick that
  // asked to take something from the other one. Older run.json files have none.
  buildNotes: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
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
  rounds: Schema.Array(RoundRecord),
  threads: Schema.Array(ThreadRef),
  pending: Schema.NullOr(Pending),
  seq: Schema.Number,
  budgetEndsAt: Schema.NullOr(Schema.Number),
  lane: Schema.String,
  trunk: Schema.String,
  best: Schema.String,
  protos: Schema.Array(Schema.Struct({ branch: Schema.String, booted: Schema.Boolean })),
  pickNotes: Schema.String,
  // The prototype the game became, set only when the pick's adopt succeeded:
  // how it was chosen and the id of the comparison record it came from.
  // Older run.json files have none.
  picked: Schema.NullOr(Picked).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  next: Schema.String,
  lastDirection: Schema.String,
  // null until the plan wrote one; older run.json files have none and write one at the next round.
  ladder: Schema.NullOr(Ladder).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  // The creator's notes for the next round, folded in from .studio/steer.jsonl
  // by the driver. Older run.json files have none.
  steer: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // The creator thread that started the run, so a server restart can resume
  // it with the same model and runtime mode. Older run.json files have none.
  creator: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  // Older run.json files have none: their next gate plays both builds.
  played: Schema.NullOr(Played).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  task: Task,
  inFlight: Schema.NullOr(Step),
});
export type RunState = typeof RunState.Type;

const decodeRunState = Schema.decodeUnknownOption(Schema.fromJsonString(RunState));
export const encodeRunState = Schema.encodeSync(RunState);
const decodeRound = Schema.decodeUnknownOption(Schema.fromJsonString(RoundRecord));

// The loop before v3 kept less: no cursor, no best, no in-flight step.
const LegacyRun = Schema.Struct({
  runId: Schema.String,
  brief: Schema.String,
  artDirection: Schema.optionalKey(Schema.String),
  budgetMinutes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
  variant: Schema.optionalKey(Schema.NullOr(Schema.String)),
  startedAt: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(Schema.String),
  ending: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stallStreak: Schema.optionalKey(Schema.Number),
  lastFailure: Schema.optionalKey(Schema.String),
  shipNoReasons: Schema.optionalKey(Schema.String),
  threads: Schema.optionalKey(Schema.Array(ThreadRef)),
  pending: Schema.optionalKey(Schema.NullOr(Pending)),
});
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyRun));

/** Journal lines, torn or foreign lines skipped. */
export const parseJournal = (text: string): RoundRecord[] =>
  text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const decoded = decodeRound(line);
      return decoded._tag === "Some" ? [decoded.value] : [];
    });

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
  trunk: "",
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

// Where an old run's stage name leaves the v3 cursor. `init` comes first in
// every case: it resolves trunk and best and moves stray work off trunk.
export const legacyResumeStage = (stage: string, rounds: number): RunState["stage"] =>
  rounds > 0 || stage === "build" || stage.startsWith("round-")
    ? "build"
    : ["vision", "pick", "plan", "art"].includes(stage)
      ? stage
      : "starting";

export type Loaded =
  | { readonly kind: "none" }
  | { readonly kind: "v3"; readonly state: RunState }
  | { readonly kind: "legacy"; readonly state: RunState }
  | { readonly kind: "unreadable" };

export const loadState = (runText: string | null, journalText: string): Loaded => {
  if (runText === null) return { kind: "none" };
  const v3 = decodeRunState(runText);
  if (v3._tag === "Some") return { kind: "v3", state: v3.value };
  const legacy = decodeLegacy(runText);
  if (legacy._tag === "None") return { kind: "unreadable" };
  const old = legacy.value;
  // A crash between the old loop's two writes left the journal one record
  // ahead of run.json; the longer one is the truth.
  const rounds = parseJournal(journalText);
  const state = freshState(
    {
      runId: old.runId,
      profile: "autopilot",
      brief: old.brief,
      artDirection: old.artDirection ?? "",
      budgetMinutes: old.budgetMinutes ?? null,
      provider: old.provider ?? null,
      model: old.model ?? null,
      variant: old.variant ?? null,
      startedAt: old.startedAt ?? "1970-01-01T00:00:00.000Z",
    },
    { rounds, pending: old.pending ?? null },
  );
  return {
    kind: "legacy",
    state: {
      ...state,
      stage: legacyResumeStage(old.stage ?? "starting", rounds.length),
      ending: old.ending ?? null,
      stallStreak: old.stallStreak ?? 0,
      lastFailure: old.lastFailure ?? "",
      shipNoReasons: old.shipNoReasons ?? "",
      threads: old.threads ?? [],
    },
  };
};
