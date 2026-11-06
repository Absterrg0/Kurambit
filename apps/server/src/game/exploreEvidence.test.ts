// Blind judges weigh exposure, so a session written after every act and at
// close, or reloaded after a restart, must count exactly once.
// @effect-diagnostics nodeBuiltinImport:off -- The record is a file on disk; the test reads it back as a restart would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as ExploreEvidence from "./exploreEvidence.ts";

// The record as the atomic writer leaves it (its own tests cover the write).
const writeRecord = async (dir: string, record: ExploreEvidence.ThreadEvidence) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(ExploreEvidence.recordPath(dir, record.threadId), JSON.stringify(record));
};
const readRecord = async (dir: string, threadId: string) => {
  const found = await ExploreEvidence.read(dir, threadId);
  return found === "damaged" ? null : found;
};

const session = (id: string, actions: number, nominalMs: number, closed = false) => ({
  id,
  actions,
  executedInputSteps: actions * 2,
  nominalMs,
  images: actions,
  frames: Array.from({ length: actions }, (_, i) => ({ step: i + 1, path: `/f/${id}-${i + 1}` })),
  closed,
  closeReason: closed ? "closed" : null,
});

describe("explore evidence", () => {
  it("counts a session rewritten after each act and at close once", () => {
    let record = ExploreEvidence.empty("t", "/g");
    record = ExploreEvidence.upsert(record, session("a", 1, 1000));
    record = ExploreEvidence.upsert(record, session("a", 2, 2500));
    record = ExploreEvidence.upsert(record, session("a", 2, 2500, true));
    record = ExploreEvidence.upsert(record, session("b", 1, 400));
    expect(ExploreEvidence.totals(record)).toEqual({
      sessions: 2,
      actions: 3,
      executedInputSteps: 6,
      nominalMs: 2900,
      images: 3,
    });
    expect(ExploreEvidence.totals(record, "b").nominalMs).toBe(2500);
    expect(ExploreEvidence.frames(record).map((f) => [f.session, f.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
  });

  it("closes a session the previous process left open, keeping what it recorded", () => {
    const record = ExploreEvidence.upsert(
      ExploreEvidence.upsert(ExploreEvidence.empty("t", "/g"), session("a", 3, 9000, true)),
      session("b", 2, 4000),
    );
    const reloaded = ExploreEvidence.closeOrphans(record, new Set());
    expect(reloaded.sessions.map((s) => [s.closed, s.closeReason])).toEqual([
      [true, "closed"],
      [true, "server-restarted"],
    ]);
    expect(ExploreEvidence.totals(reloaded)).toEqual(ExploreEvidence.totals(record));
    expect(ExploreEvidence.closeOrphans(record, new Set(["b"])).sessions[1]!.closed).toBe(false);
  });

  it("keeps a sample's input budget and its memory waits across a restart", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "explore-evidence-"));
    try {
      const record: ExploreEvidence.ThreadEvidence = {
        ...ExploreEvidence.upsert(ExploreEvidence.empty("t", "/g"), session("a", 2, 30_000)),
        inputCapMs: 120_000,
        memory: { waitedMs: 45_000, refused: "busy" },
      };
      await writeRecord(dir, record);
      const reloaded = await readRecord(dir, "t");
      expect(reloaded?.inputCapMs).toBe(120_000);
      expect(reloaded?.memory).toEqual({ waitedMs: 45_000, refused: "busy" });
      // A record an older server wrote, with a refusal count and a plain flag, still reads.
      NodeFS.writeFileSync(
        ExploreEvidence.recordPath(dir, "t"),
        JSON.stringify({ ...record, memory: { waitedMs: 1, refusals: 1, refused: true } }),
      );
      expect((await readRecord(dir, "t"))?.memory).toEqual({
        waitedMs: 1,
        refused: true,
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never takes an unreadable record for no play, and tells damaged from missing", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "explore-evidence-"));
    try {
      expect(await ExploreEvidence.read(dir, "t")).toBeNull();
      NodeFS.writeFileSync(ExploreEvidence.recordPath(dir, "t"), "{not json");
      expect(await ExploreEvidence.read(dir, "t")).toBe("damaged");
      const aside = await ExploreEvidence.setAside(dir, "t", 1);
      expect(NodeFS.existsSync(aside)).toBe(true);
      // A record that cannot be read at all is an error, never "none".
      NodeFS.mkdirSync(ExploreEvidence.recordPath(dir, "t"));
      await expect(ExploreEvidence.read(dir, "t")).rejects.toThrow();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
