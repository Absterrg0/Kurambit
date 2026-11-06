// @effect-diagnostics nodeBuiltinImport:off -- the generated bot is imported from a temp file to drive it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "@effect/vitest";
import { checkBot, evaluate, keysOf, needlesOf, parseExpect, readReport } from "./checks.ts";
import * as State from "./state.ts";

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

  it("leaves the title, plays the input and reports only what the expect reads", async () => {
    const t0 = terms('zone >= 2 and delta(score) >= 1 and hud contains "Zone"');
    const { status, sent } = await drive(
      {
        what: "x",
        from: "play",
        input: [{ hold: "d", ms: 500 }, { press: "Space" }],
        keys: keysOf(t0),
        needles: needlesOf(t0),
      },
      (_t, s) => {
        const playing = s.presses.includes("Enter");
        return {
          gameState: {
            state: playing ? "playing" : "title",
            zone: s.held.has("d") || s.presses.includes("Space") ? 2 : 1,
            score: s.presses.includes("Space") ? 3 : 2,
            secret: "unrelated",
          },
          hudText: "Hull 3\nZone 2 / 3\nScrap 0",
        };
      },
    );
    expect(sent.setStates).toEqual([]);
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
        input: [],
        keys: keysOf(t0),
        needles: needlesOf(t0),
      },
      () => ({ gameState: { state: "title" }, hudText: "Play" }),
    );
    expect(sent.presses).toEqual([]);
    expect(evaluate(t0, readReport(status.evidence)!).pass).toBe(true);
  });

  // Whatever the game holds, the report fits the bot status's 4096-byte evidence:
  // a check never pauses the run because a game's state is large.
  it("bounds its report by construction and says what it cut", async () => {
    const t0 = terms('inventory contains "key" and player.name == "x" and hud contains "Hp"');
    const { status } = await drive(
      {
        what: "x",
        from: "title",
        input: [],
        keys: keysOf(t0),
        needles: needlesOf(t0),
      },
      () => ({
        gameState: {
          state: "title",
          inventory: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item-${i}` })),
          player: { name: "y".repeat(10_000) },
        },
        hudText: `Hp ${"z".repeat(10_000)}`,
      }),
    );
    expect(JSON.stringify(status.evidence).length).toBeLessThan(4096);
    expect(readReport(status.evidence)!.cut).toEqual(["inventory", "player.name"]);
  });
});

// A check the run cannot verify in play stalls its rung forever (research-anatomy:
// GC-2's audio and 0.32 s flash checks cost 54 minutes), so the plan's own
// submission is refused with the reason, whoever wrote the ladder.
describe("the check lint", () => {
  const rung = (check: Record<string, unknown>) => ({
    is: "the game has a goal",
    checks: [{ what: "the title shows", kind: "look", how: "look at the title" }, check],
  });
  const problem = (check: Record<string, unknown>) => {
    const parsed = State.ladderOf(
      Array.from({ length: 4 }, () => rung(check)) as unknown as Parameters<
        typeof State.ladderOf
      >[0],
    );
    return "error" in parsed ? parsed.error : null;
  };
  const state = (expect: string, extra: Record<string, unknown> = {}) => ({
    what: "it holds",
    kind: "state",
    from: "play",
    input: [{ hold: "d", ms: 500 }],
    expect,
    ...extra,
  });
  const look = (what: string, how = "watch it") => ({ what, kind: "look", how });

  it("refuses setups and teleports, volume rewards, and audio or sub-second looks", () => {
    expect(problem(state("won == true", { setup: "shrine5" }))).toMatch(
      /no setup states or teleports/,
    );
    expect(problem(state("won == true", { values: { position: [1, 2, 3] } }))).toMatch(
      /drop setup and values/,
    );
    expect(problem(state("score >= 10"))).toMatch(/"score >= 10" rewards volume/);
    expect(problem(state("delta(gems) > 2"))).toMatch(/rewards volume/);
    expect(problem(look("at least 5 enemy types appear"))).toMatch(/rewards volume/);
    expect(problem(look("a chime plays when a gem is taken"))).toMatch(/without sound/);
    expect(problem(look("the music swells near the gate"))).toMatch(/without sound/);
    expect(problem(look("the screen shakes on a hit"))).toMatch(/faster than frames show/);
    expect(problem(look("the knight flashes red", "for 0.32 s after a hit"))).toMatch(
      /faster than frames show/,
    );
  });

  it("takes what play can verify: exists, exact states, upper bounds, still looks", () => {
    expect(problem(state("delta(score) >= 1"))).toBeNull();
    expect(problem(state("lives <= 3 and won == false"))).toBeNull();
    expect(problem(state("sounds_played > 0"))).toBeNull();
    expect(problem(look("at least one enemy is on screen"))).toBeNull();
    expect(problem(look("the flashlight beam lights the path", "look at the frames"))).toBeNull();
    expect(problem(look("a 2.5 s countdown shows before each wave"))).toBeNull();
    expect(problem(look("the player respawns within 1.5 seconds"))).toBeNull();
    expect(problem(look("the settings menu shows a music volume slider"))).toBeNull();
    expect(problem(look("a mute button sits on the HUD"))).toBeNull();
    expect(problem(look("the hit flash lasts 300 ms"))).toMatch(/faster than frames show/);
    expect(problem(look("the door opens in .5 s"))).toMatch(/faster than frames show/);
  });
});
