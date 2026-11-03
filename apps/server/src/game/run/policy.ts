// PURE. Every loop decision: stage order, round structure, keep or revert, stalls, the
// pending line, ship and budget. No I/O and no clock: time and randomness are inputs.
import type { GameBotDecider, ThreadId } from "@kurambit/contracts";
import * as Roles from "./roles.ts";
import { BLANK } from "./state.ts";
import type {
  Block,
  BotFact,
  Compare,
  Evidence,
  GitOp,
  Judge,
  Pending,
  RoleStep,
  Round,
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
  fullBuild: 40 * MIN,
  retry: 6 * MIN,
  vision: 10 * MIN,
  proto: 8 * MIN,
  plan: 5 * MIN,
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
      readonly ending: "usage-limit" | "provider-down";
      readonly reason: string;
    }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "git"; readonly git: GitOutcome }
  | { readonly kind: "boot"; readonly ok: boolean; readonly detail: string }
  | { readonly kind: "facts"; readonly jev: boolean; readonly code: string }
  | { readonly kind: "bot"; readonly fact: Omit<BotFact, "side"> }
  | { readonly kind: "note" };

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

// ── Step builders. ────────────────────────────────────────────────────────
type RoleSpec = Partial<Omit<RoleStep, "kind" | "id" | "role" | "prompt" | "capMs">> &
  Pick<RoleStep, "role" | "prompt" | "capMs">;
const role = (id: number, spec: RoleSpec): Step => ({
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
  attached: null,
  ...spec,
});
const git = (id: number, op: GitOp): Step => ({ kind: "git", id, op });
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

/** A finished turn may need follow-up, but two turns without a game-file change end the block. */
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
  return { block, over: quiet >= 2 || res.timedOut || msLeft < FLOOR_MS };
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

type CompareMove =
  | { readonly kind: "sample"; readonly side: Side; readonly current: Sample | null }
  | { readonly kind: "bot"; readonly side: Side }
  | { readonly kind: "judge"; readonly aIs: Side; readonly current: Judge | null }
  | { readonly kind: "done"; readonly gate: string | null };

// Each build is played once, in random order with equal caps; a sample without
// usable evidence is replayed once. The round's bot then plays each build, and
// each order gets a fresh comparator, a missing verdict one fresh retry on the
// same reports.
const compareMove = (c: Compare): CompareMove => {
  for (const side of c.xFirst ? (["x", "y"] as const) : (["y", "x"] as const)) {
    const entries = c.samples.filter((s) => s.side === side);
    const last = entries.at(-1) ?? null;
    if (last === null) return { kind: "sample", side, current: null };
    if (last.phase !== "done") return { kind: "sample", side, current: last };
    if (!usable(last) && entries.length === 1) return { kind: "sample", side, current: null };
  }
  const gate = validatePlayEvidence(
    lastSample(c, "x")?.evidence ?? null,
    lastSample(c, "y")?.evidence ?? null,
  );
  if (gate !== null) return { kind: "done", gate };
  if (c.bot.length > 0 && c.botWithheld === "")
    for (const side of ["x", "y"] as const)
      if (!c.bots.some((b) => b.side === side)) return { kind: "bot", side };
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

const compareStep = (
  id: number,
  c: Compare,
  input: Inputs,
  state: RunState,
): { cmp: Compare; step: Step; logs: string[] } => {
  const move = compareMove(c);
  if (move.kind === "bot") {
    // Decided here, after the plays and their replays: the runs still owed
    // must fit and leave both verdicts their time.
    const owed = (2 - c.bots.length) * BOT_RUN_MS;
    if (fit(state, input.now, owed, 2 * CAP.write) < owed) {
      const why = "the budget leaves no time for the bot runs";
      const next = compareStep(id, { ...c, botWithheld: why }, input, state);
      return {
        ...next,
        logs: [`bot facts withheld: ${why}; judging on play reports`, ...next.logs],
      };
    }
    return {
      cmp: c,
      step: {
        kind: "bot",
        id,
        sha: move.side === "x" ? c.x : c.y,
        file: c.bot,
        decider: c.botDecider,
        seconds: BOT_SECONDS,
      },
      logs: [],
    };
  }
  if (move.kind === "sample") {
    const at = move.side === "x" ? c.x : c.y;
    if (move.current === null) {
      const s: Sample = {
        side: move.side,
        label: input.id,
        thread: null,
        phase: "play",
        notes: "",
        evidence: null,
        sheet: "",
      };
      const step = role(id, {
        role: `sample-${s.label}`,
        title: "studio sample",
        at,
        prompt: Roles.samplePlay(c.question, sampleFile(s)),
        capMs: CAP.judge,
      });
      return { cmp: { ...c, samples: [...c.samples, s] }, step, logs: [] };
    }
    const s = move.current;
    if (s.phase === "more")
      return {
        cmp: c,
        step: role(id, {
          role: `sample-${s.label}`,
          title: "studio sample",
          thread: s.thread,
          at,
          prompt: Roles.sampleMore(Math.round((s.evidence?.nominalMs ?? 0) / 1000), sampleFile(s)),
          capMs: CAP.judge,
        }),
        logs: [],
      };
    const step = role(id, {
      role: `sample-${s.label}`,
      title: "studio sample",
      thread: s.thread,
      at,
      prompt: Roles.sampleWrite(sampleFile(s)),
      capMs: CAP.write,
      read: [sampleFile(s)],
      release: true,
      sheet: sheetFile(s),
    });
    return { cmp: c, step, logs: [] };
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
  res: StepResult,
  logs: string[],
  release: ThreadId[],
): Compare => {
  if (res.kind === "bot") {
    const move = compareMove(c);
    if (move.kind !== "bot") return c;
    const bots = [...c.bots, { side: move.side, ...res.fact }];
    if (res.fact.ending !== "error") return { ...c, bots };
    // Either build failing withholds both reports' facts, so the other run is skipped.
    const botWithheld = `the bot could not run on ${(move.side === "x" ? c.x : c.y).slice(0, 12)}: ${res.fact.note || "no detail"}`;
    logs.push(`bot facts withheld from both reports: ${botWithheld}`);
    return { ...c, bots, botWithheld };
  }
  const si = c.samples.findIndex((s) => s.phase !== "done");
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
              phase:
                res.evidence !== null && res.evidence.nominalMs < PLAY_FLOOR_MS ? "more" : "write",
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
    return { ...c, samples: c.samples.with(si, next) };
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
): Task => ({
  _tag: "stage",
  name,
  phase: "role",
  thread: null,
  block,
  sha: "",
  why: "",
  review: "",
});

// Stages before rounds; the stage label names the last one finished.
const afterStage = (state: RunState, done: string, now: number): RunState => {
  if (done === "starting") return { ...state, task: stageTask("vision") };
  if (done === "vision")
    return {
      ...state,
      stage: done,
      task: { _tag: "proto", i: 0, phase: "role", branch: "", why: "" },
    };
  if (done === "pick") return { ...state, stage: done, task: stageTask("plan") };
  if (done === "plan") return { ...state, stage: done, task: stageTask("art") };
  if (done === "art") {
    const ms = fit(state, now, CAP.fullBuild, BUILD_RESERVE_MS);
    if (ms >= FLOOR_MS)
      return {
        ...state,
        stage: done,
        task: stageTask("build", newBlock("build", Roles.firstDirection(state.lane), true, ms)),
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
          : act({ role: name, prompt: Roles.stage(name, lane), capMs: CAP[name] });
      if (t.phase === "commit") return run({ _tag: "commit", message: t.name, base: state.best });
      return t.phase === "boot" ? go({ kind: "boot", id }) : reject(t.name, t.why);
    }
    case "proto": {
      const name = `proto-${t.i}`;
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
      const { direction, repeating } = roundDirection(state);
      const move = direction.slice(0, 300);
      const steer = state.steer.length === 0 ? {} : { steer: state.steer };
      const next: Round = {
        ...r,
        direction,
        repeating,
        move,
        record: { ...r.record, move, ...steer },
      };
      const from = state.pending?.branch ?? null;
      return run({ _tag: "start-round", trunk: state.trunk, key: `round-${n}`, from }, next);
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
      return tester(Roles.testerPlay(n, r.jev, state.lane), CAP.tester);
    case "tester-write":
      return tester(Roles.testerWrite(n, r.move), CAP.write, [`.studio/tester-${n}.md`]);
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
        clear: [".studio/next.md"],
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
  const record = { ...r.record, note: noteOf(r, note), durationMs: now - r.startedAt };
  const next = {
    ...state,
    rounds: [...state.rounds, record],
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
  // Usage limits and a provider that stays down end the run resumably; the
  // step stays in flight so a resume reattaches to its thread.
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
    case "stage": {
      const artFits = (cap: number) => fit(s, now, cap, BUILD_RESERVE_MS + FLOOR_MS) >= FLOOR_MS;
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
      if (t.i === 0)
        return out({
          ...s,
          protos,
          task: { _tag: "proto", i: 1, phase: "role", branch: "", why: "" },
        });
      const booted = protos.filter((p) => p.booted).map((p) => p.branch);
      const pick = (cmp: Compare, chosen: string, phase: "compare" | "adopt"): RunState => ({
        ...s,
        protos,
        task: { _tag: "pick", phase, cmp, chosen, notes: "" },
      });
      if (booted.length >= 2) {
        // Labels, play order and report presentation are randomized independently.
        const [a, b] = bit(input.coin, 0) ? [booted[1]!, booted[0]!] : [booted[0]!, booted[1]!];
        return out(
          pick(newCompare(Roles.PICK_QUESTION, a, b, bit(input.coin, 1), ["x"]), "", "compare"),
        );
      }
      if (booted.length === 1)
        return out(pick(newCompare("", "", "", true, []), booted[0]!, "adopt"));
      logs.push("pick: no prototype booted; building from trunk");
      return out(afterStage({ ...s, protos }, "pick", now));
    }
    case "pick": {
      if (t.phase === "adopt") {
        logs.push(
          g!.ok
            ? `pick ${t.chosen} adopted at ${g!.sha.slice(0, 8)}`
            : `pick ${t.chosen} not adopted (${g!.detail}); staying on best`,
        );
        return out(afterStage(g!.ok ? { ...s, best: g!.sha } : s, "pick", now));
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
      const cmp = applyCompare(t.cmp, res, logs, release);
      const move = compareMove(cmp);
      if (move.kind !== "done") return out({ ...s, task: { ...t, cmp } });
      files.push(...comparisonFiles("pick", input.id, cmp, move.gate, { x: "A", y: "B" }));
      const j = move.gate === null ? finalJudge(cmp, "x") : null;
      const verdict = j?.verdict ?? "NONE";
      if (verdict === "A" || verdict === "B")
        return out({
          ...s,
          pickNotes: `${pickLegend(verdict)}\n${j!.notes}`,
          task: { ...t, cmp, phase: "adopt", chosen: verdict === "A" ? cmp.x : cmp.y },
        });
      // TIE compares honestly, but creation needs a base: the comparator picks
      // which prototype to continue, a selection rather than a win.
      if (verdict === "TIE") {
        // Its comparator makes the selection on the same thread, so its worktree stays.
        release.splice(0, release.length, ...release.filter((thread) => thread !== j!.thread));
        return out({ ...s, task: { ...t, cmp, phase: "select", notes: j!.notes } });
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
    case "leave":
      if (t.phase === "restore") return out({ ...s, task: { ...t, phase: "trunk" } });
      return out({ ...s, ending: "budget", task: newRound(s, now) });
    case "round":
      return out(applyRound(s, t, res, input, logs, files, release));
  }
};

const applyRound = (
  s: RunState,
  r: Round,
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
      const ms = fit(s, now, CAP.block, ROUND_RESERVE_MS);
      const round = {
        ...r,
        branch: g!.branch,
        base: g!.sha,
        record: { ...r.record, branch: g!.branch },
      };
      if (ms < FLOOR_MS) return leaveRound({ ...s, pending }, round);
      const direction = Roles.roundDirection(r.direction, r.repeating, lane);
      // Only the notes this round read are used up; later ones wait for the next.
      return {
        ...s,
        pending,
        steer: s.steer.slice(r.record.steer?.length ?? 0),
        task: { ...round, phase: "block", block: newBlock(`${r.n}`, direction, false, ms) },
      };
    }
    case "block":
    case "retry": {
      if (res.kind !== "done")
        return at({ phase: r.phase === "block" ? "commit" : "retry-commit" });
      const stepped = advanceBlock(r.block!, res);
      if (stepped.block.quiet >= 2)
        logs.push(`builder ${r.block!.tag}: finished after two turns without a game-file change`);
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
      // One short replace attempt with a concrete prompt before calling it stalled.
      const ms = fit(s, now, CAP.retry, 5 * MIN);
      if (r.phase === "commit" && ms >= FLOOR_MS)
        return at({
          phase: "retry",
          block: newBlock(
            `${r.n}b`,
            Roles.retryDirection(Roles.roundDirection(r.direction, r.repeating, lane), lane),
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
      if (
        r.phase === "tester-write" &&
        res.kind === "done" &&
        res.botsAfter <= r.botsBefore &&
        Roles.laneBots(lane)
      ) {
        logs.push(`round ${r.n}: tester ran no bot; one follow-up turn asks for it`);
        return at({ phase: "tester-duty", testerNotes, ...bot });
      }
      const testerNote = testerNotes.split("\n").slice(0, 20).join("\n").slice(0, 600);
      const note = testerNotes.length > 20 ? r.record.note : noteOf(r, "tester write failed");
      return at({
        phase: "restore",
        testerNotes,
        ...bot,
        record: { ...r.record, testerNote, ...(note === undefined ? {} : { note }) },
      });
    }
    case "restore": {
      // With a budget, judging starts only when both plays and both verdicts fit.
      if (remaining(s, now) < COMPARE_MIN_MS) {
        logs.push(
          `round ${r.n}: budget leaves no time to judge; candidate stays on branch ${r.branch}`,
        );
        return { ...s, task: { _tag: "leave", branch: r.branch, candidate: "", phase: "trunk" } };
      }
      const question = Roles.roundQuestion(Roles.roundDirection(r.direction, r.repeating, lane));
      const lanePlaysBots = Roles.laneBots(lane);
      if (!lanePlaysBots)
        logs.push(`round ${r.n}: bot runs do not play ${lane} games; bot facts are skipped`);
      const cmp = newCompare(
        question,
        r.candidate,
        s.best,
        bit(input.coin, 0),
        ["x", "y"],
        lanePlaysBots ? r.bot : "",
        r.botDecider,
      );
      return at({ phase: "compare", cmp });
    }
    case "compare": {
      const cmp = applyCompare(r.cmp!, res, logs, release);
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
    case "review-facts":
      return at({ phase: "review", facts: res.kind === "facts" ? res.code : "" });
    case "review":
      if (res.kind === "done" && res.budgetCut) return finishRound(s, r, null, "budget", now);
      return res.kind === "done"
        ? at({ phase: "review-write", thread: res.threadId })
        : finishRound(s, r, null, null, now);
    case "review-write":
      return finishRound(
        s,
        r,
        res.kind === "done" ? res : null,
        res.kind === "done" && res.budgetCut ? "budget" : null,
        now,
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
): RunState => {
  const reviewerNotes = res === null ? "" : textOf(res, `.studio/reviewer-${r.n}.md`);
  const next = res === null ? "" : (res.files[".studio/next.md"] ?? "").trim().slice(0, 4000);
  let note = r.record.note ?? "";
  if (reviewerNotes.length <= 20) note = `${note} reviewer write failed`.trim();
  if (next.length === 0) note = `${note} reviewer wrote no next.md`.trim();
  const record = {
    ...r.record,
    durationMs: now - r.startedAt,
    ...(note.length > 0 ? { note } : {}),
  };
  const state: RunState = {
    ...s,
    rounds: [...s.rounds, record],
    stage: `round-${r.n}`,
    next,
    lastDirection: r.direction,
    ending,
  };
  if (
    ending === null &&
    state.stallStreak < 3 &&
    state.steer.length === 0 &&
    parseStatus(next) === "ready"
  )
    return { ...state, task: { _tag: "ship", n: r.n, phase: "play", thread: null } };
  return { ...state, task: newRound(state, now) };
};
