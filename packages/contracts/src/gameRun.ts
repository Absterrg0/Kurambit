import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId } from "./baseSchemas.ts";

/** Production loop as a Kurambit service: one game's run from vision to an ending. */

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
});
export type GameRunRoundRef = typeof GameRunRoundRef.Type;

export const GameRunStatusResult = Schema.Struct({
  active: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  stage: Schema.String,
  /** What the run is doing now (the role or phase in flight), null when no run is recorded. */
  step: Schema.NullOr(Schema.String),
  ending: Schema.NullOr(Schema.String),
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
  comparison: Schema.NullOr(
    Schema.Struct({
      /** Why the comparison stopped before the comparators, if it did. */
      gate: Schema.NullOr(Schema.String),
      playOrder: Schema.String,
      /** Each comparator's full answer, in the order it was asked. */
      judges: Schema.Array(
        Schema.Struct({ order: Schema.String, verdict: Schema.String, reasoning: Schema.String }),
      ),
      /** The blind players' reports; the players never knew which build they had. */
      reports: Schema.Array(Schema.Struct({ build: Schema.String, text: Schema.String })),
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
    }),
  ),
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
