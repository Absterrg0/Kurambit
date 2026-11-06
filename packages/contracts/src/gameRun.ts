import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId } from "./baseSchemas.ts";

/** Production loop as a Kurambit service: one game's run from vision to an ending. */

/**
 * Guided asks the creator at the run's decision points and takes a default when
 * nobody answers in time; Autopilot decides everything itself.
 */
export const GameRunProfile = Schema.Literals(["guided", "autopilot"]);
export type GameRunProfile = typeof GameRunProfile.Type;

/** The decision points of a Guided run: the vision's style, the prototype, the ladder. */
/** `rung`: a ladder step that failed twice, split or changed before it is built again. */
export const GameRunDecisionKind = Schema.Literals(["style", "prototype", "ladder", "rung"]);
export type GameRunDecisionKind = typeof GameRunDecisionKind.Type;

/** The caller's id for one request: a retry with the same id is the same command, applied once. */
export const GameRunCommandKey = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);

export const GameRunStartInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  /** Required for a new run; empty resumes a stopped run with its own brief. */
  brief: Schema.String.check(Schema.isMaxLength(8000)),
  artDirection: Schema.optionalKey(Schema.String),
  /** Creator's choice. Omitted means no time limit. */
  budgetMinutes: Schema.optionalKey(Schema.Number),
  /** Default: the calling thread's own provider, model and options. */
  provider: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  /** A new run defaults to Guided; a resumed run keeps its own unless one is given. */
  profile: Schema.optionalKey(GameRunProfile),
});
export type GameRunStartInput = typeof GameRunStartInput.Type;

export const GameRunStartResult = Schema.Struct({
  runId: Schema.String,
  root: Schema.String,
  stage: Schema.String,
  resumed: Schema.Boolean,
  /** What the start did, for the creator: a resume, a fresh run, an earlier run not carried over. */
  message: Schema.String,
});
export type GameRunStartResult = typeof GameRunStartResult.Type;

export const GameRunStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameRunStatusInput = typeof GameRunStatusInput.Type;

export const GameRunThreadRef = Schema.Struct({
  role: Schema.String,
  /** The run stage or round the role ran in ("Vision", "Blind pick", "Round 2"), for grouping. */
  group: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type GameRunThreadRef = typeof GameRunThreadRef.Type;

/**
 * How a round ended: merged, tied or split (best stands), lost both orders,
 * never judged, or dropped mid-way by the creator's restore of another round.
 */
export const GameRunRoundOutcome = Schema.Literals([
  "kept",
  "inconclusive",
  "rejected",
  "unjudged",
  "abandoned",
]);
export type GameRunRoundOutcome = typeof GameRunRoundOutcome.Type;

/** One check of a ladder rung, as the round's tester declared it. */
export const GameRunCheckResult = Schema.Struct({
  what: Schema.String,
  pass: Schema.Boolean,
  evidence: Schema.String,
});
export type GameRunCheckResult = typeof GameRunCheckResult.Type;

/** What a ladder round did with its rung: landed, failed, or set aside on its second failure. */
export const GameRunRungResult = Schema.Struct({
  is: Schema.String,
  checks: Schema.Array(GameRunCheckResult),
  outcome: Schema.Literals(["landed", "failed", "set-aside"]),
  why: Schema.String,
});
export type GameRunRungResult = typeof GameRunRungResult.Type;

/** A rung of the run's ladder, in build order. */
export const GameRunRungRef = Schema.Struct({
  is: Schema.String,
  checks: Schema.Array(Schema.String),
  status: Schema.Literals(["todo", "done", "set-aside"]),
  /** The rung the round in progress builds. */
  current: Schema.Boolean,
  /** Why it was set aside, or why a reviewer added it. */
  why: Schema.String,
  from: Schema.Literals(["plan", "reviewer", "split"]),
  /** The one plan turn it waits for before it is built again, with `why` saying why. */
  need: Schema.optionalKey(Schema.Literals(["rewrite", "split"])),
});
export type GameRunRungRef = typeof GameRunRungRef.Type;

/**
 * One round in the run's status, short on purpose: every push resends it. The
 * verdicts' reasons and the tester's note are in the round's detail
 * (GameRunRoundResult, game_run_round).
 */
export const GameRunRoundRef = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  kept: Schema.Boolean,
  /** This round's build is the game's current best. */
  current: Schema.Boolean,
  outcome: GameRunRoundOutcome,
  verdicts: Schema.Array(Schema.Struct({ order: Schema.String, verdict: Schema.String })),
  linesChanged: Schema.Number,
  durationMs: Schema.Number,
  note: Schema.NullOr(Schema.String),
  /** The creator's steering notes this round started from. */
  steer: Schema.Array(Schema.String),
  /** The ladder rung this round built; null for a finish round or an older record. */
  rung: Schema.NullOr(GameRunRungResult),
  /** The round's candidate build (a commit oid); absent before builds were listed. */
  build: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The best build it was judged against. */
  base: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** When the round ended (ISO): where its card sits in the chat. */
  endedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Tokens its role turns used, summed from the providers' own usage; null when none was reported. */
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type GameRunRoundRef = typeof GameRunRoundRef.Type;

/** The run's pipeline, in order; `GameRunStatusResult.progress.stage` indexes it. */
export const GAME_RUN_STAGES = [
  "Vision",
  "Prototypes",
  "Blind pick",
  "Plan",
  "Art",
  "First build",
  "Rounds",
] as const;

/**
 * How the pick chose the prototype the game became: a comparator's win, its
 * selection after a tie, the only prototype that booted, or the creator's pick.
 */
export const GameRunPickHow = Schema.Literals(["won", "selected", "only-booted", "creator"]);
export type GameRunPickHow = typeof GameRunPickHow.Type;

/** The prototype pick as a timeline entry; its evidence is read with `game.runPick`. */
export const GameRunPickRef = Schema.Struct({
  phase: Schema.Literals(["prototypes", "comparing", "done"]),
  /** The prototype branch the game continued from, null while open or when none was adopted. */
  chosen: Schema.NullOr(Schema.String),
  how: Schema.NullOr(GameRunPickHow),
  durationMs: Schema.NullOr(Schema.Number),
});
export type GameRunPickRef = typeof GameRunPickRef.Type;

/** A decision a Guided run is waiting on, for any agent to present and answer. */
export const GameRunDecision = Schema.Struct({
  id: Schema.String,
  kind: GameRunDecisionKind,
  /** What the run asks the creator, in plain words. */
  ask: Schema.String,
  /** Files to show the creator, as absolute paths on this machine. */
  evidence: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })),
  /** What goes with the files: which prototype is which, the ladder's rungs. */
  text: Schema.String,
  answers: Schema.Array(Schema.Struct({ answer: Schema.String, means: Schema.String })),
  /** The answer the run takes when nobody answers in time. */
  default: Schema.String,
  /** When the default fires (ISO); null until the message reached the creator's agent. */
  deadline: Schema.NullOr(Schema.String),
});
export type GameRunDecision = typeof GameRunDecision.Type;

/**
 * A build an ended run keeps that is no kept round: the work an ending found,
 * a left round's unfinished work, the folder before a restore, or a round's
 * build that was never kept. Restoring one never makes it the judged best.
 */
export const GameRunSavedBuild = Schema.Struct({
  /** What game-run restore takes as `build`. */
  name: Schema.String,
  label: Schema.String,
  /** When the build was kept (ISO). */
  at: Schema.String,
});
export type GameRunSavedBuild = typeof GameRunSavedBuild.Type;

/** The run's latest restore, as its record holds it. */
export const GameRunRestoreRef = Schema.Struct({
  requestId: Schema.String,
  round: Schema.NullOr(Schema.Number),
  build: Schema.NullOr(Schema.String),
  /** What it brings back, in words ("Round 3's build"). */
  label: Schema.String,
  requestedAt: Schema.String,
  /** Null while its job moves the game folder. */
  outcome: Schema.NullOr(Schema.Struct({ restored: Schema.Boolean, message: Schema.String })),
});
export type GameRunRestoreRef = typeof GameRunRestoreRef.Type;

/** The runs that talk to one chat, newest first, for its round cards. */
export const GameRunRoundsInput = Schema.Struct({ threadId: ThreadId });
export const GameRunRoundsResult = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      runId: Schema.String,
      active: Schema.Boolean,
      best: Schema.NullOr(Schema.String),
      rounds: Schema.Array(GameRunRoundRef),
    }),
  ),
});
export type GameRunRoundsResult = typeof GameRunRoundsResult.Type;

export const GameRunStatusResult = Schema.Struct({
  /** The chat the run talks to (where its round cards appear). */
  chat: Schema.optionalKey(Schema.NullOr(ThreadId)),
  /** The run's best build (a commit oid). */
  best: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active: Schema.Boolean,
  /** The run ended where game-run.resume continues it: a start without a new brief resumes it. */
  resumable: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  /** Null when no run is recorded. */
  profile: Schema.NullOr(GameRunProfile),
  /** The decision the run waits on now, null when it waits on none. */
  decision: Schema.NullOr(GameRunDecision),
  stage: Schema.String,
  /** What the run is doing now (the role or phase in flight), null when no run is recorded. */
  step: Schema.NullOr(Schema.String),
  ending: Schema.NullOr(Schema.String),
  /** When this run started (ISO), null when no run is recorded. */
  startedAt: Schema.NullOr(Schema.String),
  /** Where the run stands in GAME_RUN_STAGES and what comes after the current step. */
  progress: Schema.NullOr(
    Schema.Struct({ stage: Schema.Number, next: Schema.NullOr(Schema.String) }),
  ),
  pick: Schema.NullOr(GameRunPickRef),
  /** The demo ladder rounds build rung by rung; empty before the plan writes it. */
  ladder: Schema.Array(GameRunRungRef),
  rounds: Schema.Array(GameRunRoundRef),
  /** Creator notes waiting for the next round. */
  steer: Schema.Array(Schema.String),
  threads: Schema.Array(GameRunThreadRef),
  /** An ended run's saved builds, latest first; empty while a run is live. */
  builds: Schema.Array(GameRunSavedBuild),
  restore: Schema.NullOr(GameRunRestoreRef),
  message: Schema.String,
});
export type GameRunStatusResult = typeof GameRunStatusResult.Type;

export const GameRunRoundInput = Schema.Struct({
  threadId: ThreadId,
  round: PositiveInt,
});
export type GameRunRoundInput = typeof GameRunRoundInput.Type;

const GameRunBotFinal = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Null]),
);

/** How much of a build one blind player saw: sessions, actions, input time and frames. */
export const GameRunExposure = Schema.Struct({
  sessions: Schema.Number,
  actions: Schema.Number,
  nominalMs: Schema.Number,
  images: Schema.Number,
});
export type GameRunExposure = typeof GameRunExposure.Type;

/** One blind comparison of two builds, as the run recorded it. */
export const GameRunComparison = Schema.Struct({
  /** Why the comparison stopped before the comparators, if it did. */
  gate: Schema.NullOr(Schema.String),
  playOrder: Schema.String,
  /** Each comparator's full answer, in the order it was asked. */
  judges: Schema.Array(
    Schema.Struct({ order: Schema.String, verdict: Schema.String, reasoning: Schema.String }),
  ),
  /** The blind players' reports; the players never knew which build they had. */
  reports: Schema.Array(
    Schema.Struct({
      build: Schema.String,
      text: Schema.String,
      exposure: Schema.NullOr(GameRunExposure),
    }),
  ),
  bot: Schema.NullOr(Schema.Struct({ file: Schema.String, decider: Schema.String })),
  botWithheld: Schema.NullOr(Schema.String),
  bots: Schema.Array(
    Schema.Struct({
      build: Schema.String,
      ending: Schema.String,
      seconds: Schema.Number,
      final: GameRunBotFinal,
      note: Schema.String,
    }),
  ),
  /** Each blind player's frame sheet, by build; `url` is a short-lived signed path. */
  sheets: Schema.Array(
    Schema.Struct({
      build: Schema.String,
      file: Schema.String,
      url: Schema.NullOr(Schema.String),
    }),
  ),
  /** Whether the comparators were shown the sheets (only when both players had one). */
  sheetsShown: Schema.Boolean,
});
export type GameRunComparison = typeof GameRunComparison.Type;

/**
 * One round's evidence, read on demand from the game's .studio folder. Long
 * texts are bounded server-side and end in "…" when cut.
 */
export const GameRunRoundDetail = Schema.Struct({
  round: Schema.Number,
  outcome: GameRunRoundOutcome,
  move: Schema.String,
  branch: Schema.String,
  durationMs: Schema.Number,
  linesChanged: Schema.Number,
  note: Schema.NullOr(Schema.String),
  steer: Schema.Array(Schema.String),
  verdicts: Schema.Array(
    Schema.Struct({ order: Schema.String, verdict: Schema.String, reason: Schema.String }),
  ),
  /** The blind comparison: null when the round never reached one. */
  comparison: Schema.NullOr(GameRunComparison),
  testerNote: Schema.NullOr(Schema.String),
  reviewerNotes: Schema.NullOr(Schema.String),
  /** The reviewer's direction for the round after this one. */
  direction: Schema.NullOr(Schema.String),
  /** Bot runs recorded in the game folder while this round was built and tested, latest last. */
  botRuns: Schema.Array(
    Schema.Struct({
      runId: Schema.String,
      file: Schema.String,
      mode: Schema.String,
      ending: Schema.String,
      seconds: Schema.Number,
      findings: Schema.Number,
      at: Schema.String,
    }),
  ),
  /** The round's latest bot video; `url` is a short-lived signed path the client streams. */
  video: Schema.NullOr(
    Schema.Struct({ runId: Schema.String, file: Schema.String, url: Schema.NullOr(Schema.String) }),
  ),
  /** A kept round's commit can become the game's working tree again. */
  restorable: Schema.Boolean,
  /** The game's committed sources are this round's build right now. */
  current: Schema.Boolean,
});
export type GameRunRoundDetail = typeof GameRunRoundDetail.Type;

export const GameRunPickInput = Schema.Struct({ threadId: ThreadId });
export type GameRunPickInput = typeof GameRunPickInput.Type;

/** The prototype pick's evidence: which prototype each blind label was and why one won. */
export const GameRunPickDetail = Schema.Struct({
  /** Blind label to prototype branch ("A" → "proto-1"). */
  sides: Schema.Array(Schema.Struct({ build: Schema.String, branch: Schema.String })),
  chosen: Schema.NullOr(Schema.String),
  how: Schema.NullOr(GameRunPickHow),
  /** How the choice was made when it was not a plain comparator win. */
  note: Schema.NullOr(Schema.String),
  comparison: Schema.NullOr(GameRunComparison),
});
export type GameRunPickDetail = typeof GameRunPickDetail.Type;

/** A kept round by its number, or a saved build by the name the run's status lists it under. */
export const GameRunRestoreInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  round: Schema.optionalKey(PositiveInt),
  build: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  /** With `round`: the round's build becomes the best even when it was not kept. */
  asBest: Schema.optionalKey(Schema.Boolean),
});
export type GameRunRestoreInput = typeof GameRunRestoreInput.Type;

/** A restore once it is recorded; its outcome follows in the run's status. */
export const GameRunRestoreResult = Schema.Struct({
  requestId: Schema.String,
  /** The folder has moved, or the restore found it already there; false while the job runs. */
  done: Schema.Boolean,
  message: Schema.String,
});
export type GameRunRestoreResult = typeof GameRunRestoreResult.Type;

export const GameRunStopInput = Schema.Struct({ threadId: ThreadId, commandId: GameRunCommandKey });
export type GameRunStopInput = typeof GameRunStopInput.Type;

export const GameRunStopResult = Schema.Struct({
  stopped: Schema.Boolean,
  message: Schema.String,
});
export type GameRunStopResult = typeof GameRunStopResult.Type;

export const GameRunSteerInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type GameRunSteerInput = typeof GameRunSteerInput.Type;

export const GameRunSteerResult = Schema.Struct({
  /** Notes now waiting for the next round, this one included. */
  pending: Schema.Number,
  message: Schema.String,
});
export type GameRunSteerResult = typeof GameRunSteerResult.Type;

export const GameRunChecksResult = Schema.Struct({
  /** The rung scored (its position in the ladder), null when the run has none open. */
  rung: Schema.NullOr(Schema.Number),
  is: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      /** The check's number in the rung. */
      check: Schema.Number,
      what: Schema.String,
      pass: Schema.Boolean,
      evidence: Schema.String,
      /** The scenario's last frame, "" when none was taken. */
      frame: Schema.String,
    }),
  ),
  message: Schema.String,
});
export type GameRunChecksResult = typeof GameRunChecksResult.Type;

export const GameRunDecideInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  decisionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  answer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type GameRunDecideInput = typeof GameRunDecideInput.Type;

export const GameRunDecideResult = Schema.Struct({ message: Schema.String });
export type GameRunDecideResult = typeof GameRunDecideResult.Type;

export const GameRunProfileInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  profile: GameRunProfile,
});
export type GameRunProfileInput = typeof GameRunProfileInput.Type;

export const GameRunProfileResult = Schema.Struct({
  profile: GameRunProfile,
  message: Schema.String,
});
export type GameRunProfileResult = typeof GameRunProfileResult.Type;

/**
 * A readable name for a run role thread ("tester-3" is "Tester, round 3").
 * Blind samples and comparators carry random ids, which say nothing to a reader.
 */
export const gameRunRoleLabel = (role: string): string => {
  const [head = role, ...rest] = role.split("-");
  const tail = rest.join("-");
  const round = /^\d+$/.test(tail) ? Number(tail) : null;
  switch (head) {
    case "vision":
      return "Vision";
    case "plan":
      return "Plan";
    case "art":
      return tail === "director" ? "Art director" : "Art";
    case "proto":
      return round === null ? "Prototype" : `Prototype ${round + 1}`;
    case "builder":
      if (tail === "build") return "First full build";
      if (/^\d+b$/.test(tail)) return `Builder retry, round ${tail.slice(0, -1)}`;
      return round === null ? "Builder" : `Builder, round ${round}`;
    case "tester":
      return round === null ? "Tester" : `Tester, round ${round}`;
    case "reviewer":
      return round === null ? "Reviewer" : `Reviewer, round ${round}`;
    case "ship":
      return round === null ? "Ship review" : `Ship review after round ${round}`;
    case "sample":
      return "Blind play sample";
    case "compare":
      return "Blind comparison";
    default:
      return role;
  }
};

// ── The demo ladder and what run roles submit. ─────────────────────────────
const RunLine = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(600));
const CheckInput = Schema.Union([
  Schema.Struct({ hold: Schema.String.check(Schema.isNonEmpty()), ms: Schema.Number }),
  Schema.Struct({ press: Schema.String.check(Schema.isNonEmpty()) }),
  Schema.Struct({ wait: Schema.Number }),
]);
/**
 * One check of a rung. A "state" check is a scenario and an expectation the
 * harness plays and scores; a "look" check (the default, and every check of an
 * older ladder) is judged by a tester from play, as `how` says.
 */
export const GameRunRungCheck = Schema.Struct({
  what: RunLine,
  how: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(600))),
  kind: Schema.optionalKey(Schema.Literals(["state", "look"])),
  from: Schema.optionalKey(Schema.Literals(["play", "title"])),
  /** Older ladders only: a check now starts from the title or play with real input, and a submission with a setup is refused. */
  setup: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80))),
  /** What the setup target is given: values for "game_state", a position for "player". */
  values: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.Number, Schema.Boolean, Schema.String, Schema.Array(Schema.Number)]),
    ),
  ),
  input: Schema.optionalKey(Schema.Array(CheckInput).check(Schema.isMaxLength(30))),
  expect: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});
export type GameRunRungCheck = typeof GameRunRungCheck.Type;
export const GameRunRungFields = {
  is: RunLine,
  checks: Schema.Array(GameRunRungCheck).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
};
export const GameRunLadder = Schema.Struct({
  rungs: Schema.Array(Schema.Struct(GameRunRungFields)).check(
    Schema.isMinLength(4),
    Schema.isMaxLength(7),
  ),
});
export type GameRunLadder = typeof GameRunLadder.Type;
/** A reviewer's one ladder change: a rung that unblocks the ladder, and why. */
export const GameRunRungChange = Schema.Struct({ why: RunLine, ...GameRunRungFields });
export type GameRunRungChange = typeof GameRunRungChange.Type;

const Reasons = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4000));
/**
 * What a run role hands the run, by the kind its step asks for. The run reads
 * only these, never a file a role wrote, so a format slip is refused in-turn.
 */
export const GameRunSubmission = Schema.Union([
  Schema.TaggedStruct("checks", {
    /** The rung's look checks, by their number in the rung. */
    checks: Schema.Array(
      Schema.Struct({
        check: PositiveInt,
        pass: Schema.Boolean,
        evidence: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(600)),
        /** It cannot be seen in play at all (it needs sound, or it is faster than frames show); never with pass. */
        unverifiable: Schema.optionalKey(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(4)),
    notes: Schema.String.check(Schema.isMaxLength(8000)),
  }),
  Schema.TaggedStruct("ladder", { rungs: GameRunLadder.fields.rungs }),
  /** One rung's change: its checks rewritten (one rung) or the rung split (two or three). */
  Schema.TaggedStruct("rungs", {
    rungs: Schema.Array(Schema.Struct(GameRunRungFields)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
  }),
  Schema.TaggedStruct("verdict", { verdict: Schema.Literals(["A", "B", "TIE"]), reasons: Reasons }),
  Schema.TaggedStruct("select", { pick: Schema.Literals(["A", "B"]), reasons: Reasons }),
  Schema.TaggedStruct("ship", { ship: Schema.Boolean, reasons: Reasons }),
  Schema.TaggedStruct("ledger", {
    ledger: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
    rungChange: Schema.optionalKey(GameRunRungChange),
  }),
  Schema.TaggedStruct("report", {
    report: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8000)),
  }),
  /** An art director's verdict on the art stage: keep it, or one redo against these defects. */
  Schema.TaggedStruct("art", {
    redo: Schema.Boolean,
    defects: Schema.String.check(Schema.isMaxLength(4000)),
  }),
]);
export type GameRunSubmission = typeof GameRunSubmission.Type;
export type GameRunSubmissionKind = GameRunSubmission["_tag"];
export const GameRunSubmissionKind = Schema.Literals([
  "checks",
  "ladder",
  "rungs",
  "verdict",
  "select",
  "ship",
  "ledger",
  "report",
  "art",
]);

export const GameRunSubmitInput = Schema.Struct({ submission: GameRunSubmission });
export type GameRunSubmitInput = typeof GameRunSubmitInput.Type;
export const GameRunSubmitResult = Schema.Struct({ message: Schema.String });
export type GameRunSubmitResult = typeof GameRunSubmitResult.Type;

/** Why a game-run command was refused; a tool hands the message back in-turn. */
export const GameRunRefusalReason = Schema.Literals([
  "no-run",
  "run-live",
  "run-ended",
  "not-resumable",
  "stale-run",
  "stale-step",
  "wrong-thread",
  "wrong-kind",
  "invalid-submission",
  "stale-attempt",
  "no-decision",
  "stale-decision",
  "invalid-answer",
  "not-due",
  /** The run's ending is still being finished (stops, outputs, exports). */
  "finishing",
  /** A creator's restore of a kept round is moving the game folder. */
  "restoring",
  /** The run may still use its copies: it is live, finishing, or resumable within the bound. */
  "copies-in-use",
]);
export type GameRunRefusalReason = typeof GameRunRefusalReason.Type;

/** Why a restore left the game folder as it was. */
export const GameRunRestoreRefusal = Schema.Literals([
  "round-not-found",
  "not-kept",
  "mid-step",
  "off-trunk",
  /** Older records only: a restore now abandons the round in progress. */
  "mid-round",
  "uncommitted-work",
  "commit-missing",
  "restore-incomplete",
  "local-changes",
  "git-failed",
  /** The folder already holds the saved build: nothing moved, so the run stays as it was. */
  "already-current",
]);
export type GameRunRestoreRefusal = typeof GameRunRestoreRefusal.Type;

/**
 * Why a run tool or RPC failed, typed for agents and the UI: the run's own
 * refusal, a restore's, or what the transport found before the run was asked.
 */
export const GameRunErrorReason = Schema.Union([
  GameRunRefusalReason,
  GameRunRestoreRefusal,
  Schema.Literals([
    "project-not-found",
    "role-thread",
    "brief-required",
    "no-live-run",
    "empty-note",
    "records-unreadable",
    "thread-read",
    "not-a-role",
    "command-failed",
  ]),
]);
export type GameRunErrorReason = typeof GameRunErrorReason.Type;
