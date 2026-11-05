// Keep-or-revert, stalls, the pending line, budget and resume decide what happens to a
// creator's game history; these are pure decisions, so they are checked here.
import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@kurambit/contracts";
import * as Policy from "./policy.ts";
import * as State from "./state.ts";

const T0 = 1_000_000_000_000;
const POLISH = "polish the game";
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
      profile: "autopilot",
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
  evidence: goodEvidence,
  timedOut: false,
  budgetCut: false,
  elapsedMs: MIN,
  sourceBefore: "s0",
  sourceAfter: `s${step.id}`,
  bots: 1,
  bot: null,
  sheet: "",
  ...patch,
});
const buildOk = (patch: Partial<Policy.BuildOutcome> = {}): Policy.StepResult => ({
  kind: "build",
  build: { ok: true, sha: "c0ffee", changed: true, lines: 10, detail: "", ...patch },
});

type Single = Exclude<State.Step, State.PairStep>;
type Responder = (step: Single, state: State.RunState) => Policy.StepResult;

const stepName = (s: Single) =>
  s.kind === "role" ? s.role.replace(/-[0-9a-z]+$/, "") : s.kind === "build" ? s.op._tag : s.kind;

// A pair's halves answer in the order given (x then y, unless reversed), as a
// driver would record them when each finishes; then the pair applies.
const answerPair = (
  pair: State.PairStep,
  state: State.RunState,
  respond: Responder,
  reverse = false,
): State.PairStep => ({
  ...pair,
  results: (reverse ? pair.halves.toReversed() : pair.halves).map((half) => ({
    id: half.id,
    result: respond(half, state) as State.HalfResult,
  })),
});

// Applies a planned step, a pair through its halves.
const applyStep = (
  state: State.RunState,
  step: State.Step,
  respond: Responder,
  input: Policy.Inputs,
): Policy.Applied =>
  step.kind === "pair"
    ? Policy.applyPair(state, answerPair(step, state, respond), input)
    : Policy.applyResult(state, step, respond(step, state), input);

const asked = (state: State.RunState): State.RunState => ({ ...state, steer: [POLISH] });
/** The restore that starts a round in the folder from its base. */
const roundStart = (step: Single, state: State.RunState) =>
  step.kind === "build" &&
  step.op._tag === "restore" &&
  state.task._tag === "round" &&
  state.task.phase === "start";

// Plans and applies until `until` holds or the run ends; returns the steps taken.
const drive = (
  start: State.RunState,
  respond: Responder,
  until: (s: State.RunState) => boolean,
  now = T0,
) => {
  let state = start;
  const steps: string[] = [];
  const logs: string[] = [];
  const released: string[] = [];
  const written: Record<string, string> = {};
  const pairs: string[][] = [];
  // A creator who keeps asking for polish: finish rounds run only on an ask.
  const polishing = start.steer.includes(POLISH);
  for (let guard = 0; guard < 200 && !until(state) && state.ending === null; guard += 1) {
    if (
      polishing &&
      state.steer.length === 0 &&
      state.task._tag === "round" &&
      state.task.phase === "start"
    )
      state = asked(state);
    const planned = Policy.plan(state, { now, coin: 0.3, id: `id${guard}` });
    if (planned.kind === "end")
      return {
        state: { ...state, ending: planned.reason },
        steps,
        logs,
        released,
        written,
        pairs,
      };
    logs.push(...(planned.logs ?? []));
    state = planned.state;
    const s = planned.step;
    const applyInput = { now, coin: 0.3, id: `a${guard}` };
    let applied: Policy.Applied;
    if (s.kind === "pair") {
      steps.push(...s.halves.map(stepName));
      pairs.push(s.halves.map(stepName));
      applied = Policy.applyPair(state, answerPair(s, state, respond), applyInput);
    } else {
      steps.push(stepName(s));
      applied = Policy.applyResult(state, s, respond(s, state), applyInput);
    }
    logs.push(...applied.logs);
    released.push(...applied.release);
    for (const file of applied.files) written[file.path] = file.text;
    state = applied.state;
  }
  return { state, steps, logs, released, written, pairs };
};

// A responder for a whole round. v1 answers order 1 (A=candidate), v2 order 2 (A=best).
const roundResponder =
  (
    v1: string,
    v2: string,
    opts: {
      bootOk?: boolean;
      changed?: boolean;
      bot?: (sha: string) => Policy.StepResult;
      checks?: (k: number, state: State.RunState) => boolean;
    } = {},
  ): Responder =>
  (step, state) => {
    if (step.kind === "build") {
      if (step.op._tag === "capture")
        return buildOk({
          sha: step.op.name === "base" ? "best" : "cand",
          changed: opts.changed ?? true,
        });
      return buildOk({ sha: step.op.sha });
    }
    if (step.kind === "git") throw new Error("a run on checkpoints plans no git step");
    if (step.kind === "boot")
      return { kind: "boot", ok: opts.bootOk ?? true, detail: "check failed" };
    if (step.kind === "facts") return { kind: "facts", jev: false, code: "facts." };
    if (step.kind === "checks") {
      // By default every state check of the rung passes; opts.checks scripts failures.
      const rung = state.ladder?.rungs.find((x) => x.id === step.rung);
      const results = (rung?.checks ?? []).flatMap((c, k) =>
        c.kind === "state"
          ? [
              {
                k,
                what: c.what,
                pass: opts.checks?.(k, state) ?? true,
                evidence: "read",
                frame: "",
              },
            ]
          : [],
      );
      return { kind: "checks", results };
    }
    if (step.kind === "note") return { kind: "note" };
    if (step.kind === "decide")
      return { kind: "decided", answer: step.decision.fallback, notes: "", by: "default" };
    if (step.kind === "bot")
      return (
        opts.bot?.(step.sha) ?? {
          kind: "bot",
          fact: { ending: "timed out", seconds: 140, final: {}, note: "" },
        }
      );
    if (step.role.startsWith("compare")) {
      const t = state.task;
      const aIs = t._tag === "round" ? t.cmp?.judges.at(-1)?.aIs : "x";
      return done(step, verdictOf(aIs === "x" ? v1 : v2));
    }
    if (step.role.startsWith("builder")) return done(step, { elapsedMs: step.capMs });
    if (step.role.startsWith("reviewer"))
      return done(step, { submission: { _tag: "ledger", ledger: "fix the jump" } });
    return done(step, plainSubmission(state, step));
  };

/**
 * A plan's ladder as it reaches the run: game-run.submit refuses one of the
 * wrong shape in the role's turn, so a ladder that does not parse is a turn
 * that submitted none.
 */
const ladderSubmitted = (text: string): Partial<Policy.RoleDone> => {
  const parsed = State.parseLadder(text);
  return "ladder" in parsed
    ? {
        submission: {
          _tag: "ladder",
          rungs: parsed.ladder.rungs.map(({ is, checks }) => ({ is, checks })),
        },
      }
    : {};
};

/** A comparator's verdict; anything but A, B or TIE is a turn that submitted none. */
const verdictOf = (verdict: string, reasons = "play-based reasons"): Partial<Policy.RoleDone> =>
  verdict === "A" || verdict === "B" || verdict === "TIE"
    ? { submission: { _tag: "verdict", verdict, reasons } }
    : {};

/**
 * What a role hands in by default: notes where its step asks for notes, and no
 * verdict, ladder or selection, which a test gives explicitly when it needs one.
 */
const plainSubmission = (state: State.RunState, step: State.RoleStep): Partial<Policy.RoleDone> => {
  const asked = Policy.asked(state, step);
  const notes = "notes that are long enough to count";
  return asked.kind === "report"
    ? { submission: { _tag: "report", report: notes } }
    : asked.kind === "checks"
      ? { submission: { _tag: "checks", checks: [], notes } }
      : {};
};

// An empty ladder: these rounds are finish rounds, the fix-the-flaw shape, and
// each runs on a creator's ask (drive keeps asking).
const atRound = (patch: Partial<State.RunState> = {}) =>
  base({
    trunk: "main",
    best: "best",
    stage: "build",
    ladder: { rungs: [], note: "finish rounds only" },
    steer: [POLISH],
    task: Policy.applyResult(
      base({ stage: "build" }),
      { kind: "build", id: 1, op: { _tag: "capture", name: "base", base: "" } },
      buildOk({ sha: "best" }),
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
      "restore",
      "builder",
      "capture",
      "boot",
      "facts",
      "tester",
      "tester",
      "restore",
      "sample",
      "sample",
      "sample",
      "sample",
      "compare",
      "compare",
      "keep",
      "facts",
      "reviewer",
      "reviewer",
    ]);
    expect(state.rounds[0]?.kept).toBe(true);
    expect(state.best).toBe("cand");
    expect(state.stallStreak).toBe(0);
    expect(state.next).toContain("fix the jump");
  });

  it("judges a Unity round on blind samples played one at a time in worktrees", () => {
    const samples: Array<string | null> = [];
    const respond = roundResponder("A", "B");
    const { state, steps, logs } = drive(
      atRound({ lane: "unity" }),
      (step, s) => {
        if (step.kind === "role" && step.role.startsWith("sample")) samples.push(step.at);
        return respond(step, s);
      },
      (s) => s.rounds.length === 1,
    );
    expect(steps.slice(steps.indexOf("restore", 1), steps.indexOf("keep"))).toEqual([
      "restore",
      "sample",
      "sample",
      "sample",
      "sample",
      "compare",
      "compare",
    ]);
    // Each build's play and write turns run at its own commit, one build after the other.
    expect(new Set(samples.slice(0, 2)).size).toBe(1);
    expect(new Set(samples.slice(2)).size).toBe(1);
    expect(new Set(samples)).toEqual(new Set(["cand", "best"]));
    expect(logs.some((line) => line.includes("judging on play reports"))).toBe(false);
    expect(state.rounds[0]?.kept).toBe(true);
  });

  it("drops the candidate when best wins both orders and counts a stall", () => {
    const { state, steps } = drive(
      atRound(),
      roundResponder("B", "A"),
      (s) => s.rounds.length === 1,
    );
    expect(steps).toContain("restore");
    expect(steps).not.toContain("keep");
    expect(state.rounds[0]?.kept).toBe(false);
    expect(state.best).toBe("best");
    expect(state.stallStreak).toBe(1);
  });

  it("opens a pending line on a split and drops it after three", () => {
    const one = drive(atRound(), roundResponder("A", "A"), (s) => s.rounds.length === 1).state;
    expect(one.pending?.branch).toBe("round-1");
    // It landed nothing, so it is a stall like any other round that did not.
    expect(one.stallStreak).toBe(1);
    expect(one.rounds[0]?.inconclusive).toBe(true);
    const dropped = Policy.advancePending(
      { branch: "r", round: 2, verdicts: [], streak: 2 },
      "r",
      3,
      [],
    );
    expect(dropped).toBeNull();
    // The third inconclusive round in a row is the third stall: counted once.
    const three = drive(atRound(), roundResponder("A", "A"), () => false).state;
    expect(three.rounds).toHaveLength(3);
    expect(three.stallStreak).toBe(3);
    expect(three.ending).toBe("stalled");
  });

  it("rejects a boot failure and ends the run on the third stall", () => {
    const { state, steps } = drive(
      atRound({ stallStreak: 2 }),
      roundResponder("A", "B", { bootOk: false }),
      () => false,
    );
    expect(steps).toEqual(["restore", "builder", "capture", "boot", "restore"]);
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
    expect(steps).toEqual(["restore", "builder", "capture", "builder", "capture", "restore"]);
    expect(state.stallStreak).toBe(1);
  });

  it("ends the builder block on a turn without a source change", () => {
    const quiet: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("builder")
        ? done(step, { changed: false, elapsedMs: 1000 })
        : roundResponder("A", "B")(step, state);
    const { steps } = drive(
      atRound(),
      quiet,
      (s) => s.task._tag === "round" && s.task.phase === "boot",
    );
    expect(steps.filter((s) => s === "builder")).toHaveLength(1);
  });

  it("asks the tester for a bot run once when none was recorded", () => {
    const lazy: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("tester")
        ? done(step, {
            bots: 0,
            ...plainSubmission(state, step),
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

describe("parallel samples", () => {
  const atCompare = (patch: Partial<State.RunState> = {}) =>
    drive(
      atRound(patch),
      roundResponder("A", "B"),
      (s) => s.task._tag === "round" && s.task.phase === "compare",
    ).state;
  const planPair = (state: State.RunState) => {
    const planned = Policy.plan(state, { now: T0, coin: 0.3, id: "lbl" });
    if (planned.kind !== "step" || planned.step.kind !== "pair") throw new Error("expected a pair");
    return { state: planned.state, pair: planned.step };
  };
  const roles = (pair: State.PairStep) =>
    pair.halves.map((h) => {
      if (h.kind !== "role") throw new Error("expected role halves");
      return h;
    });
  const cmpOf = (state: State.RunState) => {
    if (state.task._tag !== "round" || state.task.cmp === null) throw new Error("no comparison");
    return state.task.cmp;
  };

  it("plans both builds' plays as one pair with identical prompts, caps and budgets", () => {
    const { state, pair } = planPair(atCompare());
    const [x, y] = roles(pair);
    expect([x!.at, y!.at]).toEqual(["cand", "best"]);
    const cmp = cmpOf(state);
    const [lx, ly] = [x!, y!].map((h) => h.role.replace("sample-", ""));
    expect(lx).not.toBe(ly);
    expect(x!.prompt.replace(lx!, "L")).toBe(y!.prompt.replace(ly!, "L"));
    expect([x!.capMs, x!.inputCapMs]).toEqual([y!.capMs, y!.inputCapMs]);
    // Ids follow the coin's play order, so the lower id is not always x.
    const first = cmp.xFirst ? x! : y!;
    expect(first.id).toBe(Math.min(x!.id, y!.id));
    expect(pair.id).toBe(Math.max(x!.id, y!.id));
    expect(state.seq).toBe(pair.id);
    const { pairs } = drive(atRound(), roundResponder("A", "B"), (s) => s.rounds.length === 1);
    expect(pairs).toEqual([
      ["sample", "sample"],
      ["sample", "sample"],
    ]);
  });

  it("lets one build take its extra play turn alone while the other is done", () => {
    const shortOnCand: Responder = (step, state) =>
      step.kind === "role" && step.role.startsWith("sample") && step.read.length === 0
        ? done(step, {
            evidence: {
              ...goodEvidence,
              nominalMs:
                step.at === "cand" && !step.prompt.includes("You used about") ? 12_000 : 80_000,
            },
          })
        : roundResponder("A", "B")(step, state);
    const { state, steps, pairs } = drive(atRound(), shortOnCand, (s) => s.rounds.length === 1);
    expect(steps.filter((s) => s === "sample")).toHaveLength(5);
    // Plays together; then the candidate's extra turn beside the best's write-up; then its write-up alone.
    expect(pairs).toEqual([
      ["sample", "sample"],
      ["sample", "sample"],
    ]);
    expect(state.rounds[0]?.kept).toBe(true);
  });

  it("gives a build played well short of the other one catch-up turn, once", () => {
    const uneven =
      (cand: number, best: number): Responder =>
      (step, state) =>
        step.kind === "role" && step.role.startsWith("sample") && step.read.length === 0
          ? done(step, {
              evidence: {
                ...goodEvidence,
                nominalMs: step.prompt.includes("You used about")
                  ? 100_000
                  : step.at === "cand"
                    ? cand
                    : best,
              },
            })
          : roundResponder("A", "B")(step, state);
    const short = drive(atRound(), uneven(70_000, 110_000), (s) => s.rounds.length === 1);
    // Both plays, the candidate's catch-up turn, both write-ups.
    expect(short.steps.filter((s) => s === "sample")).toHaveLength(5);
    expect(short.logs.some((l) => /plays on: 70 s against 110 s/.test(l))).toBe(true);
    const close = drive(atRound(), uneven(95_000, 110_000), (s) => s.rounds.length === 1);
    expect(close.steps.filter((s) => s === "sample")).toHaveLength(4);
    // A floor turn already spent is the one extra turn: no second catch-up.
    const floored = drive(atRound(), uneven(10_000, 118_000), (s) => s.rounds.length === 1);
    expect(floored.steps.filter((s) => s === "sample")).toHaveLength(5);
  });

  it("replays an unusable sample on its own build only", () => {
    const ats: Array<string | null> = [];
    let candPlays = 0;
    const noInputOnce: Responder = (step, state) => {
      if (step.kind === "role" && step.role.startsWith("sample")) {
        ats.push(step.at);
        // The candidate's first player (its play and write-up turns) records no input.
        if (step.at === "cand" && candPlays++ < 2)
          return done(step, { evidence: { ...goodEvidence, executedInputSteps: 0 } });
      }
      return roundResponder("A", "B")(step, state);
    };
    const { state, steps, pairs, logs } = drive(
      atRound(),
      noInputOnce,
      (s) => s.rounds.length === 1,
    );
    expect(steps.filter((s) => s === "sample")).toHaveLength(6);
    expect(pairs).toHaveLength(2);
    expect(ats.slice(4)).toEqual(["cand", "cand"]);
    expect(logs.some((l) => l.includes("lacked usable hands-on evidence"))).toBe(true);
    expect(state.rounds[0]?.kept).toBe(true);
  });

  it("resumes a half-finished pair and runs only the unfinished half", () => {
    const { state, pair } = planPair(atCompare());
    const [x, y] = roles(pair);
    // x finished and was saved; then the server stopped. y carries the attach an
    // older driver wrote, which still loads.
    const attachedY = {
      ...y!,
      attached: { threadId: ThreadId.make("ty"), runId: RunId.make("run-y") },
    };
    const saved: State.RunState = {
      ...state,
      inFlight: {
        ...pair,
        halves: [x!, attachedY],
        results: [{ id: x!.id, result: done(x!) as State.HalfResult }],
      },
    };
    const again = Policy.plan(saved, { now: T0 + MIN, coin: 0.9, id: "other" });
    if (again.kind !== "step" || again.step.kind !== "pair") throw new Error("expected the pair");
    const resumed = again.step;
    expect(resumed).toEqual(saved.inFlight);
    expect(resumed.halves.filter((h) => !resumed.results.some((r) => r.id === h.id))).toEqual([
      attachedY,
    ]);
    const applied = Policy.applyPair(
      again.state,
      {
        ...resumed,
        results: [...resumed.results, { id: y!.id, result: done(attachedY) as State.HalfResult }],
      },
      { now: T0, coin: 0, id: "a" },
    );
    const samples = cmpOf(applied.state).samples;
    expect(samples.map((s) => [s.side, s.phase])).toEqual(
      expect.arrayContaining([
        ["x", "write"],
        ["y", "write"],
      ]),
    );
    expect(samples.find((s) => s.side === "x")?.thread).toBe(`t-${x!.id}`);
    expect(applied.state.inFlight).toBeNull();
  });

  it("keeps a usage-limited pair in flight with its finished half's result", () => {
    const { state, pair } = planPair(atCompare());
    const [x] = roles(pair);
    const withX = { ...pair, results: [{ id: x!.id, result: done(x!) as State.HalfResult }] };
    const applied = Policy.applyResult(
      state,
      withX,
      { kind: "ended", ending: "usage-limit", reason: "usage limit" },
      { now: T0, coin: 0, id: "y" },
    );
    expect(applied.state.ending).toBe("usage-limit");
    expect(applied.state.inFlight).toEqual(withX);
  });

  it("drops the other half at a budget end and gives its worktree back", () => {
    const { state, pair } = planPair(atCompare());
    const [x, y] = roles(pair);
    const applied = Policy.applyPair(
      state,
      {
        ...pair,
        results: [
          { id: x!.id, result: done(x!, { timedOut: true, budgetCut: true }) as State.HalfResult },
          { id: y!.id, result: done(y!) as State.HalfResult },
        ],
      },
      { now: T0, coin: 0, id: "a" },
    );
    expect(applied.state.task._tag).toBe("leave");
    expect(applied.state.inFlight).toBeNull();
    expect(applied.release).toEqual([`t-${y!.id}`]);
  });

  it("gives the first half's worktree back when the second half ends the round", () => {
    const { state, pair } = planPair(atCompare());
    const [x, y] = roles(pair);
    const applied = Policy.applyPair(
      state,
      {
        ...pair,
        results: [
          { id: x!.id, result: done(x!) as State.HalfResult },
          { id: y!.id, result: done(y!, { timedOut: true, budgetCut: true }) as State.HalfResult },
        ],
      },
      { now: T0, coin: 0, id: "a" },
    );
    expect(applied.state.task._tag).toBe("leave");
    expect(applied.release).toEqual([`t-${x!.id}`]);
  });

  it("keeps Unity samples one at a time", () => {
    const { pairs } = drive(
      atRound({ lane: "unity" }),
      roundResponder("A", "B"),
      (s) => s.rounds.length === 1,
    );
    expect(pairs).toEqual([]);
  });
});

describe("bot facts", () => {
  // The tester's turns report the bot they ran; each build's bot outcome is keyed by sha.
  const withBot =
    (
      outcomes: Record<string, Policy.StepResult>,
      bot = ".studio/bot/win.mjs",
      decider: "policy" | "jev" = "policy",
    ): Responder =>
    (step, state) => {
      if (step.kind === "role" && step.role.startsWith("tester"))
        return done(step, {
          bot: Policy.asked(state, step).kind === null ? { file: bot, decider } : null,
          ...plainSubmission(state, step),
        });
      return roundResponder("A", "B", { bot: (sha) => outcomes[sha]! })(step, state);
    };
  const fact = (ending: string, final: Record<string, number>, note = ""): Policy.StepResult => ({
    kind: "bot",
    fact: { ending, seconds: ending === "error" ? 0 : 148, final, note },
  });
  // Every comparator prompt the round sent.
  const comparePrompts = (respond: Responder) => {
    const prompts: string[] = [];
    const seeing: Responder = (step, state) => {
      if (step.kind === "role" && step.role.startsWith("compare")) prompts.push(step.prompt);
      return respond(step, state);
    };
    const run = drive(atRound(), seeing, (s) => s.rounds.length === 1);
    return { ...run, prompts };
  };

  it("runs the tester's bot on both builds after the plays and gives each report its facts", () => {
    const { steps, prompts, state, pairs } = comparePrompts(
      withBot({ cand: fact("won", { jars: 5 }), best: fact("timed out", { jars: 2 }) }),
    );
    expect(steps.slice(steps.indexOf("restore", 1), steps.indexOf("compare"))).toEqual([
      "restore",
      "sample",
      "sample",
      "sample",
      "sample",
      "bot",
      "bot",
    ]);
    expect(pairs).toContainEqual(["bot", "bot"]);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("not how play feels");
      expect(prompt).toContain("wrote that bot against one of these two builds");
      expect(prompt).toContain(
        'for up to 150 seconds of real time and ended won after 148 seconds of game time. Final probe values: {"jars":5}',
      );
      expect(prompt).toContain(
        'ended timed out after 148 seconds of game time. Final probe values: {"jars":2}',
      );
    }
    // Order 1 shows the candidate as A, order 2 shows the best as A.
    const factsOf = (prompt: string, label: "A" | "B") =>
      prompt.split(`Build ${label}. `)[1]!.split("\n\nBuild ")[0]!;
    expect(factsOf(prompts[0]!, "A")).toContain('{"jars":5}');
    expect(factsOf(prompts[1]!, "A")).toContain('{"jars":2}');
    expect(state.rounds[0]?.kept).toBe(true);
  });

  it("skips bot facts when the tester ran no bot this round", () => {
    const { steps, prompts } = comparePrompts(roundResponder("A", "B"));
    expect(steps).not.toContain("bot");
    expect(prompts.every((p) => !p.includes("Bot facts"))).toBe(true);
  });

  it("withholds bot facts from both reports when the bot errors on one build", () => {
    const { steps, prompts, state, logs, pairs, written } = comparePrompts(
      withBot({
        cand: fact("error", {}, "bot file does not load: no node named Jar"),
        best: fact("lost", { level: 3 }),
      }),
    );
    // Both runs play at once; the candidate's error still withholds both.
    expect(pairs).toContainEqual(["bot", "bot"]);
    expect(steps.filter((s) => s === "bot")).toHaveLength(2);
    const record = Object.entries(written).find(([path]) => path.endsWith(".json"))?.[1] ?? "";
    expect(JSON.parse(record).botWithheld).toContain("the bot could not run on cand");
    expect(steps.filter((s) => s === "compare")).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("Bot facts");
      expect(prompt).not.toContain("bot facts");
      expect(prompt).not.toContain("no node named Jar");
    }
    expect(logs.join("\n")).toContain(
      "bot facts withheld from both reports: the bot could not run on cand: bot file does not load",
    );
    expect(state.rounds[0]?.verdicts.map((v) => v.verdict)).toEqual(["A", "B"]);
  });

  it("withholds bot facts when only the second build's run errors", () => {
    const { steps, prompts } = comparePrompts(
      withBot({ cand: fact("won", { jars: 5 }), best: fact("error", {}, "no probe") }),
    );
    expect(steps.filter((s) => s === "bot")).toHaveLength(2);
    expect(prompts.every((p) => !p.includes("Bot facts") && !p.includes('{"jars":5}'))).toBe(true);
  });

  it("replays the tester's play bot with its decider", () => {
    const deciders: string[] = [];
    const respond = withBot(
      { cand: fact("won", {}), best: fact("won", {}) },
      ".studio/bot/win.mjs",
      "jev",
    );
    comparePrompts((step, state) => {
      if (step.kind === "bot") deciders.push(step.decider);
      return respond(step, state);
    });
    expect(deciders).toEqual(["jev", "jev"]);
  });

  it("decides the bot's budget at the bot move, after the plays", () => {
    const budget = { budgetEndsAt: T0 + 60 * MIN };
    const respond = withBot({ cand: fact("won", {}), best: fact("won", {}) });
    const atRestore = drive(
      atRound(budget),
      respond,
      (s) => s.task._tag === "round" && s.task.phase === "restore",
    ).state;
    // Enough at restore for judging and both bot runs; the plays then use up
    // the clock, which the bot move sees.
    let clock = T0 + 20 * MIN;
    const late: Responder = (step, state) => {
      if (step.kind === "role" && step.role.startsWith("sample")) clock += 8 * MIN;
      return respond(step, state);
    };
    const steps: string[] = [];
    const logs: string[] = [];
    let state = atRestore;
    for (let guard = 0; guard < 40 && state.rounds.length === 0; guard += 1) {
      const planned = Policy.plan(state, { now: clock, coin: 0.3, id: `b${guard}` });
      if (planned.kind === "end") break;
      logs.push(...(planned.logs ?? []));
      const halves = planned.step.kind === "pair" ? planned.step.halves : [planned.step];
      steps.push(...halves.map((h) => (h.kind === "role" ? h.role.split("-")[0]! : h.kind)));
      const applied = applyStep(planned.state, planned.step, late, {
        now: clock,
        coin: 0.3,
        id: `c${guard}`,
      });
      logs.push(...applied.logs);
      state = applied.state;
    }
    expect(steps).toContain("sample");
    expect(steps).toContain("compare");
    expect(steps).not.toContain("bot");
    expect(logs).toContain(
      "bot facts withheld: the budget leaves no time for the bot runs; judging on play reports",
    );
    // With the same start and no time spent in play, the bot runs.
    expect(drive(atRestore, respond, (s) => s.rounds.length === 1, T0 + 20 * MIN).steps).toContain(
      "bot",
    );
  });
});

describe("blind comparators", () => {
  // Each sample's last turn asks for its sheet; `drawn` says which builds' runners drew one.
  const run = (drawn: ReadonlyArray<string>, respond: Responder = roundResponder("A", "B")) => {
    const compares: Array<Extract<State.Step, { kind: "role" }>> = [];
    const sheets: Record<string, string> = {};
    const seeing: Responder = (step, state) => {
      if (step.kind === "role" && step.role.startsWith("compare")) compares.push(step);
      if (step.kind === "role" && step.sheet !== "" && step.at !== null) {
        expect(step.sheet).toMatch(/^\.studio\/comparisons\/frames-id\d+b?\.jpg$/);
        if (drawn.includes(step.at)) sheets[step.at] = step.sheet;
        return done(step, {
          sheet: drawn.includes(step.at) ? step.sheet : "",
          ...plainSubmission(state, step),
        });
      }
      return respond(step, state);
    };
    const driven = drive(atRound(), seeing, (s) => s.rounds.length === 1);
    return { ...driven, compares, sheets, prompts: compares.map((c) => c.prompt) };
  };
  // Everything that would tell a comparator which report is which build.
  const tells = (state: State.RunState, compares: ReadonlyArray<{ role: string }>) => [
    "cand",
    "best",
    "round-",
    ".studio",
    "frames-",
    ...compares.map((c) => c.role.replace("compare-", "")),
    ...state.threads.map((t) => t.threadId),
  ];

  it("runs each comparator in a blank worktree with its sheets copied under neutral names", () => {
    const { compares, sheets, state, written } = run(["cand", "best"]);
    expect(compares).toHaveLength(2);
    for (const step of compares) {
      expect(step.at).toBe(State.BLANK);
      expect(step.prompt).toContain("Submit your verdict with game_run_submit");
      expect(step.prompt).toContain("Use only these reports and the two frame sheets,");
      expect(step.prompt).toContain("frames from that player's own play, evenly sampled");
    }
    // Order 1 shows the candidate as A, order 2 the best; each copy follows its comparator's A and B.
    const a = ".compare/sheet-a.jpg";
    const b = ".compare/sheet-b.jpg";
    expect(compares[0]!.copy).toEqual([
      { from: sheets.cand, to: a },
      { from: sheets.best, to: b },
    ]);
    expect(compares[1]!.copy).toEqual([
      { from: sheets.best, to: a },
      { from: sheets.cand, to: b },
    ]);
    for (const step of compares) {
      expect(step.prompt).toMatch(/Build [AB]'s is \.compare\/sheet-[ab]\.jpg and Build [AB]'s is/);
      expect(step.prompt).toContain(`Build A's is ${a}`);
      expect(step.prompt).toContain(`Build B's is ${b}`);
      for (const tell of tells(state, compares)) expect(step.prompt).not.toContain(tell);
    }
    // Once both verdicts are in, the game root keeps each write-up where the round detail reads it.
    for (const step of compares)
      expect(written[`.studio/comparisons/${step.role.replace("compare-", "")}.md`]).toMatch(
        /^Verdict: [AB]\nplay-based reasons/,
      );
    expect(state.rounds[0]?.verdicts.map((v) => v.verdict)).toEqual(["A", "B"]);
  });

  it("withholds both sheets when one player has none", () => {
    const { compares, sheets, state } = run(["cand"]);
    expect(compares).toHaveLength(2);
    for (const step of compares) {
      expect(step.at).toBe(State.BLANK);
      expect(step.copy).toEqual([]);
      expect(step.prompt).not.toContain("frame sheet");
      expect(step.prompt).not.toContain(".compare/sheet");
      expect(step.prompt).not.toContain(sheets.cand!);
      expect(step.prompt).toContain("Use only these reports, not the game folder");
      for (const tell of tells(state, compares)) expect(step.prompt).not.toContain(tell);
    }
  });

  it("releases each comparator's worktree once its verdict is in, after one turn to submit it", () => {
    // The first order's first answer has no declaration line; the follow-up fixes it.
    let fixed = false;
    const respond: Responder = (step, state) => {
      if (
        step.kind === "role" &&
        step.role.startsWith("compare") &&
        step.thread === null &&
        !fixed
      ) {
        fixed = true;
        // A write-up with no verdict submitted: the comparator gets one turn to submit it.
        return done(step);
      }
      return roundResponder("A", "B")(step, state);
    };
    const { compares, released, state } = run(["cand", "best"], respond);
    expect(compares.map((c) => c.thread === null)).toEqual([true, false, true]);
    const correct = compares[1]!;
    expect(correct.at).toBe(State.BLANK);
    expect(correct.prompt).toContain("without submitting a verdict");
    // The first comparator's thread outlives its unformatted answer, then goes with the other's.
    expect(released).toEqual([correct.thread, "t-" + compares[2]!.id]);
    expect(state.rounds[0]?.verdicts.map((v) => v.verdict)).toEqual(["A", "B"]);
  });

  it("keeps a tied pick's comparator worktree for its selection, then releases it", () => {
    const pick = base({
      trunk: "main",
      best: "trunk0",
      stage: "vision",
      task: {
        _tag: "pick",
        phase: "compare",
        chosen: "",
        notes: "",
        comparison: "",
        cmp: {
          question: "which prototype?",
          x: "proto1",
          y: "proto2",
          xFirst: true,
          orders: ["x"],
          samples: [],
          bot: "",
          botDecider: "policy",
          bots: [],
          botWithheld: "",
          judges: [],
          reused: null,
        },
      },
    });
    const selects: State.Step[] = [];
    const respond: Responder = (step, state) => {
      if (step.kind === "role" && step.prompt.startsWith("The comparison is a tie")) {
        selects.push(step);
        return done(step, {
          submission: { _tag: "select", pick: "B", reasons: "reasons to continue from B" },
        });
      }
      if (step.kind === "role" && step.role.startsWith("compare"))
        return done(step, verdictOf("TIE", "no difference shown"));
      return roundResponder("A", "B")(step, state);
    };
    const tied = drive(pick, respond, (s) => s.task._tag === "pick" && s.task.phase === "select");
    expect(tied.released).toEqual([]);
    const chose = drive(
      tied.state,
      respond,
      (s) => s.task._tag === "pick" && s.task.phase === "adopt",
    );
    expect(selects).toHaveLength(1);
    const select = selects[0]!;
    expect(select.kind === "role" && select.at).toBe(State.BLANK);
    expect(select.kind === "role" && select.thread).not.toBeNull();
    expect(chose.released).toEqual([select.kind === "role" ? select.thread : null]);
    expect(chose.state.task._tag === "pick" && chose.state.task.chosen).toBe("proto2");
  });

  // The run records what the game became only when the adopt lands; the Run
  // view reads this record, never the pick's notes.
  const atPick = (
    task: Partial<Extract<State.RunState["task"], { _tag: "pick" }>> = {},
  ): State.RunState =>
    base({
      trunk: "main",
      best: "trunk0",
      stage: "vision",
      protos: [
        { branch: "proto1", booted: true },
        { branch: "proto2", booted: true },
      ],
      task: {
        _tag: "pick",
        phase: "compare",
        chosen: "",
        notes: "",
        comparison: "",
        cmp: {
          question: "which prototype?",
          x: "proto1",
          y: "proto2",
          xFirst: true,
          orders: ["x"],
          samples: [],
          bot: "",
          botDecider: "policy",
          bots: [],
          botWithheld: "",
          judges: [],
          reused: null,
        },
        ...task,
      },
    });
  const comparing =
    (verdict: string): Responder =>
    (step, state) =>
      step.kind === "role" && step.role.startsWith("compare")
        ? step.prompt.startsWith("The comparison is a tie")
          ? done(step, {
              submission: { _tag: "select", pick: "B", reasons: "reasons to continue from B" },
            })
          : done(step, verdictOf(verdict, "reasons"))
        : roundResponder("A", "B")(step, state);
  const past = (s: State.RunState) => s.task._tag !== "pick";

  it("records a comparator's win with the comparison it came from", () => {
    const { state, written } = drive(atPick(), comparing("A"), past);
    expect(state.picked).toMatchObject({ branch: "proto1", how: "won" });
    expect(written[`.studio/comparisons/pick-${state.picked?.comparison}.json`]).toBeDefined();
  });

  it("records a tie's continuation as a selection, not a win", () => {
    const { state } = drive(atPick(), comparing("TIE"), past);
    expect(state.picked).toMatchObject({ branch: "proto2", how: "selected" });
    expect(state.picked?.comparison).not.toBeNull();
  });

  it("records nothing when the adopt fails", () => {
    const adopting = atPick({ phase: "adopt", chosen: "proto1", comparison: "c1" });
    const planned = Policy.plan(adopting, { now: T0, coin: 0.3, id: "p" });
    if (planned.kind !== "step") throw new Error("expected the adopt step");
    const applied = Policy.applyResult(
      planned.state,
      planned.step,
      buildOk({ ok: false, detail: "conflict" }),
      { now: T0, coin: 0.3, id: "a" },
    );
    expect(applied.state.task._tag).not.toBe("pick");
    expect(applied.state.picked).toBeNull();
    expect(applied.state.best).toBe("trunk0");
  });
});

describe("ladder", () => {
  const ladderJson = (n: number) =>
    JSON.stringify({
      rungs: Array.from({ length: n }, (_, i) => ({
        is: `the game has part ${i + 1}`,
        checks: [
          { what: `part ${i + 1} starts`, how: "probe value started" },
          { what: `part ${i + 1} ends`, how: "HUD text" },
        ],
      })),
    });
  const fresh = () => {
    const parsed = State.parseLadder(ladderJson(4));
    if (!("ladder" in parsed)) throw new Error(parsed.error);
    return parsed.ladder;
  };
  // Ladder rounds build rungs on their own: no creator ask.
  const atLadder = (patch: Partial<State.RunState> = {}) =>
    atRound({ ladder: fresh(), steer: [], ...patch });
  // The tester declares each check; `pass` says which of the two pass.
  const ladderResponder =
    (
      v1: string,
      v2: string,
      pass: [boolean, boolean] = [true, true],
      extra: ((step: Single, state: State.RunState) => Policy.StepResult | undefined) | null = null,
    ): Responder =>
    (step, state) => {
      const answered = extra?.(step, state);
      if (answered !== undefined) return answered;
      if (
        step.kind === "role" &&
        step.role.startsWith("tester") &&
        Policy.asked(state, step).kind === "checks"
      ) {
        const asked = Policy.asked(state, step);
        const look = asked.kind === "checks" ? asked.look : [];
        return done(step, {
          submission: {
            _tag: "checks",
            checks: look.map((check) => ({
              check,
              pass: pass[check - 1] ?? false,
              evidence: check === 1 ? "started read true" : "saw the end text",
            })),
            notes: "played it through, start to end",
          },
        });
      }
      return roundResponder(v1, v2)(step, state);
    };
  const oneRound = (start: State.RunState, respond: Responder) =>
    drive(start, respond, (s) => s.rounds.length === start.rounds.length + 1);

  it("writes the ladder in the plan stage and gives a wrong shape one fix turn", () => {
    const atPlan = base({
      trunk: "main",
      best: "best",
      stage: "pick",
      task: {
        _tag: "stage",
        name: "plan",
        phase: "role",
        thread: null,
        block: null,
        sha: "",
        why: "",
        review: "",
      },
    });
    const planWith = (texts: string[]) => {
      const prompts: string[] = [];
      const respond: Responder = (step) => {
        if (step.kind === "build") return buildOk({ sha: "plan", changed: false });
        if (step.kind !== "role") throw new Error(`unexpected ${step.kind}`);
        prompts.push(step.prompt);
        return done(step, {
          threadId: ThreadId.make("plan-thread"),
          ...ladderSubmitted(texts.shift() ?? ""),
        });
      };
      const { state } = drive(
        atPlan,
        respond,
        (s) => s.task._tag === "stage" && s.task.name === "art",
      );
      return { state, prompts };
    };
    const good = planWith([ladderJson(5)]);
    expect(good.prompts).toHaveLength(1);
    expect(good.prompts[0]).toContain("game_run_submit");
    expect(good.state.ladder?.rungs.map((r) => r.status)).toEqual([
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    const fixed = planWith([ladderJson(2), ladderJson(4)]);
    expect(fixed.prompts).toHaveLength(2);
    expect(fixed.prompts[1]).toContain("4 to 7 rungs");
    expect(fixed.state.ladder?.rungs).toHaveLength(4);
    const never = planWith(["{", "{"]);
    expect(never.state.ladder?.rungs).toEqual([]);
    expect(never.state.ladder?.note).toContain("no valid ladder");
  });

  it("builds the next rung, keeps it when its checks pass and judging agrees, and moves on", () => {
    const blocks: string[] = [];
    const respond = ladderResponder("A", "B", [true, true], (step) => {
      if (step.kind === "role" && step.role.startsWith("builder")) {
        blocks.push(step.prompt);
        return done(step, { elapsedMs: step.capMs });
      }
      return undefined;
    });
    const first = oneRound(atLadder({ next: "the jump sticks" }), respond);
    expect(first.logs).toContain("round 1 builds rung 1 of 4: the game has part 1");
    expect(blocks[0]).toContain("the game has part 1");
    expect(blocks[0]).toContain(
      "part 1 starts (look check, judged by a tester: probe value started)",
    );
    // The last review is a ledger beside the rung, never the goal.
    expect(blocks[0]).toContain("the jump sticks");
    const record = first.state.rounds[0]!;
    expect(record.kept).toBe(true);
    expect(record.rung?.outcome).toBe("landed");
    expect(record.rung?.checks.map((c) => c.pass)).toEqual([true, true]);
    expect(record.rung?.checks[0]?.evidence).toBe("started read true");
    expect(first.state.ladder?.rungs.map((r) => r.status)).toEqual([
      "done",
      "todo",
      "todo",
      "todo",
    ]);
    const second = oneRound(first.state, respond);
    expect(blocks.at(-1)).toContain("the game has part 2");
    expect(second.state.rounds[1]?.rung?.rung).toBe(2);
  });

  it("keeps a round whose checks pass when judging ties", () => {
    const { state, logs } = oneRound(atLadder(), ladderResponder("TIE", "TIE"));
    expect(state.rounds[0]?.kept).toBe(true);
    expect(state.rounds[0]?.inconclusive).toBeUndefined();
    expect(state.best).toBe("cand");
    expect(state.pending).toBeNull();
    expect(logs.some((line) => line.includes("shows no regression; kept"))).toBe(true);
  });

  it("does not keep a round whose old build wins both orders, even with its checks passing", () => {
    const { state } = oneRound(atLadder(), ladderResponder("B", "A"));
    expect(state.rounds[0]?.kept).toBe(false);
    expect(state.rounds[0]?.rung?.outcome).toBe("failed");
  });

  it("retries a rung from the last try's branch when that try passed some checks", () => {
    const starts: Array<string | null> = [];
    const prompts: string[] = [];
    const respond = ladderResponder("A", "B", [true, false], (step, state) => {
      if (roundStart(step, state)) {
        const from = step.kind === "build" && step.op._tag === "restore" ? step.op.sha : "";
        starts.push(from === "best" ? null : from);
        return buildOk({ sha: from });
      }
      if (step.kind === "role") prompts.push(step.prompt);
      return undefined;
    });
    const one = oneRound(atLadder(), respond);
    const two = oneRound(one.state, respond);
    // The retry starts from the last try's own build.
    expect(starts).toEqual([null, "cand"]);
    expect(two.logs).toContain("round 2: continues the last try's work");
    expect(prompts.some((p) => p.includes("Its work is your starting point"))).toBe(true);
    expect(prompts.some((p) => p.includes("This build continues a try that failed"))).toBe(true);
    // The reviewer reads the round's play evidence in one turn instead of replaying the build.
    const reviews = prompts.filter((p) => p.includes("submit the ledger with game_run_submit"));
    expect(reviews).toHaveLength(2);
    expect(reviews.every((p) => p.includes("do not play it again"))).toBe(true);
    // A try that passed nothing starts again from the best.
    const none = ladderResponder("A", "B", [false, false], (step, state) => {
      if (roundStart(step, state) && step.kind === "build" && step.op._tag === "restore")
        starts.push(step.op.sha === "best" ? null : step.op.sha);
      return undefined;
    });
    oneRound(oneRound(atLadder(), none).state, none);
    expect(starts.slice(2)).toEqual([null, null]);
  });

  it("plays the ship check once the ladder is done, and ends there", () => {
    const ladder = fresh();
    const lastOpen = {
      ...ladder,
      rungs: ladder.rungs.map((x, i) => (i < 3 ? { ...x, status: "done" as const } : x)),
    };
    const landed = oneRound(atLadder({ ladder: lastOpen }), ladderResponder("A", "B"));
    expect(landed.state.task._tag).toBe("ship");
    expect(landed.logs.some((l) => l.includes("the ladder is done; the ship check"))).toBe(true);
    const ship =
      (verdict: string): Responder =>
      (step, state) =>
        step.kind === "role" && step.role.startsWith("ship")
          ? done(step, {
              submission: {
                _tag: "ship",
                ship: verdict === "YES",
                reasons: "played it; the ending is abrupt",
              },
            })
          : ladderResponder("A", "B")(step, state);
    const no = drive(landed.state, ship("NO"), (s) => s.ending !== null);
    expect(no.state.ending).toBe("done");
    expect(no.state.shipNoReasons).toContain("the ending is abrupt");
    expect(no.state.rounds).toHaveLength(landed.state.rounds.length);
    expect(drive(landed.state, ship("YES"), (s) => s.ending !== null).state.ending).toBe("ready");
  });

  describe("state checks scored by the harness", () => {
    // Rung 1's first check becomes a state check; its second stays a look check.
    const withState = () => {
      const ladder = fresh();
      const [first, ...rest] = ladder.rungs;
      const state = { what: "part 1 starts", kind: "state" as const, expect: "started == true" };
      return { ...ladder, rungs: [{ ...first!, checks: [state, first!.checks[1]!] }, ...rest] };
    };
    const record = (passes: ReadonlyArray<boolean>) => {
      const prompts: Array<{ role: string; prompt: string }> = [];
      let call = 0;
      const respond = ladderResponder("A", "B", [false, true], (step, state) => {
        if (step.kind === "role") prompts.push({ role: step.role, prompt: step.prompt });
        if (step.kind !== "checks") return undefined;
        const pass = passes[Math.min(call++, passes.length - 1)]!;
        return roundResponder("A", "B", { checks: () => pass })(step, state);
      });
      return { prompts, respond };
    };

    it("scores state checks after boot and lets the tester judge only the look checks", () => {
      const { prompts, respond } = record([true]);
      const one = oneRound(atLadder({ ladder: withState() }), respond);
      expect(one.steps).toContain("checks");
      expect(one.logs).toContain("round 1: the harness's state checks: 1 PASS");
      const tester = prompts.find((p) => p.role.startsWith("tester"))!.prompt;
      expect(tester).toContain("do not re-verify");
      // The tester declared check 1 FAIL; the harness's PASS stands for a state check.
      expect(one.state.rounds[0]?.rung?.checks.map((c) => c.pass)).toEqual([true, true]);
      expect(one.state.rounds[0]?.kept).toBe(true);
    });

    it("gives the same builder a fix turn when a state check fails, then scores again", () => {
      const { prompts, respond } = record([false, true]);
      const one = oneRound(atLadder({ ladder: withState() }), respond);
      expect(one.logs).toContain("round 1: fix turn 1 of 2 for the failed state checks");
      const fix = prompts.filter((p) => p.role.startsWith("builder")).at(-1)!.prompt;
      expect(fix).toContain("These failed:");
      expect(fix).toContain("game_run_checks");
      expect(one.steps.filter((x) => x === "checks")).toHaveLength(2);
      expect(one.state.rounds[0]?.kept).toBe(true);
    });

    it("fails the round on its facts after the fix turns, with no tester or judges", () => {
      const { prompts, respond } = record([false]);
      const one = oneRound(atLadder({ ladder: withState() }), respond);
      expect(one.steps.filter((x) => x === "checks")).toHaveLength(3);
      expect(prompts.some((p) => p.role.startsWith("tester"))).toBe(false);
      expect(one.steps).not.toContain("sample");
      expect(one.state.rounds[0]?.kept).toBe(false);
      expect(one.state.rounds[0]?.rung?.checks[0]?.evidence).toBe("read");
      expect(one.state.rounds[0]?.rung?.checks[1]?.evidence).toContain("not tested");
    });

    it("refuses a ladder whose state check cannot be scored", () => {
      const bad = JSON.stringify({
        rungs: [1, 2, 3, 4].map((i) => ({
          is: `part ${i}`,
          checks: [
            { what: "a", kind: "state", expect: i === 2 ? "zone is high" : "zone >= 1" },
            { what: "b", kind: "look", how: "look" },
          ],
        })),
      });
      const parsed = State.parseLadder(bad);
      expect("error" in parsed && parsed.error).toContain("rung 2 check 1");
    });
  });

  it("does not keep or judge a round whose checks fail, and sets the rung aside after two", () => {
    const respond = ladderResponder("A", "B", [true, false]);
    const one = oneRound(atLadder(), respond);
    expect(one.steps).not.toContain("sample");
    expect(one.steps).not.toContain("keep");
    expect(one.state.rounds[0]?.kept).toBe(false);
    expect(one.state.rounds[0]?.rung?.outcome).toBe("failed");
    expect(one.state.rounds[0]?.rung?.why).toContain("part 1 ends");
    expect(one.state.best).toBe("best");
    // A rung that failed its checks landed nothing: one stall, with why.
    expect(one.state.stallStreak).toBe(1);
    expect(one.state.lastFailure).toContain("rung checks failed");
    const two = oneRound(one.state, respond);
    expect(two.state.rounds[1]?.rung?.outcome).toBe("set-aside");
    expect(two.state.ladder?.rungs[0]?.status).toBe("set-aside");
    expect(two.logs.some((line) => line.includes("rung 1 set aside after 2 rounds"))).toBe(true);
    const three = oneRound(two.state, respond);
    expect(three.logs).toContain("round 3 builds rung 2 of 4: the game has part 2");
    // A third round in a row that lands nothing ends the run, resumably, before
    // it works through every rung's tries; its reason is the last round's.
    expect(three.state.stallStreak).toBe(3);
    const ended = Policy.plan(three.state, { now: T0, coin: 0, id: "x" });
    expect(ended).toEqual({ kind: "end", reason: "stalled" });
    expect(three.state.lastFailure).toMatch(/^round 3: rung checks failed/);
    const resumed = Policy.plan(Policy.resume(three.state), { now: T0, coin: 0, id: "y" });
    expect(resumed.kind === "step" && resumed.logs).toContain(
      "round 4 builds rung 2 of 4: the game has part 2",
    );
  });

  it("counts a kept round as progress: the stall count starts again", () => {
    const kept = oneRound(atLadder({ stallStreak: 2 }), ladderResponder("A", "B"));
    expect(kept.state.rounds[0]?.kept).toBe(true);
    expect(kept.state.stallStreak).toBe(0);
  });

  it("tells a second attempt at a rung why the first did not land", () => {
    const blocks: string[] = [];
    const respond = ladderResponder("A", "B", [false, true], (step) => {
      if (step.kind === "role" && step.role.startsWith("builder") && step.thread === null)
        blocks.push(step.prompt);
      return undefined;
    });
    const two = oneRound(oneRound(atLadder(), respond).state, respond);
    expect(two.state.rounds).toHaveLength(2);
    expect(blocks[1]).toContain(
      "did not land it: round 1, branch round-1: checks failed: part 1 starts",
    );
  });

  it("brings a set-aside rung back once after the rest of the ladder", () => {
    const ladder = fresh();
    const rungs = ladder.rungs.map((r, i) =>
      i === 1
        ? { ...r, status: "set-aside" as const, fails: 2, why: "never worked" }
        : { ...r, status: "done" as const },
    );
    const back = oneRound(
      atLadder({ ladder: { ...ladder, rungs } }),
      ladderResponder("A", "B", [false, false]),
    );
    expect(back.logs.some((line) => line.startsWith("rung 2 comes back"))).toBe(true);
    expect(back.state.ladder?.rungs[1]?.back).toBe(true);
    const again = oneRound(back.state, ladderResponder("A", "B", [false, false]));
    expect(again.state.ladder?.rungs[1]?.status).toBe("set-aside");
    // Every rung has had its tries: the ladder is done and the ship check plays it.
    expect(again.state.task._tag).toBe("ship");
  });

  it("ends a run whose plan wrote no valid ladder unless the creator asks, and re-plans on resume", () => {
    const at = { now: T0, coin: 0, id: "x" };
    const none = atLadder({
      ladder: { rungs: [], note: "the plan wrote no valid ladder: rung 2 has no checks" },
    });
    // Polish is the creator's call: no rung to build and no ask ends the run, saying why.
    expect(Policy.plan(none, at)).toEqual({
      kind: "end",
      reason: "no-ladder",
      why: "the plan wrote no valid ladder: rung 2 has no checks",
    });
    // An ask still runs one finish round on it.
    const asked = Policy.plan({ ...none, steer: ["fix the jump"] }, at);
    expect(asked.kind === "step" && asked.logs).toContain(
      "round 1: finish round (the plan wrote no valid ladder: rung 2 has no checks)",
    );
    // A resume gives the plan another go instead of ending on the same empty ladder.
    const resumed = Policy.plan(Policy.resume(none), at);
    expect(resumed.kind === "step" && resumed.state.task._tag).toBe("ladder");
  });

  it("runs past a finished ladder only on the creator's ask; a late budget keeps building rungs", () => {
    const done4 = fresh();
    const finished = {
      ...done4,
      rungs: done4.rungs.map((r) => ({ ...r, status: "done" as const })),
    };
    const at = { now: T0, coin: 0, id: "x" };
    expect(Policy.plan(atLadder({ ladder: finished }), at)).toEqual({
      kind: "end",
      reason: "done",
    });
    const asked = oneRound(
      atLadder({ ladder: finished, steer: ["fix the jump"] }),
      ladderResponder("A", "B"),
    );
    expect(asked.logs).toContain("round 1: finish round (the ladder is done)");
    expect(asked.state.rounds[0]?.finish).toBe(true);
    expect(asked.state.rounds[0]?.move).toContain("fix the jump");
    // One round per ask: with the note used up, the run is done again.
    expect(Policy.plan(asked.state, at)).toEqual({ kind: "end", reason: "done" });
    // 200 minutes of budget with 30 left still builds the next rung.
    const late = Policy.plan(atLadder({ budgetMinutes: 200, budgetEndsAt: T0 + 30 * MIN }), at);
    expect(late.kind === "step" && late.logs).toContain(
      "round 1 builds rung 1 of 4: the game has part 1",
    );
  });

  it("puts a reviewer's ladder change in as the next rung, one open at a time", () => {
    const rungChange = {
      why: "the core cannot be played",
      is: "the core can be played",
      checks: [
        { what: "a", how: "b" },
        { what: "c", how: "d" },
      ],
    };
    const reviewer: Responder = (step, state) =>
      step.kind === "role" &&
      step.role.startsWith("reviewer") &&
      Policy.asked(state, step).kind === "ledger"
        ? done(step, {
            submission: { _tag: "ledger", ledger: "- the jump sticks", rungChange },
          })
        : ladderResponder("A", "B", [true, false])(step, state);
    const one = oneRound(atLadder(), reviewer);
    expect(one.state.ladder?.rungs.map((r) => r.is)).toEqual([
      "the core can be played",
      "the game has part 1",
      "the game has part 2",
      "the game has part 3",
      "the game has part 4",
    ]);
    expect(one.state.ladder?.rungs[0]?.id).toBe(5);
    const two = oneRound(one.state, reviewer);
    expect(two.logs).toContain("round 2 builds rung 1 of 5: the core can be played");
    expect(two.state.ladder?.rungs).toHaveLength(5);
    expect(two.logs.some((line) => line.includes("an earlier one is still open"))).toBe(true);
  });

  describe("the gate's held play of the best", () => {
    // Each round's candidate is a build of its own; a kept one becomes the best as it is.
    const merging = (_same: boolean) =>
      ladderResponder("A", "B", [true, true], (step, state) =>
        step.kind === "build" && step.op._tag === "capture"
          ? buildOk({ sha: `cand-${state.rounds.length + 1}` })
          : undefined,
      );
    const samples = (steps: ReadonlyArray<string>) => steps.filter((x) => x === "sample").length;
    const comparison = (written: Record<string, string>, branch: string) =>
      JSON.parse(
        Object.entries(written).find(
          ([path]) => path.startsWith(`.studio/comparisons/${branch}-`) && path.endsWith(".json"),
        )![1],
      );

    it("plays only the candidate when the best is the build the last gate's player saw", () => {
      const respond = merging(true);
      const one = oneRound(atLadder(), respond);
      expect(samples(one.steps)).toBe(4);
      expect(one.state.played).toMatchObject({ sha: "cand-1", round: 1, branch: "round-1" });
      const two = oneRound(one.state, respond);
      expect(samples(two.steps)).toBe(2);
      expect(two.state.rounds[1]?.kept).toBe(true);
      const record = comparison(two.written, "round-2");
      expect(record.reusedPlay).toEqual({ build: "best", round: 1, branch: "round-1" });
      expect(record.reports.best).toBe(one.state.played?.sample.notes);
      expect(record.players.best).toBe(one.state.played?.sample.thread);
      expect(two.state.played).toMatchObject({ sha: "cand-2", round: 2 });
    });

    it("keeps the comparators blind to which report was reused", () => {
      const prompts: string[] = [];
      const respond = merging(true);
      const one = oneRound(atLadder(), respond);
      oneRound(one.state, (step, state) => {
        if (step.kind === "role" && step.role.startsWith("compare")) prompts.push(step.prompt);
        return respond(step, state);
      });
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) {
        expect(prompt).not.toMatch(/reuse|round 1|earlier/i);
        expect(prompt).not.toContain(one.state.played!.sample.label);
      }
    });

    it("plays both builds when the held play is of another build, question or budget", () => {
      const respond = merging(true);
      const held = oneRound(atLadder(), respond).state;
      const played = held.played!;
      for (const patch of [
        { sha: "other" },
        { question: "which build plays better?" },
        { budget: "input 1 ms" },
        { sample: { ...played.sample, notes: "" } },
        { sample: { ...played.sample, evidence: { ...goodEvidence, nominalMs: 999_000 } } },
      ])
        expect(samples(oneRound({ ...held, played: { ...played, ...patch } }, respond).steps)).toBe(
          4,
        );
    });

    it("plays both builds when the run's player changed since the held play", () => {
      const respond = merging(true);
      const held = oneRound(atLadder(), respond).state;
      for (const patch of [{ model: "another-model" }, { creator: "thread:another-chat" }])
        expect(samples(oneRound({ ...held, ...patch }, respond).steps)).toBe(4);
    });

    it("never reuses in a finish round, which asks its own question", () => {
      const respond = merging(true);
      const held = oneRound(atLadder(), respond).state;
      const finish = oneRound(
        { ...held, ladder: { rungs: [], note: "finish rounds only" }, steer: [POLISH] },
        respond,
      );
      expect(finish.state.rounds[1]?.finish).toBe(true);
      expect(samples(finish.steps)).toBe(4);
    });

    it("keeps the reused side reused across a stop mid-gate", () => {
      const respond = merging(true);
      const held = oneRound(atLadder(), respond).state;
      expect(samples(oneRound(held, respond).steps)).toBe(2);
      const midGate = drive(
        held,
        respond,
        (s) => s.task._tag === "round" && s.task.cmp !== null && s.task.cmp.samples.length === 2,
      ).state;
      const t = midGate.task;
      expect(t._tag === "round" && t.cmp?.reused).toEqual({
        side: "y",
        round: 1,
        branch: "round-1",
      });
      const rest = drive(midGate, respond, (s) => s.rounds.length === held.rounds.length + 1);
      expect(rest.state.rounds[1]?.kept).toBe(true);
      // Only the candidate's write-up is left; the best is never played.
      expect(samples(rest.steps)).toBe(1);
    });
  });

  it("writes a ladder first when a run reaches its next round without one", () => {
    const planned = Policy.plan({ ...atLadder(), ladder: null }, { now: T0, coin: 0, id: "l" });
    if (planned.kind !== "step" || planned.step.kind !== "role") throw new Error("expected a role");
    expect(planned.step.role).toBe("plan");
    expect(Policy.asked(planned.state, planned.step).kind).toBe("ladder");
    const applied = Policy.applyResult(
      planned.state,
      planned.step,
      done(planned.step, ladderSubmitted(ladderJson(4))),
      { now: T0, coin: 0, id: "m" },
    );
    expect(applied.state.ladder?.rungs).toHaveLength(4);
    const next = Policy.plan(applied.state, { now: T0, coin: 0, id: "n" });
    expect(next.kind === "step" && next.state.task._tag === "round" && next.state.task.rung).toBe(
      1,
    );
  });

  it("a Guided run reviews the rounds' own ladder, and every answer leads back to the rounds", () => {
    const writeLadder = (state: State.RunState, id: string) => {
      const planned = Policy.plan(state, { now: T0, coin: 0, id: `${id}-plan` });
      if (planned.kind !== "step" || planned.step.kind !== "role")
        throw new Error("expected a role");
      expect(planned.step.role).toBe("plan");
      return Policy.applyResult(
        planned.state,
        planned.step,
        done(planned.step, ladderSubmitted(ladderJson(4))),
        { now: T0, coin: 0, id: `${id}-apply` },
      ).state;
    };
    const answer = (state: State.RunState, given: string, notes: string, id: string) => {
      const planned = Policy.plan(state, { now: T0, coin: 0, id: `${id}-ask` });
      if (planned.kind !== "step" || planned.step.kind !== "decide")
        throw new Error("expected the ladder review");
      expect(planned.step.decision.kind).toBe("ladder");
      return {
        answers: planned.step.decision.answers.map((a) => a.answer),
        state: Policy.applyResult(
          planned.state,
          planned.step,
          { kind: "decided", answer: given, notes, by: "creator" },
          { now: T0, coin: 0, id: `${id}-answer` },
        ).state,
      };
    };
    const startedAtBuild = {
      ...atLadder(),
      ladder: null,
      profile: "guided" as const,
      stage: "build",
    };

    // Approve: straight to the first rung's round, never to the art stage.
    const reviewed = writeLadder(startedAtBuild, "a");
    expect(reviewed.task._tag).toBe("decide");
    const approved = answer(reviewed, "approve", "", "a");
    expect(approved.answers).toContain("rewrite");
    expect(approved.state.task._tag).toBe("round");

    // Rewrite: the plan rewrites the ladder with the notes, then the creator is asked again,
    // this time without a second rewrite, and approving leads to the rounds.
    const rewritten = answer(writeLadder(startedAtBuild, "b"), "rewrite", "shorter rungs", "b");
    const revise = rewritten.state.task;
    expect(revise._tag === "ladder" && revise.phase === "revise" && revise.notes).toBe(
      "shorter rungs",
    );
    const askedAgain = writeLadder(rewritten.state, "c");
    const second = answer(askedAgain, "approve", "", "c");
    expect(second.answers).not.toContain("rewrite");
    expect(second.state.task._tag).toBe("round");

    // Autopilot is unchanged: no review.
    const autopilot = writeLadder({ ...startedAtBuild, profile: "autopilot" as const }, "d");
    expect(autopilot.task._tag).toBe("round");
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
  // Plays the art stage with the given review (none: the director submitted nothing).
  const playArt = (review: { readonly redo: boolean; readonly defects: string } | null) => {
    const seen: State.RoleStep[] = [];
    const respond: Responder = (step) => {
      if (step.kind === "build") return buildOk({ sha: "art" });
      if (step.kind === "boot") return { kind: "boot", ok: true, detail: "boot clean" };
      if (step.kind !== "role") throw new Error(`unexpected ${step.kind}`);
      seen.push(step);
      if (step.role === "art-director")
        return done(step, review === null ? {} : { submission: { _tag: "art", ...review } });
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
    const { state, roles, steps } = playArt({ redo: false, defects: "- key.png: fine" });
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director"]);
    expect(steps.slice(-2)).toEqual(["capture", "boot"]);
    expect(state.best).toBe("art");
  });

  it("gives one redo turn on the art thread with the defect list, then continues", () => {
    const { state, roles, steps } = playArt({
      redo: true,
      defects: "- assets/firefly.png: plain white dot, no glow; render a soft additive glow",
    });
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director", "art"]);
    const redo = roles[2]!;
    expect(redo.thread).toBe("art-thread");
    expect(redo.prompt).toContain("plain white dot, no glow");
    expect(steps.slice(-2)).toEqual(["capture", "boot"]);
    expect(state.task._tag === "stage" && state.task.name).toBe("build");
  });

  it("keeps the art and logs when the director submits no verdict", () => {
    const { roles } = playArt(null);
    expect(roles.map((r) => r.role)).toEqual(["art", "art-director"]);
    const reviewing = {
      ...atArt,
      task: { ...atArt.task, phase: "review" as const, thread: ThreadId.make("art-thread") },
    } as State.RunState;
    const planned = Policy.plan(reviewing, { now: T0, coin: 0, id: "r" });
    if (planned.kind !== "step") throw new Error("expected the review step");
    const applied = Policy.applyResult(planned.state, planned.step, done(planned.step), {
      now: T0,
      coin: 0,
      id: "r2",
    });
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
    expect(steps).toEqual(["restore", "capture", "restore"]);
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
    // The round's work is kept under a name of its own before the folder goes back to the best.
    expect(late.steps).toEqual(["restore", "capture", "restore"]);
    expect(late.state.ending).toBe("budget");
    expect(late.state.best).toBe("best");
  });
});

describe("resume", () => {
  // A step in flight is executed again, never re-planned: a role reattaches to
  // its thread and a git op re-runs (every op is repeatable).
  it("plans the step in flight of every kind again as itself", () => {
    const seen = new Set<string>();
    const respond: Responder = (step, s) =>
      step.kind === "role" && step.role.startsWith("tester")
        ? done(step, {
            bot: { file: ".studio/bot/win.mjs", decider: "policy" },
            ...plainSubmission(s, step),
          })
        : roundResponder("A", "B")(step, s);
    let state = atRound();
    for (let guard = 0; guard < 60 && state.rounds.length === 0; guard += 1) {
      const planned = Policy.plan(state, { now: T0, coin: 0.7, id: `p${guard}` });
      if (planned.kind === "end") break;
      const again = Policy.plan(planned.state, { now: T0 + MIN, coin: 0.1, id: "other" });
      expect(again.kind === "step" && again.step).toEqual(planned.step);
      seen.add(planned.step.kind === "build" ? `build:${planned.step.op._tag}` : planned.step.kind);
      state = applyStep(planned.state, planned.step, respond, {
        now: T0,
        coin: 0.7,
        id: `q${guard}`,
      }).state;
    }
    for (const kind of [
      "role",
      "boot",
      "facts",
      "pair",
      "build:restore",
      "build:capture",
      "build:restore",
      "build:keep",
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
});

describe("guided decisions", () => {
  const ladderJson = (n: number, tag = "part") =>
    JSON.stringify({
      rungs: Array.from({ length: n }, (_, i) => ({
        is: `the game has ${tag} ${i + 1}`,
        checks: [
          { what: `${tag} ${i + 1} starts`, how: "probe value" },
          { what: `${tag} ${i + 1} ends`, how: "HUD text" },
        ],
      })),
    });
  type Said = { readonly answer: string; readonly notes?: string } | null;
  // Answers each decision kind in turn; null (or none left) lets the wait run out.
  const creator =
    (said: Partial<Record<State.Decision["kind"], Said[]>> = {}, asked: State.Decision[] = []) =>
    (step: Single, state: State.RunState): Policy.StepResult => {
      if (step.kind === "decide") {
        asked.push(step.decision);
        const next = said[step.decision.kind]?.shift() ?? null;
        return next === null
          ? { kind: "decided", answer: step.decision.fallback, notes: "", by: "default" }
          : { kind: "decided", answer: next.answer, notes: next.notes ?? "", by: "creator" };
      }
      if (step.kind === "build" && step.op._tag === "capture" && step.op.name.startsWith("proto-"))
        return buildOk({ sha: step.op.name });
      if (step.kind === "role" && step.role === "plan")
        return done(step, ladderSubmitted(ladderJson(4)));
      return roundResponder("A", "B")(step, state);
    };
  const start = (profile: State.RunState["profile"]) => base({ profile });
  const toRounds = (s: State.RunState) => s.task._tag === "round";
  const toBuild = (s: State.RunState) => s.task._tag === "stage" && s.task.name === "build";

  it("plans no decide step on Autopilot", () => {
    const run = drive(start("autopilot"), creator(), toRounds);
    expect(run.steps).not.toContain("decide");
    expect(run.state.decided).toEqual([]);
    expect(run.steps).toContain("sample");
  });

  it("asks about the style, the prototype and the ladder, and takes each default on a timeout", () => {
    const asked: State.Decision[] = [];
    const run = drive(start("guided"), creator({}, asked), toRounds);
    expect(asked.map((d) => d.kind)).toEqual(["style", "prototype", "ladder"]);
    expect(run.state.decided.map((d) => [d.kind, d.answer, d.by])).toEqual([
      ["style", "approve", "default"],
      ["prototype", "run", "default"],
      ["ladder", "approve", "default"],
    ]);
    // The prototype default is the blind pick.
    expect(run.steps).toContain("sample");
    expect(run.state.picked?.how).toBe("won");
    const proto = asked[1]!;
    expect(proto.evidence.map((e) => e.path)).toEqual([
      ".studio/proto-0.md",
      ".studio/proto-0-frames.jpg",
      ".studio/proto-1.md",
      ".studio/proto-1-frames.jpg",
    ]);
    expect(proto.answers.map((a) => a.answer)).toEqual(["pick-1", "pick-2", "retry", "run"]);
    expect(asked[2]!.text).toContain("the game has part 1");
  });

  it("has each Guided prototype play itself and write its pitch", () => {
    const prompts: string[] = [];
    const respond = creator();
    drive(
      start("guided"),
      (step, state) => {
        if (step.kind === "role" && step.role.startsWith("proto")) {
          prompts.push(step.prompt);
          expect(step.sheet).toBe(`.studio/${step.role}-frames.jpg`);
        }
        return respond(step, state);
      },
      (s) => s.task._tag === "decide" && s.task.decision.kind === "prototype",
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(".studio/proto-1.md");
  });

  it("adopts the creator's pick without a blind comparison and leads the first build with their notes", () => {
    const run = drive(
      start("guided"),
      creator({ prototype: [{ answer: "pick-2", notes: "but with the camera of the first one" }] }),
      toBuild,
    );
    expect(run.steps).not.toContain("sample");
    expect(run.state.picked).toMatchObject({ branch: "proto-1", how: "creator" });
    const t = run.state.task;
    expect(t._tag === "stage" && t.block?.direction).toContain(
      "but with the camera of the first one",
    );
    expect(t._tag === "stage" && t.block?.direction).toContain("proto-0");
  });

  it("lets the run's blind pick decide on a run answer", () => {
    const run = drive(start("guided"), creator({ prototype: [{ answer: "run" }] }), toBuild);
    expect(run.steps).toContain("sample");
    expect(run.state.decided.find((d) => d.kind === "prototype")?.by).toBe("creator");
  });

  it("retries the prototypes once with the creator's notes, then takes the default", () => {
    const asked: State.Decision[] = [];
    const prompts: string[] = [];
    const respond = creator(
      {
        prototype: [
          { answer: "retry", notes: "make it faster" },
          { answer: "retry", notes: "again" },
        ],
      },
      asked,
    );
    const run = drive(
      start("guided"),
      (step, state) => {
        if (step.kind === "role" && step.role.startsWith("proto")) prompts.push(step.role);
        if (step.kind === "role" && step.role === "proto-2")
          expect(step.prompt).toContain("make it faster");
        return respond(step, state);
      },
      toBuild,
    );
    expect(prompts).toEqual(["proto-0", "proto-1", "proto-2", "proto-3"]);
    const protos = asked.filter((d) => d.kind === "prototype");
    expect(protos).toHaveLength(2);
    expect(protos[1]!.answers.map((a) => a.answer)).toEqual(["pick-3", "pick-4", "run"]);
    expect(protos[1]!.evidence[0]!.path).toBe(".studio/proto-2.md");
    // The second retry is not an answer any more, so the run takes its default.
    expect(
      run.state.decided.filter((d) => d.kind === "prototype").map((d) => [d.answer, d.by]),
    ).toEqual([
      ["retry", "creator"],
      ["run", "default"],
    ]);
    expect(run.state.protos.map((p) => p.branch)).toEqual(["proto-2", "proto-3"]);
  });

  it("redoes the vision once with the creator's notes, then asks again without a redo", () => {
    const asked: State.Decision[] = [];
    const visions: string[] = [];
    const respond = creator(
      { style: [{ answer: "redo", notes: "pinker, rounder" }, { answer: "approve" }] },
      asked,
    );
    const run = drive(
      start("guided"),
      (step, state) => {
        if (step.kind === "role" && step.role === "vision") visions.push(step.prompt);
        return respond(step, state);
      },
      (s) => s.task._tag === "proto",
    );
    expect(visions).toHaveLength(2);
    expect(visions[1]).toContain("pinker, rounder");
    const styles = asked.filter((d) => d.kind === "style");
    expect(styles.map((d) => d.answers.map((a) => a.answer))).toEqual([
      ["approve", "redo"],
      ["approve"],
    ]);
    expect(run.state.decided.map((d) => d.answer)).toEqual(["redo", "approve"]);
  });

  it("takes an edited ladder only when it parses, and rewrites once on notes", () => {
    const asked: State.Decision[] = [];
    const atLadder = drive(
      start("guided"),
      creator({}, asked),
      (s) => s.task._tag === "decide" && s.task.decision.kind === "ladder",
    );
    const t = atLadder.state.task;
    if (t._tag !== "decide") throw new Error("expected the ladder decision");
    const refused = Policy.checkAnswer(t.decision, "edit", '{"rungs":[]}');
    expect("error" in refused && refused.error).toContain("refused");
    expect("error" in Policy.checkAnswer(t.decision, "maybe", "")).toBe(true);
    expect("error" in Policy.checkAnswer(t.decision, "rewrite", " ")).toBe(true);
    const edited = drive(
      atLadder.state,
      creator({ ladder: [{ answer: "Edit", notes: ladderJson(5, "mine") }] }),
      (s) => s.task._tag === "stage" && s.task.name === "art",
    );
    expect(edited.state.ladder?.rungs.map((r) => r.is)[4]).toBe("the game has mine 5");

    const plans: string[] = [];
    const respond = creator({ ladder: [{ answer: "rewrite", notes: "boss fight sooner" }] }, asked);
    const rewritten = drive(
      atLadder.state,
      (step, state) => {
        if (step.kind === "role" && step.role === "plan") {
          plans.push(step.prompt);
          return done(step, ladderSubmitted(ladderJson(6, "boss")));
        }
        return respond(step, state);
      },
      (s) => s.task._tag === "stage" && s.task.name === "art",
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toContain("boss fight sooner");
    expect(rewritten.state.ladder?.rungs).toHaveLength(6);
    expect(asked.at(-1)?.answers.map((a) => a.answer)).toEqual(["approve", "edit"]);
  });

  it("decides itself once switched to Autopilot before the question went out", () => {
    const atStyle = drive(start("guided"), creator(), (s) => s.task._tag === "decide");
    const planned = Policy.plan(
      { ...atStyle.state, profile: "autopilot" },
      { now: T0, coin: 0.3, id: "x" },
    );
    if (planned.kind !== "step") throw new Error("expected a step");
    expect(planned.step.kind).not.toBe("decide");
    expect(planned.state.decided.at(-1)).toMatchObject({ kind: "style", by: "default" });
  });

  it("waits out only what is left of a resumed wait, and never forever", () => {
    const atStyle = drive(start("guided"), creator(), (s) => s.task._tag === "decide");
    const planned = Policy.plan(atStyle.state, { now: T0, coin: 0.3, id: "x" });
    if (planned.kind !== "step" || planned.step.kind !== "decide")
      throw new Error("expected the decide step");
    const step = planned.step;
    expect(Policy.decisionWait(step, T0)).toEqual({ kind: "send" });
    const sent = { ...step, sent: T0 };
    expect(Policy.decisionWait(sent, T0 + MIN)).toEqual({ kind: "deliver" });
    expect(Policy.decisionWait(sent, T0 + Policy.DECISION_DELIVERY_MS)).toEqual({
      kind: "default",
    });
    const waiting = { ...sent, deadline: T0 + Policy.DECISION_WAIT_MS };
    // A resumed run plans the waiting step again, and waits only what is left of it.
    const resumed = { ...planned.state, inFlight: waiting };
    expect(Policy.plan(resumed, { now: T0, coin: 0, id: "y" })).toMatchObject({
      step: { kind: "decide" },
    });
    expect(Policy.decisionWait(waiting, T0 + MIN)).toEqual({
      kind: "wait",
      ms: Policy.DECISION_WAIT_MS - MIN,
    });
    expect(Policy.decisionWait(waiting, T0 + Policy.DECISION_WAIT_MS)).toEqual({
      kind: "default",
    });
  });
});
