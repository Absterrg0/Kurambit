// What the run does with each command decides a creator's game history: which
// step runs next, what a role may hand it, when a decision takes its default,
// and that a stopped run stays stopped. These are pure decisions, checked here.
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type GameRun,
  GameRunId,
  type GameRunRound,
  type GameRunStep,
  type GameRunStepResult,
  type OrchestrationV2GameRunCommand,
  ProjectId,
  ProviderInstanceId,
  type GameRunRungChange,
  ThreadId,
  gameRunStepCommandId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import * as Policy from "../../game/run/policy.ts";
import * as State from "../../game/run/state.ts";
import * as Decide from "./decide.ts";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const threadId = ThreadId.make("thread:creator");
const runId = GameRunId.make("game-run-1");
const tester = ThreadId.make("thread:tester");
const planner = ThreadId.make("thread:plan");

type Input = OrchestrationV2GameRunCommand extends infer C
  ? C extends OrchestrationV2GameRunCommand
    ? Omit<C, "commandId" | "threadId">
    : never
  : never;

interface Records {
  readonly runs: ReadonlyArray<GameRun>;
  readonly steps: ReadonlyArray<GameRunStep>;
  readonly rounds: ReadonlyArray<GameRunRound>;
}
const none: Records = { runs: [], steps: [], rounds: [] };

const upsert = <T extends { readonly id: string }>(rows: ReadonlyArray<T>, row: T) =>
  rows.some((x) => x.id === row.id) ? rows.map((x) => (x.id === row.id ? row : x)) : [...rows, row];

const fold = (records: Records, decision: Decide.GameRunDecision): Records => {
  let { runs, steps, rounds } = records;
  for (const event of decision.events) {
    if (event.type === "game-run-step.updated") steps = upsert(steps, event.payload);
    else if (event.type === "game-run-round.recorded") rounds = upsert(rounds, event.payload);
    else runs = upsert(runs, event.payload);
  }
  return { runs, steps, rounds };
};

const read = (records: Records): Decide.GameRunRecords => {
  const run = records.runs.at(-1);
  return {
    projectId: ProjectId.make("project:game"),
    runs: records.runs,
    rounds: records.rounds,
    inFlight:
      run?.inFlight == null
        ? null
        : (records.steps.find((s) => s.runId === run.id && s.seq === run.inFlight) ?? null),
  };
};

let commands = 0;
const send = (records: Records, input: Input, ms = T0) => {
  commands += 1;
  return Decide.decide(
    { ...input, commandId: CommandId.make(`command-${commands}`), threadId },
    read(records),
    { at: DateTime.makeUnsafe(ms), coin: 0.3, id: `id${commands}` },
  );
};
const accept = (records: Records, input: Input, ms = T0) => {
  const result = send(records, input, ms);
  if (Result.isFailure(result))
    throw new Error(`${input.type} was refused: ${result.failure.message}`);
  return { records: fold(records, result.success), decision: result.success };
};
const refusal = (records: Records, input: Input, ms = T0) => {
  const result = send(records, input, ms);
  if (Result.isSuccess(result)) throw new Error(`${input.type} was accepted`);
  return result.failure;
};

const runOf = (records: Records) => records.runs.at(-1)!;
const stepOf = (records: Records) => {
  const run = runOf(records);
  return records.steps.find((s) => s.runId === run.id && s.seq === run.inFlight)!;
};

const started = (profile: "guided" | "autopilot" = "autopilot") =>
  accept(none, {
    type: "game-run.start",
    runId,
    lane: "godot",
    brief: "A small arena game.",
    profile,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
  }).records;

const complete = (records: Records, result: GameRunStepResult, ms = T0) => {
  const { id, attempt } = stepOf(records);
  return accept(records, { type: "game-run.step.complete", runId, stepId: id, attempt, result }, ms)
    .records;
};

const gitOk = (patch: Partial<Policy.GitOutcome> = {}): GameRunStepResult => ({
  kind: "git",
  git: {
    ok: true,
    sha: "c0ffee",
    branch: "main",
    changed: true,
    entered: false,
    lines: 10,
    detail: "",
    same: false,
    ...patch,
  },
});
const roleDone = (thread: ThreadId, patch: Partial<Policy.RoleDone> = {}): GameRunStepResult => ({
  kind: "done",
  threadId: thread,
  evidence: { sessions: 1, actions: 4, executedInputSteps: 4, nominalMs: 90_000, images: 4 },
  timedOut: false,
  budgetCut: false,
  elapsedMs: MIN,
  sourceBefore: "s0",
  sourceAfter: "s1",
  botsBefore: 0,
  botsAfter: 1,
  bot: null,
  sheet: "",
  ...patch,
});

/** The run as if it had stopped at `task`: a resume plans the task's next step. */
const resumedAt = (records: Records, patch: Partial<GameRun>) => {
  const run = runOf(records);
  const stopped = {
    ...records,
    runs: [
      ...records.runs.slice(0, -1),
      { ...run, status: "ended", ending: "stopped", inFlight: null, ...patch } satisfies GameRun,
    ],
  };
  return accept(stopped, { type: "game-run.resume", runId }).records;
};

const fresh = {
  runId,
  profile: "autopilot",
  brief: "b",
  artDirection: "",
  budgetMinutes: null,
  provider: null,
  model: null,
  variant: null,
  startedAt: "x",
} as const;

const lookAndState = State.ladderOf([
  {
    is: "The player moves and jumps.",
    checks: [
      { what: "jumping feels responsive", how: "jump a few times" },
      { what: "the player starts", kind: "state", expect: "started == true" },
    ],
  },
  ...[2, 3, 4].map((i) => ({
    is: `Part ${i} plays.`,
    checks: [
      { what: `part ${i} starts`, how: "play it" },
      { what: `part ${i} ends`, how: "play to the end" },
    ],
  })),
]);
if ("error" in lookAndState) throw new Error(lookAndState.error);
const ladder = lookAndState.ladder;

/** A ladder round at its blind comparison: the policy plans both samples as one pair. */
const comparing = () => {
  const base = complete(started(), gitOk());
  const round = Policy.reopen(
    { ...State.freshState(fresh, { rounds: [], pending: null }), ladder },
    T0,
  ).task;
  if (round._tag !== "round") throw new Error("expected a round");
  return resumedAt(base, {
    ladder,
    task: {
      ...round,
      rung: ladder.rungs[0]!.id,
      phase: "compare",
      branch: "round-1",
      candidate: "cafe",
      cmp: {
        question: "Which build plays better?",
        x: "cafe",
        y: "c0ffee",
        xFirst: true,
        orders: ["x", "y"],
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
};
const players = [ThreadId.make("thread:player-1"), ThreadId.make("thread:player-2")] as const;

describe("game-run commands", () => {
  it("start plans the run's first step and the effect that executes it", () => {
    const { records, decision } = accept(none, {
      type: "game-run.start",
      runId,
      lane: "godot",
      brief: "A small arena game.",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
    });
    expect(decision.events.map((e) => e.type)).toEqual([
      "game-run-step.updated",
      "game-run.created",
    ]);
    expect(runOf(records)).toMatchObject({ status: "running", profile: "guided", inFlight: 1 });
    expect(stepOf(records)).toMatchObject({ status: "planned", kind: "git" });
    expect(stepOf(records).step).toMatchObject({ op: { _tag: "init" } });
    expect(decision.effects).toEqual([
      {
        request: {
          type: "game-run.step.execute",
          runId,
          stepId: gameRunStepId(runId, 1),
          attempt: 1,
        },
      },
    ]);
    expect(
      refusal(records, {
        type: "game-run.start",
        runId: GameRunId.make("game-run-2"),
        lane: "godot",
        brief: "Again.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
        runtimeMode: "full-access",
      }).reason,
    ).toBe("run-live");
  });

  it("a completed step lands through the policy and plans the next one", () => {
    const records = complete(started(), gitOk());
    const [init, vision] = records.steps;
    expect(init).toMatchObject({ status: "completed", result: { kind: "git" } });
    expect(vision).toMatchObject({ status: "planned", kind: "role", seq: 2 });
    expect(vision!.step).toMatchObject({ role: "vision" });
    expect(runOf(records)).toMatchObject({ trunk: "main", best: "c0ffee", inFlight: 2 });
    // A result for a step that already landed names no current step.
    expect(
      refusal(records, {
        type: "game-run.step.complete",
        runId,
        stepId: init!.id,
        attempt: 1,
        result: gitOk(),
      }).reason,
    ).toBe("stale-step");
    expect(
      refusal(records, {
        type: "game-run.step.complete",
        runId,
        stepId: vision!.id,
        attempt: 1,
        result: gitOk(),
      }).reason,
    ).toBe("wrong-kind");
  });

  it("a role's submission is checked against what its step asks for", () => {
    const atVision = complete(started(), gitOk());
    const vision = stepOf(atVision);
    const launched = accept(atVision, {
      type: "game-run.step.start",
      runId,
      stepId: vision.id,
      roleThreadId: planner,
    }).records;
    expect(
      refusal(launched, {
        type: "game-run.submit",
        runId,
        stepId: vision.id,
        roleThreadId: planner,
        submission: { _tag: "report", report: "done" },
      }).reason,
    ).toBe("wrong-kind");

    const atLadder = resumedAt(atVision, {
      task: { _tag: "ladder", phase: "write", thread: null, error: "" },
    });
    const write = stepOf(atLadder);
    const asked = accept(atLadder, {
      type: "game-run.step.start",
      runId,
      stepId: write.id,
      roleThreadId: planner,
    }).records;
    const submit = (
      roleThreadId: ThreadId,
      submission: Extract<Input, { type: "game-run.submit" }>["submission"],
    ) => ({ type: "game-run.submit", runId, stepId: write.id, roleThreadId, submission }) as const;
    const rungs = ladder.rungs.map(({ is, checks }) => ({ is, checks }));
    expect(
      refusal(asked, submit(planner, { _tag: "verdict", verdict: "A", reasons: "r" })).reason,
    ).toBe("wrong-kind");
    expect(refusal(asked, submit(tester, { _tag: "ladder", rungs })).reason).toBe("wrong-thread");
    const noHow = refusal(
      asked,
      submit(planner, {
        _tag: "ladder",
        rungs: rungs.with(0, { is: "x", checks: [{ what: "a" }, { what: "b", how: "y" }] }),
      }),
    );
    expect(noHow).toMatchObject({ reason: "invalid-submission" });
    expect(noHow.message).toContain('needs "how"');
    expect(
      refusal(asked, submit(planner, { _tag: "ladder", rungs: rungs.slice(0, 3) })).reason,
    ).toBe("invalid-submission");

    const submitted = accept(asked, submit(planner, { _tag: "ladder", rungs })).records;
    expect(stepOf(submitted).roles[0]?.submission?._tag).toBe("ladder");
    // The run reads the submission it recorded, never prose or a file the role wrote.
    const landed = complete(submitted, roleDone(planner));
    expect(runOf(landed).ladder?.rungs.map((r) => r.is)).toEqual(rungs.map((r) => r.is));
    expect(landed.steps.find((s) => s.id === write.id)?.outputs.files[0]?.path).toBe(
      ".studio/ladder.json",
    );
  });

  it("a tester scores only the rung's look checks", () => {
    const base = complete(started(), gitOk());
    const round = Policy.reopen(
      { ...State.freshState(fresh, { rounds: [], pending: null }), ladder },
      T0,
    ).task;
    if (round._tag !== "round") throw new Error("expected a round");
    const atTester = resumedAt(base, {
      ladder,
      task: {
        ...round,
        rung: ladder.rungs[0]!.id,
        phase: "tester-write",
        thread: tester,
        branch: "round-1",
        candidate: "cafe",
      },
    });
    const write = stepOf(atTester);
    expect(write.roles[0]?.threadId).toBe(tester);
    const checks = (check: number) =>
      ({
        type: "game-run.submit",
        runId,
        stepId: write.id,
        roleThreadId: tester,
        submission: {
          _tag: "checks",
          checks: [{ check, pass: true, evidence: "jumped ten times, each landed" }],
          notes: "Played the first level twice; the jump is crisp.",
        },
      }) as const;
    const stateCheck = refusal(atTester, checks(2));
    expect(stateCheck.reason).toBe("invalid-submission");
    expect(stateCheck.message).toContain("score checks 1");
    const scored = accept(atTester, checks(1)).records;
    const landed = complete(scored, roleDone(tester, { botsBefore: 0, botsAfter: 1 }));
    const task = runOf(landed).task;
    expect(task._tag === "round" ? task.checks.map((c) => c.pass) : null).toEqual([true, false]);
  });

  it("a pair lands only once both halves are in, and a half never lands twice", () => {
    const atCompare = comparing();
    const pair = stepOf(atCompare);
    if (pair.step.kind !== "pair") throw new Error("expected a pair");
    const [first, second] = pair.step.halves;
    const half = (records: Records, seq: number, player: ThreadId) =>
      accept(records, {
        type: "game-run.step.complete",
        runId,
        stepId: gameRunStepId(runId, seq),
        attempt: stepOf(records).attempt,
        result: roleDone(player),
      });
    const one = half(atCompare, first!.id, players[0]!);
    expect(one.decision.effects).toEqual([]);
    expect(stepOf(one.records)).toMatchObject({ id: pair.id, status: "running" });
    expect(
      refusal(one.records, {
        type: "game-run.step.complete",
        runId,
        stepId: gameRunStepId(runId, first!.id),
        attempt: 1,
        result: roleDone(players[0]!),
      }).reason,
    ).toBe("stale-step");
    const both = half(one.records, second!.id, players[1]!).records;
    expect(both.steps.find((s) => s.id === pair.id)?.status).toBe("completed");
    // Both players played; each now writes its report up on its own thread.
    const writes = stepOf(both).step;
    expect(
      writes.kind === "pair" ? writes.halves.map((h) => h.kind === "role" && h.thread) : null,
    ).toEqual(players);
  });

  it("a half that ends the run waits for its partner, whose work is kept", () => {
    const atCompare = comparing();
    const pair = stepOf(atCompare);
    if (pair.step.kind !== "pair") throw new Error("expected a pair");
    const [first, second] = pair.step.halves;
    const limited = accept(atCompare, {
      type: "game-run.step.complete",
      runId,
      stepId: gameRunStepId(runId, first!.id),
      attempt: pair.attempt,
      result: { kind: "ended", ending: "usage-limit", reason: "limit reached" },
    }).records;
    expect(runOf(limited)).toMatchObject({ status: "running", ending: null });
    expect(stepOf(limited).endedHalves.map((h) => h.seq)).toEqual([first!.id]);
    const ended = accept(limited, {
      type: "game-run.step.complete",
      runId,
      stepId: gameRunStepId(runId, second!.id),
      attempt: pair.attempt,
      result: roleDone(players[1]),
    }).records;
    expect(runOf(ended)).toMatchObject({
      status: "ended",
      ending: "usage-limit",
      inFlight: pair.seq,
    });
    const held = stepOf(ended);
    expect(held.status).toBe("cancelled");
    expect(held.step.kind === "pair" ? held.step.results.map((r) => r.id) : null).toEqual([
      second!.id,
    ]);
    // On resume only the half that never finished plays again.
    const resumed = accept(ended, { type: "game-run.resume", runId }).records;
    expect(stepOf(resumed)).toMatchObject({ attempt: pair.attempt + 1, endedHalves: [] });
  });

  it("a step that ended on a usage limit runs again as a new attempt after a resume", () => {
    const limited = complete(started(), {
      kind: "ended",
      ending: "usage-limit",
      reason: "limit reached",
    });
    expect(runOf(limited)).toMatchObject({ status: "ended", ending: "usage-limit", inFlight: 1 });
    expect(stepOf(limited)).toMatchObject({ status: "cancelled", attempt: 1 });
    const { records: resumed, decision } = accept(limited, { type: "game-run.resume", runId });
    expect(stepOf(resumed)).toMatchObject({ status: "planned", attempt: 2, result: null });
    expect(decision.effects.map((e) => e.request)).toEqual([
      { type: "game-run.step.execute", runId, stepId: gameRunStepId(runId, 1), attempt: 2 },
    ]);
    // The first attempt's report names a different command, and the run refuses it.
    expect(gameRunStepCommandId(gameRunStepId(runId, 1), 1, "complete")).not.toBe(
      gameRunStepCommandId(gameRunStepId(runId, 1), 2, "complete"),
    );
    expect(
      refusal(resumed, {
        type: "game-run.step.complete",
        runId,
        stepId: gameRunStepId(runId, 1),
        attempt: 1,
        result: gitOk(),
      }).reason,
    ).toBe("stale-attempt");
    const landed = complete(resumed, gitOk());
    expect(landed.steps.find((s) => s.seq === 1)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(stepOf(landed).step).toMatchObject({ role: "vision" });
  });

  it("a reviewer's ladder change the run would not take is refused in-turn", () => {
    const base = complete(started(), gitOk());
    const round = Policy.reopen(
      { ...State.freshState(fresh, { rounds: [], pending: null }), ladder },
      T0,
    ).task;
    if (round._tag !== "round") throw new Error("expected a round");
    const open = {
      ...ladder,
      rungs: ladder.rungs.with(1, { ...ladder.rungs[1]!, from: "reviewer" as const }),
    };
    const reviewer = ThreadId.make("thread:reviewer");
    const atReview = resumedAt(base, {
      ladder: open,
      task: { ...round, rung: open.rungs[0]!.id, phase: "review-write", branch: "round-1" },
    });
    const write = stepOf(atReview);
    const launched = accept(atReview, {
      type: "game-run.step.start",
      runId,
      stepId: write.id,
      roleThreadId: reviewer,
    }).records;
    const ledger = (rungChange?: GameRunRungChange) =>
      ({
        type: "game-run.submit",
        runId,
        stepId: write.id,
        roleThreadId: reviewer,
        submission: {
          _tag: "ledger",
          ledger: "1. The jump clips through ledges.",
          ...(rungChange === undefined ? {} : { rungChange }),
        },
      }) as const;
    const change = {
      why: "the core is unplayable",
      is: "The player can land on ledges.",
      checks: [
        { what: "landing holds", how: "jump onto three ledges" },
        { what: "no clipping", how: "walk along the ledge" },
      ],
    };
    const refused = refusal(launched, ledger(change));
    expect(refused.reason).toBe("invalid-submission");
    expect(refused.message).toContain("an earlier one is still open");
    accept(launched, ledger());
  });

  it("an unanswered decision takes its default only once it is due", () => {
    let records = complete(started("guided"), gitOk({ branch: "main", sha: "s1" }));
    records = complete(records, roleDone(planner));
    records = complete(records, gitOk({ sha: "s2", changed: true }));
    const asked = accept(records, {
      type: "game-run.step.complete",
      runId,
      stepId: stepOf(records).id,
      attempt: stepOf(records).attempt,
      result: { kind: "boot", ok: true, detail: "boot clean" },
    });
    records = asked.records;
    const decision = stepOf(records);
    expect(runOf(records)).toMatchObject({ status: "waiting" });
    expect(runOf(records).pendingDecision?.question.kind).toBe("style");
    expect(asked.decision.effects.map((e) => [e.request.type, e.availableAt])).toEqual([
      ["game-run.decision.wake", undefined],
      ["game-run.decision.deadline", T0 + Policy.DECISION_DELIVERY_MS],
    ]);
    const decisionId = runOf(records).pendingDecision!.question.id;
    expect(refusal(records, { type: "game-run.decision.expire", runId, decisionId }).reason).toBe(
      "not-due",
    );
    // Presented a minute later: the answer's wait counts from there.
    records = accept(
      records,
      { type: "game-run.step.start", runId, stepId: decision.id },
      T0 + MIN,
    ).records;
    expect(runOf(records).pendingDecision?.deadline).toBe(T0 + MIN + Policy.DECISION_WAIT_MS);
    expect(
      refusal(records, { type: "game-run.decide", runId, decisionId, answer: "maybe" }).reason,
    ).toBe("invalid-answer");
    expect(
      refusal(records, { type: "game-run.decision.expire", runId, decisionId }, T0 + 3 * MIN)
        .reason,
    ).toBe("not-due");
    const expired = accept(
      records,
      { type: "game-run.decision.expire", runId, decisionId },
      T0 + MIN + Policy.DECISION_WAIT_MS,
    ).records;
    expect(runOf(expired).decided).toEqual([
      expect.objectContaining({ kind: "style", answer: "approve", by: "default" }),
    ]);
    expect(runOf(expired).status).toBe("running");
    expect(stepOf(expired).step).toMatchObject({ role: "proto-0" });
    // An answer that arrives after the default has nothing left to answer.
    expect(
      refusal(expired, { type: "game-run.decide", runId, decisionId, answer: "redo", notes: "x" })
        .reason,
    ).toBe("no-decision");
  });

  it("a stop ends the run, and nothing but a resume continues it", () => {
    const records = started();
    const { records: stopped, decision } = accept(records, {
      type: "game-run.stop",
      runId,
      reason: "lunch",
    });
    expect(decision.cancelEffects).toBe(true);
    expect(runOf(stopped)).toMatchObject({ status: "ended", ending: "stopped", inFlight: 1 });
    expect(stepOf(stopped).status).toBe("cancelled");
    // A job that finishes after the stop does not move the run.
    expect(
      refusal(stopped, {
        type: "game-run.step.complete",
        runId,
        stepId: gameRunStepId(runId, 1),
        attempt: 1,
        result: gitOk(),
      }).reason,
    ).toBe("run-ended");
    // A note waits for the resume.
    const noted = accept(stopped, { type: "game-run.steer", runId, note: "More enemies." }).records;
    expect(runOf(noted)).toMatchObject({
      status: "ended",
      ending: "stopped",
      steer: ["More enemies."],
    });
    expect(noted.steps).toHaveLength(1);
    expect(refusal(noted, { type: "game-run.profile.set", runId, profile: "guided" }).reason).toBe(
      "run-ended",
    );

    const resumed = accept(noted, { type: "game-run.resume", runId });
    expect(runOf(resumed.records)).toMatchObject({ status: "running", ending: null, inFlight: 1 });
    expect(stepOf(resumed.records).status).toBe("planned");
    expect(resumed.decision.effects.map((e) => e.request.type)).toEqual(["game-run.step.execute"]);
  });

  it("a note on a finished run buys one round", () => {
    const base = complete(started(), gitOk());
    const finished = {
      ...base,
      runs: [
        {
          ...runOf(base),
          status: "ended",
          ending: "done",
          inFlight: null,
          stage: "round-4",
          // The budget it had is long spent.
          budgetMinutes: 60,
          budgetEndsAt: T0 - MIN,
          ladder: {
            ...ladder,
            rungs: ladder.rungs.map((r) => ({ ...r, status: "done" as const })),
          },
        } satisfies GameRun,
      ],
    };
    const { records } = accept(finished, { type: "game-run.steer", runId, note: "Brighter sky." });
    expect(runOf(records)).toMatchObject({
      status: "running",
      ending: null,
      budgetEndsAt: T0 + 60 * MIN,
    });
    expect(stepOf(records).step).toMatchObject({ op: { _tag: "start-round" } });
    expect(stepOf(records).logs.join("\n")).toContain("finish round");
  });
});
