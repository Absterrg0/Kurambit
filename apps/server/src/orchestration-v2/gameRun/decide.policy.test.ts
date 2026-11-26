// The keep-going policy's tricky rules: what counts as worse, what counts as
// gain, never repeating a failed step, the order of evidence, and the person's
// direction.
import { describe, expect, it } from "@effect/vitest";
import {
  type GameBuildFacts,
  GameBuildId,
  type GameRunProposal,
  type GameRunTurnStep,
  RunId,
} from "@kurambit/contracts";

import * as Loop from "./decide.ts";
import type { RunState } from "./decide.ts";

const BASE = GameBuildId.make("a".repeat(40));
const BUILD = GameBuildId.make("b".repeat(40));
const NOW = 1_800_000_000_000;

type Ending = "won" | "lost" | "no-ending" | "crashed" | "unresponsive" | "did-not-boot";
const tier = (ending: Ending, at: number | null = 20) => ({
  status: "measured" as const,
  value: { ending, at, played: 60, note: "", evidence: "builds/logs/x" },
});
const counted = { objects: 50, things: 5, listeners: 30, intervals: 0, loops: 1 };
const qaReport = (dead: number) => ({
  version: 1 as const,
  controls: ["Jump", "Dash", "Shoot"].map((label, at) => ({
    name: label.toLowerCase(),
    label,
    read: at >= dead,
    answers: at >= dead ? ["moved"] : [],
  })),
  retry: { before: counted, after: counted, errors: [] },
  hud: [{ width: 1280, height: 720, off: [], over: [] }],
});
const facts = (patch: Partial<GameBuildFacts> = {}): GameBuildFacts => ({
  build: BASE,
  key: "web:" + "c".repeat(40),
  harness: "h1",
  state: "measured",
  measuredAt: null,
  renderer: "GPU",
  boots: { status: "measured", value: { ok: true, detail: "" } },
  masher: tier("lost", 20),
  use: { status: "not-measured", why: "not played", retry: false },
  performance: { status: "not-measured", why: "not played", retry: false },
  qa: { status: "measured", value: qaReport(0) },
  screens: { status: "not-measured", why: "not played", retry: false },
  player: { status: "not-measured", why: "not played", retry: false },
  savedPlays: {
    status: "not-measured",
    why: "no saved play was replayed on this build",
    cause: "no-saved-plays",
    retry: false,
  },
  message: "",
  ...patch,
});
/** A build whose QA play found `dead` declared controls the game never reads. */
const deadControls = (dead: number) => facts({ qa: { status: "measured", value: qaReport(dead) } });

const state = (patch: Partial<RunState> = {}): RunState => ({
  budgetMinutes: null,
  budgetUsedMs: 0,
  steer: [],
  finish: null,
  setAside: [],
  stallStreak: 0,
  superseded: 0,
  lastFailure: "",
  ending: null,
  records: [],
  n: 1,
  ...patch,
});

const proposal = (patch: Partial<GameRunProposal> = {}): GameRunProposal => ({
  why: "next",
  text: "Add a second enemy type.",
  target: null,
  key: "next:1",
  ...patch,
});
const turnStep = (patch: Partial<GameRunTurnStep> = {}): GameRunTurnStep => ({
  kind: "turn",
  id: 3,
  proposal: proposal(),
  steer: [],
  base: BASE,
  capMs: 15 * 60_000,
  ...patch,
});
// `startBuild` is the folder's build when the turn started (T's report).
type Turned = Loop.TurnResult & { readonly startBuild?: GameBuildId | null };
const turnResult = (patch: Partial<Turned> = {}): Loop.TurnResult =>
  ({
    kind: "turn",
    startBuild: BASE,
    runId: RunId.make("run-t3-1"),
    outcome: "completed",
    build: BUILD,
    files: 2,
    tokens: 40_000,
    elapsedMs: 180_000,
    personSteered: false,
    reason: "",
    ...patch,
  }) as Loop.TurnResult;
const look = (patch: Partial<Loop.LookResult> = {}): Loop.LookResult => ({
  kind: "look",
  current: BASE,
  facts: facts(),
  next: { text: "Add a score counter." },
  edited: false,
  ...patch,
});
const cycle = (turn = turnStep(), result = turnResult()): Loop.Cycle => ({
  turn,
  result,
  since: NOW - 300_000,
});
const judged = (s: RunState, base: GameBuildFacts, build: GameBuildFacts, c = cycle()) =>
  Loop.applyJudge(s, c, { kind: "judge", base, build: { ...build, build: BUILD } }, NOW);

describe("worse", () => {
  const broke = (base: GameBuildFacts, build: GameBuildFacts) =>
    Loop.regressions(base, build).map((r) => [r.delta.id, r.why]);

  it("undoes only on health, in words a person reads", () => {
    expect(broke(facts(), facts({ masher: tier("crashed", 12) }))).toEqual([
      ["errors", "it crashed: crashed at 12 s when played with random input"],
    ]);
    expect(broke(facts(), facts({ masher: tier("unresponsive", 8) }))).toEqual([
      ["errors", "it froze: stopped answering at 8.0 s when played with random input"],
    ]);
    expect(
      broke(
        facts(),
        facts({
          boots: { status: "measured", value: { ok: false, detail: "main.js: x is not defined" } },
        }),
      ),
    ).toEqual([["boots", "it stopped booting: main.js: x is not defined"]]);
    // Already bad on the base: the next blocker, not an undo.
    expect(
      broke(facts({ masher: tier("crashed", 3) }), facts({ masher: tier("crashed", 2) })),
    ).toEqual([]);
  });

  it("never undoes on a check alone: shown, proposed, never guarded", () => {
    expect(broke(deadControls(0), deadControls(1))).toEqual([]);
    expect(broke(facts(), facts({ masher: tier("won", 9) }))).toEqual([]);
  });

  it("never counts what cannot be compared: a renderer or a harness that changed", () => {
    const crashed = facts({
      boots: { status: "measured", value: { ok: false, detail: "throws" } },
    });
    expect(Loop.regressions(facts(), { ...crashed, renderer: "SwiftShader" })).toEqual([]);
    expect(Loop.regressions(facts(), { ...crashed, harness: "h2" })).toEqual([]);
    expect(Loop.regressions(facts(), { ...crashed, boots: { status: "pending" } })).toEqual([]);
  });

  it("undoes a broken step, and keeps the unmeasured", () => {
    const broken = facts({ masher: tier("crashed", 12) });
    expect(judged(state(), facts(), broken).plan).toEqual({
      kind: "undo",
      target: BASE,
      expect: BUILD,
    });
    // The person's own step is undone too when it breaks the game: it can be redone.
    const asked = cycle(turnStep({ proposal: proposal({ why: "steer", key: "steer:1" }) }));
    expect(judged(state(), facts(), broken, asked).plan?.kind).toBe("undo");
    const unmeasured = judged(state(), facts(), { ...broken, harness: "h2" });
    expect(unmeasured.plan).toEqual({ kind: "look" });
    expect(unmeasured.record).toMatchObject({
      failure: "harness",
      step: { verdict: "not-measured" },
    });
  });
});

describe("gain", () => {
  it("is a kept step that changed the game, and nothing else: taste is never inferred", () => {
    expect(Loop.gain({ verdict: "kept", files: 3 })).toBe(true);
    expect(Loop.gain({ verdict: "not-measured", files: 3 })).toBe(true);
    expect(Loop.gain({ verdict: "kept", files: 0 })).toBe(false);
    expect(Loop.gain({ verdict: "undone", files: 3 })).toBe(false);
    expect(Loop.gain({ verdict: "kept-moved-on", files: 3 })).toBe(false);
  });

  it("pauses the run after two steps in a row that kept nothing", () => {
    const quiet = cycle(turnStep(), turnResult({ files: 0 }));
    const first = Loop.applyTurn(state(), quiet.turn, quiet.result, {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(first.record?.step.verdict).toBe("no-change");
    expect(first.plan).toEqual({ kind: "look" });
    const second = Loop.applyTurn(first.state, quiet.turn, quiet.result, {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(second.state.ending).toBe("stalled");
    // A kept change in between resets the streak.
    const kept = judged(first.state, facts(), facts());
    expect(kept.state.stallStreak).toBe(0);
  });

  it("pauses as tool-failed on two unmeasured steps in a row", () => {
    const once = judged(state(), facts(), { ...facts(), harness: "h2" });
    const twice = judged(once.state, facts(), { ...facts(), harness: "h2" });
    expect(twice.state.ending).toBe("tool-failed");
    expect(twice.state.lastFailure).toContain("could not measure two builds in a row");
  });
});

describe("never repeat", () => {
  const easier = facts({ masher: tier("crashed", 12) });
  const undoOnce = (s: RunState, c: Loop.Cycle) =>
    Loop.applyUndo(
      s,
      { ...c, judge: { kind: "judge", base: facts(), build: easier } },
      { kind: "undo", restored: true, why: "restored", message: "" },
      NOW,
    );

  it("retries an undone step once, then sets its key aside", () => {
    const first = undoOnce(state(), cycle());
    expect(first.record?.step).toMatchObject({ verdict: "undone", key: "next:1" });
    const retry = Loop.propose(first.state, look());
    expect(retry).toMatchObject({ why: "regression", key: "next:1" });
    expect(retry?.text).toBe(
      "Your last step (Add a second enemy type) was undone: it crashed: crashed at 12 s when played with random input. Reach the same goal another way, or take a smaller step.",
    );
    const second = undoOnce(first.state, cycle(turnStep({ proposal: retry! })));
    expect(second.state.setAside.map((s) => s.key)).toEqual(["next:1"]);
    // The retry is not proposed again; the agent's own line comes instead.
    expect(Loop.propose(second.state, look())).toMatchObject({
      why: "next",
      text: "Add a score counter.",
    });
  });

  it("sets aside a fact step the agent declined", () => {
    const fact = turnStep({
      proposal: proposal({
        why: "fact",
        target: "controls",
        key: "fact:controls",
      }),
    });
    const declined = Loop.applyTurn(state(), fact, turnResult({ files: 0 }), {
      now: NOW,
      since: NOW,
      started: true,
    });
    expect(declined.state.setAside.map((s) => s.key)).toEqual(["fact:controls"]);
    expect(Loop.propose(declined.state, look({ facts: deadControls(1), next: "none" }))).toBeNull();
  });

  it("finishes a step the time cap cut off before it changed anything, never sets it aside", () => {
    const capped = Loop.applyTurn(
      state(),
      turnStep(),
      turnResult({ outcome: "capped", files: 0, build: null }),
      { now: NOW, since: NOW, started: true },
    );
    expect(capped.state.setAside).toEqual([]);
    expect(Loop.propose(capped.state, look())).toMatchObject({ key: "next:1" });
    expect(Loop.propose(capped.state, look())?.text).toMatch(/^Finish step 1: /);
  });
});

describe("the proposal", () => {
  it("follows the order of evidence and ends done only on Next: none", () => {
    const crashing = facts({ masher: tier("crashed", 12) });
    expect(Loop.propose(state({ steer: ["Make it night."] }), look({ facts: crashing }))?.why).toBe(
      "steer",
    );
    const blocker = Loop.propose(state(), look({ facts: crashing }));
    expect(blocker).toMatchObject({ why: "blocker", target: "errors", key: "fact:errors" });
    expect(blocker?.text).toContain("builds/logs/x/trace.json");
    expect(Loop.propose(state(), look({ next: null }))?.text).toBe(
      "Make the one change that most improves the game for BRIEF.md.",
    );
    expect(Loop.applyLook(state(), look({ next: "none" })).state.ending).toBe("done");
  });

  // Matching the person's picture is their stated goal: while the agent's final check still
  // declares a major difference, it comes before a failing fact and the agent's own next line.
  it("takes the next step from the reference critique until it declares none", () => {
    const critique = { text: "The camera sits higher and closer than the picture's" };
    const step = Loop.propose(state(), look({ facts: deadControls(1), critique }));
    expect(step).toMatchObject({ why: "reference" });
    expect(step?.text).toContain("The camera sits higher and closer than the picture's.");
    expect(Loop.propose(state(), look({ facts: deadControls(1), critique: "none" }))?.why).toBe(
      "next",
    );
    const crashing = facts({ masher: tier("crashed", 12) });
    expect(Loop.propose(state(), look({ facts: crashing, critique }))?.why).toBe("blocker");
  });

  // Taste from screenshots never outranks a plan: fresh eyes is proposed only when the agent's
  // own `Next:` is none or missing, and the person's picture still comes first.
  it("takes the biggest problem fresh eyes saw only when no Next is left", () => {
    const fresh = { text: "The player's ship is a small pale blob against the wall glow" };
    expect(Loop.propose(state(), look({ fresh }))?.why).toBe("next");
    const step = Loop.propose(state(), look({ fresh, next: "none" }));
    expect(step).toMatchObject({ why: "fresh" });
    expect(step?.text).toContain("The player's ship is a small pale blob against the wall glow.");
    expect(Loop.propose(state(), look({ fresh, next: null }))?.why).toBe("fresh");
    expect(Loop.propose(state(), look({ fresh: "none", next: null }))?.text).toBe(
      "Make the one change that most improves the game for BRIEF.md.",
    );
    const critique = { text: "The camera sits higher than the picture's" };
    expect(Loop.propose(state(), look({ critique, fresh }))?.why).toBe("reference");
  });

  // The controls fact sees only whether a declared action was read in one scripted run: a step
  // "fixing" it rebound the person's jump to Enter and J.
  it("never proposes the controls fact; boots and errors still do", () => {
    expect(Loop.propose(state(), look({ facts: deadControls(2), next: "none" }))).toBeNull();
    const crashing = facts({ masher: tier("crashed", 12) });
    expect(Loop.propose(state(), look({ facts: crashing }))?.why).toBe("blocker");
  });

  // The judge waits only for the boot check, so the random-input play of a step's build may
  // land after the next look: an error it found is that look's blocker while the current
  // build has no reading of its own, and never once the current build's own reading is in.
  it("proposes an error the earlier build's random-input play found while the current one has none", () => {
    const crashed = facts({ masher: tier("crashed", 12) });
    const measuring = facts({ masher: { status: "pending" } });
    const step = Loop.propose(state(), look({ facts: measuring, earlier: crashed }));
    expect(step).toMatchObject({ why: "blocker", target: "errors", key: "fact:errors" });
    expect(step?.text).toContain("the build before the last step");
    // Queued behind another play, its reading is not measured yet: the same.
    const queued = facts({
      masher: { status: "not-measured", why: "not measured yet", retry: true },
    });
    expect(Loop.propose(state(), look({ facts: queued, earlier: crashed }))?.target).toBe("errors");
    expect(Loop.propose(state(), look({ facts: facts(), earlier: crashed }))?.why).toBe("next");
  });

  it("keeps starting turns while the budget has time, each capped at the time left", () => {
    const left = (minutes: number) =>
      state({ budgetMinutes: 60, budgetUsedMs: (60 - minutes) * 60_000 });
    expect(Loop.applyLook(left(0.5), look()).state.ending).toBe("budget");
    expect(Loop.applyLook(left(4), look()).plan).toMatchObject({ kind: "turn", capMs: 4 * 60_000 });
    expect(Loop.applyLook(left(10), look()).plan).toMatchObject({
      kind: "turn",
      capMs: 10 * 60_000,
    });
    expect(Loop.applyLook(left(60), look()).plan).toMatchObject({ capMs: 15 * 60_000 });
  });

  it("spends the budget on a turn's working time only", () => {
    const spent = Loop.applyTurn(
      state({ budgetMinutes: 60 }),
      turnStep(),
      turnResult({ elapsedMs: 7 * 60_000 }),
      { now: NOW + 3_600_000, since: NOW, started: true },
    );
    expect(spent.state.budgetUsedMs).toBe(7 * 60_000);
    expect(Loop.budgetLeft(spent.state)).toBe(53 * 60_000);
  });
});

describe("the person's direction", () => {
  const started = { now: NOW, since: NOW, started: true };
  const asked = (steer: ReadonlyArray<string>) =>
    turnStep({ steer, proposal: proposal({ why: "steer", key: "steer:1" }) });

  it("is carried whole by every step, and outranks every fact", () => {
    const long = `Bolts and outlines. ${"x".repeat(400)} Then build the Blender Hive Queen.`;
    const s = state({ steer: [long] });
    expect(Loop.applyLook(s, look()).plan).toMatchObject({ kind: "turn", steer: [long] });
    const crashing = facts({ masher: tier("crashed", 12) });
    const step = Loop.propose(s, look({ facts: crashing }));
    expect(step?.why).toBe("steer");
    expect(step?.text).toContain(long);
    expect(step?.text).toContain("`Direction: done`");
  });

  it("goes on from the step before it: what the time cap cut, or that step's Next line", () => {
    const kept = Loop.applyJudge(
      state({ steer: ["Bolts, then the queen."] }),
      cycle(asked(["Bolts, then the queen."]), turnResult({ outcome: "capped" })),
      { kind: "judge", base: facts(), build: { ...facts(), build: BUILD } },
      NOW,
    );
    expect(kept.state.finish).toMatchObject({ n: 1, proposal: { why: "steer" } });
    const finishing = Loop.propose(kept.state, look());
    expect(finishing?.text).toContain("Step 1 worked on it and Kurambit's time cap stopped it");
    // A non-direction finish never jumps the direction.
    expect(finishing?.why).toBe("steer");

    const completed = Loop.applyJudge(
      state({ steer: ["Bolts, then the queen."] }),
      cycle(asked(["Bolts, then the queen."])),
      { kind: "judge", base: facts(), build: { ...facts(), build: BUILD } },
      NOW,
    );
    expect(
      Loop.propose(completed.state, look({ next: { text: "Build the Blender queen." } }))?.text,
    ).toContain("Step 1 worked on it and said what is left: Build the Blender queen.");
  });

  it("stays whatever became of the turn; one an earlier Kurambit took at its start comes back", () => {
    const back = Loop.applyTurn(
      state({ steer: ["c"] }),
      asked(["a", "b"]),
      turnResult({ outcome: "superseded" }),
      started,
    );
    expect(back.state.steer).toEqual(["a", "b", "c"]);
    expect(back.plan).toEqual({ kind: "look" });
    const kept = Loop.applyTurn(
      state({ steer: ["a", "b", "c"] }),
      asked(["a", "b"]),
      turnResult({ outcome: "superseded" }),
      { ...started, started: false },
    );
    expect(kept.state.steer).toEqual(["a", "b", "c"]);
  });

  it("is retired only by a kept direction step whose reply says it is done", () => {
    const judge = (s: RunState, c: Loop.Cycle) =>
      Loop.applyJudge(
        s,
        c,
        { kind: "judge", base: facts(), build: { ...facts(), build: BUILD } },
        NOW,
      );
    const done = turnResult({ done: true });
    expect(judge(state({ steer: ["a", "b"] }), cycle(asked(["a"]), done)).state.steer).toEqual([
      "b",
    ]);
    // Said by a step that was not about the direction, it retires nothing.
    expect(
      judge(state({ steer: ["a"] }), cycle(turnStep({ steer: ["a"] }), done)).state.steer,
    ).toEqual(["a"]);
    expect(judge(state({ steer: ["a"] }), cycle(asked(["a"]))).state.steer).toEqual(["a"]);
  });

  // Both cycle-4 ruler runs had the direction done at step 2, then took 6 more taste steps, all
  // "kept: no fact got worse", until Stop.
  it("once done, ends the run unless a measured fault earns a step", () => {
    const finished = Loop.applyJudge(
      state({ steer: ["a"] }),
      cycle(asked(["a"]), turnResult({ done: true })),
      { kind: "judge", base: facts(), build: { ...facts(), build: BUILD } },
      NOW,
    ).state;
    for (const left of [look(), look({ next: null, fresh: { text: "The ship is a pale blob" } })]) {
      const ended = Loop.applyLook(finished, left);
      expect(ended.plan).toBeNull();
      expect(ended.state.ending).toBe("done");
      expect(ended.state.lastFailure).toContain("your direction is done");
    }
    // An error only the random-input play finds (the QA play is clean) is a step, never a "done"
    // that the Game panel's ✗ then contradicts: the look waits for that play's reading.
    const crashing = facts({ build: BUILD, masher: tier("crashed", 12) });
    const fixing = Loop.applyLook(finished, look({ current: BUILD, facts: crashing }));
    expect(fixing.state.ending).toBeNull();
    expect(fixing.plan).toMatchObject({
      kind: "turn",
      proposal: { why: "blocker", target: "errors" },
    });
    // More words from the person are a direction again.
    expect(Loop.propose({ ...finished, steer: ["b"] }, look())?.why).toBe("steer");
  });

  it("is told apart from a reply's prose", () => {
    expect(Loop.directionDone("Added the queen.\n\nDirection: done\nNext: none")).toBe(true);
    expect(Loop.directionDone("- **Direction: done**")).toBe(true);
    expect(Loop.directionDone("The direction: done soon, I hope.")).toBe(false);
    expect(Loop.replyHeadline("Direction: done\nAdded the queen.")).toBe("Added the queen.");
  });
});

describe("a step acts only on the build it was planned on (TW1)", () => {
  const started = { now: NOW, since: NOW, started: true };

  it("never judges a turn that started on another build, or on an unknown one", () => {
    // A person's turn landed while the look waited for facts: the step's turn started on it.
    const moved = Loop.applyTurn(state(), turnStep(), turnResult({ startBuild: BUILD }), started);
    expect(moved.plan).toEqual({ kind: "look" });
    expect(moved.record).toBeNull();
    const unknown = Loop.applyTurn(state(), turnStep(), turnResult({ startBuild: null }), started);
    expect(unknown.plan).toEqual({ kind: "look" });
    // An unknown start is never looped on: two in a row pause the run.
    expect(moved.state.stallStreak).toBe(0);
    expect(
      Loop.applyTurn(unknown.state, turnStep(), turnResult({ startBuild: null }), started).state
        .ending,
    ).toBe("stalled");
    // A turn that started where its look read is judged against that build.
    expect(Loop.applyTurn(state(), turnStep(), turnResult(), started).plan).toEqual({
      kind: "judge",
      build: BUILD,
      base: BASE,
    });
  });

  it("never retries a step the person redid", () => {
    const easier = deadControls(1);
    const undone = Loop.applyUndo(
      state(),
      { ...cycle(), judge: { kind: "judge", base: facts(), build: easier } },
      { kind: "undo", restored: true, why: "restored", message: "" },
      NOW,
    );
    expect(Loop.propose(undone.state, look({ current: BASE }))?.why).toBe("regression");
    // Redo put the step's build back in the folder: the agent's own line comes next.
    expect(Loop.propose(undone.state, look({ current: BUILD }))?.why).toBe("next");
  });

  it("words a failed undo as failed, and only a moved folder as moved on", () => {
    const broken = facts({ masher: tier("crashed", 12) });
    const judged = { ...cycle(), judge: { kind: "judge" as const, base: facts(), build: broken } };
    expect(Loop.undoReason(judged)).toBe(
      "it crashed: crashed at 12 s when played with random input",
    );
    const failed = Loop.applyUndo(
      state(),
      judged,
      { kind: "undo", restored: false, why: "refused", message: "the copy could not be made" },
      NOW,
    );
    // Not undone either way; the reason, not the verdict, says the restore failed.
    expect(failed.record?.step).toMatchObject({ verdict: "kept-moved-on", gain: false });
    expect(failed.record?.step.reason).toBe(
      "the copy could not be made (it crashed: crashed at 12 s when played with random input)",
    );
    const moved = Loop.applyUndo(
      state(),
      judged,
      { kind: "undo", restored: false, why: "moved-on", message: "" },
      NOW,
    );
    expect(moved.record?.step.verdict).toBe("kept-moved-on");
    expect(moved.record?.step.reason).toMatch(/^the game changed after it/);
  });
});

describe("a step's record", () => {
  it("names what the step did from its reply, without markdown or its Next line", () => {
    expect(
      Loop.replyHeadline(
        "## Added the Junk King boss. It slams the ground.\n\nNext: add a boss intro",
      ),
    ).toBe("Added the Junk King boss.");
    expect(Loop.replyHeadline("**Done** — the tank now dashes on Shift\nNext: none")).toBe(
      "Done — the tank now dashes on Shift",
    );
    expect(Loop.replyHeadline("Next: add sound")).toBe("");
  });
});
