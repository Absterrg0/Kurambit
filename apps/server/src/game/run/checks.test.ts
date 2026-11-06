// @effect-diagnostics nodeBuiltinImport:off -- the generated bot is imported from a temp file to drive it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { checkBot, evaluate, keysOf, needlesOf, parseExpect, readReport } from "./checks.ts";

const terms = (text: string) => {
  const parsed = parseExpect(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.terms;
};

describe("check expectations", () => {
  it("reads keys, deltas and HUD text, and refuses what it cannot score", () => {
    expect(terms('state == "paused" and hud contains "Resume"')).toHaveLength(2);
    expect(terms("delta(score) >= 1")[0]?.ref).toEqual({ kind: "delta", key: "score" });
    expect(terms("player.hp > 0")[0]?.ref).toEqual({ kind: "key", key: "player.hp" });
    for (const bad of [
      "",
      "zone",
      "zone >= three",
      "delta(zone) == true",
      "a > 1 and b > 1 and c > 1 and d > 1 and e > 1",
    ])
      expect("error" in parseExpect(bad)).toBe(true);
  });

  it("scores what the game reported and names keys it never reports", () => {
    const seen = {
      start: { score: 2, state: "playing" },
      end: { score: 5, state: "paused" },
      hud: "Resume\nQuit",
    };
    expect(evaluate(terms('state == "paused" and delta(score) >= 3'), seen).pass).toBe(true);
    expect(evaluate(terms('hud contains "resume"'), seen).pass).toBe(true);
    const missing = evaluate(terms("lives >= 1"), seen);
    expect(missing.pass).toBe(false);
    expect(missing.missing).toEqual(["lives"]);
    expect(missing.detail).toContain("read missing");
    expect(evaluate(terms("score >= 6"), seen).detail).toBe("score >= 6: no (read 5)");
  });
});

describe("the generated check bot", () => {
  // Drives the bot's observe/status over fake ticks, the way the bot child does.
  const drive = async (
    spec: Parameters<typeof checkBot>[0],
    game: (
      t: number,
      sent: { setStates: string[]; presses: string[]; held: Set<string> },
    ) => {
      readonly gameState: Record<string, unknown>;
      readonly hudText: string;
    },
  ) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "check-bot-"));
    const file = NodePath.join(dir, "bot.mjs");
    NodeFS.writeFileSync(file, checkBot(spec));
    const bot = await import(file);
    const sent = { setStates: [] as string[], presses: [] as string[], held: new Set<string>() };
    const api = {
      press: (k: string) => sent.presses.push(k),
      hold: (k: string) => sent.held.add(k),
      release: (k: string) => sent.held.delete(k),
      setState: (target: string) => sent.setStates.push(target),
    };
    // The bot times its scenario on the wall clock; ten ticks a second here. The
    // game's own clock stands still, as a paused game's does.
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      for (let tick = 0; tick < 400; tick++) {
        now += 100;
        const status = bot.status(bot.observe(api, { t: 0, probe: game(tick / 10, sent) }));
        if (status.state !== "running") return { status, sent };
      }
    } finally {
      clock.mockRestore();
    }
    throw new Error("the bot never reported");
  };

  it("leaves the title, asks for the setup, plays the input and reports only what the expect reads", async () => {
    const t0 = terms('zone >= 2 and delta(score) >= 1 and hud contains "Zone"');
    const { status, sent } = await drive(
      {
        what: "x",
        from: "play",
        setup: "zone2",
        input: [{ hold: "d", ms: 500 }, { press: "Space" }],
        keys: keysOf(t0),
        needles: needlesOf(t0),
      },
      (_t, s) => {
        const playing = s.presses.includes("Enter");
        return {
          gameState: {
            state: playing ? "playing" : "title",
            zone: s.setStates.includes("zone2") ? 2 : 1,
            score: s.presses.includes("Space") ? 3 : 2,
            secret: "unrelated",
          },
          hudText: "Hull 3\nZone 2 / 3\nScrap 0",
        };
      },
    );
    expect(sent.setStates).toEqual(["zone2"]);
    expect(sent.presses.filter((k) => k === "Enter").length).toBeLessThanOrEqual(2);
    expect(sent.held.size).toBe(0);
    const seen = readReport(status.evidence)!;
    expect(seen.start).toEqual({ zone: 1, score: 2 });
    expect(seen.end).toEqual({ zone: 2, score: 3 });
    expect(seen.hud).toBe("Zone 2 / 3");
    expect(evaluate(t0, seen).pass).toBe(true);
  });

  it("starts on the title when the check says so", async () => {
    const t0 = terms('state == "title"');
    const { status, sent } = await drive(
      {
        what: "x",
        from: "title",
        setup: null,
        input: [],
        keys: keysOf(t0),
        needles: needlesOf(t0),
      },
      () => ({ gameState: { state: "title" }, hudText: "Play" }),
    );
    expect(sent.presses).toEqual([]);
    expect(evaluate(t0, readReport(status.evidence)!).pass).toBe(true);
  });
});
