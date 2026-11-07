import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";
import { GameBuildId, GameFactDelta, GameStepVerdict } from "./gameBuilds.ts";

/**
 * Keep going as a Kurambit service: the agent takes the next step of a game
 * itself, in the person's chat, and the run keeps or undoes each step by its
 * facts. Runs made by an earlier Kurambit (the stage era) are read, never continued.
 */

// The profile and the refusal reasons live in a leaf module: game.ts names them
// and sits under gameBuilds.ts's imports, which this module needs.
import { GameRunProfile } from "./gameRunReasons.ts";
export { GameRunErrorReason, GameRunProfile, GameRunRefusalReason } from "./gameRunReasons.ts";

/** The caller's id for one request: a retry with the same id is the same command, applied once. */
export const GameRunCommandKey = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
);

export const GameRunEnding = Schema.Literals([
  "ready",
  "done",
  "stopped",
  "stalled",
  /** Stage era only: the plan wrote no valid ladder. */
  "no-ladder",
  /** Stage era only: the ladder had set-aside rungs, or the ship review said not shippable. */
  "incomplete",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "low-memory",
  /** Stage era only: a sample's explore start kept waiting behind other starts on this machine. */
  "busy",
  /** A program Kurambit runs kept failing while measuring a build: nothing was judged. */
  "tool-failed",
]);
export type GameRunEnding = typeof GameRunEnding.Type;

export const GameKeepGoingMode = Schema.Literals(["off", "guided", "autopilot"]);
export type GameKeepGoingMode = typeof GameKeepGoingMode.Type;

/** Why the run chose a step, in the order it looks (design §2.2). */
export const GameRunStepWhy = Schema.Literals([
  "steer",
  "blocker",
  "regression",
  "bot",
  "fact",
  "next",
]);
export type GameRunStepWhy = typeof GameRunStepWhy.Type;

export const GameKeepGoingInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  mode: GameKeepGoingMode,
  /** For a start or resume; null is no limit; omitted keeps the run's own (a new run: 60). */
  budgetMinutes: Schema.optionalKey(Schema.NullOr(PositiveInt)),
});
export type GameKeepGoingInput = typeof GameKeepGoingInput.Type;

export const GameKeepGoingStatusInput = Schema.Struct({ threadId: ThreadId });
export type GameKeepGoingStatusInput = typeof GameKeepGoingStatusInput.Type;

export const GameKeepGoingPhase = Schema.Literals([
  /** look: a turn is running or queued on the game. */
  "waiting",
  /** look: reading the current build's facts. */
  "looking",
  /** Guided: a proposal with a deadline. */
  "proposed",
  /** Guided: a proposal the person is editing (no deadline). */
  "held",
  /** The step's turn is running. */
  "turn",
  /** judge */
  "measuring",
  /** undo */
  "undoing",
]);
export type GameKeepGoingPhase = typeof GameKeepGoingPhase.Type;

export const GameKeepGoingStepRef = Schema.Struct({
  n: PositiveInt,
  why: GameRunStepWhy,
  /** The step's first line, at most 140 characters. */
  text: Schema.String,
  build: Schema.NullOr(GameBuildId),
  /** Null while in flight. */
  verdict: Schema.NullOr(GameStepVerdict),
  reason: Schema.String,
  /** Kept, changed game files, and made no watched fact worse (contract §8, F2). */
  gain: Schema.Boolean,
  delta: Schema.Array(GameFactDelta).check(Schema.isMaxLength(3)),
  minutes: Schema.NullOr(Schema.Number),
  /** Input + output as the provider reported them; null when none was. */
  tokens: Schema.NullOr(Schema.Number),
  endedAt: Schema.NullOr(IsoDateTime),
});
export type GameKeepGoingStepRef = typeof GameKeepGoingStepRef.Type;

export const GameKeepGoingStatus = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  /** The chat it runs in: another chat's control says "on in <chat>". */
  chat: Schema.NullOr(ThreadId),
  /** "off" unless a run is live. */
  mode: GameKeepGoingMode,
  /** The run's last mode, kept while paused or ended (a resume sends it); null when the game never ran keep going. */
  profile: Schema.NullOr(GameRunProfile),
  phase: Schema.NullOr(GameKeepGoingPhase),
  step: Schema.NullOr(PositiveInt),
  proposal: Schema.NullOr(
    Schema.Struct({
      stepId: Schema.String,
      why: GameRunStepWhy,
      text: Schema.String,
      /** Null while held. */
      deadline: Schema.NullOr(IsoDateTime),
    }),
  ),
  budgetMinutes: Schema.NullOr(PositiveInt),
  endsAt: Schema.NullOr(IsoDateTime),
  /** Newest first, at most 10: every push resends it. */
  steps: Schema.Array(GameKeepGoingStepRef).check(Schema.isMaxLength(10)),
  steer: Schema.Array(Schema.String),
  setAside: Schema.Array(Schema.Struct({ text: Schema.String, why: Schema.String })),
  /** Why it last stopped; null while live or never run. */
  ending: Schema.NullOr(GameRunEnding),
  resumable: Schema.Boolean,
  /** Why keep going cannot run on this game or chat ("Keep going needs an engine…", "Keep going is on in <chat>"); null when it can. */
  blocked: Schema.NullOr(Schema.String),
  /** The one plain line (design §4.3, §7.2). */
  message: Schema.String,
});
export type GameKeepGoingStatus = typeof GameKeepGoingStatus.Type;

export const GameKeepGoingDecideInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  stepId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  answer: Schema.Literals(["start", "skip", "hold"]),
});
export type GameKeepGoingDecideInput = typeof GameKeepGoingDecideInput.Type;
export const GameKeepGoingDecideResult = Schema.Struct({ message: Schema.String });
export type GameKeepGoingDecideResult = typeof GameKeepGoingDecideResult.Type;

export const GameKeepGoingSteerInput = Schema.Struct({
  threadId: ThreadId,
  commandId: GameRunCommandKey,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type GameKeepGoingSteerInput = typeof GameKeepGoingSteerInput.Type;
export const GameKeepGoingSteerResult = Schema.Struct({
  pending: NonNegativeInt,
  message: Schema.String,
});
export type GameKeepGoingSteerResult = typeof GameKeepGoingSteerResult.Type;

// ── Stage-era rounds, as the round cards read them. ──────────────────────────
/**
 * How a stage-era round ended: merged, tied or split (best stands), lost both
 * orders, never judged, or dropped mid-way by the creator's restore of another round.
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

/** One stage-era round, short on purpose: every push resends it. */
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
