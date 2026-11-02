// Keep-or-revert, stalls, the pending line, budget and resume decide what happens to a
// creator's game history; these are pure decisions, so they are checked here.
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@kurambit/contracts";
import * as Policy from "./policy.ts";
import * as State from "./state.ts";

const T0 = 1_000_000_000_000;
const MIN = 60_000;
const goodEvidence = {
  sessions: 1,
  actions: 4,
  executedInputSteps: 4,
  nominalMs: 90_000,
  images: 4,
};

const base = (patch: Partial<State.RunState> = {}): State.RunState => ({
  ...State.freshState(
    {
      runId: "run_t",
      brief: "b",
      artDirection: "",
      budgetMinutes: null,
      provider: null,
      model: null,
      variant: null,
      startedAt: "x",
    },
    { rounds: [], pending: null },
  ),
  lane: "godot",
  ...patch,
});

const done = (step: State.Step, patch: Partial<Policy.RoleDone> = {}): Policy.RoleDone => ({
  kind: "done",
  threadId: ThreadId.make(
    step.kind === "role" && step.thread !== null ? step.thread : `t-${step.id}`,
  ),
  text: "",
  files: {},
  evidence: goodEvidence,
  timedOut: false,
  budgetCut: false,
  elapsedMs: MIN,
  sourceBefore: "s0",
  sourceAfter: `s${step.id}`,
  botsBefore: 0,
  botsAfter: 1,
  ...patch,
});
const gitOk = (patch: Partial<Policy.GitOutcome> = {}): Policy.StepResult => ({
  kind: "git",
  git: {
    ok: true,
    sha: "c0ffee",
    branch: "round-1",
    changed: true,
    entered: false,
    lines: 10,
    detail: "",
    ...patch,
  },
});

type Responder = (step: State.Step, state: State.RunState) => Policy.StepResult;

// Plans and applies until `until` holds or the run ends; returns the steps taken.
const drive = (
  start: State.RunState,
  respond: Responder,
  until: (s: State.RunState) => boolean,
  now = T0,
) => {
  let state = start;
  const steps: string[] = [];
  for (let guard = 0; guard < 200 && !until(state) && state.ending === null; guard += 1) {
    const planned = Policy.plan(state, { now, coin: 0.3, id: `id${guard}` });
    if (planned.kind === "end") return { state: { ...state, ending: planned.reason }, steps };
    state = planned.state;
    const s = planned.step;
    steps.push(
      s.kind === "role" ? s.role.replace(/-[0-9a-z]+$/, "") : s.kind === "git" ? s.op._tag : s.kind,
    );
    state = Policy.applyResult(state, s, respond(s, state), {
      now,
      coin: 0.3,
      id: `a${guard}`,
    }).state;
  }
  return { state, steps };
};

// A responder for a whole round. v1 answers order 1 (A=candidate), v2 order 2 (A=best).
const roundResponder =
  (v1: string, v2: string, opts: { bootOk?: boolean; changed?: boolean } = {}): Responder =>
  (step, state) => {
    if (step.kind === "git") {
      if (step.op._tag === "start-round") return gitOk({ branch: "round-1", sha: "best" });
      if (step.op._tag === "commit") return gitOk({ sha: "cand", changed: opts.changed ?? true });
      if (step.op._tag === "ff-merge") return gitOk({ sha: "merged", branch: "main" });
      return gitOk({ branch: "main" });
    }
    if (step.kind === "boot")
      return { kind: "boot", ok: opts.bootOk ?? true, detail: "check failed" };
    if (step.kind === "facts") return { kind: "facts", jev: false, code: "facts." };
    if (step.kind === "note") return { kind: "note" };
    if (step.role.startsWith("compare")) {
      const t = state.task;
      const aIs = t._tag === "round" ? t.cmp?.judges.at(-1)?.aIs : "x";
      return done(step, {
        files: { [step.read[0]!]: `COMPARE: ${aIs === "x" ? v1 : v2}\nplay-based reasons` },
      });
    }
    if (step.role.startsWith("builder")) return done(step, { elapsedMs: step.capMs });
    if (step.role.startsWith("reviewer"))
      return done(step, {
        files: {
          ".studio/next.md": "fix the jump\nSTATUS: continue",
          [step.read[0] ?? "x"]: "reviewer notes long enough",
        },
      });
    return done(step, {
      files: Object.fromEntries(step.read.map((f) => [f, "notes that are long enough to count"])),
    });
  };

const atRound = (patch: Partial<State.RunState> = {}) =>
  base({
    trunk: "main",
    best: "best",
    stage: "build",
    task: Policy.applyResult(
      base({ stage: "build" }),
      { kind: "git", id: 1, op: { _tag: "init" } },
      gitOk({ sha: "best", branch: "main" }),
      { now: T0, coin: 0, id: "i" },
    ).state.task,
    ...patch,
  });

describe("classifyComparePair", () => {
  it("needs the candidate to win both orders", () => {
    expect(Policy.classifyComparePair("A", "B")).toBe("candidate-wins");
    expect(Policy.classifyComparePair("B", "A")).toBe("best-wins");
    expect(Policy.classifyComparePair("A", "A")).toBe("inconclusive");
    expect(Policy.classifyComparePair("TIE", "B")).toBe("inconclusive");
    expect(Policy.classifyComparePair("NONE", "B")).toBe("unjudged");
    expect(Policy.classifyComparePair("B", "NONE")).toBe("unjudged");
  });
});

describe("rounds", () => {
  it("keeps a candidate that wins both orders and moves best to the merge", () => {
    const { state, steps } = drive(
      atRound({ stallStreak: 2 }),
      roundResponder("A", "B"),
      (s) => s.rounds.length === 1,
    );
    expect(steps).toEqual([
      "start-round",
      "builder",
      "commit",
      "boot",
      "facts",
      "tester",
      "tester",
      "restore-commit",
      "sample",
      "sample",
      "sample",
      "sample",
      "compare",
      "compare",
      "ff-merge",
      "facts",
      "reviewer",
      "reviewer",
    ]);
    expect(state.rounds[0]?.kept).toBe(true);
    expect(state.best).toBe("merged");
    expect(state.stallStreak).toBe(0);
    expect(state.next).toContain("fix the jump");
  });

  it("drops the candidate when best wins both orders and counts a stall", () => {
    const { state, steps } = drive(
      atRound(),
      roundResponder("B", "A"),
      (s) => s.rounds.length === 1,
    );
    expect(steps).toContain("to-trunk");
    expect(steps).not.toContain("ff-merge");
    expect(state.rounds[0]?.kept).toBe(false);
    expect(state.best).toBe("best");
    expect(state.stallStreak).toBe(1);
  });

  it("opens a pending line on a split and drops it after three", () => {
    const one = drive(atRound(), roundResponder("A", "A"), (s) => s.rounds.length === 1).state;
    expect(one.pending?.branch).toBe("round-1");
    expect(one.stallStreak).toBe(0);
    expect(one.rounds[0]?.inconclusive).toBe(true);
    const dropped = Policy.advancePending(
      { branch: "r", round: 2, verdicts: [], streak: 2 },
      "r",
      3,
      [],
    );
    expect(dropped).toEqual({ pending: null, dropStall: true });
  });

  it("rejects a boot failure and ends the run on the third stall", () => {
    const { state, steps } = drive(
      atRound({ stallStreak: 2 }),
      roundResponder("A", "B", { bootOk: false }),
      () => false,
    );
    expect(steps).toEqual(["start-round", "builder", "commit", "boot", "reject"]);
    expect(state.stallStreak).toBe(3);
    expect(state.rounds[0]?.note).toContain("boot failed");
    expect(state.ending).toBe("stalled");
  });

  it("retries a block that changed no game files once, then stalls", () => {
    const { state, steps } = drive(
      atRound(),
      roundResponder("A", "B", { changed: false }),
      (s) => s.rounds.length === 1,
    );
    expect(steps).toEqual(["start-round", "builder", "commit", "builder", "commit", "to-trunk"]);
    expect(state.stallStreak).toBe(1);
  });

  it("ends the builder block after two turns without a source change", () => {
    const quiet: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("builder")
        ? done(step, { sourceBefore: "same", sourceAfter: "same", elapsedMs: 1000 })
        : roundResponder("A", "B")(step, state);
    const { steps } = drive(
      atRound(),
      quiet,
      (s) => s.task._tag === "round" && s.task.phase === "boot",
    );
    expect(steps.filter((s) => s === "builder")).toHaveLength(2);
  });

  it("asks the tester for a bot run once when none was recorded", () => {
    const lazy: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("tester")
        ? done(step, {
            botsBefore: 3,
            botsAfter: 3,
            files: { [step.read[0] ?? "x"]: "tester notes long enough to count" },
          })
        : roundResponder("A", "B")(step, state);
    const { steps } = drive(
      atRound(),
      lazy,
      (s) => s.task._tag === "round" && s.task.phase === "compare",
    );
    expect(steps.filter((s) => s === "tester")).toHaveLength(3);
  });

  it("sends a player that used little of its play budget back for one more turn", () => {
    // Cumulative evidence per thread: 12s after the first turn, 80s after the second.
    const shortPlay: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("sample") && step.read.length === 0
        ? done(step, {
            evidence: {
              ...goodEvidence,
              nominalMs: step.prompt.includes("You used about") ? 80_000 : 12_000,
            },
          })
        : roundResponder("A", "B")(step, state);
    const { state, steps } = drive(atRound(), shortPlay, (s) => s.rounds.length === 1);
    // Per build: play, one more play, write.
    expect(steps.filter((s) => s === "sample")).toHaveLength(6);
    expect(state.rounds[0]?.kept).toBe(true);
  });

  it("marks a round unjudged when play evidence fails the gate even after a replay", () => {
    const noInput: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("sample")
        ? done(step, { evidence: { ...goodEvidence, executedInputSteps: 0 } })
        : roundResponder("A", "B")(step, state);
    const { state, steps } = drive(atRound(), noInput, (s) => s.rounds.length === 1);
    expect(steps.filter((s) => s === "sample")).toHaveLength(8);
    expect(steps).not.toContain("compare");
    expect(state.rounds[0]?.unjudged).toBe(true);
    expect(state.rounds[0]?.verdicts.map((v) => v.verdict)).toEqual(["NONE", "NONE"]);
  });
});

describe("art review", () => {
  const atArt = base({
    trunk: "main",
    best: "best",
    stage: "plan",
    task: {
      _tag: "stage",
      name: "art",
      phase: "role",
      thread: null,
      block: null,
      sha: "",
      why: "",
      review: "",
    },
  });
  // Plays the art stage with the given review text; records each role step it saw.
  const playArt = (review: string) => {
    const seen: State.RoleStep[] = [];
    const respond: Responder = (step) => {
      if (step.kind === "git") return gitOk({ sha: "art", branch: "main" });
      if (step.kind === "boot") return { kind: "boot", ok: true, detail: "boot clean" };
      if (step.kind !== "role") throw new Error(`unexpected ${step.kind}`);
      seen.push(step);
      if (step.role === "art-director")
        return done(step, { files: { ".studio/art-review.md": review } });
      return done(step, { threadId: ThreadId.make("art-thread") });
    };
    const { state, steps } = drive(
      atArt,
      respond,
      (s) => s.task._tag === "stage" && s.task.name === "build",
    );
    return { state, steps, roles: seen };
  };

  it("commits the art as it is on KEEP", () => {
    const { state, roles, steps } = playArt("- key.png: fine\nART: KEEP");
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director"]);
    expect(steps.slice(-2)).toEqual(["commit", "boot"]);
    expect(state.best).toBe("art");
  });

  it("gives one redo turn on the art thread with the defect list, then continues", () => {
    const review =
      "- assets/firefly.png: plain white dot, no glow; render a soft additive glow\nART: REDO";
    const { state, roles, steps } = playArt(review);
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director", "art"]);
    const redo = roles[2]!;
    expect(redo.thread).toBe("art-thread");
    expect(redo.prompt).toContain("plain white dot, no glow");
    expect(redo.prompt).not.toContain("ART: REDO");
    expect(steps.slice(-2)).toEqual(["commit", "boot"]);
    expect(state.task._tag === "stage" && state.task.name).toBe("build");
  });

  it("keeps the art and logs when the verdict is malformed", () => {
    const { roles } = playArt("looks mostly fine\nART: maybe REDO later");
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director"]);
    const reviewing = {
      ...atArt,
      task: { ...atArt.task, phase: "review" as const, thread: ThreadId.make("art-thread") },
    } as State.RunState;
    const planned = Policy.plan(reviewing, { now: T0, coin: 0, id: "r" });
    if (planned.kind !== "step") throw new Error("expected the review step");
    const applied = Policy.applyResult(
      planned.state,
      planned.step,
      done(planned.step, { files: { ".studio/art-review.md": "no verdict here at all" } }),
      { now: T0, coin: 0, id: "r2" },
    );
    expect(applied.state.task._tag === "stage" && applied.state.task.phase).toBe("commit");
    expect(applied.logs.join("\n")).toContain("keeping the art");
  });
});

describe("steering", () => {
  it("puts the creator's notes ahead of next.md at round start and clears them once used", () => {
    const start = atRound({ next: "fix the jump", steer: ["make the frogs faster"] });
    const planned = Policy.plan(start, { now: T0, coin: 0, id: "s" });
    if (planned.kind !== "step" || planned.state.task._tag !== "round")
      throw new Error("expected a round start");
    const direction = planned.state.task.direction;
    expect(direction.indexOf("make the frogs faster")).toBeGreaterThanOrEqual(0);
    expect(direction.indexOf("make the frogs faster")).toBeLessThan(
      direction.indexOf("fix the jump"),
    );
    expect(planned.state.task.repeating).toBe(false);
    // A note that arrives while the round starts waits for the next one.
    const arrived = { ...planned.state, steer: [...planned.state.steer, "and add a boss"] };
    const { state } = drive(arrived, roundResponder("A", "B"), (s) => s.rounds.length === 1);
    expect(state.rounds[0]?.steer).toEqual(["make the frogs faster"]);
    expect(state.steer).toEqual(["and add a boss"]);
  });

  it("reads an older run.json without notes as having none", () => {
    const encoded = State.encodeRunState(atRound());
    const { steer: _steer, ...older } = encoded;
    const loaded = State.loadState(JSON.stringify(older), "");
    expect(loaded.kind === "v3" && loaded.state.steer).toEqual([]);
  });
});

describe("budget", () => {
  it("does not start a round that cannot fit", () => {
    const planned = Policy.plan(atRound({ budgetEndsAt: T0 + 21 * MIN }), {
      now: T0,
      coin: 0,
      id: "x",
    });
    expect(planned).toEqual({ kind: "end", reason: "budget" });
  });

  it("leaves to trunk when the block would be under two minutes", () => {
    const { state, steps } = drive(
      atRound({ budgetEndsAt: T0 + 23 * MIN }),
      roundResponder("A", "B"),
      () => false,
    );
    expect(steps).toEqual(["start-round", "to-trunk"]);
    expect(state.ending).toBe("budget");
  });

  it("judges only when both plays and both verdicts fit", () => {
    const budget = { budgetEndsAt: T0 + 30 * MIN };
    const atRestore = drive(
      atRound(budget),
      roundResponder("A", "B"),
      (s) => s.task._tag === "round" && s.task.phase === "restore",
    ).state;
    expect(drive(atRestore, roundResponder("A", "B"), () => false, T0).steps).toContain("sample");
    const late = drive(atRestore, roundResponder("A", "B"), () => false, T0 + 12 * MIN);
    expect(late.steps).toEqual(["restore-commit", "to-trunk"]);
    expect(late.state.ending).toBe("budget");
    expect(late.state.best).toBe("best");
  });
});

describe("resume", () => {
  // A persisted in-flight step is executed again, never re-planned: a role
  // reattaches to its thread and a git op re-runs (every op is repeatable).
  it("re-runs the persisted step of every kind after a round trip through run.json", () => {
    const seen = new Set<string>();
    let state = atRound();
    for (let guard = 0; guard < 60 && state.rounds.length === 0; guard += 1) {
      const planned = Policy.plan(state, { now: T0, coin: 0.7, id: `p${guard}` });
      if (planned.kind === "end") break;
      const json = JSON.stringify(State.encodeRunState(planned.state));
      const loaded = State.loadState(json, "");
      expect(loaded.kind).toBe("v3");
      if (loaded.kind !== "v3") return;
      const again = Policy.plan(loaded.state, { now: T0 + MIN, coin: 0.1, id: "other" });
      expect(again.kind === "step" && again.step).toEqual(planned.step);
      seen.add(planned.step.kind === "git" ? `git:${planned.step.op._tag}` : planned.step.kind);
      state = Policy.applyResult(
        planned.state,
        planned.step,
        roundResponder("A", "B")(planned.step, planned.state),
        { now: T0, coin: 0.7, id: `q${guard}` },
      ).state;
    }
    for (const kind of [
      "role",
      "boot",
      "facts",
      "git:start-round",
      "git:commit",
      "git:restore-commit",
      "git:ff-merge",
    ])
      expect(seen).toContain(kind);
  });

  it("keeps a usage-limited step in flight with its thread for the resume", () => {
    const planned = Policy.plan(atRound(), { now: T0, coin: 0, id: "x" });
    if (planned.kind !== "step") throw new Error("expected a step");
    const attached = { ...planned.step };
    const applied = Policy.applyResult(
      planned.state,
      attached,
      { kind: "ended", ending: "usage-limit", reason: "usage limit" },
      { now: T0, coin: 0, id: "y" },
    );
    expect(applied.state.ending).toBe("usage-limit");
    expect(applied.state.inFlight).toEqual(attached);
  });

  it("migrates a run.json from the old loop and resumes at init", () => {
    const old = JSON.stringify({
      runId: "run_old",
      brief: "b",
      stage: "round-4",
      ending: "budget",
      stallStreak: 1,
      rounds: [],
      threads: [],
      pending: null,
    });
    const journal = `${JSON.stringify({ round: 1, move: "m", branch: "round-1", verdicts: [], kept: true, durationMs: 1, linesChanged: 2, sweepFindings: 0 })}\n{torn`;
    const loaded = State.loadState(old, journal);
    expect(loaded.kind).toBe("legacy");
    if (loaded.kind !== "legacy") return;
    expect(loaded.state.rounds).toHaveLength(1);
    expect(loaded.state.task._tag).toBe("init");
    const next = Policy.applyResult(
      loaded.state,
      { kind: "git", id: 1, op: { _tag: "init" } },
      gitOk({ sha: "abc", branch: "main" }),
      { now: T0, coin: 0, id: "i" },
    ).state;
    expect(next.task._tag).toBe("round");
    expect(next.trunk).toBe("main");
    expect(State.loadState("{not json", "").kind).toBe("unreadable");
  });
});
