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
export const GameRunDecisionKind = Schema.Literals(["style", "prototype", "ladder"]);
export type GameRunDecisionKind = typeof GameRunDecisionKind.Type;

export const GameRunStartInput = Schema.Struct({
  threadId: ThreadId,
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
});
export type GameRunStartResult = typeof GameRunStartResult.Type;

export const GameRunStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameRunStatusInput = typeof GameRunStatusInput.Type;

export const GameRunThreadRef = Schema.Struct({
  role: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type GameRunThreadRef = typeof GameRunThreadRef.Type;

/** How a round ended: merged, tied or split (best stands), lost both orders, or never judged. */
export const GameRunRoundOutcome = Schema.Literals([
  "kept",
  "inconclusive",
  "rejected",
  "unjudged",
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
  from: Schema.Literals(["plan", "reviewer"]),
});
export type GameRunRungRef = typeof GameRunRungRef.Type;

export const GameRunRoundRef = Schema.Struct({
  round: Schema.Number,
  move: Schema.String,
  branch: Schema.String,
  kept: Schema.Boolean,
  outcome: GameRunRoundOutcome,
  verdicts: Schema.Array(
    Schema.Struct({
      order: Schema.String,
      verdict: Schema.String,
      reason: Schema.String,
    }),
  ),
  linesChanged: Schema.Number,
  testerNote: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  note: Schema.NullOr(Schema.String),
  /** The creator's steering notes this round started from. */
  steer: Schema.Array(Schema.String),
  /** The ladder rung this round built; null for a finish round or an older record. */
  rung: Schema.NullOr(GameRunRungResult),
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

export const GameRunStatusResult = Schema.Struct({
  active: Schema.Boolean,
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
  verdicts: GameRunRoundRef.fields.verdicts,
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

export const GameRunRestoreInput = GameRunRoundInput;
export type GameRunRestoreInput = typeof GameRunRestoreInput.Type;

export const GameRunRestoreResult = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
});
export type GameRunRestoreResult = typeof GameRunRestoreResult.Type;

export const GameRunStopInput = Schema.Struct({ threadId: ThreadId });
export type GameRunStopInput = typeof GameRunStopInput.Type;

export const GameRunStopResult = Schema.Struct({
  stopped: Schema.Boolean,
  message: Schema.String,
});
export type GameRunStopResult = typeof GameRunStopResult.Type;

export const GameRunSteerInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type GameRunSteerInput = typeof GameRunSteerInput.Type;

export const GameRunSteerResult = Schema.Struct({
  /** Notes now waiting for the next round, this one included. */
  pending: Schema.Number,
  message: Schema.String,
});
export type GameRunSteerResult = typeof GameRunSteerResult.Type;

export const GameRunDecideInput = Schema.Struct({
  threadId: ThreadId,
  decisionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  answer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  notes: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type GameRunDecideInput = typeof GameRunDecideInput.Type;

export const GameRunDecideResult = Schema.Struct({ message: Schema.String });
export type GameRunDecideResult = typeof GameRunDecideResult.Type;

export const GameRunProfileInput = Schema.Struct({
  threadId: ThreadId,
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
