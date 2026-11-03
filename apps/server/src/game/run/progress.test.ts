// The pick's winner is read back from the notes the policy left; a wrong read
// would tell the creator the game became the prototype it set aside.
import { describe, expect, it } from "@effect/vitest";
import { pickRef } from "./progress.ts";
import * as State from "./state.ts";

const state = (patch: Partial<State.RunState>): State.RunState => ({
  ...State.freshState(
    {
      runId: "run_t",
      brief: "b",
      artDirection: "",
      budgetMinutes: null,
      provider: null,
      model: null,
      variant: null,
      startedAt: "2026-11-03T11:33:00.000Z",
    },
    { rounds: [], pending: null },
  ),
  stage: "plan",
  task: { _tag: "init" },
  protos: [
    { branch: "proto-0", booted: true },
    { branch: "proto-1", booted: true },
  ],
  ...patch,
});
const record = { sides: { A: "proto-1", B: "proto-0" }, verdict: null };

describe("pickRef", () => {
  it("maps the legend's blind label to its prototype", () => {
    const notes =
      "(In these notes, B is the prototype the game continued from, now on main; A is the one set aside.)\nCOMPARE: B";
    expect(pickRef(state({ pickNotes: notes }), record)?.chosen).toBe("proto-0");
  });

  it("falls back to the comparator's verdict for notes written before the legend", () => {
    const old = state({ pickNotes: "COMPARE: A\n\nA plays better." });
    expect(pickRef(old, { ...record, verdict: "A" })?.chosen).toBe("proto-1");
  });

  it("names no winner for an unresolved tie and the lone booted prototype otherwise", () => {
    expect(pickRef(state({ pickNotes: "COMPARE: TIE" }), { ...record, verdict: "TIE" })).toEqual({
      phase: "done",
      chosen: null,
      durationMs: null,
    });
    const single = state({
      protos: [
        { branch: "proto-0", booted: false },
        { branch: "proto-1", booted: true },
      ],
    });
    expect(pickRef(single, { sides: {}, verdict: null })?.chosen).toBe("proto-1");
  });

  it("is absent for a run that never reached prototypes", () => {
    expect(pickRef(state({ protos: [] }), { sides: {}, verdict: null })).toBeNull();
  });
});
