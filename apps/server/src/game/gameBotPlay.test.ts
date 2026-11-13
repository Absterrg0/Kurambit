// A crash under a bot is the strongest fact a bot can produce about a build,
// and a bot that never ran says nothing about it. The run loop must hand the
// first over as a measured result with its trace, keep the second off the
// record, and never take our own side going away for the game's.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The bot child is a real Node process reading real files, and a silent game waits out its own tick bound.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { GameOperationError } from "@kurambit/contracts";
import { playBot, type BotLaunch } from "./gameBotPlay.ts";
import type { PlayEnd, PlayTick } from "./playSession.ts";

const BOT = `export const goal = "walk right";
export const observe = (api, obs) => obs;
export const options = () => [{ name: "go", description: "walk", facts: {}, run: (api) => { api.hold("d"); return "running"; } }];
export const status = (obs) => obs?.probe?.gameState?.dead === true
  ? { state: "crashed", note: "saw a death screen" }
  : obs?.probe?.gameState?.won === true
  ? { state: "done", note: "reached the end", evidence: obs.probe.gameState.big ? { blob: "x".repeat(5000) } : { s: 1, e: 2 } }
  : { state: "running" };
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** A game whose runner sends the scripted ticks, then whatever `after` says. */
const scriptedLaunch = (
  ticks: ReadonlyArray<Record<string, unknown>>,
  after: PlayTick["kind"],
  end: PlayEnd,
  onEnd?: () => void,
): BotLaunch => {
  let sent = 0;
  let settle: (end: PlayEnd) => void = () => undefined;
  const ended = new Promise<PlayEnd>((resolve) => (settle = resolve));
  return {
    ended,
    stop: async () => ({ keptStorage: null, use: null, perf: null, scene: null }),
    play: {
      protocol: 2,
      capabilities: new Set(["realtime"]),
      boot: { probe: null },
      bootPerf: null,
      act: () => Promise.reject(new Error("not in this test")),
      realtime: async () => undefined,
      still: async () => false,
      nextTick: async (): Promise<PlayTick> => {
        const tick = ticks[sent];
        sent += 1;
        if (tick !== undefined)
          return { kind: "tick", observation: { op: "tick", tick: sent, ...tick } };
        if (after === "closed") {
          onEnd?.();
          settle(end);
        }
        return after === "tick" ? { kind: "timeout" } : { kind: after };
      },
      input: async () => undefined,
      setState: async () => undefined,
      refusedStates: () => [],
      close: async () => undefined,
    },
  };
};

/** A game that answers these ticks, then goes silent: each later tick waits its whole bound. */
const silentAfter = (ticks: ReadonlyArray<Record<string, unknown>>): BotLaunch => {
  const launch = scriptedLaunch([], "timeout", { by: "game", detail: "" });
  let sent = 0;
  return {
    ...launch,
    play: {
      ...launch.play,
      nextTick: async (timeoutMs): Promise<PlayTick> => {
        const tick = ticks[sent];
        sent += 1;
        if (tick !== undefined)
          return { kind: "tick", observation: { op: "tick", tick: sent, ...tick } };
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return { kind: "timeout" };
      },
    },
  };
};

const runIn = (
  launch: BotLaunch,
  bot = BOT,
  session: { stopped: boolean; processes: never[] } = { stopped: false, processes: [] },
  seconds = 30,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kurambit-bot-play-"));
  dirs.push(root);
  const runDir = NodePath.join(root, "builds/logs/game-bot-run");
  NodeFS.mkdirSync(runDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, ".studio/bot"), { recursive: true });
  const botFile = NodePath.join(root, ".studio/bot/b.mjs");
  NodeFS.writeFileSync(botFile, bot);
  const childPath = NodePath.join(import.meta.dirname, "../../templates/bot-child.mjs");
  const tracePath = NodePath.join(runDir, "trace.json");
  const result = playBot(launch, {
    host: { joinJob: () => undefined },
    root,
    runId: "00000000-0000-4000-8000-000000000000",
    runDir,
    childPath,
    videoPath: NodePath.join(runDir, "run.mp4"),
    tracePath,
    botFile,
    mode: "play",
    seconds,
    ffmpeg: "ffmpeg",
    // The very object a stop flips, as GameBot shares it with the run.
    session: Object.assign(session, { root, runId: "call" }),
    signal: undefined,
    runIndex: 0,
    runTotal: 1,
    seed: 1,
    priorRuns: [],
  });
  return { result, tracePath, session };
};

const playing = [
  { t: 0.1, probe: { gameState: { x: 1 } } },
  { t: 0.2, probe: { gameState: { x: 2 } } },
];

describe("playBot", () => {
  it("hands over a crash as a measured result, with its trace", async () => {
    const { result, tracePath } = runIn(
      scriptedLaunch(playing, "closed", {
        by: "game",
        detail: "The game's process exited with code 139.",
      }),
    );
    const run = await result;
    expect(run.status.state).toBe("crashed");
    expect(run.status.note).toContain("code 139");
    expect(run.played).not.toBe(false);
    expect(run.ticks).toBe(2);
    expect(JSON.parse(NodeFS.readFileSync(tracePath, "utf8")).status.state).toBe("crashed");
  });

  it("calls a game that stops answering unresponsive, still measured", async () => {
    const run = await runIn(scriptedLaunch(playing, "timeout", { by: "game", detail: "" })).result;
    expect(run.status.state).toBe("unresponsive");
  });

  it("never takes our own side going away for the game's", async () => {
    const failure = await runIn(
      scriptedLaunch(playing, "closed", { by: "host", detail: "The private display ended." }),
    ).result.then(
      () => null,
      (error: GameOperationError) => error,
    );
    expect(failure?.reason).toBe("tool-failed");
  });

  it("reads a stop as stopped, never as a crash", async () => {
    const session = { stopped: false, processes: [] };
    const run = await runIn(
      scriptedLaunch(playing, "closed", { by: "game", detail: "killed" }, () => {
        session.stopped = true;
      }),
      BOT,
      session,
    ).result;
    expect(run.status.state).toBe("stopped");
  });

  it("keeps a bot that never ran off the record", async () => {
    const run = await runIn(
      scriptedLaunch(playing, "closed", { by: "game", detail: "" }),
      "export const goal = ;",
    ).result;
    expect(run.played).toBe(false);
    expect(run.status.state).toBe("bot-error");
  });

  it("carries the bot's structured evidence whole, and drops it past 4 KB", async () => {
    const won = [{ t: 0.1, probe: { gameState: { won: true } } }];
    const small = await runIn(scriptedLaunch(won, "timeout", { by: "game", detail: "" })).result;
    expect(small.status.state).toBe("done");
    expect(small.status.evidence).toEqual({ s: 1, e: 2 });
    const bigWon = [{ t: 0.1, probe: { gameState: { won: true, big: true } } }];
    const big = await runIn(scriptedLaunch(bigWon, "timeout", { by: "game", detail: "" })).result;
    expect(big.status.evidence).toBeUndefined();
    expect(big.status.note).toContain("4 KB");
  });

  it("never lets a bot claim an ending only the harness measures", async () => {
    const dead = [{ t: 0.1, probe: { gameState: { dead: true } } }];
    const run = await runIn(scriptedLaunch(dead, "timeout", { by: "game", detail: "" })).result;
    expect(run.status.state).toBe("bot:crashed");
  });

  it("calls a game silent when its budget ends unresponsive, at the game time it stopped", async () => {
    const run = await runIn(silentAfter(playing), BOT, { stopped: false, processes: [] }, 2).result;
    expect(run.status.state).toBe("unresponsive");
    expect(run.status.note).toContain("0.2 s");
  }, 30_000);
});
