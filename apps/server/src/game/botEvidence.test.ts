// A run decides by a thread's bot runs, so the record must come back whole
// after a restart, stay bounded without losing the bot a comparison replays,
// and never read another thread's runs.
// @effect-diagnostics nodeBuiltinImport:off -- The record is a file on disk; the test reads it back as a restart would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as BotEvidence from "./botEvidence.ts";
import { recordPath } from "./exploreEvidence.ts";

const run = (runId: string, mode: string) => ({
  runId,
  file: `.studio/bot/${mode}.mjs`,
  mode,
  decider: "policy",
  won: false,
  seconds: 30,
  findings: 0,
  at: "2026-11-06T00:00:00.000Z",
});

describe("bot evidence", () => {
  it("comes back after a restart, bounded, with every run counted", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bot-evidence-"));
    try {
      let record = BotEvidence.add(BotEvidence.empty("t", "/g"), "/g", run("p", "play"));
      for (let i = 0; i < BotEvidence.KEPT_RUNS; i++)
        record = BotEvidence.add(record, "/g", run(`e${i}`, "explore"));
      // The record as the atomic writer leaves it (its own tests cover the write).
      NodeFS.writeFileSync(recordPath(dir, "t"), JSON.stringify(record));
      const reloaded = await BotEvidence.read(dir, "t");
      expect(reloaded).toEqual(record);
      expect(record.count).toBe(BotEvidence.KEPT_RUNS + 1);
      expect(record.runs).toHaveLength(BotEvidence.KEPT_RUNS);
      // The bot a comparison replays outlives the exploration runs after it.
      expect(BotEvidence.lastPlay(reloaded as BotEvidence.ThreadBots)?.file).toBe(
        ".studio/bot/play.mjs",
      );
      expect(await BotEvidence.read(dir, "other")).toBeNull();
      // Another thread's record under this thread's name is no run of its own.
      NodeFS.copyFileSync(recordPath(dir, "t"), recordPath(dir, "u"));
      expect(await BotEvidence.read(dir, "u")).toBe("damaged");
      // Moved aside, not overwritten: its count stays readable for a person.
      const aside = await BotEvidence.setAside(dir, "u", 1);
      expect(await BotEvidence.read(dir, "u")).toBeNull();
      expect(JSON.parse(NodeFS.readFileSync(aside, "utf8")).count).toBe(record.count);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
