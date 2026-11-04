// PURE. Every loop decision: stage order, the ladder, round structure, keep or revert,
// stalls, the pending line, ship and budget. No I/O and no clock: time and randomness are inputs.
import type { GameBotDecider, ThreadId } from "@kurambit/contracts";
import { laneProfile } from "../engineProfile.ts";
import * as Roles from "./roles.ts";
import { BLANK, parseLadder, parseRungChange } from "./state.ts";
import type {
  Block,
  BotFact,
  Compare,
  DecideStep,
  Decided,
  Decision,
  Evidence,
  GitOp,
  Half,
  Judge,
  Ladder,
  PairStep,
  Pending,
  Picked,
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
const ART_REVIEW = ".studio/art-review.md";
const LADDER = Roles.LADDER_FILE;
const RUNG_CHANGE = Roles.RUNG_CHANGE_FILE;
// A rung that fails in this many rounds is set aside for the next.
const RUNG_TRIES = 2;
// A reviewer's insertions stop growing the ladder past this.
const LADDER_MAX = 10;

export type Inputs = { readonly now: number; readonly coin: number; readonly id: string };

export type RoleDone = {
  readonly kind: "done";
  readonly threadId: ThreadId;
  readonly text: string;
  readonly files: Readonly<Record<string, string>>;
  readonly evidence: Evidence | null;
  readonly timedOut: boolean;
  readonly budgetCut: boolean;
  readonly elapsedMs: number;
  readonly sourceBefore: string;
  readonly sourceAfter: string;
  readonly botsBefore: number;
  readonly botsAfter: number;
  /** The play bot this turn last ran and its decider, null when it ran none. */
  readonly bot: { readonly file: string; readonly decider: GameBotDecider } | null;
  /** The step's sheet when the runner drew one, else "". */
  readonly sheet: string;
};
/** One shape for every git op; each op fills the fields it knows. */
export type GitOutcome = {
  readonly ok: boolean;
  readonly sha: string;
  readonly branch: string;
  readonly changed: boolean;
  readonly entered: boolean;
  readonly lines: number;
  readonly detail: string;
};
export type StepResult =
  | RoleDone
  | {
      readonly kind: "ended";
      readonly ending: "usage-limit" | "provider-down" | "low-memory";
      readonly reason: string;
    }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "git"; readonly git: GitOutcome }
  | { readonly kind: "boot"; readonly ok: boolean; readonly detail: string }
  | { readonly kind: "facts"; readonly jev: boolean; readonly code: string }
  | { readonly kind: "bot"; readonly fact: Omit<BotFact, "side"> }
  | { readonly kind: "note" }
  | {
      readonly kind: "decided";
      readonly answer: string;
      readonly notes: string;
      readonly by: Decided["by"];
    };

export type Planned =
  | {
      readonly kind: "step";
      readonly state: RunState;
      readonly step: Step;
      /** Decisions made while planning, for the run log. */
      readonly logs?: ReadonlyArray<string>;
    }
  | { readonly kind: "end"; readonly reason: string };
export type Applied = {
  readonly state: RunState;
  readonly logs: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  /** Role threads with no turn left, whose worktrees the driver now removes. */
  readonly release: ReadonlyArray<ThreadId>;
};

// ── Declared lines. Code never interprets any other prose. ─────────────────
const lastDeclared = (text: string, re: RegExp): string | null => {
  const found = [...text.matchAll(re)].at(-1);
  return found === undefined ? null : (found[1] ?? "").toUpperCase();
};
const parseStatus = (text: string) =>
  lastDeclared(text, /^STATUS:\s*(continue|ready)\s*$/gim)?.toLowerCase() ?? null;
const parseShip = (text: string) => lastDeclared(text, /^SHIP:\s*(YES|NO)\s*$/gim);
const parseCompare = (text: string) => lastDeclared(text, /^COMPARE:\s*(A|B|TIE)\s*$/gim);
const parseSelect = (text: string) => lastDeclared(text, /^SELECT:\s*(A|B)\s*$/gim);
const ART_LINE = /^ART:\s*(KEEP|REDO)\s*$/gim;
const parseArt = (text: string) => lastDeclared(text, ART_LINE);
// The tester's line per check; the last one for a check wins, a missing one fails.
// Notes are Markdown, so bold, bullets, headings and words after the verdict
// are formatting, not a different answer.
const CHECK_LINE = /^CHECK\s+(\d+)\s*[:\-–—]\s*(PASS|FAIL)\b/i;
const checkText = (line: string) =>
  line
    .replace(/[*_`]/g, "")
    .replace(/^[\s>#\-+•]*(?:\d+[.)]\s*)?/, "")
    .trim();
const parseChecks = (text: string, rung: Rung): Round["checks"] => {
  const lines = text.split("\n").map(checkText);
  return rung.checks.map((check, i) => {
    const at = lines.findLastIndex((line) => CHECK_LINE.exec(line)?.[1] === `${i + 1}`);
    if (at < 0)
      return { what: check.what, pass: false, evidence: "the tester declared no CHECK line" };
    const end = lines.findIndex((line, j) => j > at && CHECK_LINE.test(line));
    const evidence = lines
      .slice(at + 1, end < 0 ? undefined : end)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    return {
      what: check.what,
      pass: CHECK_LINE.exec(lines[at]!)?.[2]?.toUpperCase() === "PASS",
      evidence,
    };
  });
};
const reasonsAfter = (text: string, re: RegExp): string => {
  const lines = text.split("\n");
  const at = lines.findLastIndex((line) => re.test(line));
  return lines
    .slice(at + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
};

// ── Pure round decisions. ─────────────────────────────────────────────────
export type PairKind = "best-wins" | "candidate-wins" | "inconclusive" | "unjudged";

/** Order 1 is A=candidate, order 2 is A=best. The candidate must win both. */
export const classifyComparePair = (order1: string, order2: string): PairKind => {
  if (order1 === "B" && order2 === "A") return "best-wins";
  if (order1 === "NONE" || order2 === "NONE") return "unjudged";
  if (order1 === "A" && order2 === "B") return "candidate-wins";
  return "inconclusive";
};

/** Three consecutive inconclusive rounds drop the pending line and count one stall. */
export const advancePending = (
  current: Pending | null,
  branch: string,
  round: number,
  verdicts: ReadonlyArray<Verdict>,
): { pending: Pending | null; dropStall: boolean } => {
  const streak = (current?.streak ?? 0) + 1;
  if (streak >= 3) return { pending: null, dropStall: true };
  return { pending: { branch, round, verdicts, streak }, dropStall: false };
};

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

/** The branch the tree must be on before the next non-git step, for resume. */
export const expectedBranch = (state: RunState): string | null => {
  const t = state.task;
  if (state.trunk.length === 0 || t._tag === "init") return null;
  if (t._tag === "proto" && t.phase !== "role" && t.phase !== "commit") return t.branch;
  if (t._tag === "leave") return t.branch;
  if (
    t._tag === "round" &&
    t.branch.length > 0 &&
    !["start", "review-facts", "review", "review-write"].includes(t.phase)
  )
    return t.branch;
  return state.trunk;
};

// ── The ladder. ───────────────────────────────────────────────────────────
/** The finish stage also begins with the budget's last fifth, whatever the ladder holds. */
const lastFifth = (state: RunState, now: number): boolean =>
  state.budgetMinutes !== null &&
  state.budgetEndsAt !== null &&
  remaining(state, now) < (state.budgetMinutes * MIN) / 5;

type RungPick =
  | {
      readonly kind: "rung";
      readonly ladder: Ladder;
      readonly rung: Rung;
      readonly logs: ReadonlyArray<string>;
    }
  | { readonly kind: "finish"; readonly why: string };

// The first open rung, else a set-aside one back for its one more try, else the finish.
const pickRung = (ladder: Ladder, state: RunState, now: number): RungPick => {
  if (ladder.rungs.length === 0)
    return { kind: "finish", why: ladder.note || "the run has no ladder" };
  if (lastFifth(state, now)) return { kind: "finish", why: "the budget's last fifth began" };
  const open = ladder.rungs.find((x) => x.status === "todo");
  if (open !== undefined) return { kind: "rung", ladder, rung: open, logs: [] };
  const i = ladder.rungs.findIndex((x) => x.status === "set-aside" && !x.back);
  if (i < 0) return { kind: "finish", why: "the ladder is done" };
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
// work instead of rebuilding from the best: trunk has not moved since, and the
// blind gate still judges the result against the best.
const retryFrom = (state: RunState, rung: Rung): string | null => {
  const last = state.rounds.at(-1);
  const result = last?.rung;
  if (last === undefined || result === undefined || result.rung !== rung.id) return null;
  if (result.outcome !== "failed" || !result.checks.some((c) => c.pass)) return null;
  return last.branch.length > 0 ? last.branch : null;
};

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

type Taken =
  | { readonly kind: "ladder"; readonly ladder: Ladder }
  | { readonly kind: "fix"; readonly thread: ThreadId; readonly error: string };

// One fix turn for a ladder of the wrong shape; after it the run goes on without one.
const takeLadder = (res: StepResult, last: boolean, logs: string[]): Taken => {
  const parsed = parseLadder(res.kind === "done" ? (res.files[LADDER] ?? "") : "");
  if ("ladder" in parsed) {
    logs.push(
      `ladder: ${parsed.ladder.rungs.length} rungs`,
      ...parsed.ladder.rungs.map((x, i) => `  rung ${i + 1}: ${x.is}`),
    );
    return { kind: "ladder", ladder: parsed.ladder };
  }
  if (!last && res.kind === "done") {
    logs.push(
      `ladder: ${LADDER} has the wrong shape; one fix turn (${parsed.error.slice(0, 200)})`,
    );
    return { kind: "fix", thread: res.threadId, error: parsed.error };
  }
  logs.push(`ladder: no valid ${LADDER} (${parsed.error.slice(0, 200)}); finish rounds only`);
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
const insertRung = (ladder: Ladder, text: string, n: number, logs: string[]): Ladder => {
  const parsed = parseRungChange(text, Math.max(0, ...ladder.rungs.map((x) => x.id)) + 1);
  if (parsed === null) return ladder;
  const refused =
    "error" in parsed
      ? `wrong shape (${parsed.error})`
      : ladder.rungs.some((x) => x.from === "reviewer" && x.status === "todo")
        ? "an earlier one is still open"
        : ladder.rungs.length >= LADDER_MAX
          ? `the ladder already has ${LADDER_MAX} rungs`
          : null;
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
  text: booted.map((p) => `${protoName(p.i)} is on branch ${p.branch}.`).join("\n"),
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
  logs.push("pick: no prototype booted; building from trunk");
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
      if (answer === "rewrite")
        return { ...s, task: { ...stageTask("plan"), phase: "revise", review: notes } };
      const edited = answer === "edit" ? parseLadder(notes) : null;
      return proceed(
        edited !== null && "ladder" in edited ? { ...s, ladder: edited.ladder } : s,
        "plan",
        input.now,
      );
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
const git = (id: number, op: GitOp): Step => ({ kind: "git", id, op });
const ladderSpec = (t: Extract<Task, { _tag: "ladder" }>): RoleSpec =>
  t.phase === "write"
    ? {
        role: "plan",
        title: "studio ladder",
        prompt: Roles.ladderWrite(),
        capMs: CAP.plan,
        read: [LADDER],
        clear: [LADDER],
      }
    : {
        role: "plan",
        title: "studio ladder",
        thread: t.thread,
        prompt: Roles.ladderFix(t.error),
        capMs: CAP.ladderFix,
        read: [LADDER],
      };
const bit = (coin: number, k: number) => Math.floor(coin * 2 ** (k + 1)) % 2 === 1;

const textOf = (res: RoleDone, file: string): string => {
  const written = (res.files[file] ?? "").trim();
  if (written.length > 20) return written;
  return res.text.trim().length > 20 ? res.text.trim() : written;
};

const newBlock = (tag: string, direction: string, whole: boolean, msLeft: number): Block => ({
  tag,
  direction,
  whole,
  msLeft,
  thread: null,
  quiet: 0,
  source: "",
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
  });

/** A finished turn may need follow-up, but a turn without a game-file change ends the block. */
const advanceBlock = (b: Block, res: RoleDone): { block: Block; over: boolean } => {
  const prev = b.turns === 0 ? res.sourceBefore : b.source;
  const quiet = res.sourceAfter.length > 0 && res.sourceAfter === prev ? b.quiet + 1 : 0;
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
});
const lastSample = (c: Compare, side: Side): Sample | null =>
  c.samples.findLast((s) => s.side === side) ?? null;
const usable = (s: Sample | null) =>
  s !== null && s.phase === "done" && validatePlayEvidence(s.evidence, s.evidence) === null;
const sampleFile = (s: Pick<Sample, "label">) => `.studio/play-${s.label}.md`;
// The game root keeps each comparator's write-up here once the comparison is over.
const judgeFile = (j: Pick<Judge, "id">) => `.studio/comparisons/${j.id}.md`;
const sheetFile = (s: Pick<Sample, "label">) => `.studio/comparisons/frames-${s.label}.jpg`;
// A comparator sees only these names in its own BLANK worktree; none carries a
// label, judge id or sha, and A and B follow its order, not the builds.
const VERDICT = ".compare/verdict.md";
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
): { sample: Sample | null; step: RoleStep } => {
  const at = move.side === "x" ? c.x : c.y;
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
    read: [sampleFile(s)],
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
      sha: side === "x" ? c.x : c.y,
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
      sampleStep(id + i, c, m, m.current === null && fresh++ > 0 ? `${input.id}b` : input.id),
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
          VERDICT,
          botsShown(c),
          sheets ? SHEET : null,
        ),
        capMs: CAP.write,
        read: [VERDICT],
      });
      return { cmp: { ...c, judges: [...c.judges, j] }, step, logs: [] };
    }
    const j = move.current;
    const step = role(id, {
      role: `compare-${j.id}`,
      title: "studio blind comparison",
      thread: j.thread,
      at: BLANK,
      prompt: Roles.correct(VERDICT),
      capMs: CAP.write,
      read: [VERDICT],
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
                notes: textOf(res, sampleFile(s)),
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
  const text = textOf(res, VERDICT);
  const verdict = parseCompare(text);
  const next: Judge =
    verdict === null && j.phase === "compare"
      ? { ...j, thread: res.threadId, phase: "correct", notes: text }
      : {
          ...j,
          thread: res.threadId,
          phase: "done",
          verdict: verdict ?? "NONE",
          reason: reasonsAfter(text, /^COMPARE:\s*(A|B|TIE)\s*$/i),
          notes: text,
        };
  if (next.phase === "done") release.push(res.threadId);
  if (next.phase === "done" && next.verdict === "NONE" && j.attempt === 0)
    logs.push(`comparator gave no verdict (A=${j.aIs}); retrying once`);
  return { ...c, judges: c.judges.with(ji, next) };
};

// The comparison's record, written once the verdicts are in, with each
// comparator's write-up. The build mapping is in the game root all along
// (run.json and run.log name every sample's sha); comparators stay blind by
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
    path: `.studio/comparisons/${tag}-${id}.json`,
    text: `${JSON.stringify(
      {
        [names.x]: c.x,
        [names.y]: c.y,
        playOrder: c.xFirst ? `${names.x},${names.y}` : `${names.y},${names.x}`,
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
    botsBefore: 0,
    bot: "",
    botDecider: "policy",
    testerNotes: "",
    rung: null,
    continued: false,
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
          ),
        ),
      };
  }
  return { ...state, stage: done === "art" ? "build" : done, task: newRound(state, now) };
};

const end = (reason: string): Planned => ({ kind: "end", reason });
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

export const plan = (state: RunState, input: Inputs): Planned => {
  if (state.inFlight !== null) return { kind: "step", state, step: state.inFlight };
  const id = state.seq + 1;
  const t = state.task;
  const lane = state.lane;
  const go = (s: Step, task: Task = t, logs: ReadonlyArray<string> = []) =>
    step(state, task, s, logs);
  const run = (op: GitOp, task: Task = t) => go(git(id, op), task);
  const act = (spec: RoleSpec) => go(role(id, spec));
  const reject = (label: string, why: string) =>
    run({ _tag: "reject", label, why, trunk: state.trunk, best: state.best });
  const toTrunk = (message: string) => run({ _tag: "to-trunk", trunk: state.trunk, message });
  const artCap = (cap: number) =>
    Math.max(FLOOR_MS, fit(state, input.now, cap, BUILD_RESERVE_MS + FLOOR_MS));
  switch (t._tag) {
    case "init":
      return run({ _tag: "init" });
    case "stage": {
      const name = t.name;
      if (t.phase === "review")
        return act({
          role: "art-director",
          title: "studio art director",
          prompt: Roles.artReview(lane),
          capMs: artCap(CAP.artReview),
          read: [ART_REVIEW],
          clear: [ART_REVIEW],
        });
      if (t.phase === "revise")
        return name === "plan"
          ? act({
              role: "plan",
              prompt: Roles.ladderRevise(t.review),
              capMs: CAP.plan,
              read: [LADDER],
            })
          : act({ role: name, prompt: Roles.visionRevise(t.review, lane), capMs: CAP.vision });
      if (t.phase === "redo" && name === "plan")
        return act({
          role: "plan",
          thread: t.thread,
          prompt: Roles.ladderFix(t.review),
          capMs: CAP.ladderFix,
          read: [LADDER],
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
              ...(name === "plan" ? { read: [LADDER], clear: [LADDER] } : {}),
            });
      if (t.phase === "commit") return run({ _tag: "commit", message: t.name, base: state.best });
      return t.phase === "boot" ? go({ kind: "boot", id }) : reject(t.name, t.why);
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
      if (t.phase === "commit") return run({ _tag: "branch-commit", name, message: name });
      if (t.phase === "boot") return go({ kind: "boot", id });
      return t.phase === "keep" ? toTrunk(name) : reject(t.branch, t.why);
    }
    case "pick": {
      if (t.phase === "adopt")
        return run({ _tag: "adopt", trunk: state.trunk, sha: t.chosen, label: t.chosen });
      const j = finalJudge(t.cmp, "x");
      if (t.phase === "select")
        return act({
          role: `compare-${j?.id ?? "select"}`,
          title: "studio blind comparison",
          thread: j?.thread ?? null,
          at: BLANK,
          prompt: Roles.SELECT,
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
            prompt: Roles.SHIP_WRITE,
            capMs: CAP.write,
            read: [".studio/ship.md"],
          });
    case "leave":
      return t.phase === "restore"
        ? run({ _tag: "restore-commit", sha: t.candidate, message: t.branch })
        : toTrunk(t.branch);
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
  const tester = (prompt: string, capMs: number, read: string[] = []) =>
    act({ role: `tester-${n}`, thread: r.thread, prompt, capMs, read, bots: true });
  switch (r.phase) {
    case "start": {
      if (state.stallStreak >= 3) return end("stalled");
      if (remaining(state, input.now) < ROUND_RESERVE_MS) return end("budget");
      if (state.ladder === null) {
        const task: Task = { _tag: "ladder", phase: "write", thread: null, error: "" };
        return go(role(id, ladderSpec(task)), task, [
          `round ${n}: the run has no ladder yet; the plan writes one first`,
        ]);
      }
      const steer = state.steer.length === 0 ? {} : { steer: state.steer };
      const start = (from: string | null): GitOp => ({
        _tag: "start-round",
        trunk: state.trunk,
        key: `round-${n}`,
        from,
      });
      const pick = pickRung(state.ladder, state, input.now);
      if (pick.kind === "finish") {
        const { direction, repeating } = roundDirection(state);
        const move = direction.slice(0, 300);
        const next: Round = {
          ...r,
          direction,
          repeating,
          move,
          record: { ...r.record, move, finish: true, ...steer },
        };
        return go(git(id, start(state.pending?.branch ?? null)), next, [
          `round ${n}: finish round (${pick.why})`,
        ]);
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
        rung: rung.id,
        direction,
        repeating: false,
        move,
        record: { ...r.record, move, ...steer },
      };
      const logs = [...pick.logs, `round ${n} builds rung ${k} of ${total}: ${rung.is}`];
      // A ladder round starts from the judged best (or the try it retries); an open
      // pending line stays on its branch.
      if (state.pending !== null)
        logs.push(`round ${n}: pending ${state.pending.branch} stays on its branch`);
      return step({ ...state, ladder, pending: null }, next, git(id, start(from)), logs);
    }
    case "block":
    case "retry":
      return go(blockStep(id, r.block!, lane));
    case "commit":
    case "retry-commit":
      return run({ _tag: "commit", message: r.branch, base: state.best });
    case "stall":
      return toTrunk(r.branch);
    case "boot":
      return go({ kind: "boot", id });
    case "reject":
      return reject(r.branch, r.record.note ?? "");
    case "tester-facts":
    case "review-facts":
      return go({ kind: "facts", id });
    case "tester":
      return tester(
        Roles.testerPlay(n, r.jev, rungOf(state, r), r.continued ? lastTryOf(state, r) : ""),
        CAP.tester,
      );
    case "tester-write":
      return tester(Roles.testerWrite(n, r.move, rungOf(state, r)), CAP.write, [
        `.studio/tester-${n}.md`,
      ]);
    case "tester-duty":
      return tester(Roles.BOT_DUTY, CAP.duty, [`.studio/tester-${n}.md`]);
    case "restore":
      return run({ _tag: "restore-commit", sha: r.candidate, message: r.branch });
    case "compare": {
      const made = compareStep(id, r.cmp!, input, state);
      return go(made.step, { ...r, cmp: made.cmp }, made.logs);
    }
    case "outcome":
      return r.outcome === "merge"
        ? run({ _tag: "ff-merge", trunk: state.trunk, branch: r.branch })
        : toTrunk(r.branch);
    case "review":
      return act({
        role: `reviewer-${n}`,
        prompt: Roles.reviewerPlay(n, r.reviewed, r.facts),
        capMs: CAP.reviewer,
        clear: [".studio/next.md", RUNG_CHANGE],
      });
    case "review-write": {
      const [o1, o2] = r.record.verdicts;
      const word = r.record.kept
        ? "kept"
        : r.record.inconclusive === true
          ? "inconclusive, flaw still open"
          : "rejected/unjudged";
      const verdicts = `${o1?.verdict ?? "NONE"}/${o2?.verdict ?? "NONE"} (${word})`;
      const read = [`.studio/reviewer-${n}.md`, ".studio/next.md"];
      const rung = rungOf(state, r);
      if (rung !== null && state.ladder !== null) {
        const k = positionOf(state.ladder, rung);
        const built = `it built rung ${k} (${rung.is}); the tester's checks: ${checkLine(r.checks) || "none verified"}; ${r.record.kept ? "kept" : `not kept (${r.record.note ?? ""})`}; judging ${verdicts}.`;
        return act({
          role: `reviewer-${n}`,
          prompt: Roles.reviewerLedger(n, built, ladderText(state.ladder, rung.id), r.facts),
          capMs: CAP.reviewer,
          clear: [".studio/next.md", RUNG_CHANGE],
          read: [...read, RUNG_CHANGE],
        });
      }
      return act({
        role: `reviewer-${n}`,
        thread: r.thread,
        prompt: Roles.reviewerWrite(n, r.move, verdicts, r.facts),
        capMs: CAP.write,
        read,
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
    { ...r.record, note: noteOf(r, note), durationMs: now - r.startedAt },
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

// A budget end inside a round puts the candidate back on its branch and
// returns to trunk, so the exports are of the judged best.
const leaveRound = (state: RunState, r: Round): RunState => ({
  ...state,
  task: {
    _tag: "leave",
    branch: r.branch,
    candidate: r.candidate,
    phase: r.candidate.length > 0 ? "restore" : "trunk",
  },
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
      // A budget-cut half already gave its own checkout back in the role runner.
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
  const g = res.kind === "git" ? res.git : null;
  const now = input.now;
  switch (t._tag) {
    case "init":
      return out(afterStage({ ...s, trunk: g!.branch, best: g!.sha }, s.stage, now));
    case "decide":
      return out(
        decide(
          s,
          t.decision,
          res.kind === "decided" ? { answer: res.answer, notes: res.notes, by: res.by } : null,
          input,
          logs,
        ),
      );
    case "stage": {
      const artFits = (cap: number) => fit(s, now, cap, BUILD_RESERVE_MS + FLOOR_MS) >= FLOOR_MS;
      // The creator's rewrite keeps the old ladder when the new one has the wrong shape.
      if (t.name === "plan" && t.phase === "revise") {
        const parsed = parseLadder(res.kind === "done" ? (res.files[LADDER] ?? "") : "");
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
        const taken = takeLadder(res, t.phase === "redo", logs);
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
        const text = res.kind === "done" ? textOf(res, ART_REVIEW) : "";
        const verdict = parseArt(text);
        if (verdict === null)
          logs.push(
            `art review declared no ART: KEEP or ART: REDO${res.kind === "failed" ? ` (${res.reason})` : ""}; keeping the art`,
          );
        if (verdict !== "REDO") return out({ ...s, task: { ...t, phase: "commit" } });
        if (!artFits(CAP.artRedo)) {
          logs.push("art review asked for a redo, but the budget leaves no room; keeping the art");
          return out({ ...s, task: { ...t, phase: "commit" } });
        }
        logs.push("art review: REDO; one redo turn with its defect list");
        const defects = text.replace(ART_LINE, "").trim().slice(0, 3000);
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
        if (g!.sha === s.best) return out(afterStage(s, t.name, now));
        if (!g!.changed) return out(afterStage({ ...s, best: g!.sha }, t.name, now));
        return out({ ...s, task: { ...t, phase: "boot", sha: g!.sha } });
      }
      if (t.phase === "boot" && res.kind === "boot") {
        if (res.ok) return out(afterStage({ ...s, best: t.sha }, t.name, now));
        return out({ ...s, task: { ...t, phase: "reject", why: res.detail } });
      }
      logs.push(`${t.name}: boot failed, work saved on ${g?.branch ?? "a rejected branch"}`);
      return out(afterStage(s, t.name, now));
    }
    case "proto": {
      if (t.phase === "role") return out({ ...s, task: { ...t, phase: "commit" } });
      if (t.phase === "commit")
        return out({ ...s, task: { ...t, phase: "boot", branch: g!.branch } });
      if (t.phase === "boot" && res.kind === "boot")
        return out({ ...s, task: { ...t, phase: res.ok ? "keep" : "reject", why: res.detail } });
      // Only prototypes that booted compete or become the base.
      const protos = [...s.protos, { branch: t.branch, booted: t.phase === "keep" }];
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
        const text = res.kind === "done" ? res.text : "";
        const chosen = parseSelect(text);
        if (chosen === null) {
          logs.push("pick tie unresolved: building from trunk with the tie recorded");
          return out(afterStage({ ...s, pickNotes: t.notes }, "pick", now));
        }
        const notes = `${pickLegend(chosen)}\n${t.notes}\nSELECT: ${chosen} (continuation choice on tied comparison; no demonstrated preference)\n${reasonsAfter(text, /^SELECT:\s*(A|B)\s*$/i)}`;
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
      const text = res.kind === "done" ? textOf(res, ".studio/ship.md") : "";
      // A creator note that arrived during the ship review still gets its round.
      if (parseShip(text) === "YES" && s.steer.length === 0) return out({ ...s, ending: "ready" });
      const reasons =
        text
          .split(/SHIP:\s*(?:YES|NO)/i)
          .pop()
          ?.trim()
          .slice(0, 500) ?? "";
      return out({ ...s, shipNoReasons: reasons, task: newRound(s, now) });
    }
    case "ladder": {
      const taken = takeLadder(res, t.phase === "fix", logs);
      if (taken.kind === "fix")
        return out({
          ...s,
          task: { ...t, phase: "fix", thread: taken.thread, error: taken.error },
        });
      return out({ ...s, ladder: taken.ladder, task: newRound(s, now) });
    }
    case "leave":
      if (t.phase === "restore") return out({ ...s, task: { ...t, phase: "trunk" } });
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
  const g = res.kind === "git" ? res.git : null;
  const at = (round: Partial<Round>): RunState => ({ ...s, task: { ...r, ...round } });
  switch (r.phase) {
    case "start": {
      if (!g!.ok)
        return stallRound(
          s,
          r,
          `stalled (cannot reach ${s.trunk}: ${g!.detail})`.slice(0, 300),
          now,
          logs,
        );
      if (r.repeating)
        logs.push(
          `round ${r.n}: no next.md from the last review; repeating the previous direction`,
        );
      let pending = s.pending;
      if (pending !== null && !g!.entered) {
        logs.push(
          `round ${r.n}: pending ${pending.branch} unreachable; continuing from ${s.trunk}`,
        );
        pending = null;
      } else if (pending !== null)
        logs.push(
          `round ${r.n}: refining pending ${pending.branch} against best ${s.best.slice(0, 8)}`,
        );
      const ms = fit(s, now, r.rung === null ? CAP.block : CAP.rung, ROUND_RESERVE_MS);
      const continued = r.rung !== null && g!.entered === true;
      if (continued) logs.push(`round ${r.n}: continues the last try's work`);
      const round = {
        ...r,
        branch: g!.branch,
        base: g!.sha,
        continued,
        record: { ...r.record, branch: g!.branch },
      };
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
          block: newBlock(`${r.n}`, direction, r.rung !== null, ms),
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
    case "boot":
      if (res.kind === "boot" && res.ok) return at({ phase: "tester-facts" });
      return at({
        phase: "reject",
        record: {
          ...r.record,
          note: `boot failed: ${res.kind === "boot" ? res.detail : "unknown"}`.slice(0, 300),
        },
      });
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
        ? at({
            phase: "tester-write",
            thread: res.threadId,
            botsBefore: res.botsBefore,
            ...testedBot(res, r),
          })
        : at({ phase: "restore" });
    case "tester-write":
    case "tester-duty": {
      const bot = testedBot(res, r);
      const notes = res.kind === "done" ? textOf(res, `.studio/tester-${r.n}.md`) : "";
      const testerNotes = notes.length > 20 ? notes : r.testerNotes;
      if (r.phase === "tester-write" && res.kind === "done" && res.botsAfter <= r.botsBefore) {
        logs.push(`round ${r.n}: tester ran no bot; one follow-up turn asks for it`);
        return at({ phase: "tester-duty", testerNotes, ...bot });
      }
      const testerNote = testerNotes.split("\n").slice(0, 20).join("\n").slice(0, 600);
      const note = testerNotes.length > 20 ? r.record.note : noteOf(r, "tester write failed");
      const rung = rungOf(s, r);
      // A check passes only on what was played: a tester with no explore input
      // and no bot run on record cannot have seen it, whatever it declares.
      const played =
        (res.kind === "done" && (res.evidence?.executedInputSteps ?? 0) > 0) ||
        (res.kind === "done" && res.botsAfter > r.botsBefore) ||
        r.bot !== null;
      const declared = rung === null ? [] : parseChecks(testerNotes, rung);
      const checks = played
        ? declared
        : declared.map((check) => ({
            ...check,
            pass: false,
            evidence:
              `no play on record for the tester (no explore input, no bot run); ${check.evidence}`.slice(
                0,
                400,
              ),
          }));
      if (rung !== null && !played && declared.some((check) => check.pass))
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
        logs.push(`round ${r.n}: ${why}; not judged, candidate stays on branch ${r.branch}`);
        return {
          ...s,
          lastFailure: `round ${r.n}: ${why}`,
          task: {
            ...r,
            phase: "outcome",
            outcome: "drop",
            reviewed: `the current best (this round's rung failed its checks; its candidate stays on branch ${r.branch} unmerged)`,
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
        logs.push(
          `round ${r.n}: budget leaves no time to judge; candidate stays on branch ${r.branch}`,
        );
        return { ...s, task: { _tag: "leave", branch: r.branch, candidate: "", phase: "trunk" } };
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
      return at({ phase: "compare", cmp });
    }
    case "compare": {
      const cmp = applyCompare(r.cmp!, done, res, logs, release);
      const move = compareMove(cmp);
      if (move.kind !== "done") return at({ cmp });
      files.push(
        ...comparisonFiles(r.branch, input.id, cmp, move.gate, { x: "candidate", y: "best" }),
      );
      return classify(s, { ...r, cmp }, move.gate, logs);
    }
    case "outcome": {
      if (r.outcome === "merge" && g!.ok) {
        logs.push(`round ${r.n}: kept, ${s.trunk} at ${g!.sha.slice(0, 8)}`);
        return {
          ...s,
          best: g!.sha,
          stallStreak: 0,
          pending: null,
          task: {
            ...r,
            phase: "review-facts",
            reviewed: "the kept build (just merged)",
            record: { ...r.record, kept: true },
          },
        };
      }
      if (r.outcome === "merge") {
        const onTrunk = g!.branch === s.trunk;
        return {
          ...s,
          stallStreak: s.stallStreak + 1,
          pending: null,
          task: {
            ...r,
            phase: "review-facts",
            reviewed: onTrunk
              ? `the current best (merge failed; candidate stays on branch ${r.branch} unmerged)`
              : `the unmerged candidate on branch ${r.branch} (merge skipped: cannot reach ${s.trunk})`,
            record: {
              ...r.record,
              note: noteOf(r, `merge failed (${g!.detail}); kept on branch`.slice(0, 200)),
            },
          },
        };
      }
      const record = g!.ok
        ? r.record
        : {
            ...r.record,
            note: noteOf(r, `cannot reach ${s.trunk}; review plays the round branch`),
          };
      return at({
        phase: "review-facts",
        record,
        ...(g!.ok
          ? {}
          : { reviewed: `the candidate on branch ${r.branch} (cannot reach ${s.trunk})` }),
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
      if (res.kind === "done" && res.budgetCut) return finishRound(s, r, null, "budget", now, logs);
      return res.kind === "done"
        ? at({ phase: "review-write", thread: res.threadId })
        : finishRound(s, r, null, null, now, logs);
    case "review-write":
      return finishRound(
        s,
        r,
        res.kind === "done" ? res : null,
        res.kind === "done" && res.budgetCut ? "budget" : null,
        now,
        logs,
      );
  }
};

// A tester turn's play bot replaces the round's; a turn that ran none keeps it.
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
      stallStreak: s.stallStreak + 1,
      pending: null,
      lastFailure: `round ${r.n}: rejected, best won both orders`,
      task: round(
        { outcome: "drop", reviewed: "the current best (last candidate rejected; best won both)" },
        { note: noteOf(r, "rejected: best won both orders") },
      ),
    };
  if (kind === "unjudged") {
    logs.push(`round ${r.n}: no judge verdicts after retry; kept on branch ${r.branch}`);
    const why = verdicts[0]!.verdict === "NONE" ? verdicts[0]!.reason : verdicts[1]!.reason;
    return {
      ...s,
      stallStreak: s.stallStreak + 1,
      pending: null,
      lastFailure: `round ${r.n}: ${why}`.slice(0, 300),
      task: round(
        {
          outcome: "drop",
          reviewed: `the current best (last round unjudged; its candidate stays on branch ${r.branch})`,
        },
        { unjudged: true, note: noteOf(r, "no judge verdicts after retry; kept on branch") },
      ),
    };
  }
  // A tie or split is an honest non-finding, never a keep: the best stands and
  // later rounds refine this candidate against the same judged best.
  const split = `${verdicts[0]!.verdict}/${verdicts[1]!.verdict}`;
  const advanced = advancePending(s.pending, r.branch, r.n, verdicts);
  logs.push(`round ${r.n}: inconclusive ${split}; best stands, kept on branch ${r.branch}`);
  const note = noteOf(
    r,
    `inconclusive (${split}); best stands, kept on branch ${r.branch}${advanced.dropStall ? "; pending dropped after 3 inconclusive rounds" : ""}`,
  );
  return {
    ...s,
    stallStreak: s.stallStreak + (advanced.dropStall ? 1 : 0),
    pending: advanced.pending,
    task: round(
      {
        outcome: "hold",
        reviewed: `the current best (last round inconclusive ${split}; its candidate stays on branch ${r.branch} unmerged; the top flaw below is still open)`,
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
): RunState => {
  const reviewerNotes = res === null ? "" : textOf(res, `.studio/reviewer-${r.n}.md`);
  const next = res === null ? "" : (res.files[".studio/next.md"] ?? "").trim().slice(0, 4000);
  let note = r.record.note ?? "";
  if (reviewerNotes.length <= 20) note = `${note} reviewer write failed`.trim();
  if (next.length === 0) note = `${note} reviewer wrote no next.md`.trim();
  const settled = settleRung(
    s,
    r,
    { ...r.record, durationMs: now - r.startedAt, ...(note.length > 0 ? { note } : {}) },
    logs,
  );
  const ladder = settled.state.ladder;
  const change = res === null ? "" : (res.files[RUNG_CHANGE] ?? "");
  const state: RunState = {
    ...settled.state,
    ladder: r.rung === null || ladder === null ? ladder : insertRung(ladder, change, r.n, logs),
    rounds: [...s.rounds, settled.record],
    stage: `round-${r.n}`,
    next,
    lastDirection: r.direction,
    ending,
  };
  // Only a finish round's review can send the game to the ship check.
  if (
    r.rung === null &&
    ending === null &&
    state.stallStreak < 3 &&
    state.steer.length === 0 &&
    parseStatus(next) === "ready"
  )
    return { ...state, task: { _tag: "ship", n: r.n, phase: "play", thread: null } };
  return { ...state, task: newRound(state, now) };
};
