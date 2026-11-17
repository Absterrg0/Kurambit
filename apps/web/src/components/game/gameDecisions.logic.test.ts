import { describe, expect, it } from "vite-plus/test";

import { decisionRows } from "./gameDecisions.logic";

const said = (decisions: Parameters<typeof decisionRows>[0]) =>
  decisionRows(decisions).map((row) => row.said);

describe("decisionRows", () => {
  it("folds a keep that was later undone into the undo's line, newest first", () => {
    const decisions = [
      {
        line: 3,
        date: "2026-11-17",
        text: "Kept tuned values as Build 2: Island › Cabin roof colour #3c4a5c → #b8322a",
        kind: "kept-values" as const,
        build: "b2",
      },
      {
        line: 4,
        date: "2026-11-17",
        text: "Undid Build 2: tuned Island › Cabin roof colour #3c4a5c → #b8322a",
        kind: "undone" as const,
        build: "b2",
      },
      {
        line: 5,
        date: "2026-11-17",
        text: "Kept tuned values as Build 3: Fisher knit colour #d9a441 → #3a7bd5; player jump 9 → 12",
        kind: "kept-values" as const,
        build: "b3",
      },
    ];
    expect(said(decisions)).toEqual([
      "Fisher knit: kept #d9a441 → #3a7bd5 · player jump: kept 9 → 12",
      "Undid: Cabin roof #3c4a5c → #b8322a",
    ]);
    // Forgetting the undo forgets the keep it folded in.
    expect(decisionRows(decisions)[1]!.lines.map((line) => line.line)).toEqual([4, 3]);
    expect(
      decisionRows(decisions)[0]!.pieces.filter((piece) => piece._tag === "colour"),
    ).toHaveLength(2);
  });

  it("keeps a hand-written line as written", () => {
    expect(said([{ line: 1, date: "", text: "No music with lyrics" }])).toEqual([
      "No music with lyrics",
    ]);
  });
});
