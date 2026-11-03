// Where a run stands, for the creator: its place in the pipeline, what comes
// next, and how the prototype pick ended. Pure reads of the run record.
import type { GAME_RUN_STAGES, GameRunPickRef } from "@kurambit/contracts";
import type { RunState } from "./state.ts";

type Stage = (typeof GAME_RUN_STAGES)[number];
const STAGE: Record<Stage, number> = {
  Vision: 0,
  Prototypes: 1,
  "Blind pick": 2,
  Plan: 3,
  Art: 4,
  "First build": 5,
  Rounds: 6,
};

const ROUND_NEXT: Record<string, string> = {
  "tester-facts": "Blind comparison",
  tester: "Blind comparison",
  "tester-write": "Blind comparison",
  "tester-duty": "Blind comparison",
  restore: "Keep or revert",
  compare: "Keep or revert",
  outcome: "Reviewer",
};

const stageProgress = (name: string, phase: string) =>
  name === "vision"
    ? { stage: STAGE.Vision, next: "Prototypes" }
    : name === "plan"
      ? { stage: STAGE.Plan, next: "Art" }
      : name === "art"
        ? { stage: STAGE.Art, next: phase === "role" ? "Art director" : "First build" }
        : { stage: STAGE["First build"], next: "Round 1" };

export const runProgress = (state: RunState): { stage: number; next: string | null } => {
  const t = state.task;
  switch (t._tag) {
    case "init":
      return { stage: STAGE.Vision, next: "Vision" };
    case "proto":
      return { stage: STAGE.Prototypes, next: t.i === 0 ? "Prototype 2" : "Blind pick" };
    case "pick":
      return { stage: STAGE["Blind pick"], next: "Plan" };
    case "stage":
      return stageProgress(t.name, t.phase);
    case "round":
      return {
        stage: STAGE.Rounds,
        next: ROUND_NEXT[t.phase] ?? (t.phase.startsWith("review") ? `Round ${t.n + 1}` : "Tester"),
      };
    case "ship":
      return { stage: STAGE.Rounds, next: `Ready, or round ${t.n + 1}` };
    case "leave":
      return { stage: STAGE.Rounds, next: null };
  }
};

// The pick's notes open with a legend naming the blind label the game continued from.
const LEGEND = /^\(In these notes, (A|B) is the prototype the game continued from/;

/** The blind label ("A" or "B") the pick continued from, read from the notes it left. */
export const pickedLabel = (pickNotes: string): "A" | "B" | null => {
  const found = LEGEND.exec(pickNotes.trimStart())?.[1];
  return found === "A" || found === "B" ? found : null;
};

/** How the pick reads from the run record: still open, or which prototype the game became. */
export const pickRef = (
  state: RunState,
  sides: Readonly<Record<string, string>>,
): GameRunPickRef | null => {
  const t = state.task;
  const startedAt = state.threads.find((thread) => thread.role === "proto-0")?.startedAt;
  const endedAt = state.threads.find((thread) => thread.role === "plan")?.startedAt;
  const durationMs =
    startedAt === undefined || endedAt === undefined
      ? null
      : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || null;
  if (t._tag === "proto") return { phase: "prototypes", chosen: null, durationMs: null };
  if (t._tag === "pick")
    return {
      phase: "comparing",
      chosen: t.phase === "adopt" && t.chosen.length > 0 ? t.chosen : null,
      durationMs: null,
    };
  const label = pickedLabel(state.pickNotes);
  const booted = state.protos.filter((proto) => proto.booted);
  const chosen =
    label !== null ? (sides[label] ?? null) : booted.length === 1 ? booted[0]!.branch : null;
  if (chosen === null && state.pickNotes.length === 0 && state.protos.length === 0) return null;
  return { phase: "done", chosen, durationMs };
};
