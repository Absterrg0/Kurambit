// Keep-or-revert, stalls, the pending line, budget and resume decide what happens to a
// creator's game history; these are pure decisions, so they are checked here.
import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@kurambit/contracts";
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
  bot: null,
  sheet: "",
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

type Single = Exclude<State.Step, State.PairStep>;
type Responder = (step: Single, state: State.RunState) => Policy.StepResult;

const stepName = (s: Single) =>
  s.kind === "role" ? s.role.replace(/-[0-9a-z]+$/, "") : s.kind === "git" ? s.op._tag : s.kind;

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
  for (let guard = 0; guard < 200 && !until(state) && state.ending === null; guard += 1) {
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
    opts: { bootOk?: boolean; changed?: boolean; bot?: (sha: string) => Policy.StepResult } = {},
  ): Responder =>
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

  it("judges a Unity round on blind samples played one at a time in worktrees, without bot facts", () => {
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
    expect(steps.slice(steps.indexOf("restore-commit"), steps.indexOf("ff-merge"))).toEqual([
      "restore-commit",
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
    expect(logs).toContain("round 1: bot runs do not play unity games; bot facts are skipped");
    expect(logs.some((line) => line.includes("judging on play reports"))).toBe(false);
    expect(state.rounds[0]?.kept).toBe(true);
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

  it("resumes a half-finished pair from run.json and runs only the unfinished half", () => {
    const { state, pair } = planPair(atCompare());
    const [x, y] = roles(pair);
    // The driver attached both halves, then x finished and was saved; then the server stopped.
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
    const loaded = State.loadState(JSON.stringify(State.encodeRunState(saved)), "");
    if (loaded.kind !== "v3") throw new Error("expected v3");
    const again = Policy.plan(loaded.state, { now: T0 + MIN, coin: 0.9, id: "other" });
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
          bot: step.read.length === 0 ? { file: bot, decider } : null,
          files: Object.fromEntries(step.read.map((f) => [f, "tester notes long enough to count"])),
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
    expect(steps.slice(steps.indexOf("restore-commit"), steps.indexOf("compare"))).toEqual([
      "restore-commit",
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
          files: Object.fromEntries(
            step.read.map((f) => [f, "notes that are long enough to count"]),
          ),
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
      expect(step.read).toEqual([".compare/verdict.md"]);
      expect(step.prompt).toContain("Write .compare/verdict.md.");
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
        /^COMPARE: [AB]\nplay-based reasons/,
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

  it("releases each comparator's worktree once its verdict is in, after a format fix", () => {
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
        return done(step, { files: { [step.read[0]!]: "A is better, clearly so in play" } });
      }
      return roundResponder("A", "B")(step, state);
    };
    const { compares, released, state } = run(["cand", "best"], respond);
    expect(compares.map((c) => c.thread === null)).toEqual([true, false, true]);
    const correct = compares[1]!;
    expect(correct.at).toBe(State.BLANK);
    expect(correct.read).toEqual([".compare/verdict.md"]);
    expect(correct.prompt).toContain(".compare/verdict.md");
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
        },
      },
    });
    const selects: State.Step[] = [];
    const respond: Responder = (step, state) => {
      if (step.kind === "role" && step.prompt.startsWith("The comparison is a tie")) {
        selects.push(step);
        return done(step, { text: "SELECT: B\nreasons to continue from B" });
      }
      if (step.kind === "role" && step.role.startsWith("compare"))
        return done(step, { files: { [step.read[0]!]: "COMPARE: TIE\nno difference shown" } });
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
    const respond: Responder = (step, s) =>
      step.kind === "role" && step.role.startsWith("tester")
        ? done(step, {
            bot: { file: ".studio/bot/win.mjs", decider: "policy" },
            files: Object.fromEntries(step.read.map((f) => [f, "tester notes long enough"])),
          })
        : roundResponder("A", "B")(step, s);
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
