// PURE. Every loop decision: stage order, the ladder, round structure, keep or revert,
// stalls, the pending line, ship and budget. No I/O and no clock: time and randomness are inputs.
import type {
  GameBotDecider,
  GameRunBuildOutcome,
  GameRunSubmission,
  GameRunSubmissionKind,
  ThreadId,
} from "@kurambit/contracts";
import { laneProfile } from "../engineProfile.ts";
import { BuildName, keptBuild } from "./buildNames.ts";
import * as Roles from "./roles.ts";
import type * as State from "./state.ts";
import { BLANK, isStateCheck, ladderOf, parseLadder, rungOfChange } from "./state.ts";
import type {
  Block,
  BotFact,
  Compare,
  DecideStep,
  Decided,
  Decision,
  BuildOp,
  Evidence,
  Half,
  Judge,
  Ladder,
  PairStep,
  Pending,
  Picked,
  Played,
  RoleStep,
  Round,
  RoundRecord,
  Rung,
  RungResult,
  RunState,
  Sample,
  Side,
  Step,
  Task,
  Verdict,
} from "./state.ts";

const MIN = 60_000;
// A blind player that used less than half its input budget saw only the
// opening; a weak model often stops there, so judges never see late flaws.
const PLAY_FLOOR_MS = 60_000;
const CAP = {
  block: 25 * MIN,
  // A ladder round builds a whole rung, not one fix.
  rung: 45 * MIN,
  fullBuild: 40 * MIN,
  retry: 6 * MIN,
  vision: 10 * MIN,
  proto: 8 * MIN,
  plan: 5 * MIN,
  ladderFix: 4 * MIN,
  art: 20 * MIN,
  artReview: 6 * MIN,
  artRedo: 12 * MIN,
  tester: 12 * MIN,
  duty: 6 * MIN,
  judge: 6 * MIN,
  write: 2 * MIN,
  reviewer: 5 * MIN,
  ship: 7 * MIN,
};
// Both blind plays plus both comparator verdicts, uncorrected.
const COMPARE_MIN_MS = 2 * (CAP.judge + CAP.write) + 2 * CAP.write;
// The round's bot plays each build for up to this long in real time; one run's
// share adds a fresh checkout and engine import. Skipped when the budget lacks it.
const BOT_SECONDS = 150;
const BOT_RUN_MS = BOT_SECONDS * 1000 + 2 * MIN;
// A round needs its block plus tester, judging and review.
const ROUND_RESERVE_MS = 22 * MIN;
const FLOOR_MS = 2 * MIN;
// What the first full build needs after art; the art review and its redo
// run only when they leave the build its start.
const BUILD_RESERVE_MS = 24 * MIN;
const LADDER = Roles.LADDER_FILE;
// A rung that fails in this many rounds is set aside for the next.
const RUNG_TRIES = 2;
// A reviewer's insertions stop growing the ladder past this.
const LADDER_MAX = 10;

export type Inputs = { readonly now: number; readonly coin: number; readonly id: string };

export type RoleDone = State.RoleDone;
export type BuildOutcome = GameRunBuildOutcome;
export type StepResult = State.StepResult;

export type Planned =
  | {
      readonly kind: "step";
      readonly state: RunState;
      readonly step: Step;
      /** Decisions made while planning, for the run log. */
      readonly logs?: ReadonlyArray<string>;
    }
  | {
      readonly kind: "end";
      readonly reason: string;
      /** Why, for the run's lastFailure; absent keeps what the last round recorded. */
      readonly why?: string;
    };
export type Applied = {
  readonly state: RunState;
  readonly logs: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  /** Role threads with no turn left, whose copies the landing's outputs effect removes. */
  readonly release: ReadonlyArray<ThreadId>;
};

// ── What a role hands the run. ─────────────────────────────────────────────
type Submitted<K extends GameRunSubmissionKind> = Extract<GameRunSubmission, { readonly _tag: K }>;
const isKind = <K extends GameRunSubmissionKind>(
  submission: GameRunSubmission,
  kind: K,
): submission is Submitted<K> => submission._tag === kind;
/** The typed submission a role turn made, when it is the kind its step asks for. */
const submitted = <K extends GameRunSubmissionKind>(
  res: StepResult,
  kind: K,
): Submitted<K> | null =>
  res.kind === "done" && res.submission !== undefined && isKind(res.submission, kind)
    ? res.submission
    : null;
// Later roles and the creator read these files, so a submission lands there too.
const ladderJson = (rungs: Submitted<"ladder">["rungs"]) =>
  `${JSON.stringify({ rungs }, null, 2)}\n`;

// A tester's look-check results by their number in the rung; the run's own scoring covers state checks.
const submittedChecksOf = (sub: Submitted<"checks">, rung: Rung): Round["checks"] =>
  rung.checks.map((check, i) => {
    const said = sub.checks.findLast((c) => c.check === i + 1);
    return said === undefined
      ? { what: check.what, pass: false, evidence: "the tester submitted no result for this check" }
      : { what: check.what, pass: said.pass, evidence: said.evidence.slice(0, 400) };
  });

// ── Pure round decisions. ─────────────────────────────────────────────────
export type PairKind = "best-wins" | "candidate-wins" | "inconclusive" | "unjudged";

/** Order 1 is A=candidate, order 2 is A=best. The candidate must win both. */
export const classifyComparePair = (order1: string, order2: string): PairKind => {
  if (order1 === "B" && order2 === "A") return "best-wins";
  if (order1 === "NONE" || order2 === "NONE") return "unjudged";
  if (order1 === "A" && order2 === "B") return "candidate-wins";
  return "inconclusive";
};

/**
 * Three consecutive inconclusive rounds drop the pending line. Each of them is
 * already a stall (it landed nothing), so dropping it counts none of its own.
 */
export const advancePending = (
  current: Pending | null,
  branch: string,
  round: number,
  verdicts: ReadonlyArray<Verdict>,
  sha = "",
): Pending | null => {
  const streak = (current?.streak ?? 0) + 1;
  return streak >= 3 ? null : { branch, round, verdicts, streak, sha };
};

/**
 * Rounds in a row that land nothing, whatever the reason, before the run ends
 * "stalled": a broken game would otherwise work through every rung and its
 * retries (30 rounds on a full ladder) for nothing. A kept round resets it.
 */
export const STALL_LIMIT = 3;

/** Both builds need recorded hands-on input within the equal budget; null when usable. */
const validatePlayEvidence = (a: Evidence | null, b: Evidence | null): string | null => {
  if (a === null || b === null || a.executedInputSteps === 0 || b.executedInputSteps === 0)
    return "Both builds did not receive recorded hands-on input.";
  if (a.nominalMs > Roles.SAMPLE_INPUT_MS || b.nominalMs > Roles.SAMPLE_INPUT_MS)
    return `A play sample exceeded the equal ${Roles.SAMPLE_INPUT_MS / 1000}-second input budget.`;
  return null;
};

/** Budget left in ms; Infinity without a budget. */
const remaining = (state: RunState, now: number): number =>
  state.budgetEndsAt === null ? Number.POSITIVE_INFINITY : state.budgetEndsAt - now;

const fit = (state: RunState, now: number, cap: number, reserve: number): number =>
  Math.min(cap, remaining(state, now) - reserve);

// ── The ladder. ───────────────────────────────────────────────────────────
type RungPick =
  | {
      readonly kind: "rung";
      readonly ladder: Ladder;
      readonly rung: Rung;
      readonly logs: ReadonlyArray<string>;
    }
  | { readonly kind: "finish"; readonly why: string };

const LADDER_DONE = "the ladder is done";

// The first open rung, else a set-aside one back for its one more try, else the finish.
const pickRung = (ladder: Ladder): RungPick => {
  if (ladder.rungs.length === 0)
    return { kind: "finish", why: ladder.note || "the run has no ladder" };
  const open = ladder.rungs.find((x) => x.status === "todo");
  if (open !== undefined) return { kind: "rung", ladder, rung: open, logs: [] };
  const i = ladder.rungs.findIndex((x) => x.status === "set-aside" && !x.back);
  if (i < 0) return { kind: "finish", why: LADDER_DONE };
  const was = ladder.rungs[i]!;
  const rung: Rung = { ...was, status: "todo", fails: 0, back: true };
  return {
    kind: "rung",
    ladder: { ...ladder, rungs: ladder.rungs.with(i, rung) },
    rung,
    logs: [`rung ${i + 1} comes back after the rest of the ladder (set aside: ${was.why})`],
  };
};

const rungOf = (state: RunState, r: Pick<Round, "rung">): Rung | null =>
  r.rung === null ? null : (state.ladder?.rungs.find((x) => x.id === r.rung) ?? null);
const positionOf = (ladder: Ladder, rung: Rung): number =>
  ladder.rungs.findIndex((x) => x.id === rung.id) + 1;
const checkLine = (checks: Round["checks"]): string =>
  checks.map((c, i) => `${i + 1} ${c.pass ? "PASS" : "FAIL"}`).join(", ");
const checksPassed = (r: Round, rung: Rung): boolean =>
  r.checks.length === rung.checks.length && r.checks.every((c) => c.pass);
const ladderText = (ladder: Ladder, current: number | null): string =>
  ladder.rungs
    .map((x, i) => `${i + 1}. [${x.id === current ? "this round" : x.status}] ${x.is}`)
    .join("\n");

// Why the last round on this rung did not land it, for the next attempt's direction.
// A retry right after a try that booted and passed some of its checks grows that
// work instead of rebuilding from the best: the best has not moved since, and the
// blind gate still judges the result against the best.
const retryFrom = (state: RunState, rung: Rung): string | null => {
  const last = state.rounds.at(-1);
  const result = last?.rung;
  if (last === undefined || result === undefined || result.rung !== rung.id) return null;
  if (result.outcome !== "failed" || !result.checks.some((c) => c.pass)) return null;
  return last.build !== undefined && last.build.length > 0 ? last.build : null;
};

// Fix turns a builder gets in one round when state checks fail, and how long each runs.
const MAX_FIXES = 2;
const FIX_MS = 12 * MIN;

const lastTryOf = (state: RunState, r: Round): string => {
  const rung = rungOf(state, r);
  return rung === null ? "" : lastTry(state, rung);
};

const lastTry = (state: RunState, rung: Rung): string => {
  const last = state.rounds.findLast((x) => x.rung?.rung === rung.id);
  return last?.rung === undefined || last.rung.outcome === "landed"
    ? ""
    : `round ${last.round}, branch ${last.branch}: ${last.rung.why}`;
};

// A plan turn that ended without a ladder left its work unfinished.
const MISSING_LADDER = "no ladder was submitted";
type Taken =
  | { readonly kind: "ladder"; readonly ladder: Ladder }
  | { readonly kind: "fix"; readonly thread: ThreadId; readonly error: string };

// One fix turn for a ladder of the wrong shape; after it the run goes on without one.
const takeLadder = (
  res: StepResult,
  last: boolean,
  logs: string[],
  files: Array<{ path: string; text: string }>,
): Taken => {
  const sub = submitted(res, "ladder");
  // A missing ladder is unfinished work; game-run.submit refused any of the wrong shape.
  const parsed = sub !== null ? ladderOf(sub.rungs) : { error: MISSING_LADDER };
  if ("ladder" in parsed && sub !== null) files.push({ path: LADDER, text: ladderJson(sub.rungs) });
  if ("ladder" in parsed) {
    logs.push(
      `ladder: ${parsed.ladder.rungs.length} rungs`,
      ...parsed.ladder.rungs.map((x, i) => `  rung ${i + 1}: ${x.is}`),
    );
    return { kind: "ladder", ladder: parsed.ladder };
  }
  if (!last && res.kind === "done") {
    logs.push(`ladder: none submitted; one fix turn (${parsed.error.slice(0, 200)})`);
    return { kind: "fix", thread: res.threadId, error: parsed.error };
  }
  logs.push(`ladder: no valid ladder (${parsed.error.slice(0, 200)}); finish rounds only`);
  return {
    kind: "ladder",
    ladder: { rungs: [], note: `the plan wrote no valid ladder: ${parsed.error}`.slice(0, 300) },
  };
};

// A round's end settles its rung: landed when kept, else one more failure, and
// the RUNG_TRIES-th sets it aside so the next rung starts.
const settleRung = (
  state: RunState,
  r: Round,
  record: RoundRecord,
  logs: string[],
): { state: RunState; record: RoundRecord } => {
  const ladder = state.ladder;
  const rung = rungOf(state, r);
  if (ladder === null || rung === null) return { state, record };
  const tested = r.checks.length > 0;
  const checks = tested
    ? r.checks
    : rung.checks.map((c) => ({ what: c.what, pass: false, evidence: "not tested" }));
  const failed = checks.filter((c) => !c.pass);
  const why = record.kept
    ? ""
    : (tested && failed.length > 0
        ? `checks failed: ${failed.map((c) => `${c.what} (${c.evidence || "no evidence"})`).join("; ")}`
        : (record.note ?? "not kept")
      ).slice(0, 500);
  const fails = record.kept ? rung.fails : rung.fails + 1;
  const outcome = record.kept ? "landed" : fails >= RUNG_TRIES ? "set-aside" : "failed";
  const k = positionOf(ladder, rung);
  logs.push(
    outcome === "landed"
      ? `round ${r.n}: rung ${k} landed (checks ${checkLine(checks)})`
      : outcome === "set-aside"
        ? `round ${r.n}: rung ${k} set aside after ${fails} rounds that did not land it: ${why}`
        : `round ${r.n}: rung ${k} not landed (${fails} of ${RUNG_TRIES} tries): ${why}`,
  );
  const settled: Rung = {
    ...rung,
    fails,
    status: outcome === "landed" ? "done" : outcome === "set-aside" ? "set-aside" : "todo",
    why: outcome === "set-aside" ? why : rung.why,
  };
  const result: RungResult = { rung: rung.id, is: rung.is, checks, outcome, why };
  return {
    state: {
      ...state,
      ladder: { ...ladder, rungs: ladder.rungs.map((x) => (x.id === rung.id ? settled : x)) },
    },
    record: { ...record, rung: result },
  };
};

// A reviewer's one ladder change goes in as the next rung; one open at a time.
// Why the ladder takes no reviewer's rung now, or null when it does.
const insertionRefused = (ladder: Ladder): string | null =>
  ladder.rungs.some((x) => x.from === "reviewer" && x.status === "todo")
    ? "an earlier one is still open"
    : ladder.rungs.length >= LADDER_MAX
      ? `the ladder already has ${LADDER_MAX} rungs`
      : null;

const insertRung = (
  ladder: Ladder,
  change: (id: number) => ReturnType<typeof rungOfChange> | null,
  n: number,
  logs: string[],
): Ladder => {
  const parsed = change(Math.max(0, ...ladder.rungs.map((x) => x.id)) + 1);
  if (parsed === null) return ladder;
  const refused = "error" in parsed ? `wrong shape (${parsed.error})` : insertionRefused(ladder);
  if (refused !== null || "error" in parsed) {
    logs.push(`round ${n}: the reviewer's ladder change was not taken: ${refused}`);
    return ladder;
  }
  const at = ladder.rungs.findIndex((x) => x.status === "todo");
  logs.push(`round ${n}: the reviewer added the next rung (${parsed.rung.why}): ${parsed.rung.is}`);
  return {
    ...ladder,
    rungs: at < 0 ? [...ladder.rungs, parsed.rung] : ladder.rungs.toSpliced(at, 0, parsed.rung),
  };
};

/** Why the run would not take a reviewer's ladder change now, or null when it would. */
export const rungChangeRefused = (
  state: RunState,
  change: Parameters<typeof rungOfChange>[0],
): string | null => {
  const t = state.task;
  if (t._tag !== "round" || t.rung === null || state.ladder === null)
    return "this round builds no rung, so it takes no ladder change";
  const rung = rungOfChange(change, 0);
  if ("error" in rung) return `the rung has the wrong shape (${rung.error})`;
  return insertionRefused(state.ladder);
};

// ── Creator decisions (Guided). ───────────────────────────────────────────
/** How long a Guided run waits for an answer once its question reached the creator's agent. */
export const DECISION_WAIT_MS = 3 * MIN;
/** How long a question may wait behind a busy creator chat before the run takes its default. */
export const DECISION_DELIVERY_MS = 10 * MIN;
// Answers that send work back once; each needs the creator's notes.
const ONCE = { style: "redo", prototype: "retry", ladder: "rewrite" } as const;

const protoFiles = (i: number) => ({
  pitch: `.studio/proto-${i}.md`,
  sheet: `.studio/proto-${i}-frames.jpg`,
});
const protoName = (i: number) => `Prototype ${i + 1}`;
const usedOnce = (s: RunState, kind: Decision["kind"]) =>
  s.decided.some((d) => d.kind === kind && d.answer === ONCE[kind]);
const decisionId = (s: RunState, kind: Decision["kind"]) => `${kind}-${s.decided.length + 1}`;

const styleDecision = (s: RunState): Decision => ({
  id: decisionId(s, "style"),
  kind: "style",
  ask: "Is this the look and the game the creator wants before the prototypes start?",
  evidence: [{ label: "Vision", path: "VISION.md" }],
  text: "",
  answers: [
    { answer: "approve", means: "Keep this vision and look; the run builds two prototypes next." },
    ...(usedOnce(s, "style")
      ? []
      : [
          {
            answer: "redo",
            means:
              "The vision is made once more with the creator's notes (required), then asked again.",
          },
        ]),
  ],
  fallback: "approve",
  waitMs: DECISION_WAIT_MS,
});

const prototypeDecision = (
  s: RunState,
  booted: ReadonlyArray<{ readonly branch: string; readonly i: number }>,
): Decision => ({
  id: decisionId(s, "prototype"),
  kind: "prototype",
  ask: "Which prototype should the game continue from?",
  evidence: booted.flatMap((p) => [
    { label: `${protoName(p.i)}: its pitch`, path: protoFiles(p.i).pitch },
    { label: `${protoName(p.i)}: frames from its own play`, path: protoFiles(p.i).sheet },
  ]),
  text: booted.map((p) => `${protoName(p.i)} is kept as build ${p.branch}.`).join("\n"),
  answers: [
    ...booted.map((p) => ({
      answer: `pick-${p.i + 1}`,
      means: `Continue from ${protoName(p.i)}. Notes, if any, say what to take from the other one; they lead the first full build.`,
      branch: p.branch,
    })),
    ...(usedOnce(s, "prototype")
      ? []
      : [
          {
            answer: "retry",
            means:
              "One more pair of prototypes, made with the creator's notes (required), then asked again.",
          },
        ]),
    { answer: "run", means: "Let the run's blind comparison of the two pick." },
  ],
  fallback: "run",
  waitMs: DECISION_WAIT_MS,
});

const ladderDecision = (s: RunState, ladder: Ladder): Decision => ({
  id: decisionId(s, "ladder"),
  kind: "ladder",
  ask: "Is this the ladder the creator wants the run to build, rung by rung?",
  evidence: [
    { label: "Plan", path: "PLAN.md" },
    { label: "Ladder", path: LADDER },
  ],
  text: ladder.rungs
    .map((r, i) => `${i + 1}. ${r.is}\n${r.checks.map((c) => `   - ${c.what}`).join("\n")}`)
    .join("\n"),
  answers: [
    { answer: "approve", means: "Build this ladder as written." },
    {
      answer: "edit",
      means:
        'Replace the ladder: notes hold the full ladder as JSON {"rungs":[{"is":"...","checks":[{"what":"...","how":"..."}]}]}, 4 to 7 rungs with 2 to 4 checks each.',
    },
    ...(usedOnce(s, "ladder")
      ? []
      : [
          {
            answer: "rewrite",
            means:
              "The plan rewrites the ladder once with the creator's notes (required), then asks again.",
          },
        ]),
  ],
  fallback: "approve",
  waitMs: DECISION_WAIT_MS,
});

/** The creator's answer as the run takes it, or why it is refused. */
export const checkAnswer = (
  d: Decision,
  answer: string,
  notes: string,
): { readonly answer: string; readonly notes: string } | { readonly error: string } => {
  const a = answer.trim().toLowerCase();
  const n = notes.trim();
  if (!d.answers.some((x) => x.answer === a))
    return {
      error: `"${answer}" is not an answer to decision ${d.id}; answer one of: ${d.answers.map((x) => x.answer).join(", ")}.`,
    };
  if (a === ONCE[d.kind] && n.length === 0)
    return { error: `${a} needs notes: what the creator wants changed, in their words.` };
  if (d.kind === "ladder" && a === "edit") {
    const parsed = parseLadder(n);
    if ("error" in parsed) return { error: `The ladder in notes was refused: ${parsed.error}` };
    return { answer: a, notes: n };
  }
  return { answer: a, notes: n.slice(0, 4000) };
};

export type DecisionWait =
  | { readonly kind: "send" }
  | { readonly kind: "deliver" }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "default" };

/** Where a decide step's wait stands: a resumed step waits only what is left of it. */
export const decisionWait = (step: DecideStep, now: number): DecisionWait => {
  if (step.sent === null) return { kind: "send" };
  if (step.deadline === null)
    return now - step.sent >= DECISION_DELIVERY_MS ? { kind: "default" } : { kind: "deliver" };
  return step.deadline > now ? { kind: "wait", ms: step.deadline - now } : { kind: "default" };
};

// The blind pick of the booted prototypes, as an Autopilot run (or a creator's "run") takes it.
const startPick = (
  s: RunState,
  booted: ReadonlyArray<string>,
  input: Inputs,
  logs: string[],
): RunState => {
  const pick = (cmp: Compare, chosen: string, phase: "compare" | "adopt"): RunState => ({
    ...s,
    task: { _tag: "pick", phase, cmp, chosen, notes: "", comparison: "" },
  });
  if (booted.length >= 2) {
    // Labels, play order and report presentation are randomized independently.
    const [a, b] = bit(input.coin, 0) ? [booted[1]!, booted[0]!] : [booted[0]!, booted[1]!];
    return pick(newCompare(Roles.PICK_QUESTION, a, b, bit(input.coin, 1), ["x"]), "", "compare");
  }
  if (booted.length === 1) return pick(newCompare("", "", "", true, []), booted[0]!, "adopt");
  logs.push("pick: no prototype booted; building from the base");
  return proceed(s, "pick", input.now);
};

/** A decision's answer, or its default when `taken` is null, moves the run on. */
const decide = (
  state: RunState,
  d: Decision,
  taken: { readonly answer: string; readonly notes: string; readonly by: Decided["by"] } | null,
  input: Inputs,
  logs: string[],
): RunState => {
  // Anything the checks would refuse is the default: the run never stops on an answer.
  const checked = taken === null ? null : checkAnswer(d, taken.answer, taken.notes);
  const ok = checked !== null && "answer" in checked && taken !== null;
  const answer = ok ? checked.answer : d.fallback;
  const notes = ok ? checked.notes : "";
  const by = ok ? taken.by : "default";
  logs.push(
    by === "creator"
      ? `creator decided ${d.kind}: ${answer}${notes.length > 0 ? ` (${notes.slice(0, 200)})` : ""}`
      : `${d.kind}: no answer from the creator; the run takes its default, ${answer}`,
  );
  const s: RunState = {
    ...state,
    decided: [...state.decided, { id: d.id, kind: d.kind, answer, notes, by }],
  };
  switch (d.kind) {
    case "style":
      return answer === "redo"
        ? { ...s, task: { ...stageTask("vision"), phase: "revise", review: notes } }
        : proceed(s, "vision", input.now);
    case "ladder": {
      // The plan stage asks after writing the ladder (stage "plan"); a run that
      // reached its rounds without one asks after the rounds' ladder task, and
      // its answer leads back to the rounds, never to the stages.
      const inRounds = s.stage !== "plan";
      if (answer === "rewrite")
        return inRounds
          ? { ...s, task: { _tag: "ladder", phase: "revise", thread: null, error: "", notes } }
          : { ...s, task: { ...stageTask("plan"), phase: "revise", review: notes } };
      const edited = answer === "edit" ? parseLadder(notes) : null;
      const next = edited !== null && "ladder" in edited ? { ...s, ladder: edited.ladder } : s;
      return inRounds
        ? { ...next, task: newRound(next, input.now) }
        : proceed(next, "plan", input.now);
    }
    case "prototype": {
      if (answer === "retry") {
        const retries = s.decided.filter((x) => x.kind === "prototype" && x.answer === "retry");
        return { ...s, protos: [], task: { ...protoTask(2 * retries.length), notes } };
      }
      const chosen = d.answers.find((x) => x.answer === answer)?.branch;
      if (answer === "run" || chosen === undefined)
        return startPick(
          s,
          s.protos.filter((p) => p.booted).map((p) => p.branch),
          input,
          logs,
        );
      const others = d.answers.flatMap((x) =>
        x.branch === undefined || x.branch === chosen ? [] : [x.branch],
      );
      return {
        ...s,
        pickNotes: "",
        buildNotes:
          notes.length > 0
            ? `The creator picked this prototype and asked to take this from the other one (branch ${others.join(", ")}; read its code with git show): ${notes}`
            : "",
        task: {
          _tag: "pick",
          phase: "adopt",
          cmp: newCompare("", "", "", true, []),
          chosen,
          notes: "",
          comparison: "",
        },
      };
    }
  }
};

// ── Step builders. ────────────────────────────────────────────────────────
type RoleSpec = Partial<Omit<RoleStep, "kind" | "id" | "role" | "prompt" | "capMs">> &
  Pick<RoleStep, "role" | "prompt" | "capMs">;
const role = (id: number, spec: RoleSpec): RoleStep => ({
  kind: "role",
  id,
  title: `studio ${spec.role}`,
  thread: null,
  at: null,
  read: [],
  clear: [],
  source: false,
  bots: false,
  release: false,
  copy: [],
  sheet: "",
  inputCapMs: 0,
  ...spec,
});
const build = (id: number, op: BuildOp): Step => ({ kind: "build", id, op });
/** A prototype's label names its build; anything else already is one (a checkpoint oid). */
const buildOf = (state: RunState, name: string): string =>
  state.protos.find((p) => p.branch === name)?.sha ?? name;
const ladderSpec = (t: Extract<Task, { _tag: "ladder" }>): RoleSpec =>
  t.phase === "write"
    ? {
        role: "plan",
        title: "studio ladder",
        prompt: Roles.ladderWrite(),
        capMs: CAP.plan,
      }
    : t.phase === "revise"
      ? {
          role: "plan",
          title: "studio ladder",
          prompt: Roles.ladderRevise(t.notes ?? ""),
          capMs: CAP.plan,
        }
      : {
          role: "plan",
          title: "studio ladder",
          thread: t.thread,
          prompt: Roles.ladderFix(),
          capMs: CAP.ladderFix,
        };
const bit = (coin: number, k: number) => Math.floor(coin * 2 ** (k + 1)) % 2 === 1;

// `base`: the build the block starts from, which its first turn's change is measured against.
const newBlock = (
  tag: string,
  direction: string,
  whole: boolean,
  msLeft: number,
  base: string,
): Block => ({
  tag,
  direction,
  whole,
  msLeft,
  thread: null,
  quiet: 0,
  source: base,
  turns: 0,
});

const blockStep = (id: number, b: Block, lane: string): Step =>
  role(id, {
    role: `builder-${b.tag}`,
    title: `studio builder ${b.tag}`,
    thread: b.thread,
    prompt:
      b.thread === null
        ? Roles.builderFirst(b.whole, lane, b.direction)
        : Roles.builderMore(Math.max(1, Math.round(b.msLeft / MIN)), b.direction),
    capMs: b.msLeft,
    source: true,
    // Each turn's landing captures the folder and measures it against the last.
    since: b.source,
  });

/** A finished turn may need follow-up, but a turn without a game-file change ends the block. */
const advanceBlock = (b: Block, res: RoleDone): { block: Block; over: boolean } => {
  // A turn whose change could not be measured counts as a change.
  const quiet = res.changed === false ? b.quiet + 1 : 0;
  const msLeft = b.msLeft - res.elapsedMs;
  const block = {
    ...b,
    thread: res.threadId,
    quiet,
    source: res.sourceAfter,
    turns: b.turns + 1,
    msLeft,
  };
  return { block, over: quiet >= 1 || res.timedOut || msLeft < FLOOR_MS };
};

// ── Blind comparison. ─────────────────────────────────────────────────────
const newCompare = (
  question: string,
  x: string,
  y: string,
  xFirst: boolean,
  orders: Side[],
  bot = "",
  botDecider: GameBotDecider = "policy",
): Compare => ({
  question,
  x,
  y,
  xFirst,
  orders,
  samples: [],
  bot,
  botDecider,
  bots: [],
  botWithheld: "",
  judges: [],
  reused: null,
});
const lastSample = (c: Compare, side: Side): Sample | null =>
  c.samples.findLast((s) => s.side === side) ?? null;
const usable = (s: Sample | null) =>
  s !== null && s.phase === "done" && validatePlayEvidence(s.evidence, s.evidence) === null;
const sampleFile = (s: Pick<Sample, "label">) => `.studio/play-${s.label}.md`;

// A held play stands in for a fresh one only when a fresh player would be the same:
// the same budget, model (a run without one uses its creator chat's) and
// instructions. Otherwise a stale report's voice or strictness could tell judges
// which side is old, or skew the verdict.
const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
};
const playerKey = (s: RunState, question: string) =>
  `input ${Roles.SAMPLE_INPUT_MS} ms, floor ${PLAY_FLOOR_MS} ms, turn ${CAP.judge} ms; player ${s.provider ?? ""}/${s.model ?? ""}/${s.variant ?? ""} via ${s.model === null ? s.creator : ""}; prompt ${fnv(Roles.samplePlay(question, ""))}`;
const reusable = (s: Sample) => usable(s) && s.notes.trim().length > 0;

// The blind play a kept round's merge may carry to the new best: the
// candidate's own when it was judged, else the one the best already holds
// (a rung the current build already met). The merge checks the build.
const heldPlay = (s: RunState, r: Round): Played | null => {
  const mine = r.cmp === null ? null : lastSample(r.cmp, "x");
  if (r.cmp !== null && mine !== null && reusable(mine))
    return {
      sha: r.cmp.x,
      question: r.cmp.question,
      budget: playerKey(s, r.cmp.question),
      round: r.n,
      branch: r.branch,
      sample: mine,
    };
  return s.played !== null && s.played.sha === s.best ? s.played : null;
};

// A ladder gate on a best whose own blind play is held under the same
// question and budget plays only the candidate. A finish round asks its own
// question, so it never reuses.
const gateCompare = (s: RunState, r: Round, c: Compare, logs: string[]): Compare => {
  const held = s.played;
  if (
    r.rung === null ||
    held === null ||
    held.sha !== s.best ||
    held.question !== c.question ||
    held.budget !== playerKey(s, c.question) ||
    !reusable(held.sample)
  )
    return c;
  logs.push(
    `round ${r.n}: the best is the build round ${held.round}'s blind player saw under this question; its play is reused and only the candidate is played`,
  );
  return {
    ...c,
    samples: [{ ...held.sample, side: "y" }],
    reused: { side: "y", round: held.round, branch: held.branch },
  };
};
// The game root keeps each comparator's write-up here once the comparison is over.
const judgeFile = (j: Pick<Judge, "id">) => `.studio/comparisons/${j.id}.md`;
const sheetFile = (s: Pick<Sample, "label">) => `.studio/comparisons/frames-${s.label}.jpg`;
// A comparator sees only these names in its own BLANK worktree; none carries a
// label, judge id or sha, and A and B follow its order, not the builds.
const SHEET = { a: ".compare/sheet-a.jpg", b: ".compare/sheet-b.jpg" } as const;

type SampleMove = { readonly side: Side; readonly current: Sample | null };
type CompareMove =
  | { readonly kind: "samples"; readonly moves: ReadonlyArray<SampleMove> }
  | { readonly kind: "bots"; readonly sides: ReadonlyArray<Side> }
  | { readonly kind: "judge"; readonly aIs: Side; readonly current: Judge | null }
  | { readonly kind: "done"; readonly gate: string | null };

// Each build is played once with equal caps; a sample without usable evidence
// is replayed once. The round's bot then plays each build, and each order gets
// a fresh comparator, a missing verdict one fresh retry on the same reports.
// The two builds' plays (and bot runs) are independent, so each side's next
// one is returned, in the comparison's random play order.
const compareMove = (c: Compare): CompareMove => {
  const moves = (c.xFirst ? (["x", "y"] as const) : (["y", "x"] as const)).flatMap(
    (side): SampleMove[] => {
      const entries = c.samples.filter((s) => s.side === side);
      const last = entries.at(-1) ?? null;
      if (last === null) return [{ side, current: null }];
      if (last.phase !== "done") return [{ side, current: last }];
      if (!usable(last) && entries.length === 1) return [{ side, current: null }];
      return [];
    },
  );
  if (moves.length > 0) return { kind: "samples", moves };
  const gate = validatePlayEvidence(
    lastSample(c, "x")?.evidence ?? null,
    lastSample(c, "y")?.evidence ?? null,
  );
  if (gate !== null) return { kind: "done", gate };
  const sides = (["x", "y"] as const).filter((side) => !c.bots.some((b) => b.side === side));
  if (c.bot.length > 0 && c.botWithheld === "" && sides.length > 0) return { kind: "bots", sides };
  for (const aIs of c.orders) {
    const entries = c.judges.filter((j) => j.aIs === aIs);
    const last = entries.at(-1) ?? null;
    if (last === null) return { kind: "judge", aIs, current: null };
    if (last.phase !== "done") return { kind: "judge", aIs, current: last };
    if (last.verdict === "NONE" && entries.length === 1)
      return { kind: "judge", aIs, current: null };
  }
  return { kind: "done", gate: null };
};

// The pick's comparator wrote blind, about "A" and "B"; the builders who read
// its notes afterwards need to know which of those the game became.
const pickLegend = (chosen: string) =>
  `(In these notes, ${chosen} is the prototype the game continued from, now on main; ${chosen === "A" ? "B" : "A"} is the one set aside.)`;

const finalJudge = (c: Compare, aIs: Side): Judge | null => {
  const [first, retry] = c.judges.filter((j) => j.aIs === aIs);
  return retry !== undefined && retry.verdict !== "NONE" ? retry : (first ?? null);
};

// Comparators see bot facts only when the bot ran on both builds: a bot that
// fails on one build would name that build, and the bot is the candidate's tester's.
const botsShown = (c: Compare): boolean =>
  c.bot.length > 0 && c.botWithheld === "" && c.bots.length === 2;
const botReport = (c: Compare, side: Side): string => {
  const f = c.bots.find((b) => b.side === side);
  if (!botsShown(c) || f === undefined) return "";
  return `\nBot facts: the scripted bot played this build for up to ${BOT_SECONDS} seconds of real time and ended ${f.ending} after ${f.seconds.toFixed(0)} seconds of game time${f.note.length > 0 ? ` (${f.note})` : ""}. Final probe values: ${JSON.stringify(f.final)}.${c.bots.every((b) => b.perf !== undefined) ? nodeCounts(f) : ""}`;
};

// Like bot facts, frame sheets reach the comparators only when both players have
// one, so a missing sheet never marks a build.
const sheetsShown = (c: Compare): boolean =>
  (["x", "y"] as const).every((side) => (lastSample(c, side)?.sheet ?? "") !== "");

// Shown only when both builds have counts, so a missing line never names a build.
const nodeCounts = (f: BotFact): string =>
  f.perf === undefined
    ? ""
    : ` Scene nodes: ${f.perf.nodesStart} at boot, ${f.perf.nodesPeak} at peak, ${f.perf.nodesEnd} at the end; ${f.perf.orphansEnd} orphan nodes (out of the tree, not freed) at the end. A build that reached more of the game is expected to have more nodes; many orphans, or nodes far above what the visible play needs, suggest something spawned and was not freed.`;

// Judges discount a verdict when one build was played much longer than the
// other. A sample about to write up that played well short of the other
// side's finished play takes its one extra turn now (the same neutral prompt
// as the floor's), unless it already had one.
const CATCH_UP_MS = 20_000;
const catchUp = (samples: ReadonlyArray<Sample>, logs: string[]): ReadonlyArray<Sample> => {
  let out = samples;
  for (const side of ["x", "y"] as const) {
    const mi = out.findLastIndex((s) => s.side === side);
    const oi = out.findLastIndex((s) => s.side !== side);
    if (mi < 0 || oi < 0) continue;
    const mine = out[mi]!;
    const other = out[oi]!;
    if (mine.phase !== "write" || mine.extra) continue;
    if (other.phase !== "write" && other.phase !== "done") continue;
    const played = mine.evidence?.nominalMs ?? 0;
    const theirs = other.evidence?.nominalMs ?? 0;
    if (
      theirs - played > Math.max(CATCH_UP_MS, theirs * 0.25) &&
      played < Roles.SAMPLE_INPUT_MS - CATCH_UP_MS
    ) {
      logs.push(
        `sample ${mine.label} plays on: ${Math.round(played / 1000)} s against ${Math.round(theirs / 1000)} s`,
      );
      out = out.with(mi, { ...mine, phase: "more", extra: true });
    }
  }
  return out;
};

// One play turn of one side's sample: its first play, the floor's one extra
// turn, or the write-up. Both sides get the same prompt, caps and input budget.
const sampleStep = (
  id: number,
  c: Compare,
  move: SampleMove,
  label: string,
  resolve: (name: string) => string,
): { sample: Sample | null; step: RoleStep } => {
  const at = resolve(move.side === "x" ? c.x : c.y);
  if (move.current === null) {
    const s: Sample = {
      side: move.side,
      label,
      thread: null,
      phase: "play",
      notes: "",
      evidence: null,
      sheet: "",
      extra: false,
    };
    const step = role(id, {
      role: `sample-${s.label}`,
      title: "studio sample",
      at,
      prompt: Roles.samplePlay(c.question, sampleFile(s)),
      capMs: CAP.judge,
      inputCapMs: Roles.SAMPLE_INPUT_MS,
    });
    return { sample: s, step };
  }
  const s = move.current;
  if (s.phase === "more")
    return {
      sample: null,
      step: role(id, {
        role: `sample-${s.label}`,
        title: "studio sample",
        thread: s.thread,
        at,
        prompt: Roles.sampleMore(Math.round((s.evidence?.nominalMs ?? 0) / 1000), sampleFile(s)),
        capMs: CAP.judge,
        inputCapMs: Roles.SAMPLE_INPUT_MS,
      }),
    };
  const step = role(id, {
    role: `sample-${s.label}`,
    title: "studio sample",
    thread: s.thread,
    at,
    prompt: Roles.sampleWrite(sampleFile(s)),
    capMs: CAP.write,
    // After a restart only this turn re-registers the thread's cap, and a
    // model that plays on here would void the sample.
    inputCapMs: Roles.SAMPLE_INPUT_MS,
    release: true,
    sheet: sheetFile(s),
  });
  return { sample: null, step };
};

const sideOf = (c: Compare, half: Half): Side | null => {
  if (half.kind === "bot")
    return (["x", "y"] as const).find((side) => (side === "x" ? c.x : c.y) === half.sha) ?? null;
  return c.samples.find((s) => half.role === `sample-${s.label}`)?.side ?? null;
};

// Two halves become one pair step in x-then-y order; a lone half is itself.
const pairOf = (c: Compare, id: number, halves: ReadonlyArray<Half>): Step => {
  const [a, b] = halves;
  if (b === undefined) return a!;
  return { kind: "pair", id, halves: sideOf(c, a!) === "y" ? [b, a!] : [a!, b], results: [] };
};

const compareStep = (
  id: number,
  c: Compare,
  input: Inputs,
  state: RunState,
): { cmp: Compare; step: Step; logs: string[] } => {
  const move = compareMove(c);
  const parallel = laneProfile(state.lane).run.parallelSamples;
  if (move.kind === "bots") {
    // Decided here, after the plays and their replays: the runs still owed
    // must fit and leave both verdicts their time.
    const sides = parallel ? move.sides : move.sides.slice(0, 1);
    const owed = (parallel ? 1 : move.sides.length) * BOT_RUN_MS;
    if (fit(state, input.now, owed, 2 * CAP.write) < owed) {
      const why = "the budget leaves no time for the bot runs";
      const next = compareStep(id, { ...c, botWithheld: why }, input, state);
      return {
        ...next,
        logs: [`bot facts withheld: ${why}; judging on play reports`, ...next.logs],
      };
    }
    const halves = sides.map((side, i): Half => ({
      kind: "bot",
      id: id + i,
      sha: buildOf(state, side === "x" ? c.x : c.y),
      file: c.bot,
      decider: c.botDecider,
      seconds: BOT_SECONDS,
    }));
    return { cmp: c, step: pairOf(c, id + halves.length - 1, halves), logs: [] };
  }
  if (move.kind === "samples") {
    // Ids and labels follow the play order, which is a coin, never x and y.
    let fresh = 0;
    const made = (parallel ? move.moves : move.moves.slice(0, 1)).map((m, i) =>
      sampleStep(
        id + i,
        c,
        m,
        m.current === null && fresh++ > 0 ? `${input.id}b` : input.id,
        (name) => buildOf(state, name),
      ),
    );
    const cmp = {
      ...c,
      samples: [...c.samples, ...made.flatMap((m) => (m.sample === null ? [] : [m.sample]))],
    };
    return {
      cmp,
      step: pairOf(
        cmp,
        id + made.length - 1,
        made.map((m) => m.step),
      ),
      logs: [],
    };
  }
  if (move.kind === "judge") {
    if (move.current === null) {
      const j: Judge = {
        aIs: move.aIs,
        id: input.id,
        attempt: c.judges.filter((entry) => entry.aIs === move.aIs).length,
        aFirst: bit(input.coin, 0),
        thread: null,
        phase: "compare",
        verdict: "NONE",
        reason: "",
        notes: "",
      };
      const report = (side: Side) => {
        const s = lastSample(c, side);
        return `Recorded play: ${JSON.stringify(s?.evidence ?? null)}\n${s?.notes ?? ""}${botReport(c, side)}`;
      };
      const other: Side = move.aIs === "x" ? "y" : "x";
      const sheets = sheetsShown(c);
      const step = role(id, {
        role: `compare-${j.id}`,
        title: "studio blind comparison",
        at: BLANK,
        copy: sheets
          ? [
              { from: lastSample(c, move.aIs)!.sheet, to: SHEET.a },
              { from: lastSample(c, other)!.sheet, to: SHEET.b },
            ]
          : [],
        prompt: Roles.compare(
          c.question,
          report(move.aIs),
          report(other),
          j.aFirst,
          botsShown(c),
          sheets ? SHEET : null,
        ),
        capMs: CAP.write,
      });
      return { cmp: { ...c, judges: [...c.judges, j] }, step, logs: [] };
    }
    const j = move.current;
    const step = role(id, {
      role: `compare-${j.id}`,
      title: "studio blind comparison",
      thread: j.thread,
      at: BLANK,
      prompt: Roles.correct(),
      capMs: CAP.write,
    });
    return { cmp: c, step, logs: [] };
  }
  throw new Error("compareStep called on a finished comparison");
};

const applyCompare = (
  c: Compare,
  done: Step,
  res: StepResult,
  logs: string[],
  release: ThreadId[],
): Compare => {
  if (res.kind === "bot") {
    // The step names its build; both builds may be one sha, then either side is it.
    const side = (["x", "y"] as const).find(
      (each) =>
        !c.bots.some((b) => b.side === each) &&
        (done.kind !== "bot" || (each === "x" ? c.x : c.y) === done.sha),
    );
    if (side === undefined) return c;
    const bots = [...c.bots, { side, ...res.fact }];
    if (res.fact.ending !== "error" || c.botWithheld !== "") return { ...c, bots };
    // Either build failing withholds both reports' facts; a serial run skips the other.
    const botWithheld = `the bot could not run on ${(side === "x" ? c.x : c.y).slice(0, 12)}: ${res.fact.note || "no detail"}`;
    logs.push(`bot facts withheld from both reports: ${botWithheld}`);
    return { ...c, bots, botWithheld };
  }
  // Two samples may be in flight at once; the step's role names its own.
  const si = c.samples.findIndex(
    (s) => s.phase !== "done" && (done.kind !== "role" || done.role === `sample-${s.label}`),
  );
  if (si >= 0) {
    const s = c.samples[si]!;
    const next: Sample =
      res.kind !== "done"
        ? { ...s, phase: "done", notes: "", evidence: null }
        : s.phase === "play"
          ? {
              ...s,
              thread: res.threadId,
              // Evidence is cumulative per thread, so the second turn adds to it.
              ...(res.evidence !== null && res.evidence.nominalMs < PLAY_FLOOR_MS
                ? { phase: "more" as const, extra: true }
                : { phase: "write" as const }),
              evidence: res.evidence,
            }
          : s.phase === "more"
            ? { ...s, phase: "write", evidence: res.evidence ?? s.evidence }
            : {
                ...s,
                phase: "done",
                notes: submitted(res, "report")?.report ?? "",
                evidence: res.evidence ?? s.evidence,
                sheet: res.sheet,
              };
    if (res.kind === "failed") logs.push(`sample ${s.label} could not finish: ${res.reason}`);
    if (next.phase === "done" && !usable(next))
      logs.push(`play sample ${s.label} lacked usable hands-on evidence`);
    return { ...c, samples: catchUp(c.samples.with(si, next), logs) };
  }
  const ji = c.judges.findIndex((j) => j.phase !== "done");
  if (ji < 0) return c;
  const j = c.judges[ji]!;
  if (res.kind !== "done") {
    logs.push(`comparator ${j.id} could not finish`);
    return { ...c, judges: c.judges.with(ji, { ...j, phase: "done" }) };
  }
  const sub = submitted(res, "verdict");
  const text = sub?.reasons ?? "";
  const verdict = sub?.verdict ?? null;
  const next: Judge =
    verdict === null && j.phase === "compare"
      ? { ...j, thread: res.threadId, phase: "correct", notes: text }
      : {
          ...j,
          thread: res.threadId,
          phase: "done",
          verdict: verdict ?? "NONE",
          reason: text.replace(/\s+/g, " ").trim().slice(0, 500),
          // The comparator's write-up as the round detail shows it.
          notes: verdict === null ? text : `Verdict: ${verdict}\n${text}`,
        };
  if (next.phase === "done") release.push(res.threadId);
  if (next.phase === "done" && next.verdict === "NONE" && j.attempt === 0)
    logs.push(`comparator gave no verdict (A=${j.aIs}); retrying once`);
  return { ...c, judges: c.judges.with(ji, next) };
};

// The comparison's record, written once the verdicts are in, with each
// comparator's write-up. The build mapping is in the game root all along
// (the run's step records name every sample's sha); comparators stay blind by
// working outside it, in BLANK worktrees that hold only their neutral files.
const comparisonFiles = (
  tag: string,
  id: string,
  c: Compare,
  gate: string | null,
  names: Record<Side, string>,
) => [
  comparisonFile(tag, id, c, gate, names),
  ...c.judges.flatMap((j) =>
    j.notes.length === 0 ? [] : [{ path: judgeFile(j), text: `${j.notes}\n` }],
  ),
];
const comparisonPath = (tag: string, id: string) => `.studio/comparisons/${tag}-${id}.json`;
const comparisonFile = (
  tag: string,
  id: string,
  c: Compare,
  gate: string | null,
  names: Record<Side, string>,
) => {
  const side = (pick: (s: Sample | null) => unknown) => ({
    [names.x]: pick(lastSample(c, "x")),
    [names.y]: pick(lastSample(c, "y")),
  });
  return {
    path: comparisonPath(tag, id),
    text: `${JSON.stringify(
      {
        [names.x]: c.x,
        [names.y]: c.y,
        playOrder: c.xFirst ? `${names.x},${names.y}` : `${names.y},${names.x}`,
        // Never shown to the comparators: their two reports look alike either way.
        reusedPlay:
          c.reused === null
            ? null
            : { build: names[c.reused.side], round: c.reused.round, branch: c.reused.branch },
        evidence: side((s) => s?.evidence ?? null),
        players: side((s) => s?.thread ?? null),
        reports: side((s) => s?.notes ?? ""),
        sheets: side((s) => (s === null || s.sheet === "" ? null : s.sheet)),
        sheetsShown: sheetsShown(c),
        bot: c.bot.length === 0 ? null : { file: c.bot, decider: c.botDecider },
        botWithheld: c.botWithheld === "" ? null : c.botWithheld,
        bots: {
          [names.x]: c.bots.find((b) => b.side === "x") ?? null,
          [names.y]: c.bots.find((b) => b.side === "y") ?? null,
        },
        gate,
        verdicts: c.orders.map((aIs) => {
          const j = finalJudge(c, aIs);
          return {
            order: `A=${names[aIs]}`,
            verdict: j?.verdict ?? "NONE",
            presentation: j === null ? null : j.aFirst ? "A,B" : "B,A",
            comparison: j === null ? null : judgeFile(j),
          };
        }),
      },
      null,
      2,
    )}\n`,
  };
};

// ── Tasks. ────────────────────────────────────────────────────────────────
const newRound = (state: RunState, now: number): Round => {
  const n = state.rounds.length + 1;
  return {
    _tag: "round",
    n,
    branch: "",
    phase: "start",
    direction: "",
    repeating: false,
    move: "",
    base: "",
    candidate: "",
    startedAt: now,
    block: null,
    jev: false,
    thread: null,
    bot: "",
    botDecider: "policy",
    testerNotes: "",
    rung: null,
    continued: false,
    stateChecks: [],
    fixes: 0,
    checks: [],
    cmp: null,
    outcome: "",
    reviewed: "",
    facts: "",
    record: {
      round: n,
      move: "",
      branch: `round-${n}`,
      verdicts: [],
      kept: false,
      durationMs: 0,
      linesChanged: 0,
      comparison: "",
    },
  };
};

const stageTask = (
  name: "vision" | "plan" | "art" | "build",
  block: Block | null = null,
): Extract<Task, { _tag: "stage" }> => ({
  _tag: "stage",
  name,
  phase: "role",
  thread: null,
  block,
  sha: "",
  why: "",
  review: "",
});

// Stages before rounds; the stage label names the last one finished. A Guided
// run asks the creator after the vision and after the plan.
const afterStage = (state: RunState, done: string, now: number): RunState => {
  if (state.profile === "guided" && done === "vision")
    return { ...state, stage: done, task: { _tag: "decide", decision: styleDecision(state) } };
  if (state.profile === "guided" && done === "plan" && state.ladder !== null) {
    const ladder = state.ladder;
    if (ladder.rungs.length > 0)
      return {
        ...state,
        stage: done,
        task: { _tag: "decide", decision: ladderDecision(state, ladder) },
      };
  }
  return proceed(state, done, now);
};

const protoTask = (i: number): Extract<Task, { _tag: "proto" }> => ({
  _tag: "proto",
  i,
  phase: "role",
  branch: "",
  why: "",
  notes: "",
});

const proceed = (state: RunState, done: string, now: number): RunState => {
  if (done === "starting") return { ...state, task: stageTask("vision") };
  if (done === "vision") return { ...state, stage: done, task: protoTask(0) };
  if (done === "pick") return { ...state, stage: done, task: stageTask("plan") };
  if (done === "plan") return { ...state, stage: done, task: stageTask("art") };
  if (done === "art") {
    const ms = fit(state, now, CAP.fullBuild, BUILD_RESERVE_MS);
    if (ms >= FLOOR_MS)
      return {
        ...state,
        stage: done,
        task: stageTask(
          "build",
          newBlock(
            "build",
            Roles.firstDirection(state.lane, state.ladder?.rungs[0] ?? null, state.buildNotes),
            true,
            ms,
            state.best,
          ),
        ),
      };
  }
  return { ...state, stage: done === "art" ? "build" : done, task: newRound(state, now) };
};

const end = (reason: string, why?: string): Planned =>
  why === undefined ? { kind: "end", reason } : { kind: "end", reason, why };
const step = (state: RunState, task: Task, s: Step, logs: ReadonlyArray<string> = []): Planned => ({
  kind: "step",
  state: { ...state, task, seq: s.id, inFlight: s },
  step: s,
  ...(logs.length > 0 ? { logs } : {}),
});

// Where the next direction comes from: the creator's notes first, then the
// last review, else a plain repeat of the previous one (said so), else the
// pick's findings, else the plan.
const roundDirection = (state: RunState) => {
  const prior = state.lastDirection || (state.rounds.at(-1)?.move ?? "");
  const repeating =
    state.rounds.at(-1)?.rung === undefined &&
    state.steer.length === 0 &&
    state.next.length === 0 &&
    state.rounds.length > 0 &&
    prior.length > 0;
  const base = repeating ? prior : Roles.roundBase(state.next, state.pickNotes, state.lane);
  const direction = state.steer.length === 0 ? base : Roles.steered(state.steer, base);
  return { direction, repeating };
};

/**
 * What a planned role turn hands the run: nothing, or one submission kind; a
 * tester scores the rung's look checks, by their number in the rung.
 */
export type Asked =
  | { readonly kind: null }
  | { readonly kind: Exclude<GameRunSubmissionKind, "checks"> }
  | { readonly kind: "checks"; readonly look: ReadonlyArray<number> };

export const asked = (state: RunState, step: RoleStep): Asked => {
  const t = state.task;
  const none = { kind: null } as const;
  const inCompare = (c: Compare): Asked => {
    if (step.role.startsWith("compare-")) return { kind: "verdict" };
    const sample = c.samples.find((x) => step.role === `sample-${x.label}`);
    return sample?.phase === "write" ? { kind: "report" } : none;
  };
  switch (t._tag) {
    case "stage":
      if (t.phase === "review") return { kind: "art" };
      return t.name === "plan" && ["role", "redo", "revise"].includes(t.phase)
        ? { kind: "ladder" }
        : none;
    case "ladder":
      return { kind: "ladder" };
    case "ship":
      return t.phase === "write" ? { kind: "ship" } : none;
    case "pick":
      return t.phase === "select" ? { kind: "select" } : inCompare(t.cmp);
    case "round": {
      if (t.phase === "tester-write" || t.phase === "tester-duty") {
        const rung = rungOf(state, t);
        return {
          kind: "checks",
          look: (rung?.checks ?? []).flatMap((c, k) => (isStateCheck(c) ? [] : [k + 1])),
        };
      }
      if (t.phase === "review-write") return { kind: "ledger" };
      return t.phase === "compare" && t.cmp !== null ? inCompare(t.cmp) : none;
    }
    case "init":
    case "proto":
    case "leave":
    case "decide":
      return none;
  }
};

/**
 * A finished run comes back for a creator's note: one round on it, then it
 * ends again. The note's round starts a fresh stall count.
 */
export const reopen = (state: RunState, now: number): RunState => ({
  ...state,
  ending: null,
  inFlight: null,
  stallStreak: 0,
  task: newRound(state, now),
});

/**
 * A resumed run starts a fresh stall count, so resuming one that stalled
 * gets its rounds, and a run whose plan wrote no valid ladder plans again
 * instead of ending at once on the same empty ladder.
 */
export const resume = (state: RunState): RunState => ({
  ...state,
  stallStreak: 0,
  ladder: state.ladder !== null && state.ladder.rungs.length === 0 ? null : state.ladder,
});

/**
 * Whether a creator's restore abandons the round a stopped run holds: one
 * past its start (or with its start's step saved), or the budget's leave of
 * one. A resume would otherwise continue it on the folder the restore replaced.
 */
export const holdsRound = (state: RunState): boolean =>
  state.task._tag === "leave" ||
  (state.task._tag === "round" && (state.task.phase !== "start" || state.inFlight !== null));

/**
 * A creator's restore drops the round in flight: the next round starts from
 * the best (a restored round is the best), never from this round's work (the restore kept the folder
 * as a build first). A round already judged, waiting only on its review, is
 * recorded with its outcome; one never judged is recorded as abandoned, which
 * is no stall and leaves its rung as it was, with the creator's notes it read
 * back for the next round. `release` names the role threads whose copies go.
 */
export const abandonRound = (
  state: RunState,
  why: string,
  now: number,
): Pick<Applied, "state" | "logs" | "release"> => {
  const t = state.task;
  const logs: string[] = [];
  const fresh = (s: RunState) => ({ ...s, inFlight: null, task: newRound(s, now) });
  if (t._tag === "leave") {
    logs.push(`${t.branch}: left unfinished, ${why}`);
    return { state: fresh(state), logs, release: [] };
  }
  if (t._tag !== "round" || !holdsRound(state)) return { state, logs, release: [] };
  if (t.phase === "start") return { state: fresh(state), logs, release: [] };
  const release = [
    ...(t.cmp?.samples ?? []).map((x) => x.thread),
    ...(t.cmp?.judges ?? []).map((j) => j.thread),
  ].filter((thread): thread is ThreadId => thread !== null);
  const record = { ...t.record, durationMs: now - t.startedAt, note: noteOf(t, why) };
  if (t.record.kept) {
    const settled = settleRung(
      state,
      t,
      { ...record, ...(t.candidate.length > 0 ? { build: t.candidate } : {}) },
      logs,
    );
    logs.push(`round ${t.n}: kept; its review is skipped, ${why}`);
    const next = {
      ...settled.state,
      rounds: [...state.rounds, settled.record],
      stage: `round-${t.n}`,
      stallStreak: 0,
    };
    return { state: fresh(next), logs, release };
  }
  // Judged and not kept (rejected, inconclusive, unjudged, failed checks, a
  // merge that failed): it keeps its outcome and its rung counts the try, but
  // it is no stall, and it names no build a retry would continue over the
  // restored best. A keep still waiting to be merged was never kept: abandoned.
  const judged =
    t.outcome === "drop" ||
    t.outcome === "hold" ||
    (t.outcome === "merge" && t.phase !== "outcome");
  if (judged) {
    const settled = settleRung(state, t, record, logs);
    logs.push(`round ${t.n}: not kept; its review is skipped, ${why}`);
    const next = {
      ...settled.state,
      rounds: [...state.rounds, settled.record],
      stage: `round-${t.n}`,
    };
    return { state: fresh(next), logs, release };
  }
  logs.push(`round ${t.n}: abandoned, ${why}`);
  const next = {
    ...state,
    rounds: [...state.rounds, { ...record, abandoned: true }],
    stage: `round-${t.n}`,
    steer: [...(t.record.steer ?? []), ...state.steer],
  };
  return { state: fresh(next), logs, release };
};

export const plan = (state: RunState, input: Inputs): Planned => {
  if (state.inFlight !== null) return { kind: "step", state, step: state.inFlight };
  const id = state.seq + 1;
  const t = state.task;
  const lane = state.lane;
  const go = (s: Step, task: Task = t, logs: ReadonlyArray<string> = []) =>
    step(state, task, s, logs);
  const run = (op: BuildOp, task: Task = t) => go(build(id, op), task);
  const act = (spec: RoleSpec) => go(role(id, spec));
  // A rejected or set-aside build stays under its own name; the folder goes back to the best.
  const toBest = () => run({ _tag: "restore", sha: state.best, keep: [] });
  const artCap = (cap: number) =>
    Math.max(FLOOR_MS, fit(state, input.now, cap, BUILD_RESERVE_MS + FLOOR_MS));
  switch (t._tag) {
    case "init":
      return run({ _tag: "capture", name: BuildName.base, base: "" });
    case "stage": {
      const name = t.name;
      if (t.phase === "review")
        return act({
          role: "art-director",
          title: "studio art director",
          prompt: Roles.artReview(lane),
          capMs: artCap(CAP.artReview),
        });
      if (t.phase === "revise")
        return name === "plan"
          ? act({
              role: "plan",
              prompt: Roles.ladderRevise(t.review),
              capMs: CAP.plan,
            })
          : act({ role: name, prompt: Roles.visionRevise(t.review, lane), capMs: CAP.vision });
      if (t.phase === "redo" && name === "plan")
        return act({
          role: "plan",
          thread: t.thread,
          prompt: Roles.ladderFix(),
          capMs: CAP.ladderFix,
        });
      if (t.phase === "redo")
        return act({
          role: "art",
          thread: t.thread,
          prompt: Roles.artRedo(t.review, lane),
          capMs: artCap(CAP.artRedo),
        });
      if (t.phase === "role")
        return name === "build"
          ? go(blockStep(id, t.block!, lane))
          : act({
              role: name,
              prompt: Roles.stage(name, lane),
              capMs: CAP[name],
            });
      if (t.phase === "commit")
        return run({ _tag: "capture", name: BuildName.stage(t.name), base: state.best });
      return t.phase === "boot" ? go({ kind: "boot", id }) : toBest();
    }
    case "proto": {
      const name = `proto-${t.i}`;
      if (t.phase === "role" && state.profile === "guided") {
        const files = protoFiles(t.i);
        return act({
          role: name,
          prompt: Roles.proto(lane, { pitch: files.pitch, notes: t.notes }),
          capMs: CAP.proto,
          clear: [files.pitch, files.sheet],
          sheet: files.sheet,
        });
      }
      if (t.phase === "role")
        return act({ role: name, prompt: Roles.proto(lane), capMs: CAP.proto });
      if (t.phase === "commit")
        return run({ _tag: "capture", name: BuildName.proto(t.i), base: state.best });
      if (t.phase === "boot") return go({ kind: "boot", id });
      // Each prototype starts from the same base: kept or not, it stays under its name.
      return toBest();
    }
    case "pick": {
      if (t.phase === "adopt")
        return run({ _tag: "restore", sha: buildOf(state, t.chosen), keep: [BuildName.best] });
      const j = finalJudge(t.cmp, "x");
      if (t.phase === "select")
        return act({
          role: `compare-${j?.id ?? "select"}`,
          title: "studio blind comparison",
          thread: j?.thread ?? null,
          at: BLANK,
          prompt: Roles.select(),
          capMs: CAP.write,
        });
      const made = compareStep(id, t.cmp, input, state);
      return go(made.step, { ...t, cmp: made.cmp }, made.logs);
    }
    case "ladder":
      return act(ladderSpec(t));
    case "ship":
      return t.phase === "play"
        ? act({
            role: `ship-${t.n}`,
            prompt: Roles.SHIP_PLAY,
            capMs: CAP.ship,
            clear: [".studio/ship.md"],
          })
        : act({
            role: `ship-${t.n}`,
            thread: t.thread,
            prompt: Roles.shipWrite(),
            capMs: CAP.write,
          });
    case "leave":
      // The round's work, whatever state it is in, is kept before the folder returns to the best.
      return t.phase === "capture"
        ? run({ _tag: "capture", name: BuildName.unfinished(t.branch, id), base: state.best })
        : toBest();
    case "decide": {
      if (state.profile === "guided")
        return go({ kind: "decide", id, decision: t.decision, sent: null, deadline: null });
      // Switched to Autopilot before the question went out: the run decides itself.
      const logs: string[] = [];
      const next = plan(decide(state, t.decision, null, input, logs), input);
      return next.kind === "step" ? { ...next, logs: [...logs, ...(next.logs ?? [])] } : next;
    }
    case "round":
      break;
  }
  const r = t;
  const n = r.n;
  const tester = (prompt: string, capMs: number) =>
    act({ role: `tester-${n}`, thread: r.thread, prompt, capMs, bots: true });
  switch (r.phase) {
    case "start": {
      if (state.stallStreak >= STALL_LIMIT) return end("stalled");
      if (remaining(state, input.now) < ROUND_RESERVE_MS) return end("budget");
      if (state.ladder === null) {
        const task: Task = { _tag: "ladder", phase: "write", thread: null, error: "" };
        return go(role(id, ladderSpec(task)), task, [
          `round ${n}: the run has no ladder yet; the plan writes one first`,
        ]);
      }
      const steer = state.steer.length === 0 ? {} : { steer: state.steer };
      // The round builds in the folder from its base: the best, or the
      // candidate it continues (a pending line, a rung's retry).
      const label = `round-${n}`;
      const start = (from: string | null): Step =>
        build(id, { _tag: "restore", sha: from ?? state.best, keep: [] });
      const pick = pickRung(state.ladder);
      // Polish is the creator's call: with no rung left (the ladder is done, or
      // the plan wrote none) a round runs only on their ask. A run without a
      // ladder ends resumably, and a resume plans one again.
      if (pick.kind === "finish" && state.steer.length === 0)
        return pick.why === LADDER_DONE ? end("done") : end("no-ladder", pick.why.slice(0, 300));
      if (pick.kind === "finish") {
        const { direction, repeating } = roundDirection(state);
        const move = direction.slice(0, 300);
        const next: Round = {
          ...r,
          branch: label,
          direction,
          repeating,
          move,
          record: { ...r.record, branch: label, move, finish: true, ...steer },
        };
        const pendingBuild = state.pending?.sha;
        return go(
          start(pendingBuild === undefined || pendingBuild === "" ? null : pendingBuild),
          next,
          [`round ${n}: finish round (${pick.why})`],
        );
      }
      const { ladder, rung } = pick;
      const k = positionOf(ladder, rung);
      const total = ladder.rungs.length;
      const from = retryFrom(state, rung);
      const base = Roles.rungDirection(
        rung,
        k,
        total,
        state.next,
        lastTry(state, rung),
        from !== null,
        lane,
      );
      const direction = state.steer.length === 0 ? base : Roles.steered(state.steer, base);
      const move = `Rung ${k} of ${total}: ${rung.is}`.slice(0, 300);
      const next: Round = {
        ...r,
        branch: label,
        rung: rung.id,
        direction,
        repeating: false,
        move,
        record: { ...r.record, branch: label, move, ...steer },
      };
      const logs = [...pick.logs, `round ${n} builds rung ${k} of ${total}: ${rung.is}`];
      // A ladder round starts from the judged best (or the try it retries); an open
      // pending line stays a build of its own.
      if (state.pending !== null)
        logs.push(`round ${n}: pending ${state.pending.branch} stays a build of its own`);
      return step({ ...state, ladder, pending: null }, next, start(from), logs);
    }
    case "block":
    case "retry":
      return go(blockStep(id, r.block!, lane));
    case "commit":
    case "retry-commit":
      return run({ _tag: "capture", name: BuildName.candidate(r.branch), base: state.best });
    case "stall":
      return toBest();
    case "boot":
      return go({ kind: "boot", id });
    case "checks":
      return go({ kind: "checks", id, rung: r.rung! });
    case "reject":
      return toBest();
    case "tester-facts":
    case "review-facts":
      return go({ kind: "facts", id });
    case "tester":
      return tester(
        Roles.testerPlay(n, r.jev, rungOf(state, r), r.continued ? lastTryOf(state, r) : ""),
        CAP.tester,
      );
    case "tester-write":
      return tester(Roles.testerWrite(n, r.move, rungOf(state, r)), CAP.write);
    case "tester-duty":
      return tester(Roles.BOT_DUTY, CAP.duty);
    case "restore":
      // The tester played the candidate and may have touched its files: they
      // go back to the candidate's before it is judged.
      return run({ _tag: "restore", sha: r.candidate, keep: [] });
    case "compare": {
      const made = compareStep(id, r.cmp!, input, state);
      return go(made.step, { ...r, cmp: made.cmp }, made.logs);
    }
    case "outcome":
      // A kept round is the best and keeps its own name for a creator's restore;
      // the folder already holds it.
      return r.outcome === "merge"
        ? run({ _tag: "keep", names: [BuildName.best, BuildName.kept(r.branch)], sha: r.candidate })
        : toBest();
    case "review":
      return act({
        role: `reviewer-${n}`,
        prompt: Roles.reviewerPlay(n, r.reviewed, r.facts),
        capMs: CAP.reviewer,
      });
    case "review-write": {
      const [o1, o2] = r.record.verdicts;
      const word = r.record.kept
        ? "kept"
        : r.record.inconclusive === true
          ? "inconclusive, flaw still open"
          : "rejected/unjudged";
      const verdicts = `${o1?.verdict ?? "NONE"}/${o2?.verdict ?? "NONE"} (${word})`;
      const rung = rungOf(state, r);
      if (rung !== null && state.ladder !== null) {
        const k = positionOf(state.ladder, rung);
        const built = `it built rung ${k} (${rung.is}); the tester's checks: ${checkLine(r.checks) || "none verified"}; ${r.record.kept ? "kept" : `not kept (${r.record.note ?? ""})`}; judging ${verdicts}.`;
        return act({
          role: `reviewer-${n}`,
          prompt: Roles.reviewerLedger(
            n,
            (r.record.comparison ?? "") === ""
              ? ""
              : comparisonPath(r.branch, r.record.comparison ?? ""),
            built,
            ladderText(state.ladder, rung.id),
            r.facts,
          ),
          capMs: CAP.reviewer,
        });
      }
      return act({
        role: `reviewer-${n}`,
        thread: r.thread,
        prompt: Roles.reviewerWrite(n, r.move, verdicts, r.facts),
        capMs: CAP.write,
      });
    }
  }
};

// ── Results. ──────────────────────────────────────────────────────────────
const noteOf = (r: Round, add: string) => `${r.record.note ?? ""} ${add}`.trim();

// Every round writes a record or it doesn't count; three stalls in a row end the run.
const stallRound = (
  state: RunState,
  r: Round,
  note: string,
  now: number,
  logs: string[],
): RunState => {
  logs.push(`round ${r.n}: ${note}`);
  const settled = settleRung(
    state,
    r,
    {
      ...r.record,
      note: noteOf(r, note),
      durationMs: now - r.startedAt,
      ...(r.candidate.length > 0 ? { build: r.candidate } : {}),
    },
    logs,
  );
  const next = {
    ...settled.state,
    rounds: [...state.rounds, settled.record],
    stallStreak: state.stallStreak + 1,
    lastFailure: `round ${r.n}: ${note}`,
    stage: `round-${r.n}`,
  };
  return { ...next, task: newRound(next, now) };
};

// A budget end inside a round keeps the round's work as a build of its own and
// returns the folder to the best, so the exports are of the judged best.
const leaveRound = (state: RunState, r: Round): RunState => ({
  ...state,
  task: { _tag: "leave", branch: r.branch, candidate: r.candidate, phase: "capture" },
});

const inComparison = (s: RunState): boolean =>
  s.ending === null &&
  (s.task._tag === "pick" || s.task._tag === "round") &&
  s.task.phase === "compare";

/**
 * A pair lands once both halves have results: each goes through applyResult,
 * x then y, so every per-side rule (the play floor's extra turn, a replay, bot
 * withholding) is the serial one. A half that ends the comparison (a budget
 * end) drops the other; one that stays in flight keeps the other with it.
 */
export const applyPair = (state: RunState, pair: PairStep, input: Inputs): Applied => {
  const logs: string[] = [];
  const files: Array<{ path: string; text: string }> = [];
  const release: ThreadId[] = [];
  const out = (next: RunState): Applied => ({ state: next, logs, files, release });
  const resultOf = (half: Half) => pair.results.find((r) => r.id === half.id)?.result;
  // What stays in flight: these halves, each with its result unless it re-runs.
  const keep = (rest: ReadonlyArray<Half>, rerun: number | null): Step =>
    rest.length === 1
      ? rest[0]!
      : {
          ...pair,
          halves: rest,
          results: pair.results.filter((r) => r.id !== rerun && rest.some((h) => h.id === r.id)),
        };
  // Leaving the comparison (a budget end on either half) drops every sample
  // in it, so each finished worktree play gives its checkout back, including
  // one applied earlier in this pair that was kept for a follow-up turn.
  // Releasing an already released checkout is a no-op.
  const leave = (next: RunState): Applied => {
    for (const each of pair.halves) {
      const r = resultOf(each);
      // A budget-cut half already gave its own checkout back with its own landing.
      if (
        each.kind === "role" &&
        each.at !== null &&
        r?.kind === "done" &&
        !(r.timedOut && r.budgetCut) &&
        !release.includes(r.threadId)
      )
        release.push(r.threadId);
    }
    return out(next);
  };
  let s: RunState = { ...state, inFlight: null };
  for (const [i, half] of pair.halves.entries()) {
    const rest = pair.halves.slice(i);
    if (!inComparison(s)) return leave(s);
    const res = resultOf(half);
    if (res === undefined) return out({ ...s, inFlight: keep(rest, null) });
    const applied = applyResult(s, half, res, input);
    logs.push(...applied.logs);
    files.push(...applied.files);
    release.push(...applied.release);
    s = applied.state;
    // Kept in flight (a budget end outside a round): it re-runs on resume, as a serial step would.
    if (s.inFlight !== null) return out({ ...s, inFlight: keep(rest, half.id) });
  }
  return inComparison(s) ? out(s) : leave(s);
};

export const applyResult = (
  state: RunState,
  done: Step,
  res: StepResult,
  input: Inputs,
): Applied => {
  const logs: string[] = [];
  const files: Array<{ path: string; text: string }> = [];
  const release: ThreadId[] = [];
  const out = (s: RunState): Applied => ({ state: s, logs, files, release });
  // Usage limits, a provider that stays down and memory that stays short end
  // the run resumably; the step stays in flight so a resume reattaches to its thread.
  if (res.kind === "ended")
    return out({ ...state, inFlight: done, ending: res.ending, lastFailure: res.reason });
  const s: RunState = { ...state, inFlight: null };
  const t = s.task;
  const inCompare =
    (t._tag === "pick" && t.phase === "compare") || (t._tag === "round" && t.phase === "compare");
  // The run never stalls on the art reviewer: a review that cannot finish keeps the art.
  const inArtReview = t._tag === "stage" && t.phase === "review";
  if (res.kind === "failed" && !inCompare && !inArtReview)
    return out({ ...s, ending: "failed", lastFailure: res.reason.slice(0, 300) });
  if (
    res.kind === "done" &&
    res.budgetCut &&
    !(t._tag === "round" && (t.phase === "review" || t.phase === "review-write"))
  ) {
    logs.push(`budget reached during ${done.kind === "role" ? done.role : done.kind}`);
    if (t._tag === "round" && t.phase !== "start") return out(leaveRound(s, t));
    return out({ ...s, inFlight: done, ending: "budget" });
  }
  const g = res.kind === "build" ? res.build : null;
  const now = input.now;
  switch (t._tag) {
    case "init":
      return out(afterStage({ ...s, best: g!.sha }, s.stage, now));
    case "decide": {
      const next = decide(
        s,
        t.decision,
        res.kind === "decided" ? { answer: res.answer, notes: res.notes, by: res.by } : null,
        input,
        logs,
      );
      // The run holds an edited ladder; the file is what the creator and every role read.
      const taken = next.decided.at(-1);
      if (t.decision.kind === "ladder" && taken?.answer === "edit")
        files.push({ path: LADDER, text: taken.notes });
      return out(next);
    }
    case "stage": {
      const artFits = (cap: number) => fit(s, now, cap, BUILD_RESERVE_MS + FLOOR_MS) >= FLOOR_MS;
      // The creator's rewrite keeps the old ladder when the new one has the wrong shape.
      if (t.name === "plan" && t.phase === "revise") {
        const sub = submitted(res, "ladder");
        const parsed = sub !== null ? ladderOf(sub.rungs) : { error: MISSING_LADDER };
        if ("ladder" in parsed && sub !== null)
          files.push({ path: LADDER, text: ladderJson(sub.rungs) });
        if ("ladder" in parsed) logs.push(`ladder rewritten: ${parsed.ladder.rungs.length} rungs`);
        else
          logs.push(`ladder rewrite not taken (${parsed.error.slice(0, 200)}); keeping the ladder`);
        return out({
          ...s,
          ladder: "ladder" in parsed ? parsed.ladder : s.ladder,
          task: { ...t, phase: "commit" },
        });
      }
      if (t.phase === "revise") return out({ ...s, task: { ...t, phase: "commit" } });
      if (t.name === "plan" && (t.phase === "role" || t.phase === "redo")) {
        const taken = takeLadder(res, t.phase === "redo", logs, files);
        if (taken.kind === "fix")
          return out({
            ...s,
            task: { ...t, phase: "redo", thread: taken.thread, review: taken.error },
          });
        return out({ ...s, ladder: taken.ladder, task: { ...t, phase: "commit" } });
      }
      if (t.phase === "role" && t.name === "art" && res.kind === "done") {
        if (artFits(CAP.artReview))
          return out({ ...s, task: { ...t, phase: "review", thread: res.threadId } });
        logs.push("art review skipped: the budget leaves no room before the first build");
        return out({ ...s, task: { ...t, phase: "commit", thread: res.threadId } });
      }
      if (t.phase === "review") {
        const art = submitted(res, "art");
        const text = art?.defects ?? "";
        const verdict = art === null ? null : art.redo ? "REDO" : "KEEP";
        if (verdict === null)
          logs.push(
            `art review submitted no verdict${res.kind === "failed" ? ` (${res.reason})` : ""}; keeping the art`,
          );
        if (verdict !== "REDO") return out({ ...s, task: { ...t, phase: "commit" } });
        if (!artFits(CAP.artRedo)) {
          logs.push("art review asked for a redo, but the budget leaves no room; keeping the art");
          return out({ ...s, task: { ...t, phase: "commit" } });
        }
        logs.push("art review: REDO; one redo turn with its defect list");
        const defects = text.trim().slice(0, 3000);
        return out({ ...s, task: { ...t, phase: "redo", review: defects } });
      }
      if (t.phase === "redo") return out({ ...s, task: { ...t, phase: "commit" } });
      if (t.phase === "role") {
        if (t.block === null || res.kind !== "done")
          return out({ ...s, task: { ...t, phase: "commit" } });
        const stepped = advanceBlock(t.block, res);
        return out({
          ...s,
          task: { ...t, block: stepped.block, phase: stepped.over ? "commit" : "role" },
        });
      }
      if (t.phase === "commit") {
        // Documents only: the build moves on with them, nothing to boot.
        if (!g!.changed) return out(afterStage({ ...s, best: g!.sha }, t.name, now));
        return out({ ...s, task: { ...t, phase: "boot", sha: g!.sha } });
      }
      if (t.phase === "boot" && res.kind === "boot") {
        if (res.ok) return out(afterStage({ ...s, best: t.sha }, t.name, now));
        return out({ ...s, task: { ...t, phase: "reject", why: res.detail } });
      }
      logs.push(`${t.name}: boot failed; its work stays as build ${BuildName.stage(t.name)}`);
      return out(afterStage(s, t.name, now));
    }
    case "proto": {
      if (t.phase === "role") return out({ ...s, task: { ...t, phase: "commit" } });
      if (t.phase === "commit")
        return out({ ...s, task: { ...t, phase: "boot", branch: `proto-${t.i}`, sha: g!.sha } });
      if (t.phase === "boot" && res.kind === "boot")
        return out({ ...s, task: { ...t, phase: res.ok ? "keep" : "reject", why: res.detail } });
      // Only prototypes that booted compete or become the base.
      const protos = [
        ...s.protos,
        {
          branch: t.branch,
          booted: t.phase === "keep",
          ...(t.sha === undefined ? {} : { sha: t.sha }),
        },
      ];
      if (t.i % 2 === 0)
        return out({ ...s, protos, task: { ...protoTask(t.i + 1), notes: t.notes } });
      const booted = protos.flatMap((p, k) =>
        p.booted ? [{ branch: p.branch, i: t.i - 1 + k }] : [],
      );
      if (s.profile === "guided" && booted.length >= 2)
        return out({
          ...s,
          protos,
          task: { _tag: "decide", decision: prototypeDecision(s, booted) },
        });
      return out(
        startPick(
          { ...s, protos },
          booted.map((p) => p.branch),
          input,
          logs,
        ),
      );
    }
    case "pick": {
      if (t.phase === "adopt") {
        logs.push(
          g!.ok
            ? `pick ${t.chosen} adopted at ${g!.sha.slice(0, 8)}`
            : `pick ${t.chosen} not adopted (${g!.detail}); staying on best`,
        );
        // A lone booted prototype has no comparison; only a tie's selection leaves notes on the task.
        const creator =
          t.cmp.x === "" &&
          s.decided.findLast((d) => d.kind === "prototype")?.answer.startsWith("pick-") === true;
        const picked: Picked = {
          branch: t.chosen,
          how: creator
            ? "creator"
            : t.cmp.x === ""
              ? "only-booted"
              : t.notes !== ""
                ? "selected"
                : "won",
          comparison: t.comparison === "" ? null : t.comparison,
        };
        return out(
          afterStage(g!.ok ? { ...s, best: g!.sha, picked } : { ...s, picked: null }, "pick", now),
        );
      }
      if (t.phase === "select") {
        if (res.kind === "done") release.push(res.threadId);
        const select = submitted(res, "select");
        const chosen = select?.pick ?? null;
        if (chosen === null) {
          logs.push("pick tie unresolved: building from the base with the tie recorded");
          return out(afterStage({ ...s, pickNotes: t.notes }, "pick", now));
        }
        const reasons = (select?.reasons ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
        const notes = `${pickLegend(chosen)}\n${t.notes}\nSELECT: ${chosen} (continuation choice on tied comparison; no demonstrated preference)\n${reasons}`;
        return out({
          ...s,
          pickNotes: notes,
          task: { ...t, phase: "adopt", chosen: chosen === "A" ? t.cmp.x : t.cmp.y },
        });
      }
      const cmp = applyCompare(t.cmp, done, res, logs, release);
      const move = compareMove(cmp);
      if (move.kind !== "done") return out({ ...s, task: { ...t, cmp } });
      files.push(...comparisonFiles("pick", input.id, cmp, move.gate, { x: "A", y: "B" }));
      const j = move.gate === null ? finalJudge(cmp, "x") : null;
      const verdict = j?.verdict ?? "NONE";
      if (verdict === "A" || verdict === "B")
        return out({
          ...s,
          pickNotes: `${pickLegend(verdict)}\n${j!.notes}`,
          task: {
            ...t,
            cmp,
            phase: "adopt",
            chosen: verdict === "A" ? cmp.x : cmp.y,
            comparison: input.id,
          },
        });
      // TIE compares honestly, but creation needs a base: the comparator picks
      // which prototype to continue, a selection rather than a win.
      if (verdict === "TIE") {
        // Its comparator makes the selection on the same thread, so its worktree stays.
        release.splice(0, release.length, ...release.filter((thread) => thread !== j!.thread));
        return out({
          ...s,
          task: { ...t, cmp, phase: "select", notes: j!.notes, comparison: input.id },
        });
      }
      logs.push(`pick incomplete: ${move.gate ?? "no verdict"}`);
      return out(afterStage(s, "pick", now));
    }
    case "ship": {
      if (t.phase === "play" && res.kind === "done")
        return out({ ...s, task: { ...t, phase: "write", thread: res.threadId } });
      const ship = submitted(res, "ship");
      const yes = ship?.ship === true;
      // A creator note that arrived during the ship review still gets its round.
      if (yes && s.steer.length === 0) return out({ ...s, ending: "ready" });
      const reasons = (ship?.reasons ?? "").trim().slice(0, 500);
      // The run's goal was the ladder: it ends here with the review's reasons, and
      // polish runs only when the creator asks (a note sent during the review does).
      return out({
        ...s,
        shipNoReasons: reasons,
        task: newRound(s, now),
        ...(s.steer.length === 0 ? { ending: "done" } : {}),
      });
    }
    case "ladder": {
      // A rewrite the creator asked for, as the plan stage's rewrite: a ladder of
      // the wrong shape (or none) keeps the reviewed ladder, and the creator is
      // asked again; there is no fix turn that would drop their notes.
      if (t.phase === "revise") {
        const sub = submitted(res, "ladder");
        const parsed = sub !== null ? ladderOf(sub.rungs) : { error: MISSING_LADDER };
        if ("ladder" in parsed && sub !== null)
          files.push({ path: LADDER, text: ladderJson(sub.rungs) });
        if ("ladder" in parsed) logs.push(`ladder rewritten: ${parsed.ladder.rungs.length} rungs`);
        else
          logs.push(`ladder rewrite not taken (${parsed.error.slice(0, 200)}); keeping the ladder`);
        const ladder = "ladder" in parsed ? parsed.ladder : s.ladder;
        if (ladder === null || ladder.rungs.length === 0)
          return out({ ...s, ladder, task: newRound({ ...s, ladder }, now) });
        return out({
          ...s,
          ladder,
          task:
            s.profile === "guided"
              ? { _tag: "decide", decision: ladderDecision(s, ladder) }
              : newRound({ ...s, ladder }, now),
        });
      }
      const taken = takeLadder(res, t.phase === "fix", logs, files);
      if (taken.kind === "fix")
        return out({
          ...s,
          task: { ...t, phase: "fix", thread: taken.thread, error: taken.error },
        });
      // A Guided creator reviews the ladder whichever path wrote it: here the
      // rounds' own ladder for a game that started at its build, as the plan
      // stage's ladder is reviewed for a new one.
      if (s.profile === "guided" && taken.ladder.rungs.length > 0)
        return out({
          ...s,
          ladder: taken.ladder,
          task: { _tag: "decide", decision: ladderDecision(s, taken.ladder) },
        });
      return out({ ...s, ladder: taken.ladder, task: newRound(s, now) });
    }
    case "leave":
      if (t.phase !== "trunk") {
        logs.push(
          `${t.branch}: its unfinished work is kept as ${keptBuild(s.runId, done.kind === "build" && done.op._tag === "capture" ? done.op.name : BuildName.unfinished(t.branch, done.id), s.lane, g?.sha ?? "")}`,
        );
        return out({ ...s, task: { ...t, phase: "trunk" } });
      }
      return out({ ...s, ending: "budget", task: newRound(s, now) });
    case "round":
      return out(applyRound(s, t, done, res, input, logs, files, release));
  }
};

const applyRound = (
  s: RunState,
  r: Round,
  done: Step,
  res: StepResult,
  input: Inputs,
  logs: string[],
  files: Array<{ path: string; text: string }>,
  release: ThreadId[],
): RunState => {
  const now = input.now;
  const lane = s.lane;
  const g = res.kind === "build" ? res.build : null;
  const at = (round: Partial<Round>): RunState => ({ ...s, task: { ...r, ...round } });
  switch (r.phase) {
    case "start": {
      if (!g!.ok)
        return stallRound(
          s,
          r,
          `stalled (its base build could not be restored: ${g!.detail})`.slice(0, 300),
          now,
          logs,
        );
      if (r.repeating)
        logs.push(
          `round ${r.n}: no next.md from the last review; repeating the previous direction`,
        );
      const pending = s.pending;
      // Started from a round's candidate rather than the best: its work goes on.
      const entered = done.kind === "build" && done.op._tag === "restore" && done.op.sha !== s.best;
      if (pending !== null)
        logs.push(
          `round ${r.n}: refining pending ${pending.branch} against best ${s.best.slice(0, 8)}`,
        );
      const ms = fit(s, now, r.rung === null ? CAP.block : CAP.rung, ROUND_RESERVE_MS);
      const continued = r.rung !== null && entered;
      if (continued) logs.push(`round ${r.n}: continues the last try's work`);
      const round = { ...r, base: g!.sha, continued };
      if (ms < FLOOR_MS) return leaveRound({ ...s, pending }, round);
      const direction = Roles.roundDirection(r.direction, r.repeating, lane);
      // Only the notes this round read are used up; later ones wait for the next.
      return {
        ...s,
        pending,
        steer: s.steer.slice(r.record.steer?.length ?? 0),
        task: {
          ...round,
          phase: "block",
          block: newBlock(`${r.n}`, direction, r.rung !== null, ms, g!.sha),
        },
      };
    }
    case "block":
    case "retry": {
      if (res.kind !== "done")
        return at({ phase: r.phase === "block" ? "commit" : "retry-commit" });
      const stepped = advanceBlock(r.block!, res);
      if (stepped.block.quiet >= 1)
        logs.push(`builder ${r.block!.tag}: done (a turn changed no game files)`);
      if (!stepped.over) return at({ block: stepped.block });
      return at({ block: stepped.block, phase: r.phase === "block" ? "commit" : "retry-commit" });
    }
    case "commit":
    case "retry-commit": {
      if (g!.changed)
        return at({
          phase: "boot",
          candidate: g!.sha,
          record: { ...r.record, linesChanged: g!.lines },
        });
      // The rung may already stand (the first build aims at rung 1): with nothing
      // to change, the tester verifies it on the current build instead of the
      // round stalling; there is nothing to judge, so its checks decide.
      if (r.rung !== null && r.phase === "commit") {
        logs.push(`round ${r.n}: no game-code change; verifying the rung on the current build`);
        // A continued try's build is its starting point, which the gate still judges.
        return at({
          phase: "boot",
          candidate: r.continued ? r.base : s.best,
          record: { ...r.record, note: noteOf(r, "no change; rung verified on the current build") },
        });
      }
      // One short replace attempt with a concrete prompt before calling it stalled.
      const ms = fit(s, now, CAP.retry, 5 * MIN);
      if (r.phase === "commit" && ms >= FLOOR_MS)
        return at({
          phase: "retry",
          block: newBlock(
            `${r.n}b`,
            Roles.retryDirection(
              Roles.roundDirection(r.direction, r.repeating, lane),
              lane,
              r.rung !== null,
            ),
            false,
            ms,
            g!.sha,
          ),
        });
      return at({
        phase: "stall",
        record: {
          ...r.record,
          note: `stalled (no game-code change under ${lane}/ after replace attempt)`,
        },
      });
    }
    case "stall":
      return stallRound(
        s,
        { ...r, record: { ...r.record, note: "" } },
        r.record.note ?? "stalled",
        now,
        logs,
      );
    case "boot": {
      const rung = rungOf(s, r);
      if (res.kind === "boot" && res.ok)
        return at({
          phase: rung !== null && rung.checks.some(isStateCheck) ? "checks" : "tester-facts",
        });
      return at({
        phase: "reject",
        record: {
          ...r.record,
          note: `boot failed: ${res.kind === "boot" ? res.detail : "unknown"}`.slice(0, 300),
        },
      });
    }
    case "checks": {
      const rung = rungOf(s, r)!;
      const results =
        res.kind === "checks"
          ? res.results
          : rung.checks.flatMap((c, k) =>
              c.kind === "state"
                ? [{ k, what: c.what, pass: false, evidence: "the checks did not run", frame: "" }]
                : [],
            );
      const stateChecks = results.map(({ k, pass, evidence, frame }) => ({
        k,
        pass,
        evidence,
        frame,
      }));
      const failed = results.filter((c) => !c.pass);
      logs.push(
        `round ${r.n}: the harness's state checks: ${results.map((c) => `${c.k + 1} ${c.pass ? "PASS" : "FAIL"}`).join(", ")}`,
      );
      if (failed.length === 0) return at({ phase: "tester-facts", stateChecks });
      // The same builder fixes what the checks showed, in this round, while its
      // context is warm: a failed fact costs minutes, not the round.
      if (r.fixes < MAX_FIXES && r.block !== null && remaining(s, now) > ROUND_RESERVE_MS) {
        logs.push(
          `round ${r.n}: fix turn ${r.fixes + 1} of ${MAX_FIXES} for the failed state checks`,
        );
        return at({
          phase: "block",
          stateChecks,
          fixes: r.fixes + 1,
          block: {
            ...r.block,
            direction: Roles.fixChecks(failed, rung, s.lane),
            msLeft: FIX_MS,
            quiet: 0,
            turns: Math.max(1, r.block.turns),
          },
        });
      }
      // Out of fix turns: the round fails on its facts, without a tester or judges.
      const checks = rung.checks.map((c, k) => {
        const scored = stateChecks.find((x) => x.k === k);
        return {
          what: c.what,
          pass: scored?.pass ?? false,
          evidence: scored?.evidence ?? "not tested: the state checks failed first",
        };
      });
      logs.push(`round ${r.n}: the state checks still fail after ${r.fixes} fix turns`);
      return at({ phase: "restore", stateChecks, checks });
    }
    case "reject":
      return stallRound(
        s,
        { ...r, record: { ...r.record, note: "" } },
        r.record.note ?? "boot failed",
        now,
        logs,
      );
    case "tester-facts":
      return at({ phase: "tester", jev: res.kind === "facts" && res.jev });
    case "tester":
      return res.kind === "done"
        ? at({ phase: "tester-write", thread: res.threadId, ...testedBot(res, r) })
        : at({ phase: "restore" });
    case "tester-write":
    case "tester-duty": {
      const bot = testedBot(res, r);
      const rung = rungOf(s, r);
      const sub = submitted(res, "checks");
      const notes = sub?.notes.trim() ?? "";
      const testerNotes = notes.length > 20 ? notes : r.testerNotes;
      if (sub !== null && notes.length > 20)
        files.push({ path: `.studio/tester-${r.n}.md`, text: `${notes}\n` });
      // A submission's checks are held over a follow-up turn that submits none.
      const submittedChecks =
        rung === null ? [] : sub !== null ? submittedChecksOf(sub, rung) : r.checks;
      // The bot service's record of the tester's thread, which spans its
      // play, write and duty turns; the game folder's copy decides nothing.
      if (r.phase === "tester-write" && res.kind === "done" && res.bots === 0) {
        logs.push(`round ${r.n}: tester ran no bot; one follow-up turn asks for it`);
        return at({
          phase: "tester-duty",
          testerNotes,
          ...bot,
          ...(sub === null ? {} : { checks: submittedChecks }),
        });
      }
      const testerNote = testerNotes.split("\n").slice(0, 20).join("\n").slice(0, 600);
      const wrote = sub !== null || testerNotes.length > 20;
      const note = wrote ? r.record.note : noteOf(r, "tester write failed");
      // A check passes only on what was played: a tester with no explore input
      // and no bot run on record cannot have seen it, whatever it declares.
      const played =
        (res.kind === "done" && (res.evidence?.executedInputSteps ?? 0) > 0) ||
        (res.kind === "done" && res.bots > 0) ||
        r.bot !== "";
      // State checks were scored by the harness; the tester's lines count for look checks only.
      const isState = (k: number) => rung?.checks[k]?.kind === "state";
      const said = rung === null ? [] : submittedChecks;
      const declared = said.map((check, k) => {
        const scored = r.stateChecks.find((x) => x.k === k);
        return isState(k)
          ? {
              what: check.what,
              pass: scored?.pass ?? false,
              evidence: scored?.evidence ?? "not scored",
            }
          : check;
      });
      const checks = played
        ? declared
        : declared.map((check, k) =>
            isState(k)
              ? check
              : {
                  ...check,
                  pass: false,
                  evidence:
                    `no play on record for the tester (no explore input, no bot run); ${check.evidence}`.slice(
                      0,
                      400,
                    ),
                },
          );
      if (rung !== null && !played && declared.some((check, k) => check.pass && !isState(k)))
        logs.push(
          `round ${r.n}: the tester declared passes without any play on record; not counted`,
        );
      if (rung !== null) logs.push(`round ${r.n}: the tester's checks: ${checkLine(checks)}`);
      return at({
        phase: "restore",
        testerNotes,
        checks,
        ...bot,
        record: { ...r.record, testerNote, ...(note === undefined ? {} : { note }) },
      });
    }
    case "restore": {
      // A rung whose checks failed is not kept whatever judging says, so it is not judged.
      const rung = rungOf(s, r);
      if (rung !== null && !checksPassed(r, rung)) {
        const why = `rung checks failed (${checkLine(r.checks) || "none verified"})`;
        logs.push(`round ${r.n}: ${why}; not judged, candidate kept as build ${r.branch}`);
        return {
          ...s,
          lastFailure: `round ${r.n}: ${why}`,
          task: {
            ...r,
            phase: "outcome",
            outcome: "drop",
            reviewed: `the current best (this round's rung failed its checks; its candidate is set aside as build ${r.branch})`,
            record: { ...r.record, note: noteOf(r, `${why}; not judged`) },
          },
        };
      }
      // An unchanged build is the best itself: its passing checks land the rung.
      if (rung !== null && r.candidate === s.best) {
        logs.push(`round ${r.n}: the current build already passes the rung's checks; landed`);
        return {
          ...s,
          task: {
            ...r,
            phase: "outcome",
            outcome: "merge",
            record: { ...r.record, note: noteOf(r, "rung already met by the current build") },
          },
        };
      }
      // With a budget, judging starts only when both plays and both verdicts fit.
      if (remaining(s, now) < COMPARE_MIN_MS) {
        // Kept as a left round's work: its candidate's name is the next round's.
        logs.push(
          `round ${r.n}: budget leaves no time to judge; the round's work is kept as it is`,
        );
        return leaveRound(s, r);
      }
      const question =
        rung !== null
          ? Roles.GATE_QUESTION
          : Roles.roundQuestion(Roles.roundDirection(r.direction, r.repeating, lane));
      const cmp = newCompare(
        question,
        r.candidate,
        s.best,
        bit(input.coin, 0),
        // Which comparator sees the candidate as A is a coin too, so no
        // ordinal (thread order, step id) can tell a judge which build is new.
        bit(input.coin, 2) ? ["y", "x"] : ["x", "y"],
        r.bot,
        r.botDecider,
      );
      return at({ phase: "compare", cmp: gateCompare(s, r, cmp, logs) });
    }
    case "compare": {
      const cmp = applyCompare(r.cmp!, done, res, logs, release);
      const move = compareMove(cmp);
      if (move.kind !== "done") return at({ cmp });
      files.push(
        ...comparisonFiles(r.branch, input.id, cmp, move.gate, { x: "candidate", y: "best" }),
      );
      const record = { ...r.record, comparison: input.id };
      return classify(s, { ...r, cmp, record }, move.gate, logs);
    }
    case "outcome": {
      if (r.outcome === "merge" && g!.ok) {
        logs.push(`round ${r.n}: kept, the best is ${g!.sha.slice(0, 8)}`);
        const held = heldPlay(s, r);
        // The kept build is the candidate itself, so a play of it carries over exactly.
        const carried = held !== null && held.sha === g!.sha;
        return {
          ...s,
          best: g!.sha,
          played: carried ? { ...held, sha: g!.sha } : null,
          pending: null,
          task: {
            ...r,
            phase: "review-facts",
            reviewed: "the kept build (just merged)",
            record: { ...r.record, kept: true },
          },
        };
      }
      if (r.outcome === "merge")
        return {
          ...s,
          pending: null,
          task: {
            ...r,
            phase: "review-facts",
            reviewed: `the candidate in the folder (not kept: ${g!.detail})`.slice(0, 300),
            record: {
              ...r.record,
              note: noteOf(r, `not kept (${g!.detail}); its build stays ${r.branch}`.slice(0, 200)),
            },
          },
        };
      const record = g!.ok
        ? r.record
        : {
            ...r.record,
            note: noteOf(r, "the best build could not be restored; review plays the folder"),
          };
      return at({
        phase: "review-facts",
        record,
        ...(g!.ok ? {} : { reviewed: "the build in the folder (the best could not be restored)" }),
      });
    }
    case "review-facts": {
      const facts = res.kind === "facts" ? res.code : "";
      // A rung round's build was just played by its tester and blind players; the
      // reviewer writes the ledger from their evidence instead of playing it again.
      return r.rung !== null
        ? at({ phase: "review-write", facts, thread: null })
        : at({ phase: "review", facts });
    }
    case "review":
      if (res.kind === "done" && res.budgetCut)
        return finishRound(s, r, null, "budget", now, logs, files);
      return res.kind === "done"
        ? at({ phase: "review-write", thread: res.threadId })
        : finishRound(s, r, null, null, now, logs, files);
    case "review-write":
      return finishRound(
        s,
        r,
        res.kind === "done" ? res : null,
        res.kind === "done" && res.budgetCut ? "budget" : null,
        now,
        logs,
        files,
      );
  }
};

// The tester thread's latest play bot replaces the round's; a thread with none keeps it.
const testedBot = (res: StepResult, r: Round): Pick<Round, "bot" | "botDecider"> =>
  res.kind === "done" && res.bot !== null
    ? { bot: res.bot.file, botDecider: res.bot.decider }
    : { bot: r.bot, botDecider: r.botDecider };

const classify = (s: RunState, r: Round, gate: string | null, logs: string[]): RunState => {
  const c = r.cmp!;
  const j1 = gate === null ? finalJudge(c, "x") : null;
  const j2 = gate === null ? finalJudge(c, "y") : null;
  const reason = gate ?? "A comparator gave no verdict after retry.";
  const v = (j: Judge | null) => ({
    verdict: j?.verdict ?? "NONE",
    reason: j === null ? reason : j.reason,
  });
  const verdicts = [
    { order: "A=candidate,B=best", ...v(j1) },
    { order: "A=best,B=candidate", ...v(j2) },
  ];
  const kind = classifyComparePair(verdicts[0]!.verdict, verdicts[1]!.verdict);
  const round = (patch: Partial<Round>, record: Partial<Round["record"]>): Round => ({
    ...r,
    phase: "outcome",
    ...patch,
    record: { ...r.record, verdicts, ...record },
  });
  if (kind === "candidate-wins") return { ...s, task: round({ outcome: "merge" }, {}) };
  // Here a ladder round's checks passed: they carry the signal, and judging only
  // blocks a build the old one clearly beats.
  // A missing verdict is no evidence of "no regression" when the other one
  // prefers the best, or when the evidence gate stopped judging (a blind player
  // got no input into a build).
  const favoursBest = verdicts[0]!.verdict === "B" || verdicts[1]!.verdict === "A";
  const blindGate = kind === "unjudged" && (gate !== null || favoursBest);
  if (r.rung !== null && kind !== "best-wins" && !blindGate) {
    const gate =
      kind === "unjudged"
        ? "judging gave no verdict"
        : `judging ${verdicts[0]!.verdict}/${verdicts[1]!.verdict}`;
    logs.push(`round ${r.n}: checks pass and ${gate} shows no regression; kept`);
    return {
      ...s,
      task: round({ outcome: "merge" }, { note: noteOf(r, `kept on its checks; ${gate}`) }),
    };
  }
  if (kind === "best-wins")
    return {
      ...s,
      pending: null,
      lastFailure: `round ${r.n}: rejected, best won both orders`,
      task: round(
        { outcome: "drop", reviewed: "the current best (last candidate rejected; best won both)" },
        { note: noteOf(r, "rejected: best won both orders") },
      ),
    };
  if (kind === "unjudged") {
    logs.push(`round ${r.n}: no judge verdicts after retry; candidate kept as build ${r.branch}`);
    const why = verdicts[0]!.verdict === "NONE" ? verdicts[0]!.reason : verdicts[1]!.reason;
    return {
      ...s,
      pending: null,
      lastFailure: `round ${r.n}: ${why}`.slice(0, 300),
      task: round(
        {
          outcome: "drop",
          reviewed: `the current best (last round unjudged; its candidate is set aside as build ${r.branch})`,
        },
        {
          unjudged: true,
          note: noteOf(r, "no judge verdicts after retry; candidate kept as a build"),
        },
      ),
    };
  }
  // A tie or split is an honest non-finding, never a keep: the best stands and
  // later rounds refine this candidate against the same judged best.
  const split = `${verdicts[0]!.verdict}/${verdicts[1]!.verdict}`;
  const pending = advancePending(s.pending, r.branch, r.n, verdicts, r.candidate);
  logs.push(
    `round ${r.n}: inconclusive ${split}; best stands, candidate kept as build ${r.branch}`,
  );
  const note = noteOf(
    r,
    `inconclusive (${split}); best stands, candidate kept as build ${r.branch}${pending === null ? "; pending dropped after 3 inconclusive rounds" : ""}`,
  );
  return {
    ...s,
    pending,
    task: round(
      {
        outcome: "hold",
        reviewed: `the current best (last round inconclusive ${split}; its candidate is set aside as build ${r.branch}; the top flaw below is still open)`,
      },
      { inconclusive: true, note },
    ),
  };
};

// The verdicts are in by now: a budget end during the review still records the round.
const finishRound = (
  s: RunState,
  r: Round,
  res: RoleDone | null,
  ending: string | null,
  now: number,
  logs: string[],
  files: Array<{ path: string; text: string }>,
): RunState => {
  const ledger = res === null ? null : submitted(res, "ledger");
  // The ledger leads the next round; next.md holds it for people and later roles.
  const next = (ledger?.ledger ?? "").trim().slice(0, 4000);
  if (next.length > 0) files.push({ path: ".studio/next.md", text: `${next}\n` });
  let note = r.record.note ?? "";
  if (next.length === 0) note = `${note} reviewer submitted no ledger`.trim();
  const settled = settleRung(
    s,
    r,
    {
      ...r.record,
      durationMs: now - r.startedAt,
      ...(note.length > 0 ? { note } : {}),
      ...(r.candidate.length > 0 ? { build: r.candidate } : {}),
    },
    logs,
  );
  const ladder = settled.state.ladder;
  const change = (id: number) =>
    ledger?.rungChange === undefined ? null : rungOfChange(ledger.rungChange, id);
  // The one place a judged or dropped round ends: kept resets the stall count,
  // anything else (rejected, unjudged, inconclusive, failed checks, a failed
  // merge) is one more stall, with its reason for a "stalled" ending.
  const kept = settled.record.kept;
  const state: RunState = {
    ...settled.state,
    ladder: r.rung === null || ladder === null ? ladder : insertRung(ladder, change, r.n, logs),
    rounds: [...s.rounds, settled.record],
    stage: `round-${r.n}`,
    next,
    lastDirection: r.direction,
    ending,
    stallStreak: kept ? 0 : s.stallStreak + 1,
    lastFailure: kept
      ? s.lastFailure
      : `round ${r.n}: ${settled.record.note || "nothing landed"}`.slice(0, 300),
  };
  const ship: RunState["task"] = { _tag: "ship", n: r.n, phase: "play", thread: null };
  // A stalled run ends at the next round's start, before any ship check.
  if (ending !== null || state.steer.length > 0 || state.stallStreak >= STALL_LIMIT)
    return { ...state, task: newRound(state, now) };
  // A finished ladder is the demo the run set out to build: the ship check plays
  // it before any polish is paid for.
  if (r.rung !== null && state.ladder !== null && ladderDone(state.ladder)) {
    logs.push(`round ${r.n}: the ladder is done; the ship check plays the game`);
    return { ...state, task: ship };
  }
  return { ...state, task: newRound(state, now) };
};

// Every rung landed, or came back once and was set aside again.
const ladderDone = (ladder: Ladder): boolean =>
  ladder.rungs.length > 0 &&
  ladder.rungs.every((x) => x.status === "done" || (x.status === "set-aside" && x.back));
