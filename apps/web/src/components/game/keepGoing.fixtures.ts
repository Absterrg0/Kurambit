import { ThreadId, type GameKeepGoingStatus } from "@kurambit/contracts";

import { BUILD_C, BUILD_D } from "./gameBuilds.fixtures";

/**
 * A faithful fake of `game.keepGoingStatus`, typed by the contract: a game
 * that never ran keep going, then the run's states in its own chat. The tests
 * read it.
 */
export const MAIN_CHAT = ThreadId.make("thread-main");
export const OTHER_CHAT = ThreadId.make("thread-other");

export const NEVER_RAN: GameKeepGoingStatus = {
  runId: null,
  chat: null,
  mode: "off",
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
  blocked: null,
  message: "Keep going is off.",
};

export const NO_TURN_LOOP: GameKeepGoingStatus = {
  ...NEVER_RAN,
  blocked: "Keep going needs an engine Kurambit plays after every turn (three.js)",
};

export const AUTOPILOT_TURN: GameKeepGoingStatus = {
  ...NEVER_RAN,
  runId: "run-7",
  chat: MAIN_CHAT,
  mode: "autopilot",
  phase: "turn",
  step: 3,
  budgetMinutes: 60,
  endsAt: "2026-11-06T15:10:00.000Z",
  steps: [
    {
      n: 2,
      why: "fact",
      text: "Masher wins at 9 s with no skill.",
      build: BUILD_C,
      verdict: "undone",
      reason: "Random input now crashes at 12 s",
      gain: false,
      delta: [],
      minutes: 5.5,
      tokens: 92_000,
      endedAt: "2026-11-06T14:30:00.000Z",
    },
    {
      n: 1,
      why: "blocker",
      text: "Kurambit measured the current build: Crashed at 12.0 s with random input. Fix it.",
      build: BUILD_D,
      verdict: "kept",
      reason: "no fact got worse",
      gain: true,
      delta: [],
      minutes: 4,
      tokens: 61_000,
      endedAt: "2026-11-06T14:20:00.000Z",
    },
  ],
  message: "Keep going · step 3 · your agent is working on it",
};

const PROPOSAL = {
  stepId: "run-7:step:14",
  why: "regression",
  text: "Your last step (Masher wins at 9 s with no skill.) was undone: Random input now crashes at 12 s.\nReach the same goal another way, or take a smaller step.",
  deadline: "2026-11-06T14:32:00.000Z",
} as const;

export const GUIDED_PROPOSED: GameKeepGoingStatus = {
  ...AUTOPILOT_TURN,
  mode: "guided",
  phase: "proposed",
  proposal: PROPOSAL,
};

export const GUIDED_HELD: GameKeepGoingStatus = {
  ...GUIDED_PROPOSED,
  phase: "held",
  proposal: { ...PROPOSAL, deadline: null },
};

export const PAUSED_STALLED: GameKeepGoingStatus = {
  ...AUTOPILOT_TURN,
  mode: "off",
  phase: null,
  step: null,
  endsAt: null,
  ending: "stalled",
  resumable: true,
  message:
    "Keep going paused: the last two steps changed nothing the facts can see. Tell your agent what to do next, or turn it on to try again.",
};

export const FINISHED_DONE: GameKeepGoingStatus = {
  ...PAUSED_STALLED,
  ending: "done",
  resumable: false,
  message: "Keep going finished: your agent says the game is done. Ask it for more to keep going.",
};
