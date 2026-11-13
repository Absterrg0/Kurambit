import { describe, expect, it } from "@effect/vitest";
import { GameOperationError, type GameBotRunResult } from "@kurambit/contracts";

import {
  faultOf,
  firstResponseOf,
  notMeasured,
  sharedPlaySuspect,
  skilledFact,
  tierFact,
  turnChangeBase,
  unmeasurableTier,
  winnableOf,
} from "./buildFacts.ts";

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
    const bot = { file: ".studio/bot/win.mjs", hash: "h" } as const;
    expect(skilledFact(slow, bot, null)).toMatchObject({ status: "not-measured", retry: false });
  });

  it("is the machine's, retried, when the machine was busy during the play", () => {
    const slow = { ...run("budget", { state: "playing" }), timeRatio: 0.14 };
    const busy = { cores: 12, stalled: 0.45, load: 13.4 };
    expect(tierFact(slow, 60, null, busy)).toMatchObject({
      status: "not-measured",
      retry: true,
      why: expect.stringContaining("the machine was busy (load 13.4 on 12 cores)"),
    });
    // Without CPU pressure, the load per core decides.
    expect(tierFact(slow, 60, null, { cores: 12, stalled: null, load: 13.4 })).toMatchObject({
      retry: true,
    });
    // Only a slow game on an idle machine is a fact about the game.
    expect(tierFact(slow, 60, null, { cores: 12, stalled: 0.03, load: 13.4 })).toMatchObject({
      retry: false,
      standing: true,
    });
    // In a software renderer a slow run says nothing about the game, busy or not.
    expect(
      tierFact(slow, 60, null, { cores: 12, stalled: 0.01, load: 1, software: true }),
    ).toMatchObject({
      status: "not-measured",
      why: expect.stringContaining("the harness renders in software here"),
    });
    const bot = { file: ".studio/bot/win.mjs", hash: "h" } as const;
    expect(skilledFact(slow, bot, null, busy)).toMatchObject({ retry: true });
  });
});

// Keep going undoes a step whose health reading crosses into bad, so a bad
// reading that other work on the machine can explain is never stored as measured.
describe("a busy machine", () => {
  const busy = { cores: 12, stalled: 0.45, load: 13.4 };
  const quiet = { cores: 12, stalled: 0.02, load: 1 };
  it("makes a game that stopped answering not measured, retried; a quiet one stays measured", () => {
    const stuck = run("unresponsive", { state: "playing" });
    expect(tierFact(stuck, 60, null, busy)).toMatchObject({ status: "not-measured", retry: true });
    expect(tierFact(stuck, 60, null, quiet)).toMatchObject({
      status: "measured",
      value: { ending: "unresponsive" },
    });
  });
  it("makes a slow first response not measured, and keeps a fast one", () => {
    const probe = (seconds: number | null) =>
      run("done", { state: "playing" }, { response: { positions: true, seconds, window: 1 } });
    expect(firstResponseOf(probe(0.9), busy)).toMatchObject({ status: "not-measured" });
    expect(firstResponseOf(probe(null), busy)).toMatchObject({ status: "not-measured" });
    expect(firstResponseOf(probe(0.1), busy)).toMatchObject({ status: "measured" });
    expect(firstResponseOf(probe(0.9), quiet)).toMatchObject({ status: "measured" });
  });
});

describe("sharedPlaySuspect", () => {
  const live = (motion: number, longestFreeze = 0) => ({
    status: "measured" as const,
    value: {
      freezes: [],
      longestFreeze,
      motion,
      detail: 40,
      dominantColour: 0.3,
      longestStall: 0,
      seconds: 60,
    },
  });
  const perf = (fps: number) => ({
    status: "measured" as const,
    value: { fps, low1: fps, gpuMs: 4, scale: 1, width: 1280, height: 720, frames: 3000 },
  });

  it("keeps a shared play whose readings are at their best", () => {
    expect(sharedPlaySuspect(run("done", {}), { liveness: live(20), performance: perf(60) })).toBe(
      null,
    );
  });

  it("plays alone again what sharing could explain", () => {
    expect(sharedPlaySuspect({ ...run("done", {}), timeRatio: 0.8 }, {})).toMatch(/0\.80/);
    expect(
      sharedPlaySuspect(run("done", {}), { firstResponse: notMeasured("busy", true) }),
    ).toMatch(/waiting/);
    expect(sharedPlaySuspect(run("done", {}), { performance: perf(45) })).toMatch(/performance/);
    expect(sharedPlaySuspect(run("done", {}), { liveness: live(20, 4) })).toMatch(/freeze/);
    expect(sharedPlaySuspect(run("done", {}), { liveness: live(0.5) })).toMatch(/motion/);
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

describe("unmeasurableTier", () => {
  it("is a tier a missing tool kept from playing, never one waiting or the build itself can clear", () => {
    const missing = faultOf(
      new GameOperationError({
        operation: "Bot run",
        path: "ffmpeg",
        reason: "tool-missing",
        detail: "ffmpeg is needed for the run video.",
      }),
    )!;
    const busy = notMeasured("the machine was busy", true);
    const own = notMeasured("the tier bot did not play: no canvas", false);
    expect(unmeasurableTier({ idle: missing, masher: busy })).toBe(missing);
    expect(unmeasurableTier({ idle: busy, masher: own })).toBeUndefined();
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
    const bot = { file: ".studio/bot/win.mjs", hash: "h" } as const;
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
  it("keeps T3's list for a thread's first turn, and when its previous turn was not read", () => {
    const restoreBefore = {
      id: "before",
      at: "2026-11-06T11:00:00.000Z",
      thread: null,
      turn: null,
    };
    expect(turnChangeBase({ ...turn, turn: 1 }, [restoreBefore])).toBeNull();
    expect(turnChangeBase(turn, [restoreBefore])).toBeNull();
  });
  it("counts from the run's build when the run changed the folder between the two turns", () => {
    const round = { id: "r3", at: "2026-11-06T11:00:00.000Z", thread: null, turn: null };
    const later = { id: "r4", at: "2026-11-06T12:30:00.000Z", thread: null, turn: null };
    expect(turnChangeBase(turn, [t1, round, later])).toBe("r3");
  });
  it("finds the thread's previous turn past a run that captured nothing (a restart's continuation)", () => {
    const undo = { id: "u", at: "2026-11-06T11:00:00.000Z", thread: null, turn: null };
    expect(turnChangeBase({ ...turn, turn: 3 }, [t1, undo])).toBe("u");
  });
});
