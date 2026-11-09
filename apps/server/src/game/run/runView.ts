// PURE. How keep going reads to people and tools: the status the control,
// the banner and game_keep_going_status share, the game card's line, and the
// one plain sentence for each way it stops.
import {
  type GameKeepGoingBotSetup,
  type GameKeepGoingPhase,
  type GameKeepGoingStatus,
  type GameKeepGoingStepRef,
  type GameRun,
  type GameRunStep,
  type GameRunTurnStep,
  type ThreadId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";

import {
  RESUMABLE,
  type StepRecord,
  proposalSummary,
} from "../../orchestration-v2/gameRun/decide.ts";

/** The engine refusal and the control's tooltip. */
export const NO_TURN_LOOP_SENTENCE =
  "Keep going needs an engine Kurambit plays after every turn (three.js).";

/** A live run's line on the game's row and card: "Keep going · step 3". A paused run is not live. */
export const stepLine = (n: number | null = null): string =>
  n === null ? "Keep going" : `Keep going · step ${n}`;

const budgetText = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;
const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/** Why keep going stopped, in one plain line for the paused and done states. */
const endingMessage = (run: GameRun, records: ReadonlyArray<StepRecord>): string => {
  const why = sentence(run.lastFailure);
  switch (run.ending) {
    case null:
      return "";
    case "stopped":
      return why === "" ? "Keep going is off." : `Keep going paused: ${why}.`;
    case "stalled":
      return why === ""
        ? "Keep going paused: the last two steps changed nothing the facts can see. Tell your agent what to do next, or turn it on to try again."
        : `Keep going paused: ${why}. Tell your agent what to do next, or turn it on to try again.`;
    case "budget": {
      const kept = records.filter((r) => r.step.verdict !== "undone").length;
      const spent =
        run.budgetMinutes === null ? "its time" : `its ${budgetText(run.budgetMinutes)}`;
      return `Keep going paused: ${spent} is up (${records.length} step${records.length === 1 ? "" : "s"}, ${kept} kept).`;
    }
    case "done":
      return "Keep going finished: your agent says the game is done. Ask it for more to keep going.";
    case "usage-limit":
      return `Keep going paused: ${why === "" ? "the provider's usage limit is reached" : why}. Turn it on again once it resets.`;
    case "provider-down":
      return `Keep going paused: ${why === "" ? "the provider stopped answering" : why}.`;
    case "tool-failed":
      return `Keep going paused: ${why === "" ? "a tool of Kurambit's kept failing" : why}. Nothing was undone.`;
    case "failed":
      return `Keep going stopped: ${why === "" ? "an unexpected fault" : why}.`;
    case "ready":
    case "no-ladder":
    case "incomplete":
    case "low-memory":
    case "busy":
      return `Keep going paused: ${why === "" ? run.ending : why}.`;
  }
};

const phaseOf = (inFlight: GameRunStep | null): GameKeepGoingPhase | null => {
  switch (inFlight?.step.kind) {
    case "look":
      return inFlight.status === "running" ? "looking" : "waiting";
    case "propose":
      return inFlight.step.deadline === null ? "held" : "proposed";
    case "turn":
      return "turn";
    case "judge":
      return "measuring";
    case "undo":
      return "undoing";
    default:
      return null;
  }
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const refOf = (record: StepRecord, endedAt: string): GameKeepGoingStepRef => ({
  n: record.round,
  why: record.step.why,
  text: record.move,
  build: (record.build ?? null) as GameKeepGoingStepRef["build"],
  verdict: record.step.verdict,
  reason: record.step.reason,
  gain: record.step.gain,
  delta: record.step.delta,
  minutes: Math.round(record.durationMs / 6000) / 10,
  tokens: record.step.tokens,
  endedAt,
});

export interface StatusInput {
  /** The game's latest run, on whichever chat it lives; null when it never ran. */
  readonly run: GameRun | null;
  /** That run's step records with when each was recorded, oldest first. */
  readonly records: ReadonlyArray<{ readonly record: StepRecord; readonly at: string }>;
  readonly inFlight: GameRunStep | null;
  /** The turn the in-flight judge or undo is judging. */
  readonly turn: GameRunTurnStep | null;
  /** The number the in-flight step has. */
  readonly n: number;
  /** While undoing: what the step made worse (loop.undoReason). */
  readonly undoing: string | null;
  readonly blocked: string | null;
  /** The run's play bot setup (botSetupView); null when it needed none. */
  readonly botSetup: GameKeepGoingBotSetup | null;
}

export const keepGoingStatus = (input: StatusInput): GameKeepGoingStatus => {
  const { run, inFlight } = input;
  const records = input.records.map((r) => r.record);
  if (run === null)
    return {
      runId: null,
      chat: null,
      mode: "off",
      profile: null,
      phase: null,
      step: null,
      proposal: null,
      budgetMinutes: null,
      endsAt: null,
      steps: [],
      steer: [],
      setAside: [],
      ending: null,
      resumable: false,
      blocked: input.blocked,
      message: "Keep going is off.",
    };
  const botSetup = input.botSetup === null ? {} : { botSetup: input.botSetup };
  const live = run.status !== "ended";
  const phase = live ? phaseOf(inFlight) : null;
  const n = phase === null || phase === "waiting" || phase === "looking" ? null : input.n;
  const proposal =
    live && inFlight?.step.kind === "propose"
      ? {
          stepId: inFlight.id,
          why: inFlight.step.proposal.why,
          summary: proposalSummary(inFlight.step.proposal),
          text: inFlight.step.proposal.text,
          deadline: inFlight.step.deadline === null ? null : iso(inFlight.step.deadline),
        }
      : null;
  const turn = inFlight?.step.kind === "turn" ? inFlight.step : input.turn;
  const current: ReadonlyArray<GameKeepGoingStepRef> =
    n !== null &&
    turn !== null &&
    (phase === "turn" || phase === "measuring" || phase === "undoing")
      ? [
          {
            n,
            why: turn.proposal.why,
            text: proposalSummary(turn.proposal),
            build:
              inFlight?.step.kind === "judge"
                ? inFlight.step.build
                : inFlight?.step.kind === "undo"
                  ? inFlight.step.expect
                  : null,
            verdict: null,
            reason:
              phase === "turn"
                ? "your agent is working on it"
                : phase === "undoing"
                  ? (input.undoing ?? "")
                  : "measuring before keeping it",
            gain: false,
            delta: [],
            minutes: null,
            tokens: null,
            endedAt: null,
          },
        ]
      : [];
  const done = input.records.map(({ record, at }) => refOf(record, at)).toReversed();
  const settingUp = live && input.botSetup?.state === "running";
  const message = live
    ? settingUp
      ? "Keep going is writing a play bot in a session of its own, so it can measure skilled play."
      : phase === "waiting"
        ? "Keep going waits for this turn to end."
        : phase === "looking"
          ? "Keep going is reading the current build's facts."
          : proposal !== null
            ? `Step ${n} · ${proposal.summary}`
            : phase === "undoing"
              ? `Keep going · undoing step ${n}${input.undoing === null || input.undoing === "" ? "" : `: ${input.undoing}`}`
              : `Keep going · step ${n} · ${current[0]?.reason ?? "working"}`
    : endingMessage(run, records);
  return {
    runId: run.id,
    chat: run.threadId as ThreadId,
    mode: live ? run.profile : "off",
    profile: run.profile,
    phase,
    step: n,
    proposal,
    budgetMinutes: run.budgetMinutes,
    endsAt: live && run.budgetEndsAt !== null ? iso(run.budgetEndsAt) : null,
    steps: [...current, ...done].slice(0, 10),
    steer: [...run.steer],
    setAside: (run.setAside ?? []).map(({ text, why }) => ({ text, why })),
    ending: live ? null : run.ending,
    resumable: !live && run.ending !== null && RESUMABLE.has(run.ending),
    blocked: input.blocked,
    message,
    ...botSetup,
  };
};
