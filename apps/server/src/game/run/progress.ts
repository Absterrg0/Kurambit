// Where a run stands, for the creator: its place in the pipeline, what comes
// next, and how the prototype pick ended. Pure reads of the run record.
import type { GAME_RUN_STAGES, GameRunPickRef, GameRunRungRef } from "@kurambit/contracts";
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
    case "ladder":
      return { stage: STAGE.Rounds, next: `Round ${state.rounds.length + 1}` };
    case "ship":
      return { stage: STAGE.Rounds, next: `Ready, or round ${t.n + 1}` };
    case "leave":
      return { stage: STAGE.Rounds, next: null };
    case "decide":
      return t.decision.kind === "style"
        ? { stage: STAGE.Vision, next: "Prototypes" }
        : t.decision.kind === "prototype"
          ? { stage: STAGE["Blind pick"], next: "Plan" }
          : state.stage === "plan"
            ? { stage: STAGE.Plan, next: "Art" }
            : // The rounds' own ladder review: the next thing is the first round.
              { stage: STAGE.Rounds, next: `Round ${state.rounds.length + 1}` };
  }
};

/** How the pick reads from the run record: still open, or which prototype the game became. */
export const pickRef = (state: RunState): GameRunPickRef | null => {
  const t = state.task;
  const startedAt = state.threads.find((thread) => thread.role === "proto-0")?.startedAt;
  const endedAt = state.threads.find((thread) => thread.role === "plan")?.startedAt;
  const durationMs =
    startedAt === undefined || endedAt === undefined
      ? null
      : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || null;
  if (t._tag === "proto" || (t._tag === "decide" && t.decision.kind === "prototype"))
    return { phase: "prototypes", chosen: null, how: null, durationMs: null };
  if (t._tag === "pick") return { phase: "comparing", chosen: null, how: null, durationMs: null };
  // Only an adopt that succeeded records what the game became.
  if (state.picked !== null)
    return { phase: "done", chosen: state.picked.branch, how: state.picked.how, durationMs };
  if (state.pickNotes.length === 0 && state.protos.length === 0) return null;
  return { phase: "done", chosen: null, how: null, durationMs };
};

/** The ladder in build order, the in-progress round's rung marked. */
export const ladderRefs = (state: RunState): GameRunRungRef[] => {
  const t = state.task;
  const current = t._tag === "round" ? t.rung : null;
  return (state.ladder?.rungs ?? []).map((rung) => ({
    is: rung.is,
    checks: rung.checks.map((check) => check.what),
    status: rung.status,
    current: rung.id === current,
    why: rung.why,
    from: rung.from,
    ...(rung.need === undefined ? {} : { need: rung.need }),
  }));
};
