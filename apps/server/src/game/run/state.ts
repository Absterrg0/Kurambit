// The run's persisted record: `.studio/run.json` holds one RunState, decoded on every load.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "@kurambit/contracts";

const Verdict = Schema.Struct({
  order: Schema.String,
  verdict: Schema.String,
  reason: Schema.String,
});
export type Verdict = typeof Verdict.Type;

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

const RoleStep = Schema.Struct({
  kind: Schema.Literal("role"),
  id: Schema.Number,
  role: Schema.String,
  title: Schema.String,
  // null launches a fresh thread; otherwise a follow-up turn on that thread.
  thread: Schema.NullOr(ThreadId),
  // A sha plays a T3 worktree at that commit; null works in the game root.
  at: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  // A duration, not a deadline: a resumed step gets a fresh cap after a pause.
  capMs: Schema.Number,
  read: Schema.Array(Schema.String),
  clear: Schema.Array(Schema.String),
  source: Schema.Boolean,
  bots: Schema.Boolean,
  release: Schema.Boolean,
  // Written by the driver once the turn exists, so a resume waits on it.
  attached: Schema.NullOr(Schema.Struct({ threadId: ThreadId, runId: RunId })),
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
  Schema.TaggedStruct("ff-merge", { trunk: Schema.String, branch: Schema.String }),
  Schema.TaggedStruct("restore-commit", { sha: Schema.String, message: Schema.String }),
]);
export type GitOp = typeof GitOp.Type;

const Step = Schema.Union([
  RoleStep,
  Schema.Struct({ kind: Schema.Literal("git"), id: Schema.Number, op: GitOp }),
  Schema.Struct({ kind: Schema.Literal("boot"), id: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("facts"), id: Schema.Number }),
  // One scripted bot run on one build, in a checkout of its own at that sha.
  Schema.Struct({
    kind: Schema.Literal("bot"),
    id: Schema.Number,
    sha: Schema.String,
    file: Schema.String,
    seconds: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("note"),
    id: Schema.Number,
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  }),
]);
export type Step = typeof Step.Type;
export type RoleStep = typeof RoleStep.Type;

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
// not run) and the game's last primitive probe values.
const BotFact = Schema.Struct({
  side: Side,
  ending: Schema.String,
  seconds: Schema.Number,
  final: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
  ),
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
  bots: Schema.Array(BotFact).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  judges: Schema.Array(Judge),
});
export type Compare = typeof Compare.Type;

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
  testerNotes: Schema.String,
  cmp: Schema.NullOr(Compare),
  outcome: Schema.Literals(["", "merge", "drop", "hold"]),
  reviewed: Schema.String,
  facts: Schema.String,
  record: RoundRecord,
});
export type Round = typeof Round.Type;

const Task = Schema.Union([
  Schema.TaggedStruct("init", {}),
  Schema.TaggedStruct("stage", {
    name: Schema.Literals(["vision", "plan", "art", "build"]),
    // The art stage alone passes through an independent review and at most one redo.
    phase: Schema.Literals(["role", "review", "redo", "commit", "boot", "reject"]),
    thread: Schema.NullOr(ThreadId),
    block: Schema.NullOr(Block),
    sha: Schema.String,
    why: Schema.String,
    // The art director's defect list, the redo's direction. Older run.json files have none.
    review: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  }),
  Schema.TaggedStruct("proto", {
    i: Schema.Number,
    phase: Schema.Literals(["role", "commit", "boot", "keep", "reject"]),
    branch: Schema.String,
    why: Schema.String,
  }),
  Schema.TaggedStruct("pick", {
    phase: Schema.Literals(["compare", "select", "adopt"]),
    cmp: Compare,
    chosen: Schema.String,
    notes: Schema.String,
  }),
  Round,
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
]);
export type Task = typeof Task.Type;

const RunState = Schema.Struct({
  version: Schema.Literal(3),
  runId: Schema.String,
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
  next: Schema.String,
  lastDirection: Schema.String,
  // The creator's notes for the next round, folded in from .studio/steer.jsonl
  // by the driver. Older run.json files have none.
  steer: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // The creator thread that started the run, so a server restart can resume
  // it with the same model and runtime mode. Older run.json files have none.
  creator: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
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
  next: "",
  lastDirection: "",
  steer: [],
  creator: "",
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
