// The skilled fact plays a thread's latest play bot, so the record must come
// back whole after a restart, stay bounded, read as an earlier version wrote
// it, and never read another thread's runs.
// @effect-diagnostics nodeBuiltinImport:off -- The record is a file on disk; the test reads it back as a restart would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as BotEvidence from "./botEvidence.ts";

const run = (runId: string, mode: string) => ({
  runId,
  file: `.studio/bot/${mode}.mjs`,
  mode,
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
        record = BotEvidence.add(record, "/g", run(`p${i}`, "play"));
      // The record as the atomic writer leaves it (its own tests cover the write).
      NodeFS.writeFileSync(BotEvidence.recordPath(dir, "t"), JSON.stringify(record));
      const reloaded = await BotEvidence.read(dir, "t");
      expect(reloaded).toEqual(record);
      expect(record.count).toBe(BotEvidence.KEPT_RUNS + 1);
      expect(record.runs).toHaveLength(BotEvidence.KEPT_RUNS);
      expect((reloaded as BotEvidence.ThreadBots).play?.runId).toBe(
        `p${BotEvidence.KEPT_RUNS - 1}`,
      );
      expect(await BotEvidence.read(dir, "other")).toBeNull();
      // A record written while runs named their decider, with exploration runs after its
      // play run, still reads, and its play run is still the one the skilled fact plays.
      NodeFS.writeFileSync(
        BotEvidence.recordPath(dir, "old"),
        JSON.stringify({
          ...BotEvidence.add(BotEvidence.empty("old", "/g"), "/g", run("p", "play")),
          runs: [run("p", "play"), run("e", "explore")],
          count: 2,
          play: { ...run("p", "play"), decider: "jev" },
        }),
      );
      expect(((await BotEvidence.read(dir, "old")) as BotEvidence.ThreadBots).play?.file).toBe(
        ".studio/bot/play.mjs",
      );
      // Another thread's record under this thread's name is no run of its own.
      NodeFS.copyFileSync(BotEvidence.recordPath(dir, "t"), BotEvidence.recordPath(dir, "u"));
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
