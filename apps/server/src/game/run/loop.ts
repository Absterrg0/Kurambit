// PURE. Keep going's policy (design §2–§5, contract K1–K10, F2): records and
// measured evidence in, the next step out. One cycle is look, then (Guided)
// propose, then turn, judge, maybe undo, then the step's record, then look
// again. Every input arrives as a step result a job measured; nothing here
// does I/O or calls a model, so a proposal costs no tokens.
import {
  type GameBuildFacts,
  type GameBuildId,
  type GameFactDelta,
  type GameFactId,
  type GameFactView,
  type GameRunProposal,
  type GameRunRoundRecord,
  type GameRunStep,
  type GameRunStepResult,
  type GameRunStepWhy,
  type GameRunTurnStep,
  type GameStepVerdict,
  diffBuildFacts,
  gameFactsView,
} from "@kurambit/contracts";

import type { RunState, SetAside, StepRecord } from "./state.ts";

type Result<K extends string> = Extract<GameRunStepResult, { readonly kind: K }>;
export type LookResult = Result<"look">;
export type TurnResult = Result<"turn">;
export type JudgeResult = Result<"judge">;
export type UndoResult = Result<"undo">;

const MIN = 60_000;
/** A typical step: a turn of about 5 min, then facts of about 3 (K7). */
const STEP_TYPICAL_MS = 8 * MIN;
const CAP_FLOOR_MS = 5 * MIN;
const CAP_CEILING_MS = 15 * MIN;
/** Guided starts its proposal after this unless the person answers (K9). */
const PROPOSAL_WAIT_MS = 60_000;
/** Steps in a row with no gain before the run pauses (F2). */
const STALL_LIMIT = 2;
/** Misses of one key (undone, or its target still bad) before it is set aside (K8). */
const MISS_LIMIT = 2;
const TEXT_MAX = 8000;

/**
 * The facts keep going acts on and guards (design §3.1). Motion, detail and
 * colour are heuristics: shown, never proposed and never guarded. Of the scene
 * report, only what the scene's own geometry decides is watched (a body sunk in
 * the ground, a player the camera cannot see); clipping, falling, the camera in
 * a wall and sliding depend on where random input led and how fast this
 * machine ran it, so they are shown and never guarded.
 */
const WATCHED: ReadonlySet<GameFactId> = new Set([
  "boots",
  "idle",
  "masher",
  "skilled",
  "winnable-without-skill",
  "freeze",
  "first-response",
  "buried",
  "player-view",
]);
const BROKE: ReadonlySet<string> = new Set(["crashed", "unresponsive", "did-not-boot"]);

// ── The step's text (design §2.2): four templates, the facts' own wording and the agent's own line.
const WHY_LABEL: Readonly<Record<GameRunStepWhy, string>> = {
  steer: "your note",
  blocker: "blocker",
  regression: "after an undo",
  bot: "a bot for the skilled fact",
  fact: "a failing fact",
  next: "your agent's next step",
};
const STEER_INTRO = "The person asked for this, in their words:";
const STEP_TAIL =
  "This is a keep-going step: make this one change, keep `game_check` clean, and end with your `Next:` line.";
const NEXT_FALLBACK = "Make the one change that most improves the game for BRIEF.md.";
const BOT_TEXT =
  "This game has no play bot, so Kurambit cannot measure whether a skilled player wins. Write `.studio/bot/play.mjs` with the bot kit (read `.studio/bot/kit/KIT-GUIDE.md`): a `policy` bot whose goal is to win one run of the core loop. Run it once with `game_bot_run` (decider `policy`), and fix it until it plays a full run. Change no game files.";

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

/** The step's line for records, the strip and the timeline: a note's own words, not its intro. */
export const headline = (proposal: Pick<GameRunProposal, "why" | "text">, max = 140): string =>
  clip(
    firstLine(
      proposal.why === "steer" && proposal.text.startsWith(STEER_INTRO)
        ? proposal.text.slice(STEER_INTRO.length)
        : proposal.text,
    ),
    max,
  );

/** What a fact step asks for, in the creator's terms rather than the agent's. */
const FACT_GOAL: Readonly<Partial<Record<GameFactId, string>>> = {
  boots: "Make the game boot cleanly",
  idle: "Make the game lose when nobody plays",
  masher: "Make random button-mashing lose",
  skilled: "Make the game winnable by a skilled player",
  "winnable-without-skill": "Make winning take skill",
  freeze: "Remove the stretches where the game stands still",
  "first-response": "Make the controls respond sooner",
  buried: "Stand the characters on the ground, not in it",
  "player-view": "Keep the player in view",
};

/**
 * PURE. The one line a person reads for a proposal, composed from its why and
 * target; the full text stays the agent's prompt, shown on Edit. A note and the
 * agent's own next line already read as a person would put them.
 */
export const proposalSummary = (
  proposal: Pick<GameRunProposal, "why" | "text" | "target">,
): string => {
  switch (proposal.why) {
    case "bot":
      return "Write a play bot so Kurambit can measure skilled play";
    case "regression":
      return "Try the undone step another way, or a smaller one";
    case "blocker":
    case "fact":
      return proposal.target === null
        ? headline(proposal, 100)
        : (FACT_GOAL[proposal.target] ?? `Fix a failing fact (${proposal.target})`);
    case "steer":
    case "next":
      return headline(proposal, 100);
  }
};

/** The message a step posts into its chat, and its notification summary. */
export const stepMessage = (
  n: number,
  proposal: Pick<GameRunProposal, "why" | "text" | "target">,
): { readonly text: string; readonly summary: string } => ({
  text: `Keep going · step ${n} (${WHY_LABEL[proposal.why]})\n\n${proposal.text}\n\n${STEP_TAIL}`,
  summary: `Keep going · step ${n}: ${proposalSummary(proposal)}`,
});

/** FNV-1a: a short stable key for a text, never a secret. */
const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
};
const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

// ── Reading facts. ──────────────────────────────────────────────────────────
type Views = ReadonlyMap<GameFactId, GameFactView>;
const viewsOf = (facts: GameBuildFacts): Views =>
  new Map(gameFactsView(facts).map((view) => [view.id, view]));
const toneOf = (views: Views, id: GameFactId) => {
  const reading = views.get(id)?.reading;
  return reading?._tag === "measured" ? reading.tone : null;
};
const textOf = (views: Views, id: GameFactId) => {
  const view = views.get(id);
  return view?.reading._tag === "measured" ? `${view.label}: ${view.reading.text}` : "";
};
const tierEnding = (facts: GameBuildFacts, id: "idle" | "masher" | "skilled") => {
  const fact = facts[id];
  return fact.status === "measured" ? fact.value.ending : null;
};

/** The facts that block the game, in display order (design §2.2, row 2). */
const blockers = (facts: GameBuildFacts, views: Views): ReadonlyArray<GameFactId> =>
  (["boots", "idle", "masher", "skilled", "freeze"] as const).filter((id) =>
    id === "idle" || id === "masher" || id === "skilled"
      ? BROKE.has(tierEnding(facts, id) ?? "")
      : toneOf(views, id) === "bad",
  );

/** A watched fact that crossed into bad between two builds, and whether it is health or design. */
export interface Regression {
  readonly delta: GameFactDelta;
  readonly kind: "health" | "design";
}

/**
 * K4: what got worse from `base` to `build`. Only a comparable delta of a
 * watched fact counts, and only when its reading crosses into `bad` (or
 * skilled stops winning); a fact already bad that gets worse is the next
 * blocker, not a regression. Design regressions do not count on a step the
 * person asked for or steered: difficulty is their call.
 */
export const regressions = (
  base: GameBuildFacts,
  build: GameBuildFacts,
  exemptDesign: boolean,
): ReadonlyArray<Regression> => {
  const before = viewsOf(base);
  const after = viewsOf(build);
  return diffBuildFacts(base, build).flatMap((delta): ReadonlyArray<Regression> => {
    if (!WATCHED.has(delta.id) || delta.change === "not-comparable") return [];
    const a = toneOf(before, delta.id);
    const b = toneOf(after, delta.id);
    if (a === null || b === null) return [];
    const crossed =
      (a !== "bad" && b === "bad") || (delta.id === "skilled" && a === "good" && b !== "good");
    if (!crossed) return [];
    const kind =
      delta.id === "idle" || delta.id === "masher" || delta.id === "skilled"
        ? BROKE.has(tierEnding(build, delta.id) ?? "")
          ? "health"
          : "design"
        : delta.id === "winnable-without-skill"
          ? "design"
          : "health";
    return kind === "design" && exemptDesign ? [] : [{ delta, kind }];
  });
};

const watchedDeltas = (base: GameBuildFacts, build: GameBuildFacts) =>
  diffBuildFacts(base, build).filter((d) => WATCHED.has(d.id));
const comparable = (deltas: ReadonlyArray<GameFactDelta>) =>
  deltas.filter((d) => d.change !== "not-comparable");
const deltaText = (d: GameFactDelta) => `${d.label}: ${d.a ?? "?"} → ${d.b ?? "?"}`;

/** Up to three chips for the record: what got worse first, then what got better. */
const chips = (
  deltas: ReadonlyArray<GameFactDelta>,
  worse: ReadonlyArray<Regression>,
): ReadonlyArray<GameFactDelta> => {
  const moved = comparable(deltas).filter((d) => d.change !== "same");
  return [
    ...worse.map((r) => r.delta),
    ...moved.filter((d) => d.tone === "better"),
    ...moved.filter((d) => d.tone === "worse" && !worse.some((r) => r.delta.id === d.id)),
  ].slice(0, 3);
};

// ── Choosing the next step (K3). ────────────────────────────────────────────
const asideKeys = (state: RunState) => new Set(state.setAside.map((entry) => entry.key));

const factStep = (why: "blocker" | "fact", id: GameFactId, views: Views): GameRunProposal => {
  const evidence = (views.get(id)?.evidence ?? [])
    .filter((e) => e.kind === "log" || e.kind === "frame")
    .slice(0, 2)
    .map((e) => e.path);
  const seen = `Kurambit measured the current build. ${textOf(views, id)}${evidence.length === 0 ? "" : ` (${evidence.join(", ")})`}.`;
  return {
    why,
    text:
      why === "blocker"
        ? `${seen} Fix it.`
        : `${seen} Fix it. If this is intended for this game, change nothing and say why in one line.`,
    target: id,
    key: `fact:${id}`,
  };
};

/** The person's waiting notes as one step, verbatim; null when none wait. */
export const steerProposal = (state: RunState): GameRunProposal | null => {
  if (state.steer.length === 0) return null;
  const entries = state.steer.join("\n\n");
  return {
    why: "steer",
    text: clip(`${STEER_INTRO}\n\n${entries}`, TEXT_MAX),
    target: null,
    key: `steer:${fnv(entries)}`,
  };
};

/**
 * The order of evidence (design §2.2): the person's notes, a blocker, a retry
 * of an undone step, the play bot, a failing fact, then the agent's own next
 * line. Every candidate whose key is set aside is passed over. Null: nothing
 * left to propose.
 */
export const propose = (state: RunState, look: LookResult): GameRunProposal | null => {
  const aside = asideKeys(state);
  const facts = look.facts;
  const views = facts === null ? null : viewsOf(facts);
  const candidates: Array<() => GameRunProposal | null> = [
    () => steerProposal(state),
    ...(facts === null || views === null
      ? []
      : blockers(facts, views).map((id) => () => factStep("blocker", id, views))),
    () => {
      const last = state.records.at(-1);
      if (last === undefined || last.step.verdict !== "undone") return null;
      // The person redid the undone step: it stands, and nothing retries it.
      if (last.build !== undefined && look.current === last.build) return null;
      return {
        why: "regression",
        text: clip(
          `Your last step (${last.move}) was undone: ${last.step.reason}. Reach the same goal another way, or take a smaller step.`,
          TEXT_MAX,
        ),
        target: null,
        key: last.step.key,
      };
    },
    () => {
      if (look.bot || facts === null || views === null) return null;
      if (state.records.some((r) => r.step.why === "bot")) return null;
      // Once a booting game has no play bot: the skilled tier is the one fact
      // that says a real player can win, and a game the idle and masher bots
      // never finish in their minute is exactly where it is needed.
      if (toneOf(views, "boots") !== "good") return null;
      return { why: "bot", text: BOT_TEXT, target: null, key: "bot" };
    },
    ...(facts === null || views === null
      ? []
      : (["winnable-without-skill", "first-response", "buried", "player-view"] as const)
          .filter((id) => toneOf(views, id) === "bad")
          .map((id) => () => factStep("fact", id, views))),
    () => {
      if (look.next === "none") return null;
      const text = look.next === null ? "" : look.next.text.trim();
      const line = text.length === 0 ? NEXT_FALLBACK : clip(text, TEXT_MAX);
      return { why: "next", text: line, target: null, key: `next:${fnv(normalized(line))}` };
    },
  ];
  for (const candidate of candidates) {
    const proposal = candidate();
    if (proposal !== null && !aside.has(proposal.key)) return proposal;
  }
  return null;
};

// ── Budget (K7). ────────────────────────────────────────────────────────────
const remaining = (state: RunState, now: number) =>
  state.budgetEndsAt === null ? Number.POSITIVE_INFINITY : state.budgetEndsAt - now;
/** Another step fits: a turn and its facts take about 8 minutes. */
const fitsBudget = (state: RunState, now: number): boolean =>
  remaining(state, now) >= STEP_TYPICAL_MS;
/** The turn's cap: the time left, clamped to 5–15 minutes. */
const turnCap = (state: RunState, now: number): number =>
  Math.max(CAP_FLOOR_MS, Math.min(CAP_CEILING_MS, remaining(state, now)));

// ── Steer and its captured prefix (K14, design §9). ─────────────────────────
/**
 * How many entries at the front of GameRun.steer the step in flight carries
 * and has not yet taken: a turn step holds them until its turn starts. A
 * note added meanwhile goes after them, so this prefix stays untouched.
 */
export const capturedSteer = (inFlight: GameRunStep | null): number =>
  inFlight?.step.kind === "turn" && inFlight.status === "planned" ? inFlight.step.steer.length : 0;

/** A turn that never landed gives back the notes its start took. */
export const giveBackSteer = (
  state: RunState,
  turn: GameRunTurnStep,
  started: boolean,
): RunState =>
  started && turn.steer.length > 0 ? { ...state, steer: [...turn.steer, ...state.steer] } : state;

// ── What a result leads to. ─────────────────────────────────────────────────
export type Plan =
  | { readonly kind: "look" }
  | { readonly kind: "propose"; readonly proposal: GameRunProposal; readonly deadline: number }
  | Omit<GameRunTurnStep, "id">
  | { readonly kind: "judge"; readonly build: GameBuildId; readonly base: GameBuildId | null }
  | { readonly kind: "undo"; readonly target: GameBuildId; readonly expect: GameBuildId };

export interface Next {
  readonly state: RunState;
  /** Null once the run ends (`state.ending`). */
  readonly plan: Plan | null;
  /** The step's record, when this result finished a step. */
  readonly record: StepRecord | null;
  readonly log: string;
}

const LOOK: Plan = { kind: "look" };
const go = (state: RunState, plan: Plan, log: string, record: StepRecord | null = null): Next => ({
  state,
  plan,
  record,
  log,
});
const end = (
  state: RunState,
  ending: NonNullable<RunState["ending"]>,
  why: string,
  log: string,
  record: StepRecord | null = null,
): Next => ({
  state: { ...state, ending, lastFailure: why.slice(0, 600) },
  plan: null,
  record,
  log,
});

/** The turn of a proposal, if the budget still holds one. */
export const startTurn = (
  state: RunState,
  proposal: GameRunProposal,
  base: GameBuildId | null,
  startedBy: GameRunTurnStep["startedBy"],
  now: number,
): Next => {
  if (!fitsBudget(state, now)) return end(state, "budget", "", "the budget holds no other step");
  return go(
    state,
    {
      kind: "turn",
      proposal,
      steer: proposal.why === "steer" ? [...state.steer] : [],
      base,
      capMs: turnCap(state, now),
      startedBy,
    },
    `step ${state.n} (${proposal.why}) starts: ${headline(proposal)}`,
  );
};

/**
 * The look's evidence becomes a proposal: Autopilot starts it at once; Guided
 * shows it with a deadline, except the person's own note, which they already
 * asked for (K9).
 */
export const applyLook = (state: RunState, look: LookResult, now: number): Next => {
  if (!fitsBudget(state, now)) return end(state, "budget", "", "the budget holds no other step");
  const proposal = propose(state, look);
  if (proposal === null)
    return look.next === "none"
      ? end(state, "done", "", "nothing to propose, and the agent says Next: none")
      : end(
          state,
          "stalled",
          "every step left to propose was set aside",
          "every step left to propose was set aside",
        );
  if (state.profile === "autopilot")
    return startTurn(state, proposal, look.current, "autopilot", now);
  if (proposal.why === "steer") return startTurn(state, proposal, look.current, "creator", now);
  return go(
    state,
    { kind: "propose", proposal, deadline: now + PROPOSAL_WAIT_MS },
    `step ${state.n} proposed (${proposal.why}): ${headline(proposal)}`,
  );
};

const setAside = (state: RunState, entry: SetAside): RunState =>
  state.setAside.some((each) => each.key === entry.key)
    ? state
    : { ...state, setAside: [...state.setAside, entry] };

/** The person's or the default's answer to a Guided proposal, or a turn that superseded it. */
export const applyDecided = (
  state: RunState,
  proposal: GameRunProposal,
  base: GameBuildId | null,
  answer: "start" | "skip" | "superseded",
  by: "creator" | "default" | "server",
  now: number,
): Next => {
  if (answer === "start")
    return startTurn(state, proposal, base, by === "creator" ? "creator" : "default", now);
  if (answer === "skip")
    return go(
      setAside(state, { key: proposal.key, text: headline(proposal), why: "you skipped it" }),
      LOOK,
      `step ${state.n} skipped: set aside`,
    );
  return go(state, LOOK, `step ${state.n}'s proposal was superseded by another turn`);
};

/** A step's turn and what it landed, with when the step began (epoch ms). */
export interface Cycle {
  readonly turn: GameRunTurnStep;
  readonly result: TurnResult;
  readonly since: number;
}

const recordOf = (
  state: RunState,
  cycle: Cycle,
  now: number,
  fields: {
    readonly verdict: GameStepVerdict;
    readonly reason: string;
    readonly gain: boolean;
    readonly delta?: ReadonlyArray<GameFactDelta>;
    readonly failure?: NonNullable<GameRunRoundRecord["failure"]>;
  },
): StepRecord => ({
  round: state.n,
  move: headline(cycle.turn.proposal),
  branch: "",
  verdicts: [],
  kept: fields.verdict !== "undone",
  ...(fields.failure === undefined ? {} : { failure: fields.failure }),
  durationMs: Math.max(0, now - cycle.since),
  // A step counts the files its turn changed; it has no line count.
  linesChanged: cycle.result.files,
  steer: [...cycle.turn.steer],
  ...(cycle.result.build === null ? {} : { build: cycle.result.build }),
  step: {
    why: cycle.turn.proposal.why,
    key: cycle.turn.proposal.key,
    turn: cycle.result.runId,
    base: startBuildOf(cycle.result) ?? cycle.turn.base,
    verdict: fields.verdict,
    reason: fields.reason,
    gain: fields.gain,
    delta: [...(fields.delta ?? [])],
    tokens: cycle.result.tokens,
  },
});

/** A blocker or fact step's target, still bad on the step's build. */
const targetStillBad = (turn: GameRunTurnStep, build: GameBuildFacts | null) =>
  turn.proposal.target !== null &&
  build !== null &&
  toneOf(viewsOf(build), turn.proposal.target) === "bad";

/**
 * F2: a step gains when it was kept, made no watched fact worse, and changed
 * the game (lane, art/, ASSETS.md). A watched fact that got better, or the
 * step's own target closing, count too: the person's own step, a kept retry,
 * the bot step once skilled is measured, a blocker or fact no longer bad.
 */
export const gain = (input: {
  readonly verdict: GameStepVerdict;
  readonly files: number;
  readonly turn: Pick<GameRunTurnStep, "proposal" | "startedBy">;
  readonly deltas: ReadonlyArray<GameFactDelta>;
  readonly build: GameBuildFacts | null;
}): boolean => {
  if (input.verdict !== "kept" && input.verdict !== "not-measured") return false;
  if (input.files > 0) return true;
  if (comparable(input.deltas).some((d) => d.tone === "better")) return true;
  const { proposal, startedBy } = input.turn;
  if (proposal.why === "steer" || startedBy === "creator") return true;
  if (proposal.why === "regression") return input.verdict === "kept";
  if (proposal.why === "bot") return input.build?.skilled.status === "measured";
  if (proposal.target === null || input.build === null) return false;
  const tone = toneOf(viewsOf(input.build), proposal.target);
  return tone !== null && tone !== "bad";
};

/** How many of this run's steps with `key` missed: undone, or kept with their target still bad. */
const misses = (records: ReadonlyArray<StepRecord>, key: string) =>
  records.filter((r) => r.step.key === key && r.failure === "game").length;

/**
 * A step's record lands: never-repeat, the stall and harness streaks, then the
 * next look, or the ending they call for (K6, K7, K8, F2).
 */
const settle = (state: RunState, record: StepRecord, log: string): Next => {
  const records = [...state.records, record];
  let next: RunState = {
    ...state,
    records,
    n: state.n + 1,
    stallStreak: record.step.gain ? 0 : state.stallStreak + 1,
  };
  if (record.failure === "game" && misses(records, record.step.key) >= MISS_LIMIT)
    next = setAside(next, {
      key: record.step.key,
      text: record.move,
      why: "two steps at it were undone or did not fix it",
    });
  if (record.failure === "harness" && state.records.at(-1)?.failure === "harness")
    return end(
      next,
      "tool-failed",
      `Kurambit could not measure two builds in a row (${record.step.reason})`,
      log,
      record,
    );
  if (next.stallStreak >= STALL_LIMIT)
    return end(next, "stalled", "", `${log}; two steps in a row gained nothing`, record);
  return go(next, LOOK, log, record);
};

/** The step's turn ended (K2, design §2.5): judge what it landed, or look again. */
export const applyTurn = (
  state: RunState,
  turn: GameRunTurnStep,
  result: TurnResult,
  input: { readonly now: number; readonly since: number; readonly started: boolean },
): Next => {
  const n = state.n;
  const cycle: Cycle = { turn, result, since: input.since };
  const back = giveBackSteer(state, turn, input.started);
  switch (result.outcome) {
    case "superseded":
      return go(back, LOOK, `step ${n}'s turn came up behind another turn: looking again`);
    case "stopped-by-person": {
      const record = recordOf(back, cycle, input.now, {
        verdict: "stopped",
        reason: "you stopped its turn",
        gain: false,
      });
      return end(
        { ...back, records: [...back.records, record], n: n + 1 },
        "stopped",
        `you stopped step ${n}'s turn`,
        `step ${n}'s turn was stopped by the person`,
        record,
      );
    }
    case "failed":
      return end(
        back,
        "failed",
        `step ${n}'s turn failed: ${result.reason}`,
        `step ${n}'s turn failed`,
      );
    case "completed":
    case "capped":
      break;
  }
  // A step acts only on the build it was planned on. When the folder moved
  // between the look and the turn's start (a restore, a Redo, a person's
  // turn), or the start is unknown, the turn is history, not a step: it is
  // never judged or undone, and the run looks again. The notes it carried
  // reached the agent, so they are not sent twice. A move is the person's
  // doing; an unknown start is ours, so it counts against the stall and can
  // never loop.
  const startBuild = startBuildOf(result);
  if (startBuild === null || startBuild !== turn.base) {
    const log = `step ${n} started on a build its look did not read: looking again`;
    if (startBuild !== null) return go(state, LOOK, log);
    const unknown = { ...state, stallStreak: state.stallStreak + 1 };
    return unknown.stallStreak >= STALL_LIMIT
      ? end(unknown, "stalled", "keep going could not tell which build its steps started from", log)
      : go(unknown, LOOK, log);
  }
  // The bot step changes no game files by design: it is judged by its build.
  if (result.build === null || (result.files === 0 && turn.proposal.why !== "bot")) {
    const declined = turn.proposal.why === "blocker" || turn.proposal.why === "fact";
    const bot = turn.proposal.why === "bot";
    const record = recordOf(state, cycle, input.now, {
      verdict: "no-change",
      reason: "the turn changed no game files",
      gain: false,
      failure: "no-change",
    });
    const aside = declined
      ? setAside(state, {
          key: turn.proposal.key,
          text: record.move,
          why: "your agent changed nothing: it may be intended for this game",
        })
      : bot
        ? setAside(state, { key: "bot", text: record.move, why: "the bot step left no play bot" })
        : state;
    return settle(aside, record, `step ${n} changed nothing`);
  }
  return go(
    state,
    { kind: "judge", build: result.build, base: startBuild },
    `step ${n}: measuring`,
  );
};

/**
 * The folder's build when the step's turn started (the turn build's recorded
 * base, contract §2.3); absent or null is unknown, never a match.
 */
const startBuildOf = (result: TurnResult): GameBuildId | null =>
  (result as TurnResult & { readonly startBuild?: GameBuildId | null }).startBuild ?? null;

const worseOf = (cycle: Cycle & { readonly judge: JudgeResult }) =>
  cycle.judge.base === null || cycle.judge.build === null
    ? []
    : regressions(
        cycle.judge.base,
        cycle.judge.build,
        cycle.turn.proposal.why === "steer" || cycle.result.personSteered,
      );

/** What an undo is for: the facts the step made worse, as one line. */
export const undoReason = (cycle: Cycle & { readonly judge: JudgeResult }): string =>
  worseOf(cycle)
    .map((r) => deltaText(r.delta))
    .join("; ");

/** K4: keep, or undo the step whose build made a watched fact worse. */
export const applyJudge = (
  state: RunState,
  cycle: Cycle,
  judge: JudgeResult,
  now: number,
): Next => {
  const n = state.n;
  const { turn, result } = cycle;
  const notMeasured = (why: string) =>
    settle(
      state,
      recordOf(state, cycle, now, {
        verdict: "not-measured",
        reason: why,
        gain: gain({
          verdict: "not-measured",
          files: result.files,
          turn,
          deltas: [],
          build: judge.build,
        }),
        failure: "harness",
      }),
      `step ${n} kept, not measured: ${why}`,
    );
  if (judge.build === null) return notMeasured("the step's build could not be measured");
  const base = startBuildOf(result);
  if (judge.base === null || base === null)
    return notMeasured("the build before it could not be measured");
  const deltas = watchedDeltas(judge.base, judge.build);
  if (comparable(deltas).length === 0)
    return notMeasured(deltas.find((d) => d.why !== null)?.why ?? "no fact could be compared");
  const exempt = turn.proposal.why === "steer" || result.personSteered;
  const worse = regressions(judge.base, judge.build, exempt);
  if (worse.length > 0 && result.build !== null)
    return go(
      state,
      { kind: "undo", target: base, expect: result.build },
      `step ${n} made a fact worse (${worse.map((r) => deltaText(r.delta)).join("; ")}): undoing it`,
    );
  const missed = targetStillBad(turn, judge.build);
  return settle(
    state,
    recordOf(state, cycle, now, {
      verdict: "kept",
      reason: "no fact got worse",
      gain: gain({ verdict: "kept", files: result.files, turn, deltas, build: judge.build }),
      delta: chips(deltas, []),
      ...(missed ? { failure: "game" as const } : {}),
    }),
    `step ${n} kept`,
  );
};

/** K5: the undo landed, or found the game moved on, or the person had undone it first. */
export const applyUndo = (
  state: RunState,
  cycle: Cycle & { readonly judge: JudgeResult },
  undo: UndoResult,
  now: number,
): Next => {
  const n = state.n;
  const { judge } = cycle;
  const worse = worseOf(cycle);
  const deltas =
    judge.base === null || judge.build === null ? [] : watchedDeltas(judge.base, judge.build);
  const why = undoReason(cycle);
  const delta = chips(deltas, worse);
  switch (undo.why) {
    case "restored":
    case "undone-by-person":
      return settle(
        state,
        recordOf(state, cycle, now, {
          verdict: "undone",
          reason: undo.why === "restored" ? why : "undone by you",
          gain: false,
          delta,
          failure: "game",
        }),
        `step ${n} undone (${undo.why === "restored" ? why : "by the person"})`,
      );
    case "moved-on":
      return settle(
        state,
        recordOf(state, cycle, now, {
          verdict: "kept-moved-on",
          reason: `the game changed after it (${why})`,
          gain: false,
          delta,
          failure: "game",
        }),
        `step ${n} not undone: the game changed after it`,
      );
    // The folder did not move on: the restore itself failed, so the step
    // stays with its regression. Like moved-on, it is "not undone"; the
    // reason (the restore's own message) says which, so the strip never
    // reads it as a step kept on purpose.
    case "refused":
      return settle(
        state,
        recordOf(state, cycle, now, {
          verdict: "kept-moved-on",
          reason: `${undo.message} (${why})`,
          gain: false,
          delta,
          failure: "game",
        }),
        `step ${n} not undone: ${undo.message}`,
      );
  }
};
