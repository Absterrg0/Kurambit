// What the run says to the creator's chat when it waits on a decision, the way
// T3 wakes a parent thread for a delegated task's question.
import type { Decision } from "./state.ts";

const WHAT: Record<Decision["kind"], string> = {
  style: "the game's vision and look",
  prototype: "which prototype the game continues from",
  ladder: "the ladder the run builds",
  rung: "a ladder step that failed twice",
};
export const SUMMARY: Record<Decision["kind"], string> = {
  style: "The production run asks about the look",
  prototype: "The production run asks which prototype to keep",
  ladder: "The production run asks about the ladder",
  rung: "The production run asks about a step that failed twice",
};
// The creator's run is still presenting in these states; any other has handed the
// question to the user ("waiting" is the agent asking them itself).
export const PRESENTING = new Set(["preparing", "queued", "starting", "running"]);

export const wakeText = (decision: Decision): string => {
  const fallback = decision.answers.find((a) => a.answer === decision.fallback);
  const minutes = Math.round(decision.waitMs / 60_000);
  return `The production run is waiting for the creator's call on ${WHAT[decision.kind]} (decision ${decision.id}). Read it with game_run_status: its decision lists the evidence files, the answers the run accepts and its default. Show the creator the evidence as a visual reply: an HTML render with the images by their local paths, and a few plain lines on what to look at and what differs. Then ask, and invite an answer in their own words; they may combine or change things freely. Record what they say with game_run_decide (decisionId ${decision.id}): pick the answer that fits and put their words in notes. If nobody answers within ${minutes} minutes of this message, the run takes its default (${decision.fallback}${fallback === undefined ? "" : `: ${fallback.means}`}); tell them, with the time game_run_status gives.`;
};
