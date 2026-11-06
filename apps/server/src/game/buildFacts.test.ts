import { describe, expect, it } from "@effect/vitest";
import { GameOperationError, type GameBotRunResult } from "@kurambit/contracts";

import { faultOf, skilledFact, tierFact, turnChangeBase, winnableOf } from "./buildFacts.ts";

const run = (
  state: string,
  finalState: GameBotRunResult["finalState"],
  evidence?: unknown,
): GameBotRunResult => ({
  runId: "r",
  goal: "",
  status: { state, note: "", ...(evidence === undefined ? {} : { evidence }) },
  ticks: 10,
  tickHz: 10,
  timeRatio: 1,
  gameSeconds: 40,
  decisions: 0,
  jev: null,
  policyNote: null,
  usedSetState: false,
  findings: [],
  finalState,
  finalPos: null,
  mode: "play",
  runIds: ["r"],
  reportPath: null,
  tracePath: "/x/trace.json",
  videoPath: "/x/run.mp4",
  frames: [],
  message: "",
});

describe("tierFact", () => {
  it("reads the ending from the game's run state, timed from the start of play", () => {
    const fact = tierFact(
      run("done", { state: "ended", result: "won" }, { playingAt: 2, endedAt: 10.5 }),
      60,
      null,
    );
    expect(fact).toMatchObject({ status: "measured", value: { ending: "won", at: 8.5 } });
  });

  it("never makes an ending of a game that reports no run state", () => {
    const fact = tierFact(run("done", { score: 3 }, { playingAt: 2, endedAt: null }), 60, null);
    expect(fact).toMatchObject({ status: "not-measured", retry: false });
  });

  it("calls a run the bot and the game disagree on not measured", () => {
    const fact = tierFact(
      run("done", { state: "ended", result: "won" }, { playingAt: 2, endedAt: null }),
      60,
      null,
    );
    expect(fact.status).toBe("not-measured");
  });

  it("measures a crash about the build, and a stop as not measured", () => {
    expect(tierFact(run("crashed", {}, { playingAt: 1 }), 60, null)).toMatchObject({
      status: "measured",
      value: { ending: "crashed" },
    });
    expect(tierFact(run("stopped", {}), 60, null)).toMatchObject({
      status: "not-measured",
      retry: true,
    });
  });
});

describe("budget", () => {
  it("is a standing not-measured, never an ending, for the tiers and the skilled bot", () => {
    const slow = { ...run("budget", { state: "playing" }), timeRatio: 0.4 };
    expect(tierFact(slow, 60, null)).toMatchObject({
      status: "not-measured",
      retry: false,
      standing: true,
    });
    const bot = { file: ".studio/bot/win.mjs", hash: "h", decider: "policy" } as const;
    expect(skilledFact(slow, bot, null)).toMatchObject({ status: "not-measured", retry: false });
  });
});

describe("faultOf", () => {
  it("is not measured for a tool or the machine, and null for the build's own failure", () => {
    const error = (reason: GameOperationError["reason"]) =>
      new GameOperationError({ operation: "Bot run", path: "/g", reason });
    expect(faultOf(error("low-memory"))).toMatchObject({ retry: true });
    expect(faultOf(error("tool-missing"))).toMatchObject({ retry: false });
    expect(faultOf(error("command-failed"))).toBeNull();
  });
});

describe("winnableOf", () => {
  const measured = (ending: "won" | "lost") =>
    ({
      status: "measured",
      value: { ending, at: 1, played: 1, note: "", evidence: null },
    }) as const;
  const missing = { status: "not-measured", why: "busy", retry: true } as const;
  it("is false only when both tiers were measured and neither won", () => {
    expect(winnableOf(measured("lost"), measured("lost"))).toEqual({
      status: "measured",
      value: false,
    });
    expect(winnableOf(measured("lost"), missing).status).toBe("not-measured");
    expect(winnableOf(missing, measured("won"))).toEqual({ status: "measured", value: true });
    const crashed = {
      status: "measured",
      value: { ending: "crashed", at: 1, played: 1, note: "", evidence: null },
    } as const;
    expect(winnableOf(crashed, measured("lost")).status).toBe("not-measured");
  });
});

describe("skilledFact", () => {
  it("keeps the bot's own word beside an unended game and never reads it as a win", () => {
    const bot = { file: ".studio/bot/win.mjs", hash: "h", decider: "policy" } as const;
    expect(skilledFact(run("done", { state: "playing" }), bot, null)).toMatchObject({
      status: "measured",
      value: { ending: "no-ending", botWord: "done" },
    });
  });
});

// A chat turn's build lists its own changes, never the run's work between two turns.
describe("turnChangeBase", () => {
  const turn = { id: "t2", startedAt: "2026-11-06T12:00:00.000Z", thread: "chat", turn: 2 };
  const t1 = { id: "t1", at: "2026-11-06T10:00:00.000Z", thread: "chat", turn: 1 };
  it("keeps T3's own diff when the thread's previous turn is the newest build before it", () => {
    expect(turnChangeBase(turn, [t1])).toBeNull();
  });
  it("counts from the run's build when the run changed the folder between the two turns", () => {
    const round = { id: "r3", at: "2026-11-06T11:00:00.000Z", thread: null, turn: null };
    const later = { id: "r4", at: "2026-11-06T12:30:00.000Z", thread: null, turn: null };
    expect(turnChangeBase(turn, [t1, round, later])).toBe("r3");
  });
});
