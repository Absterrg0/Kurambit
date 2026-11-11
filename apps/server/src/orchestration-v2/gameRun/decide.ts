// PURE. Keep going, whole: for each game-run command, the thread's game-run
// records in, the events, outbox effects or a typed refusal out. The one
// place that decides the next step (look, then (Guided) propose, then turn,
// judge, maybe undo, then the step's record, then look again), when to keep,
// undo, pause or stop, and why. Every input arrives as a step result a job
// measured; nothing here does I/O or calls a model, so a proposal costs no
// tokens. Every loop back to a look is bounded by a streak that only a landed
// step resets (see `lookAgain` and `settle`).
import {
  GAME_ENGINES,
  type GameBuildFacts,
  type GameBuildId,
  type GameFactDelta,
  type GameFactId,
  type GameFactView,
  type GameRun,
  type GameRunEnding,
  type GameRunId,
  type GameRunLookStep,
  type GameRunProfile,
  type GameRunProposal,
  type GameRunRefusalReason,
  type GameRunRound,
  type GameRunRoundRecord,
  type GameRunStep,
  type GameRunStepId,
  type GameRunStepResult,
  type GameRunStepWhy,
  type GameRunTurnStep,
  type GameStepVerdict,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GameRunCommand,
  type ProjectId,
  diffBuildFacts,
  gameFactsView,
  gameRunRoundId,
  gameRunStepId,
} from "@kurambit/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { machineFault } from "../../game/buildFacts.ts";
import type { OrchestrationEffectRequestV2 } from "../EffectOutbox.ts";

// ── The run as the policy reads it. ─────────────────────────────────────────
/** A round that is a keep-going step's record. */
export type StepRecord = GameRunRoundRecord & {
  readonly step: NonNullable<GameRunRoundRecord["step"]>;
};
type SetAside = NonNullable<GameRun["setAside"]>[number];

export interface RunState {
  readonly profile: GameRunProfile;
  readonly budgetMinutes: number | null;
  /** Epoch ms; null without a budget. */
  readonly budgetEndsAt: number | null;
  readonly steer: ReadonlyArray<string>;
  readonly setAside: ReadonlyArray<SetAside>;
  /** Steps in a row that gained nothing. */
  readonly stallStreak: number;
  /** Steps in a row that never landed: superseded, or started on another build. */
  readonly superseded: number;
  readonly lastFailure: string;
  readonly ending: GameRunEnding | null;
  readonly botSetup?: NonNullable<GameRun["botSetup"]>;
  /** This run's step records, oldest first. */
  readonly records: ReadonlyArray<StepRecord>;
  /** The number the chat's next step takes. */
  readonly n: number;
}

/** Every ending resumes but `done`; the ones only an earlier Kurambit wrote never do. */
export const RESUMABLE: ReadonlySet<GameRunEnding> = new Set<GameRunEnding>([
  "stopped",
  "stalled",
  "budget",
  "failed",
  "usage-limit",
  "provider-down",
  "tool-failed",
]);

export const isStepRecord = (round: GameRunRoundRecord): round is StepRecord =>
  round.step !== undefined;

/**
 * The number the chat's next step takes: steps are numbered per chat, across
 * its runs, so "Step 4" names one turn of the chat. A step that never reached
 * a record (superseded, paused) leaves its number to the next.
 */
export const stepNumber = (rounds: ReadonlyArray<GameRunRound>): number =>
  rounds.reduce((max, r) => (isStepRecord(r.round) ? Math.max(max, r.round.round) : max), 0) + 1;

const toState = (run: GameRun, rounds: ReadonlyArray<GameRunRound>): RunState => ({
  profile: run.profile,
  budgetMinutes: run.budgetMinutes,
  budgetEndsAt: run.budgetEndsAt,
  steer: run.steer,
  setAside: run.setAside ?? [],
  stallStreak: run.stallStreak,
  superseded: run.supersededStreak ?? 0,
  lastFailure: run.lastFailure,
  ending: run.ending,
  ...(run.botSetup === undefined ? {} : { botSetup: run.botSetup }),
  records: rounds
    .filter((r) => r.runId === run.id)
    .map((r) => r.round)
    .filter(isStepRecord)
    .toSorted((a, b) => a.round - b.round),
  n: stepNumber(rounds),
});

const withState = (run: GameRun, state: RunState): GameRun => ({
  ...run,
  profile: state.profile,
  budgetMinutes: state.budgetMinutes,
  budgetEndsAt: state.budgetEndsAt,
  steer: [...state.steer],
  setAside: [...state.setAside],
  stallStreak: state.stallStreak,
  supersededStreak: state.superseded,
  lastFailure: state.lastFailure,
  ending: state.ending,
  ...(state.botSetup === undefined ? {} : { botSetup: state.botSetup }),
});

type StepResult<K extends string> = Extract<GameRunStepResult, { readonly kind: K }>;
export type LookResult = StepResult<"look">;
export type TurnResult = StepResult<"turn">;
export type JudgeResult = StepResult<"judge">;
export type UndoResult = StepResult<"undo">;

const MIN = 60_000;
/** A typical step: a turn of about 5 min, then facts of about 3. */
const STEP_TYPICAL_MS = 8 * MIN;
const CAP_FLOOR_MS = 5 * MIN;
const CAP_CEILING_MS = 15 * MIN;
/** Guided starts its proposal after this unless the person answers. */
const PROPOSAL_WAIT_MS = 60_000;
/** Steps in a row with no gain before the run pauses: it stopped improving the game. */
const STALL_LIMIT = 2;
/**
 * Steps in a row that never landed before the run pauses. One higher than the
 * stall limit: such a step costs a look and no turn, and a person who sends
 * two messages in a row should not pause the run.
 */
const SUPERSEDE_LIMIT = 3;
/** Misses of one key (undone, or its target still bad) before it is set aside, so it is never tried forever. */
const MISS_LIMIT = 2;
const TEXT_MAX = 8000;

/**
 * The facts keep going acts on and guards. Motion, detail and
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
  "empty",
]);
const BROKE: ReadonlySet<string> = new Set(["crashed", "unresponsive", "did-not-boot"]);

// ── The step's text: four templates, the facts' own wording and the agent's own line.
const WHY_LABEL: Readonly<Record<GameRunStepWhy, string>> = {
  steer: "your note",
  blocker: "blocker",
  regression: "after an undo",
  // Only an earlier Kurambit's records: the bot is now setup, never a step.
  bot: "a bot for the skilled fact",
  fact: "a failing fact",
  next: "your agent's next step",
};
const STEER_INTRO = "The person asked for this, in their words:";
const STEP_TAIL =
  "This is a keep-going step: make this one change, keep `game_check` clean, and end with your `Next:` line.";
const NEXT_FALLBACK = "Make the one change that most improves the game for BRIEF.md.";

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

/** The step's line for records, the strip and the timeline: a note's own words, not its intro. */
/** A proposal in one line: what its step sets out to change, as the step record's `move` keeps it. */
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
  empty: "Fill the empty part of the view",
};

/**
 * The one line a person reads for a proposal, composed from its why and
 * target; the full text stays the agent's prompt, shown on Edit. A note and the
 * agent's own next line already read as a person would put them.
 */
export const proposalSummary = (
  proposal: Pick<GameRunProposal, "why" | "text" | "target">,
): string => {
  switch (proposal.why) {
    case "bot":
      return "Wrote a play bot so Kurambit could measure skilled play";
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

/**
 * The message a step posts into its chat, and its notification summary. The
 * provider tells the agent a stopped turn was stopped by the person; when it
 * was Kurambit's time cap, the next step says so.
 */
export const stepMessage = (
  rounds: ReadonlyArray<GameRunRound>,
  proposal: Pick<GameRunProposal, "why" | "text" | "target">,
): { readonly text: string; readonly summary: string } => {
  const n = stepNumber(rounds);
  const capped = rounds.find((r) => isStepRecord(r.round) && r.round.round === n - 1)?.round.step
    ?.capped;
  const cap =
    capped === undefined
      ? ""
      : `Kurambit's ${capped}-minute time cap stopped your last keep-going step's turn; the person did not stop it.\n\n`;
  return {
    text: `Keep going · step ${n} (${WHY_LABEL[proposal.why]})\n\n${cap}${proposal.text}\n\n${STEP_TAIL}`,
    summary: `Keep going · step ${n}: ${proposalSummary(proposal)}`,
  };
};

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

/** The facts that block the game, in display order. */
const blockers = (facts: GameBuildFacts, views: Views): ReadonlyArray<GameFactId> =>
  (["boots", "idle", "masher", "skilled", "freeze"] as const).filter((id) =>
    id === "idle" || id === "masher" || id === "skilled"
      ? BROKE.has(tierEnding(facts, id) ?? "")
      : toneOf(views, id) === "bad",
  );

// A step's reasons are read in the chat, where no A and B are on screen.
const STEP_SIDES = { a: "the build before the step", b: "the step's build" } as const;

/** A watched fact that crossed into bad between two builds, and whether it is health or design. */
interface Regression {
  readonly delta: GameFactDelta;
  readonly kind: "health" | "design";
}

/**
 * What got worse from `base` to `build`. Only a comparable delta of a
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
  return diffBuildFacts(base, build, STEP_SIDES).flatMap((delta): ReadonlyArray<Regression> => {
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
        : // An empty view can be the look the person asked for.
          delta.id === "winnable-without-skill" || delta.id === "empty"
          ? "design"
          : "health";
    return kind === "design" && exemptDesign ? [] : [{ delta, kind }];
  });
};

const watchedDeltas = (base: GameBuildFacts, build: GameBuildFacts) =>
  diffBuildFacts(base, build, STEP_SIDES).filter((d) => WATCHED.has(d.id));
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

// ── Choosing the next step. ─────────────────────────────────────────────────
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
const steerProposal = (state: RunState): GameRunProposal | null => {
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
 * The order of evidence, the person's first: their notes, a blocker, a retry
 * of an undone step, a failing fact, then the agent's own next line. Every
 * candidate whose key is set aside is passed over. Null: nothing left to
 * propose. The play bot is no candidate: a step must change what a person
 * sees or fix a measured fault, so the look writes it once as setup.
 */
export const propose = (state: RunState, look: LookResult): GameRunProposal | null => {
  const aside = new Set(state.setAside.map((entry) => entry.key));
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
    ...(facts === null || views === null
      ? []
      : (["winnable-without-skill", "first-response", "buried", "player-view", "empty"] as const)
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

// ── Budget. ─────────────────────────────────────────────────────────────────
const remaining = (state: RunState, now: number) =>
  state.budgetEndsAt === null ? Number.POSITIVE_INFINITY : state.budgetEndsAt - now;
/** Another step fits: a turn and its facts take about 8 minutes. */
const fitsBudget = (state: RunState, now: number): boolean =>
  remaining(state, now) >= STEP_TYPICAL_MS;
/** The turn's cap: the time left, clamped to 5–15 minutes. */
const turnCap = (state: RunState, now: number): number =>
  Math.max(CAP_FLOOR_MS, Math.min(CAP_CEILING_MS, remaining(state, now)));

// ── Steer and its captured prefix. ──────────────────────────────────────────
/**
 * How many entries at the front of GameRun.steer the step in flight carries
 * and has not yet taken: a turn step holds them until its turn starts. A
 * note added meanwhile goes after them, so this prefix stays untouched.
 */
export const capturedSteer = (inFlight: GameRunStep | null): number =>
  inFlight?.step.kind === "turn" && inFlight.status === "planned" ? inFlight.step.steer.length : 0;

/** A turn that never landed gives back the notes its start took. */
const giveBackSteer = (state: RunState, turn: GameRunTurnStep, started: boolean): RunState =>
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
  ending: GameRunEnding,
  why: string,
  log: string,
  record: StepRecord | null = null,
): Next => ({
  state: { ...state, ending, lastFailure: why.slice(0, 600) },
  plan: null,
  record,
  log,
});

/**
 * A step that never landed: the run looks again, or pauses once that has
 * happened SUPERSEDE_LIMIT times in a row. Only a landed step resets the
 * streak (settle), so no mix of supersedes and looks runs without bound,
 * whatever made the folder move.
 */
const lookAgain = (state: RunState, why: string, log: string): Next => {
  const next = { ...state, superseded: state.superseded + 1 };
  return next.superseded >= SUPERSEDE_LIMIT
    ? end(
        next,
        "stalled",
        `${SUPERSEDE_LIMIT} steps in a row never started (the last: ${why})`,
        log,
      )
    : go(next, LOOK, log);
};

/** The turn of a proposal, if the budget still holds one. */
const startTurn = (
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
 * The no-input and random-input tiers both a fault of this machine (ffmpeg
 * missing, say): every step would be kept on Boots alone, which is tokens spent
 * on nothing. Stored facts re-measure such a fault only on a person's measure,
 * hence the ending's "measure again".
 */
const bothTiersMachineFaults = ({ idle, masher }: GameBuildFacts) =>
  machineFault(idle) && machineFault(masher) ? masher : null;

/**
 * The look's evidence becomes a proposal: Autopilot starts it at once; Guided
 * shows it with a deadline, except the person's own note, which they already
 * asked for. A folder edited outside any build pauses the run: a step's undo
 * restores a build and would take those edits.
 */
const proposeFrom = (state: RunState, look: LookResult, now: number): Next => {
  if (look.edited)
    return end(
      state,
      "stalled",
      "the game folder has changes no build holds, and an undo would take them; send them in a turn first",
      "the folder holds no build",
    );
  const unjudgeable = look.facts === null ? null : bothTiersMachineFaults(look.facts);
  if (unjudgeable !== null)
    return end(
      state,
      "tool-failed",
      `it can't judge steps here: ${unjudgeable.why.trim().replace(/[.\s]+$/, "")}; then measure the build again`,
      "no play tier can be measured on this machine, so no step could be judged",
    );
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

/** A look that finished the run's bot setup records it on the run, then proposes as any look. */
export const applyLook = (state: RunState, look: LookResult, now: number): Next => {
  const setup = look.botSetup;
  if (setup === undefined) return proposeFrom(state, look, now);
  // The run keeps the setup this look finished, so no later look sets up again.
  const next = proposeFrom({ ...state, botSetup: setup }, look, now);
  const line =
    setup.state === "written"
      ? "the play bot is written"
      : setup.state === "skipped"
        ? `no play bot: ${setup.reason}`
        : `the play bot setup failed (${setup.reason}); keep going goes on without the skilled fact`;
  return { ...next, log: `${line}; ${next.log}` };
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
  return lookAgain(
    state,
    "another turn or a restore went first",
    `step ${state.n}'s proposal was superseded by another turn`,
  );
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
    base: cycle.result.startBuild ?? cycle.turn.base,
    verdict: fields.verdict,
    reason: fields.reason,
    gain: fields.gain,
    delta: [...(fields.delta ?? [])],
    tokens: cycle.result.tokens,
    ...(cycle.result.outcome === "capped" ? { capped: Math.round(cycle.turn.capMs / MIN) } : {}),
  },
});

/** A blocker or fact step's target, still bad on the step's build. */
const targetStillBad = (turn: GameRunTurnStep, build: GameBuildFacts | null) =>
  turn.proposal.target !== null &&
  build !== null &&
  toneOf(viewsOf(build), turn.proposal.target) === "bad";

/**
 * A step gains when it was kept, made no watched fact worse, and changed
 * what a restore covers. A watched fact that got better, or the step's own
 * target closing, count too: the person's own step, a kept retry, a blocker
 * or fact no longer bad.
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
  if (proposal.target === null || input.build === null) return false;
  const tone = toneOf(viewsOf(input.build), proposal.target);
  return tone !== null && tone !== "bad";
};

/** How many of this run's steps with `key` missed: undone, or kept with their target still bad. */
const misses = (records: ReadonlyArray<StepRecord>, key: string) =>
  records.filter((r) => r.step.key === key && r.failure === "game").length;

/**
 * A step's record lands: never-repeat, the stall and harness streaks, then the
 * next look, or the ending they call for. A landed step ends a streak of
 * steps that never landed.
 */
const settle = (state: RunState, record: StepRecord, log: string): Next => {
  const records = [...state.records, record];
  let next: RunState = {
    ...state,
    records,
    n: state.n + 1,
    stallStreak: record.step.gain ? 0 : state.stallStreak + 1,
    superseded: 0,
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

/** Why a step that changed nothing is never sent again as it was. */
const unchangedWhy = (why: GameRunStepWhy) =>
  why === "blocker" || why === "fact"
    ? "your agent changed nothing: it may be intended for this game"
    : "a step at it changed no game files";

/** The step's turn ended: judge what it landed, or look again. */
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
      return lookAgain(
        back,
        result.reason || "another turn went first",
        `step ${n}'s turn came up behind another turn: looking again`,
      );
    case "stopped-by-person": {
      const record = recordOf(back, cycle, input.now, {
        verdict: "stopped",
        reason: "you stopped its turn",
        gain: false,
      });
      return end(
        { ...back, records: [...back.records, record], n: n + 1, superseded: 0 },
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
  // reached the agent, so they are not sent twice. An unknown start is ours,
  // and it spent a turn, so it counts against the stall.
  const startBuild = result.startBuild;
  if (startBuild === null || startBuild !== turn.base) {
    const log = `step ${n} started on a build its look did not read: looking again`;
    if (startBuild !== null) return lookAgain(state, "the game changed as its turn started", log);
    const unknown = { ...state, stallStreak: state.stallStreak + 1 };
    return unknown.stallStreak >= STALL_LIMIT
      ? end(unknown, "stalled", "keep going could not tell which build its steps started from", log)
      : go(unknown, LOOK, log);
  }
  // A step that changed nothing is set aside, so the same step is never sent
  // again as it was: the policy has nothing new to add to it.
  if (result.build === null || result.files === 0) {
    const record = recordOf(state, cycle, input.now, {
      verdict: "no-change",
      reason: "the turn changed no game files",
      gain: false,
      failure: "no-change",
    });
    const aside = setAside(state, {
      key: turn.proposal.key,
      text: record.move,
      why: unchangedWhy(turn.proposal.why),
    });
    return settle(aside, record, `step ${n} changed nothing`);
  }
  return go(
    state,
    { kind: "judge", build: result.build, base: startBuild },
    `step ${n}: measuring`,
  );
};

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

/** Keep, or undo the step whose build made a watched fact worse. */
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
  const base = result.startBuild;
  if (judge.base === null || base === null)
    return notMeasured("the build before it could not be measured");
  const deltas = watchedDeltas(judge.base, judge.build);
  if (comparable(deltas).length === 0)
    return notMeasured(deltas.find((d) => d.why !== null)?.why ?? "no fact could be compared");
  const worse = worseOf({ ...cycle, judge });
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

/** The undo landed, or found the game moved on, or the person had undone it first. */
export const applyUndo = (
  state: RunState,
  cycle: Cycle & { readonly judge: JudgeResult },
  undo: UndoResult,
  now: number,
): Next => {
  const n = state.n;
  const { judge } = cycle;
  const deltas =
    judge.base === null || judge.build === null ? [] : watchedDeltas(judge.base, judge.build);
  const why = undoReason(cycle);
  const notUndone = (reason: string, log: string) =>
    settle(
      state,
      recordOf(state, cycle, now, {
        verdict: "kept-moved-on",
        reason,
        gain: false,
        delta: chips(deltas, worseOf(cycle)),
        failure: "game",
      }),
      log,
    );
  switch (undo.why) {
    case "restored":
    case "undone-by-person":
      return settle(
        state,
        recordOf(state, cycle, now, {
          verdict: "undone",
          reason: undo.why === "restored" ? why : "undone by you",
          gain: false,
          delta: chips(deltas, worseOf(cycle)),
          failure: "game",
        }),
        `step ${n} undone (${undo.why === "restored" ? why : "by the person"})`,
      );
    case "moved-on":
      return notUndone(
        `the game changed after it (${why})`,
        `step ${n} not undone: the game changed after it`,
      );
    // The folder did not move on: the restore itself failed, so the step
    // stays with its regression. Like moved-on, it is "not undone"; the
    // reason (the restore's own message) says which, so the strip never
    // reads it as a step kept on purpose.
    case "refused":
      return notUndone(`${undo.message} (${why})`, `step ${n} not undone: ${undo.message}`);
  }
};

// ── The orchestration domain: records in, events and effects out. ──────────
export interface GameRunRecords {
  readonly projectId: ProjectId;
  /** The game's latest run on any of its project's threads: the folder is the project's. */
  readonly projectRun: GameRun | null;
  /** The thread's runs, oldest first. */
  readonly runs: ReadonlyArray<GameRun>;
  /** The thread's rounds across its runs: a chat's step numbers continue from run to run. */
  readonly rounds: ReadonlyArray<GameRunRound>;
  /** The latest run's step in flight, when it holds one. */
  readonly inFlight: GameRunStep | null;
  /** The thread was deleted: nothing resumes its runs. */
  readonly chatDeleted: boolean;
  /**
   * The in-flight step's cycle: the two steps planned just before it (a
   * proposal's look, a turn's look or proposal and look, a judge's turn, an
   * undo's judge and turn).
   */
  readonly steps: ReadonlyArray<GameRunStep>;
}

type GameRunEventType =
  | "game-run.created"
  | "game-run.updated"
  | "game-run-step.updated"
  | "game-run-round.recorded";
type GameRunDomainEvent = Extract<OrchestrationV2DomainEvent, { readonly type: GameRunEventType }>;
type WithoutId<E> = E extends unknown ? Omit<E, "id"> : never;
/** An event the orchestrator gives an id when it commits it. */
type GameRunEvent = WithoutId<GameRunDomainEvent>;
type GameRunEffectRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: `game-run.${string}` }
>;
/** The effects a stop cancels: every live one keep going plans. */
export const GAME_RUN_EFFECT_TYPES = [
  "game-run.step.execute",
  "game-run.decision.deadline",
  "game-run.step.deadline",
  "game-run.step.resend",
  "game-run.step.wake",
] as const satisfies ReadonlyArray<GameRunEffectRequest["type"]>;

interface GameRunEffect {
  readonly request: GameRunEffectRequest;
  /** Epoch ms; absent runs at once. */
  readonly availableAt?: number;
}

export interface GameRunDecision {
  readonly events: ReadonlyArray<GameRunEvent>;
  readonly effects: ReadonlyArray<GameRunEffect>;
  /** A stop: the run's unsettled effects are cancelled in the same commit. */
  readonly cancelEffects: boolean;
}

interface GameRunRefusal {
  readonly reason: GameRunRefusalReason;
  readonly message: string;
}

const refuse = (reason: GameRunRefusalReason, message: string) =>
  Result.fail<GameRunRefusal>({ reason, message });

interface Work {
  readonly command: OrchestrationV2GameRunCommand;
  readonly records: GameRunRecords;
  readonly at: DateTime.Utc;
  readonly now: number;
  readonly iso: string;
}

const event = <T extends GameRunEventType>(
  work: Work,
  type: T,
  payload: Extract<GameRunEvent, { readonly type: T }>["payload"],
) =>
  ({
    type,
    threadId: work.command.threadId,
    occurredAt: work.at,
    payload,
  }) as GameRunEvent;
const runEvent = (work: Work, payload: GameRun, created = false) =>
  event(work, created ? "game-run.created" : "game-run.updated", payload);
const stepEvent = (work: Work, payload: GameRunStep) =>
  event(work, "game-run-step.updated", payload);

type Command<T extends OrchestrationV2GameRunCommand["type"]> = Extract<
  OrchestrationV2GameRunCommand,
  { readonly type: T }
>;
const resultOf = <K extends GameRunStepResult["kind"] & string>(
  result: GameRunStepResult | null | undefined,
  kind: K,
): StepResult<K> | null =>
  result != null && result.kind === kind ? (result as StepResult<K>) : null;

const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const NOTHING: GameRunDecision = { events: [], effects: [], cancelEffects: false };
const only = (events: ReadonlyArray<GameRunEvent>, effects: ReadonlyArray<GameRunEffect> = []) =>
  Result.succeed<GameRunDecision>({ events, effects, cancelEffects: false });

/** The command's run: the thread's latest, which the command must name. */
const current = (work: Work, runId: GameRunId) => {
  const run = work.records.runs.at(-1);
  if (run === undefined) return refuse("no-run", "This chat has no keep-going run.");
  if (run.id !== runId)
    return refuse("stale-run", `Run ${runId} is not this chat's current run (${run.id} is).`);
  return Result.succeed(run);
};

const live = (work: Work, runId: GameRunId) =>
  Result.flatMap(current(work, runId), (run) =>
    run.status === "ended"
      ? refuse("run-ended", `Keep going ended (${run.ending ?? "unknown"}).`)
      : Result.succeed(run),
  );

const inFlightOf = (work: Work, run: GameRun) =>
  run.inFlight !== null && work.records.inFlight?.seq === run.inFlight
    ? work.records.inFlight
    : null;

/** The step `stepId` names, when it is the run's step in flight, for this attempt. */
const currentStep = (work: Work, run: GameRun, stepId: GameRunStepId, attempt?: number) => {
  const record = inFlightOf(work, run);
  if (record === null || record.id !== stepId)
    return refuse("stale-step", `Step ${stepId} is not keep going's current step.`);
  if (attempt !== undefined && attempt !== record.attempt)
    return refuse(
      "stale-attempt",
      `Attempt ${attempt} of step ${stepId} was superseded; the step runs as attempt ${record.attempt}.`,
    );
  return Result.succeed(record);
};

/** A step of the in-flight cycle, `back` steps before the one in flight. */
const cycleStep = (work: Work, record: GameRunStep, back: number) =>
  work.records.steps.find((s) => s.runId === record.runId && s.seq === record.seq - back) ?? null;

/** The newest look of the cycle with measured facts: what a look again can take. */
const knownOf = (work: Work, record: GameRunStep | null): GameRunLookStep["known"] => {
  if (record === null) return undefined;
  for (const step of [record, cycleStep(work, record, 1), cycleStep(work, record, 2)]) {
    const look = resultOf(step?.result, "look");
    if (step != null && look !== null)
      return look.current === null || look.facts === null || look.edited
        ? undefined
        : { build: look.current, look: step.seq };
  }
  return undefined;
};

const planned = (seq: number, plan: Plan, known: GameRunLookStep["known"]): GameRunStep["step"] => {
  switch (plan.kind) {
    case "look":
      return { kind: "look", id: seq, ...(known === undefined ? {} : { known }) };
    case "propose":
      return { kind: "propose", id: seq, proposal: plan.proposal, deadline: plan.deadline };
    case "turn":
      return { ...plan, id: seq };
    case "judge":
      return { kind: "judge", id: seq, build: plan.build, base: plan.base };
    case "undo":
      return { kind: "undo", id: seq, target: plan.target, expect: plan.expect };
  }
};

/** A planned step's effect: a proposal's deadline, or the job that does the step's work. */
const effectsOf = (record: GameRunStep): GameRunEffect[] =>
  record.step.kind === "propose"
    ? record.step.deadline === null
      ? []
      : [
          {
            request: {
              type: "game-run.decision.deadline",
              runId: record.runId,
              stepId: record.id,
              decisionId: record.id,
            },
            availableAt: record.step.deadline,
          },
        ]
    : [
        {
          request: {
            type: "game-run.step.execute",
            runId: record.runId,
            stepId: record.id,
            attempt: record.attempt,
          },
        },
      ];

/** A judge or an undo cut off by a pause runs again on resume; any other step looks afresh. */
const keptOnPause = (record: GameRunStep | null) =>
  record !== null && (record.step.kind === "judge" || record.step.kind === "undo");

/**
 * The policy's answer becomes the run's records: the step record it finished,
 * the step's round when one landed, the next step and its effect, and the run.
 * A look after a step that never landed takes the facts its cycle's look
 * measured, so a supersede never measures the same build twice.
 */
const land = (
  work: Work,
  run: GameRun,
  next: Next,
  finished: GameRunStep | null,
  options: { readonly created?: boolean; readonly held?: GameRunStep | null } = {},
): GameRunDecision => {
  const ended = next.state.ending !== null;
  const seq = next.plan === null ? run.seq : run.seq + 1;
  const known =
    next.plan?.kind === "look" && next.record === null ? knownOf(work, finished) : undefined;
  const step: GameRunStep | null =
    next.plan === null
      ? null
      : {
          id: gameRunStepId(run.id, seq),
          runId: run.id,
          threadId: run.threadId,
          seq,
          attempt: 1,
          kind: next.plan.kind,
          step: planned(seq, next.plan, known),
          status: "planned",
          result: null,
          logs: next.log === "" ? [] : [next.log],
          plannedAt: work.iso,
          startedAt: null,
          completedAt: null,
        };
  const held = ended && keptOnPause(options.held ?? null) ? (options.held?.seq ?? null) : null;
  const updated: GameRun = {
    ...withState(run, next.state),
    status: ended ? "ended" : step?.step.kind === "propose" ? "waiting" : "running",
    seq,
    inFlight: ended ? held : (step?.seq ?? null),
    endedAt: ended ? work.iso : run.endedAt,
    updatedAt: work.iso,
  };
  return {
    events: [
      ...(finished === null ? [] : [stepEvent(work, finished)]),
      ...(step === null ? [] : [stepEvent(work, step)]),
      ...(next.record === null
        ? []
        : [
            event(work, "game-run-round.recorded", {
              id: gameRunRoundId(run.id, next.record.round),
              runId: run.id,
              threadId: run.threadId,
              round: next.record,
              recordedAt: work.iso,
            }),
          ]),
      runEvent(work, updated, options.created === true),
    ],
    effects: step === null ? [] : effectsOf(step),
    cancelEffects: false,
  };
};

const finish = (
  work: Work,
  record: GameRunStep,
  result: GameRunStepResult,
  log: string,
): GameRunStep => ({
  ...record,
  status: result.kind === "failed" ? "failed" : "completed",
  result,
  logs: log === "" ? record.logs : [...record.logs, log],
  completedAt: work.iso,
});

const stateOf = (work: Work, run: GameRun) => toState(run, work.records.rounds);

// ── Commands. ───────────────────────────────────────────────────────────────
const start = (work: Work, command: Command<"game-run.start">) => {
  const prior = work.records.runs.at(-1) ?? null;
  if (prior !== null && prior.status !== "ended")
    return refuse("run-live", "Keep going is already on in this chat.");
  // One run per game: another chat of the same project may hold it.
  const elsewhere = work.records.projectRun;
  if (elsewhere !== null && elsewhere.status !== "ended")
    return refuse("run-live", "Keep going is on in another chat of this game.");
  if (!GAME_ENGINES[command.engine].turnLoop)
    return refuse(
      "no-turn-loop",
      "Keep going needs an engine Kurambit plays after every turn (three.js).",
    );
  if (work.records.runs.some((r) => r.id === command.runId))
    return refuse("stale-run", `Run ${command.runId} already exists in this chat.`);
  // The person's waiting notes outlive a run: a new one on the game takes them up.
  const carried = elsewhere?.steer ?? prior?.steer ?? [];
  const run: GameRun = {
    id: command.runId,
    threadId: command.threadId,
    projectId: work.records.projectId,
    lane: command.lane,
    engine: command.engine,
    profile: command.profile,
    budgetMinutes: command.budgetMinutes,
    budgetEndsAt: command.budgetMinutes === null ? null : work.now + command.budgetMinutes * 60_000,
    status: "running",
    ending: null,
    steer: [...carried],
    setAside: [],
    stallStreak: 0,
    supersededStreak: 0,
    lastFailure: "",
    seq: 0,
    inFlight: null,
    endedAt: null,
    startedAt: work.iso,
    updatedAt: work.iso,
  };
  return Result.succeed(
    land(
      work,
      run,
      { state: stateOf(work, run), plan: LOOK, record: null, log: "keep going started" },
      null,
      { created: true },
    ),
  );
};

const resume = (work: Work, command: Command<"game-run.resume">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status !== "ended") return refuse("run-live", "Keep going is already on.");
    if (run.ending === null || !RESUMABLE.has(run.ending))
      return refuse(
        "not-resumable",
        "Keep going finished on this game; turning it on starts it afresh.",
      );
    const elsewhere = work.records.projectRun;
    if (elsewhere !== null && elsewhere.id !== run.id && elsewhere.status !== "ended")
      return refuse("run-live", "Keep going is on in another chat of this game.");
    const budgetMinutes =
      command.budgetMinutes === undefined ? run.budgetMinutes : command.budgetMinutes;
    const resumed: GameRun = {
      ...run,
      profile: command.profile ?? run.profile,
      budgetMinutes,
      budgetEndsAt: budgetMinutes === null ? null : work.now + budgetMinutes * 60_000,
      ending: null,
      lastFailure: "",
      // A resume starts both streaks afresh, so it always takes a step.
      stallStreak: 0,
      supersededStreak: 0,
    };
    const held = inFlightOf(work, run);
    if (keptOnPause(held) && held !== null) {
      // The judge or undo the pause cut off runs again, as a new attempt.
      const again: GameRunStep = {
        ...held,
        attempt: held.attempt + 1,
        status: "planned",
        result: null,
        logs: [...held.logs, "keep going resumed: this step runs again"],
        toolWaits: 0,
        startedAt: null,
        completedAt: null,
      };
      return only(
        [
          stepEvent(work, again),
          runEvent(work, {
            ...resumed,
            status: "running",
            inFlight: held.seq,
            updatedAt: work.iso,
          }),
        ],
        effectsOf(again),
      );
    }
    return Result.succeed(
      land(
        work,
        resumed,
        { state: stateOf(work, resumed), plan: LOOK, record: null, log: "keep going resumed" },
        null,
      ),
    );
  });

/**
 * Off, or the server's own pause for a tool that kept failing. The step in
 * flight is cancelled; a judge or undo stays the run's for a resume to run
 * again. A step turn that had started gives its notes back.
 */
const stop = (work: Work, command: Command<"game-run.stop">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    if (run.status === "ended")
      return refuse("run-ended", `Keep going ended (${run.ending ?? "unknown"}).`);
    const inFlight = inFlightOf(work, run);
    const why = command.reason?.trim() ?? "";
    // The server's own stop for a tool that kept failing is a pause with its
    // reason, never the person's act.
    const paused = command.ending === "tool-failed";
    const line = paused ? `paused: ${why}` : `stopped${why.length > 0 ? `: ${why}` : ""}`;
    const turn = inFlight?.step.kind === "turn" ? inFlight.step : null;
    const giveBack = turn !== null && inFlight?.status === "running" && turn.steer.length > 0;
    const ended: GameRun = {
      ...run,
      status: "ended",
      ending: paused ? "tool-failed" : "stopped",
      lastFailure: why.slice(0, 600),
      steer: giveBack ? [...turn.steer, ...run.steer] : run.steer,
      inFlight: keptOnPause(inFlight) ? run.inFlight : null,
      endedAt: work.iso,
      updatedAt: work.iso,
    };
    return Result.succeed<GameRunDecision>({
      events: [
        ...(inFlight === null
          ? []
          : [
              stepEvent(work, {
                ...inFlight,
                status: "cancelled",
                logs: [...inFlight.logs, line],
                completedAt: work.iso,
              }),
            ]),
        runEvent(work, ended),
      ],
      effects: [],
      cancelEffects: true,
    });
  });

/** The look before a pending proposal: the folder its turn starts from. */
const proposalBase = (work: Work, record: GameRunStep) =>
  resultOf(cycleStep(work, record, 1)?.result, "look")?.current ?? null;

/** The pending proposal gives way: it is answered, then the policy goes on from `next`. */
const answerProposal = (
  work: Work,
  run: GameRun,
  record: GameRunStep,
  result: StepResult<"decided">,
  next: Next,
) => Result.succeed(land(work, run, next, finish(work, record, result, next.log)));

/**
 * The person's note for the next step, from any chat of the game. A live run
 * takes it at its next look; a pending Guided proposal gives way to it at
 * once, since the person asked for it. An ended run keeps it for its resume.
 */
const steer = (work: Work, command: Command<"game-run.steer">) =>
  Result.flatMap(current(work, command.runId), (run) => {
    const noted: GameRun = { ...run, steer: [...run.steer, command.note.trim()] };
    const state = stateOf(work, noted);
    const record = run.status === "ended" ? null : inFlightOf(work, run);
    if (record?.step.kind === "propose") {
      const proposal = steerProposal(state);
      if (proposal !== null && !state.setAside.some((entry) => entry.key === proposal.key))
        return answerProposal(
          work,
          noted,
          record,
          { kind: "decided", answer: "superseded", by: "creator" },
          startTurn(state, proposal, proposalBase(work, record), "creator", work.now),
        );
    }
    return only([runEvent(work, { ...noted, updatedAt: work.iso })]);
  });

const profileSet = (work: Work, command: Command<"game-run.profile.set">) =>
  Result.flatMap(live(work, command.runId), (run) => {
    const switched: GameRun = { ...run, profile: command.profile };
    const record = inFlightOf(work, run);
    // Nobody needs to answer Autopilot: the pending proposal starts now.
    if (command.profile === "autopilot" && record?.step.kind === "propose")
      return answerProposal(
        work,
        switched,
        record,
        { kind: "decided", answer: "start", by: "server" },
        startTurn(
          stateOf(work, switched),
          record.step.proposal,
          proposalBase(work, record),
          "autopilot",
          work.now,
        ),
      );
    return only([runEvent(work, { ...switched, updatedAt: work.iso })]);
  });

const pendingProposal = (work: Work, run: GameRun, decisionId: string) => {
  const record = inFlightOf(work, run);
  if (record === null || record.step.kind !== "propose")
    return refuse(
      "no-decision",
      "Keep going has no proposal waiting now; it may have started already.",
    );
  if (record.id !== decisionId)
    return refuse(
      "stale-decision",
      `Proposal ${decisionId} is not the one waiting; ${record.id} is.`,
    );
  return Result.succeed({ record, step: record.step });
};

/** The person's answer to a Guided proposal: Start now, Skip, or hold it while they edit it. */
const decideCommand = (work: Work, command: Command<"game-run.decide">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(pendingProposal(work, run, command.decisionId), ({ record, step }) => {
      if (command.answer === "hold")
        // The deadline effect still fires, and finds nothing due.
        return only([
          stepEvent(work, {
            ...record,
            step: { ...step, deadline: null },
            logs: [...record.logs, "held for the person"],
          }),
          runEvent(work, { ...run, updatedAt: work.iso }),
        ]);
      return answerProposal(
        work,
        run,
        record,
        { kind: "decided", answer: command.answer, by: "creator" },
        applyDecided(
          stateOf(work, run),
          step.proposal,
          proposalBase(work, record),
          command.answer,
          "creator",
          work.now,
        ),
      );
    }),
  );

/** The proposal's deadline fired: the default starts it, unless it was held or answered. */
const expire = (work: Work, command: Command<"game-run.decision.expire">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(pendingProposal(work, run, command.decisionId), ({ record, step }) =>
      step.deadline === null || work.now < step.deadline
        ? refuse("not-due", `Proposal ${record.id} is not due.`)
        : answerProposal(
            work,
            run,
            record,
            { kind: "decided", answer: "start", by: "default" },
            applyDecided(
              stateOf(work, run),
              step.proposal,
              proposalBase(work, record),
              "start",
              "default",
              work.now,
            ),
          ),
    ),
  );

/** A step's timer, set by its own work: the turn's cap again, a resend, or its work again later. */
const schedule = (work: Work, command: Command<"game-run.step.schedule">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId, command.attempt), (record) => {
      const base = { runId: run.id, stepId: record.id, attempt: record.attempt };
      const timer = command.timer;
      const effect: GameRunEffect =
        timer.kind === "cap"
          ? { request: { type: "game-run.step.deadline", ...base }, availableAt: command.at }
          : timer.kind === "resend"
            ? {
                request: { type: "game-run.step.resend", ...base, turn: timer.turn, n: timer.n },
                availableAt: command.at,
              }
            : { request: { type: "game-run.step.wake", ...base }, availableAt: command.at };
      // The step records the timer: the orchestrator commits no command without
      // an event, and a timer only an effect carried would never be set.
      const line =
        timer.kind === "cap"
          ? "its turn's time cap is set again"
          : timer.kind === "resend"
            ? "its turn is sent again later"
            : timer.kind === "tool"
              ? `a tool of Kurambit's failed: the step waits (${timer.n})`
              : "its work runs again";
      return only(
        [
          stepEvent(work, {
            ...record,
            ...(timer.kind === "tool"
              ? { toolWaits: Math.max(record.toolWaits ?? 0, timer.n) }
              : {}),
            logs: [...record.logs, line],
          }),
        ],
        [effect],
      );
    }),
  );

/**
 * A step's work began. A turn step's turn is running: it takes the notes it
 * carries off the front of the run's steer and starts its cap.
 */
const stepStart = (work: Work, command: Command<"game-run.step.start">) =>
  Result.flatMap(live(work, command.runId), (run) =>
    Result.flatMap(currentStep(work, run, command.stepId, command.attempt), (record) => {
      if (record.status === "running") return Result.succeed(NOTHING);
      const started: GameRunStep = { ...record, status: "running", startedAt: work.iso };
      if (record.step.kind !== "turn") return only([stepEvent(work, started)]);
      const turn = record.step;
      return only(
        [
          stepEvent(work, started),
          runEvent(work, {
            ...run,
            steer: run.steer.slice(turn.steer.length),
            updatedAt: work.iso,
          }),
        ],
        [
          {
            request: {
              type: "game-run.step.deadline",
              runId: run.id,
              stepId: record.id,
              attempt: record.attempt,
            },
            availableAt: work.now + turn.capMs,
          },
        ],
      );
    }),
  );

/** A turn and what it landed, read back from the turn step's record. */
const cycleOf = (turnRecord: GameRunStep | null): Cycle | null => {
  if (turnRecord === null || turnRecord.step.kind !== "turn") return null;
  const result = resultOf(turnRecord.result, "turn");
  return result === null
    ? null
    : {
        turn: turnRecord.step,
        result,
        since: epoch(turnRecord.startedAt ?? turnRecord.plannedAt),
      };
};

/** What a step's result leads to, by the kind of step it reports on. */
const nextOf = (
  work: Work,
  run: GameRun,
  record: GameRunStep,
  result: GameRunStepResult,
): Result.Result<Next, GameRunRefusal> => {
  // A started turn that ends without landing gives back the notes its start
  // took, whichever way it ends, so no note of the person's is lost.
  const state =
    (result.kind === "ended" || result.kind === "failed") &&
    record.step.kind === "turn" &&
    record.status === "running"
      ? giveBackSteer(stateOf(work, run), record.step, true)
      : stateOf(work, run);
  // Nothing was measured: the run pauses with why, and judges nothing (a
  // judge or undo runs again on resume).
  const ended = resultOf(result, "ended");
  if (ended !== null)
    return Result.succeed(
      end(state, ended.ending, ended.reason, `paused (${ended.ending}): ${ended.reason}`),
    );
  const failed = resultOf(result, "failed");
  if (failed !== null)
    return Result.succeed(end(state, "failed", failed.reason, `failed: ${failed.reason}`));
  const wrong = () =>
    refuse("wrong-kind", `A ${record.step.kind} step cannot finish with a ${result.kind} result.`);
  const step = record.step;
  switch (step.kind) {
    case "look": {
      const look = resultOf(result, "look");
      return look === null ? wrong() : Result.succeed(applyLook(state, look, work.now));
    }
    case "propose": {
      // Only the server reports on a proposal: a turn started on the game.
      const decided = resultOf(result, "decided");
      return decided === null || decided.answer !== "superseded"
        ? refuse("wrong-kind", "A proposal is answered with game-run.decide.")
        : Result.succeed(
            applyDecided(state, step.proposal, null, "superseded", "server", work.now),
          );
    }
    case "turn": {
      const turn = resultOf(result, "turn");
      return turn === null
        ? wrong()
        : Result.succeed(
            applyTurn(state, step, turn, {
              now: work.now,
              since: epoch(record.startedAt ?? record.plannedAt),
              started: record.status === "running",
            }),
          );
    }
    case "judge": {
      const judge = resultOf(result, "judge");
      const cycle = cycleOf(cycleStep(work, record, 1));
      if (judge === null) return wrong();
      if (cycle === null)
        return refuse("stale-step", `Step ${record.id} has no turn record to judge.`);
      return Result.succeed(applyJudge(state, cycle, judge, work.now));
    }
    case "undo": {
      const undo = resultOf(result, "undo");
      const judge = resultOf(cycleStep(work, record, 1)?.result, "judge");
      const cycle = cycleOf(cycleStep(work, record, 2));
      if (undo === null) return wrong();
      if (judge === null || cycle === null)
        return refuse("stale-step", `Step ${record.id} has no judged turn to undo.`);
      return Result.succeed(applyUndo(state, { ...cycle, judge }, undo, work.now));
    }
    default:
      return refuse("wrong-kind", `A ${step.kind} step is not a keep-going step.`);
  }
};

const stepResult = (
  work: Work,
  runId: GameRunId,
  stepId: GameRunStepId,
  attempt: number,
  result: GameRunStepResult,
) =>
  Result.flatMap(live(work, runId), (run) =>
    Result.flatMap(currentStep(work, run, stepId, attempt), (record) =>
      Result.map(nextOf(work, run, record, result), (next) =>
        land(work, run, next, finish(work, record, result, next.log), {
          // Only a pause keeps its judge or undo for the resume; an ending the
          // step's own result led to (stalled, budget) has nothing left owed.
          held: result.kind === "ended" || result.kind === "failed" ? record : null,
        }),
      ),
    ),
  );

export const decide = (
  command: OrchestrationV2GameRunCommand,
  records: GameRunRecords,
  at: DateTime.Utc,
): Result.Result<GameRunDecision, GameRunRefusal> => {
  const work: Work = {
    command,
    records,
    at,
    now: DateTime.toEpochMillis(at),
    iso: DateTime.formatIso(at),
  };
  switch (command.type) {
    case "game-run.stop":
      return stop(work, command);
    case "game-run.start":
      return start(work, command);
    case "game-run.resume":
      return resume(work, command);
    case "game-run.steer":
      return steer(work, command);
    case "game-run.profile.set":
      return profileSet(work, command);
    case "game-run.decide":
      return decideCommand(work, command);
    case "game-run.decision.expire":
      return expire(work, command);
    case "game-run.step.start":
      return stepStart(work, command);
    case "game-run.step.complete":
      return stepResult(work, command.runId, command.stepId, command.attempt, command.result);
    case "game-run.step.fail":
      return stepResult(work, command.runId, command.stepId, command.attempt, {
        kind: "failed",
        reason: command.reason,
      });
    case "game-run.step.schedule":
      return schedule(work, command);
  }
};
