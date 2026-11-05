// The run's persisted record: `.studio/run.json` holds one RunState, decoded on every load.
// The shapes are the run domain's own (packages/contracts gameRunRecords.ts); this module
// adds only what run.json files written before a field existed need to decode.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  GameBotDecider,
  GameRunBlock,
  GameRunBotFact,
  GameRunBotStep,
  GameRunCompare,
  GameRunDecided,
  GameRunDecideStep,
  GameRunEvidence,
  GameRunGitOp,
  GameRunJudge,
  GameRunLadder,
  GameRunLadderState,
  GameRunPending,
  GameRunPicked,
  GameRunPlayed,
  GameRunProfile,
  GameRunQuestion,
  GameRunRoleDone,
  GameRunRoleStep,
  GameRunRoundRecord,
  GameRunRoundTask,
  GameRunRung,
  type GameRunRungCheck,
  GameRunRungChange,
  GameRunRungRecord,
  GameRunSample,
  GameRunSide,
  type GameRunStepResult,
  GameRunTask,
  GameRunVerdict,
  RunId,
  ThreadId,
} from "@kurambit/contracts";
import { MAX_INPUT_MS, inputMs, parseExpect } from "./checks.ts";

export type Verdict = GameRunVerdict;

// ── The demo ladder. The plan role submits it; code checks only its shape,
// the rungs are the model's judgment.
export type RungCheck = GameRunRungCheck;
export const isStateCheck = (c: RungCheck): boolean => c.kind === "state";
export const LadderFile = GameRunLadder;
export const RungChange = GameRunRungChange;
export type Rung = GameRunRung;
export type Ladder = GameRunLadderState;

const decodeLadderFile = Schema.decodeUnknownResult(Schema.fromJsonString(LadderFile), {
  errors: "all",
});
const decodeRungChange = Schema.decodeUnknownResult(Schema.fromJsonString(RungChange));

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

/** The plan's ladder file as a fresh ladder, or what is wrong with its shape. */
export const parseLadder = (
  text: string,
): { readonly ladder: Ladder } | { readonly error: string } => {
  if (text.trim().length === 0) return { error: "the file is missing or empty" };
  const decoded = decodeLadderFile(text);
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

/** A reviewer's proposed rung, what is wrong with its shape, or null when it wrote none. */
export const parseRungChange = (
  text: string,
  id: number,
): { readonly rung: Rung } | { readonly error: string } | null => {
  if (text.trim().length === 0) return null;
  const decoded = decodeRungChange(text);
  if (Result.isFailure(decoded)) return { error: decoded.failure.message.slice(0, 300) };
  return rungOfChange(decoded.success, id);
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

// ── run.json from before a field existed decodes with that field's default. ─
const BotDecider = GameBotDecider.pipe(Schema.withDecodingDefaultKey(Effect.succeed("policy")));

const RoleStep = GameRunRoleStep.mapFields((f) => ({
  ...f,
  copy: f.copy.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  sheet: f.sheet.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  inputCapMs: f.inputCapMs.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Older run.json files: the driver's own copy of the turn it launched, read
  // by a resume only when T3 holds no record of it. Never written now.
  attached: Schema.optionalKey(Schema.NullOr(Schema.Struct({ threadId: ThreadId, runId: RunId }))),
}));

const [gitInit, gitEnter, gitStartRound, gitCommit, gitBranchCommit, gitReject, gitToTrunk] =
  GameRunGitOp.members;
const [, , , , , , , gitAdopt, gitFfMerge, gitRestoreCommit] = GameRunGitOp.members;
const GitOp = Schema.Union([
  gitInit,
  gitEnter,
  gitStartRound,
  gitCommit,
  gitBranchCommit,
  gitReject,
  gitToTrunk,
  gitAdopt,
  gitFfMerge.mapFields((f) => ({
    ...f,
    played: f.played.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  })),
  gitRestoreCommit,
]);
export type GitOp = typeof GitOp.Type;

const BotStep = GameRunBotStep.mapFields((f) => ({ ...f, decider: BotDecider }));

// The old loop's role turns hand prose: the turn's last text and the files it read back.
const RoleDone = GameRunRoleDone.mapFields((f) => ({
  ...f,
  text: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}));
export type RoleDone = typeof RoleDone.Type;
export type StepResult = Exclude<GameRunStepResult, { readonly kind: "done" }> | RoleDone;

const HalfResult = Schema.Union([
  RoleDone,
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("bot"),
    fact: GameRunBotFact.mapFields(({ side: _side, ...f }) => f),
  }),
]);
export type HalfResult = typeof HalfResult.Type;

const PairStep = Schema.Struct({
  kind: Schema.Literal("pair"),
  id: Schema.Number,
  halves: Schema.Array(Schema.Union([RoleStep, BotStep])),
  results: Schema.Array(Schema.Struct({ id: Schema.Number, result: HalfResult })),
});

export type Decision = GameRunQuestion;
export type DecideStep = GameRunDecideStep;
export type Decided = GameRunDecided;

const Step = Schema.Union([
  RoleStep,
  Schema.Struct({ kind: Schema.Literal("git"), id: Schema.Number, op: GitOp }),
  Schema.Struct({ kind: Schema.Literal("boot"), id: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("facts"), id: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("checks"), id: Schema.Number, rung: Schema.Number }),
  BotStep,
  Schema.Struct({
    kind: Schema.Literal("note"),
    id: Schema.Number,
    files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  }),
  PairStep,
  GameRunDecideStep,
]);
export type Step = typeof Step.Type;
export type RoleStep = typeof RoleStep.Type;
export type BotStep = typeof BotStep.Type;
export type PairStep = typeof PairStep.Type;
export type Half = PairStep["halves"][number];

export type Block = GameRunBlock;

const Sample = GameRunSample.mapFields((f) => ({
  ...f,
  sheet: f.sheet.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  extra: f.extra.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}));
export type Sample = typeof Sample.Type;
export type Judge = GameRunJudge;
export type BotFact = GameRunBotFact;

const Compare = GameRunCompare.mapFields((f) => ({
  ...f,
  samples: Schema.Array(Sample),
  bot: f.bot.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  botDecider: BotDecider,
  bots: f.bots.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  botWithheld: f.botWithheld.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  reused: f.reused.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}));
export type Compare = typeof Compare.Type;

const Played = GameRunPlayed.mapFields((f) => ({ ...f, sample: Sample }));
export type Played = typeof Played.Type;

const Round = GameRunRoundTask.mapFields((f) => ({
  ...f,
  bot: f.bot.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  botDecider: BotDecider,
  rung: f.rung.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  continued: f.continued.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  stateChecks: f.stateChecks.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  fixes: f.fixes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  checks: f.checks.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  cmp: Schema.NullOr(Compare),
}));
export type Round = typeof Round.Type;

export type Picked = GameRunPicked;

const [taskInit, taskStage, taskProto, taskPick, , taskLadder, taskShip, taskLeave, taskDecide] =
  GameRunTask.members;
const Task = Schema.Union([
  taskInit,
  taskStage.mapFields((f) => ({
    ...f,
    review: f.review.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  })),
  taskProto.mapFields((f) => ({
    ...f,
    notes: f.notes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  })),
  taskPick.mapFields((f) => ({
    ...f,
    cmp: Compare,
    comparison: f.comparison.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  })),
  Round,
  taskLadder,
  taskShip,
  taskLeave,
  taskDecide,
]);
export type Task = typeof Task.Type;

const RunState = Schema.Struct({
  version: Schema.Literal(3),
  // A run on the orchestration core: its roles submit with game_run_submit
  // instead of ending their files with a line. The loop's run.json has none.
  typed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  runId: Schema.String,
  // Older run.json files decided everything themselves.
  profile: GameRunProfile.pipe(Schema.withDecodingDefaultKey(Effect.succeed("autopilot"))),
  decided: Schema.Array(GameRunDecided).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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
  rounds: Schema.Array(GameRunRoundRecord),
  threads: Schema.Array(ThreadRef),
  pending: Schema.NullOr(GameRunPending),
  seq: Schema.Number,
  budgetEndsAt: Schema.NullOr(Schema.Number),
  lane: Schema.String,
  trunk: Schema.String,
  best: Schema.String,
  protos: Schema.Array(Schema.Struct({ branch: Schema.String, booted: Schema.Boolean })),
  pickNotes: Schema.String,
  picked: Schema.NullOr(GameRunPicked).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  // The last reviewer's ledger (next.md).
  next: Schema.String,
  lastDirection: Schema.String,
  // null until the plan wrote one; older run.json files have none and write one at the next round.
  ladder: Schema.NullOr(GameRunLadderState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  // The creator's notes for the next round.
  steer: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // The creator thread that started the run, so a server restart can resume
  // it with the same model and runtime mode.
  creator: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  played: Schema.NullOr(Played).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  task: Task,
  inFlight: Schema.NullOr(Step),
});
export type RunState = typeof RunState.Type;

const decodeRunState = Schema.decodeUnknownOption(Schema.fromJsonString(RunState));
export const encodeRunState = Schema.encodeSync(RunState);
const decodeRound = Schema.decodeUnknownOption(Schema.fromJsonString(GameRunRoundRecord));

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
  pending: Schema.optionalKey(Schema.NullOr(GameRunPending)),
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
  typed: false,
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
