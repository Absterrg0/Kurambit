// Blind judges weigh exposure, so a session written after every act and at
// close, or reloaded after a restart, must count exactly once.
import { describe, expect, it } from "@effect/vitest";
import * as ExploreEvidence from "./exploreEvidence.ts";

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
});
