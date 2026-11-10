import type {
  GameBuildSource,
  GameKeepGoingInput,
  GameKeepGoingMode,
  GameKeepGoingStatus,
  GameRunProfile,
  GameRunStepWhy,
} from "@kurambit/contracts";

/** A clock time in the reader's locale: nothing on the client counts down. */
const clockTime = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

export const KEEP_GOING_MODES: ReadonlyArray<{
  readonly mode: GameKeepGoingMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "off", label: "Off", description: "Your agent waits for your message." },
  {
    mode: "guided",
    label: "Guided",
    description: "Proposes each next step and starts it after a minute unless you change it.",
  },
  {
    mode: "autopilot",
    label: "Autopilot",
    description: "Takes each next step itself, and undoes one that makes a fact worse.",
  },
];

/** Minutes; null is no limit. */
export const KEEP_GOING_BUDGETS: ReadonlyArray<{
  readonly minutes: number | null;
  readonly label: string;
}> = [
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: null, label: "No limit" },
];
const DEFAULT_BUDGET = 60;

/** A radio group's value for a budget: radio values are strings. */
export const budgetValue = (minutes: number | null): string =>
  minutes === null ? "none" : String(minutes);
export const budgetFromValue = (value: string): number | null =>
  value === "none" ? null : Number(value);

const WHY_LABEL: Record<GameRunStepWhy, string> = {
  steer: "your note",
  blocker: "blocker",
  regression: "after an undo",
  bot: "a bot for the skilled fact",
  fact: "a failing fact",
  next: "your agent's next step",
};
const stepWhyLabel = (why: GameRunStepWhy): string => WHY_LABEL[why];

/** The status with the run's last mode, which a paused run resumes in (null: never ran). */
type KeepGoingStatus = GameKeepGoingStatus & { readonly profile?: GameRunProfile | null };

/** The mode a paused run resumes in; Guided when unknown, since it waits for the person. */
const resumeMode = (status: KeepGoingStatus): GameRunProfile => status.profile ?? "guided";

const liveHere = (status: GameKeepGoingStatus, threadId: string) =>
  status.mode !== "off" && status.chat === threadId;

export interface KeepGoingControlView {
  /** "Keep going" while off, paused or live in another chat; the mode while live here. */
  readonly label: string;
  /** Live in this chat. */
  readonly pressed: boolean;
  readonly value: GameKeepGoingMode;
  /** Why the whole control is disabled, or null. */
  readonly disabled: string | null;
  /** Why Guided and Autopilot are disabled while Off stays enabled, or null. */
  readonly modesDisabled: string | null;
  readonly budget: number | null;
  readonly budgetDisabled: boolean;
  /** The budget group's label: "Until 15:10" while live here. */
  readonly budgetLabel: string;
  readonly tooltip: string;
}

/**
 * PURE. The composer control from the run's status. Stopping is always
 * allowed, so a run live in another chat leaves Off enabled here; a budget
 * chosen while off is held for the next start or resume.
 */
export const keepGoingControlView = (
  input: {
    readonly status: GameKeepGoingStatus | null;
    readonly error: string | null;
    readonly threadId: string;
    readonly canOperate: boolean;
    readonly sending: boolean;
    /** The budget the person picked here; undefined keeps the run's own. */
    readonly chosenBudget: number | null | undefined;
  },
  clock: (at: string) => string = clockTime,
): KeepGoingControlView => {
  const { status } = input;
  const live = status !== null && status.mode !== "off";
  const here = status !== null && liveHere(status, input.threadId);
  const disabled = !input.canOperate
    ? "You don't have permission to run turns here."
    : status === null
      ? (input.error ?? "Reading keep going…")
      : input.sending
        ? "Sending…"
        : !live && status.blocked !== null
          ? status.blocked
          : null;
  const modesDisabled =
    live && !here ? (status?.blocked ?? "Keep going is on in another chat.") : null;
  const budget =
    here || input.chosenBudget === undefined
      ? status === null || status.runId === null
        ? DEFAULT_BUDGET
        : status.budgetMinutes
      : input.chosenBudget;
  const endsAt = here ? status.endsAt : null;
  const mode = KEEP_GOING_MODES.find((entry) => entry.mode === status?.mode);
  return {
    label: here && mode !== undefined ? mode.label : "Keep going",
    pressed: here,
    value: status?.mode ?? "off",
    disabled,
    modesDisabled,
    budget,
    budgetDisabled: live,
    budgetLabel: endsAt !== null ? `Until ${clock(endsAt)}` : here ? "No limit" : "Budget",
    tooltip:
      disabled ??
      modesDisabled ??
      (here && mode !== undefined
        ? mode.description
        : status !== null && status.ending !== null
          ? status.message
          : "Your agent takes the next step itself, in this chat."),
  };
};

/**
 * PURE. What choosing a mode sends, or null when it changes nothing: the
 * mode it already has here, or Off with nothing live. A budget goes only when
 * the person picked one, so a resume keeps the run's own.
 */
export const keepGoingRequest = (
  status: GameKeepGoingStatus | null,
  threadId: string,
  mode: GameKeepGoingMode,
  chosenBudget: number | null | undefined,
): Pick<GameKeepGoingInput, "mode" | "budgetMinutes"> | null => {
  if (status === null) return null;
  if (mode === "off") return status.mode === "off" ? null : { mode };
  if (liveHere(status, threadId) && status.mode === mode) return null;
  return chosenBudget === undefined ? { mode } : { mode, budgetMinutes: chosenBudget };
};

export type KeepGoingBannerView =
  | {
      readonly kind: "proposal";
      readonly id: string;
      readonly stepId: string;
      /** "Step 3 · a failing fact:" */
      readonly lead: string;
      /** The proposal's first line; the full text is `text`. */
      readonly line: string;
      readonly text: string;
      /** "Starts at 14:32", or "Waits for you" while held. */
      readonly detail: string;
      readonly held: boolean;
    }
  | {
      readonly kind: "live";
      readonly id: string;
      readonly title: string;
      /** Why keep going wrote no play bot, through its first step; else null. */
      readonly note: string | null;
    }
  | {
      readonly kind: "paused";
      readonly id: string;
      readonly title: string;
      readonly resume: GameRunProfile;
    }
  | { readonly kind: "ended"; readonly id: string; readonly title: string };

/**
 * PURE. The keep-going banner in the run's own chat, or
 * null. Live lines are composed here so their times are the reader's clock;
 * a pause or an end reads the server's one plain line.
 */
export const keepGoingBannerView = (
  status: KeepGoingStatus | null,
  threadId: string,
  clock: (at: string) => string = clockTime,
): KeepGoingBannerView | null => {
  if (status === null || status.runId === null || status.chat !== threadId) return null;
  const runId = status.runId;
  if (status.mode === "off") {
    if (status.ending === null) return null;
    const id = `keep-going-ended:${runId}:${status.ending}`;
    return status.resumable
      ? { kind: "paused", id, title: status.message, resume: resumeMode(status) }
      : { kind: "ended", id, title: status.message };
  }
  const n = status.step;
  const proposal = status.proposal;
  // Said once: through the run's first step, then the run goes on without it.
  const note =
    status.botSetup?.state === "skipped" && (n === null || n <= 1)
      ? `No play bot: ${status.botSetup.reason}`
      : null;
  if (proposal !== null && (status.phase === "proposed" || status.phase === "held")) {
    const held = proposal.deadline === null;
    return {
      kind: "proposal",
      id: `keep-going-proposal:${proposal.stepId}`,
      stepId: proposal.stepId,
      lead: `${n === null ? "Next step" : `Step ${n}`} · ${stepWhyLabel(proposal.why)}:`,
      line: proposal.summary,
      text: proposal.text,
      detail: [
        proposal.deadline === null ? "Waits for you" : `Starts at ${clock(proposal.deadline)}`,
        ...(note === null ? [] : [note]),
      ].join(" · "),
      held,
    };
  }
  const step = n === null ? "Keep going" : `Keep going · step ${n}`;
  const reason = status.steps.find((entry) => entry.n === n)?.reason ?? "";
  const title =
    status.botSetup?.state === "running"
      ? "Keep going · writing a play bot in a session of its own"
      : status.phase === "waiting"
        ? `Keep going · waits for this turn to end${status.endsAt === null ? "" : ` · until ${clock(status.endsAt)}`}`
        : status.phase === "turn"
          ? `${step} · your agent is working on it`
          : status.phase === "measuring"
            ? `${step} · measuring the build before keeping it`
            : status.phase === "undoing"
              ? `${n === null ? "Undoing the last step" : `Undoing step ${n}`}${reason === "" ? "" : `: ${reason}`}`
              : "Keep going · reading the current build's facts";
  return { kind: "live", id: `keep-going:${runId}`, title, note };
};

/**
 * PURE. Keep going takes the `Next:` line itself while it is live on
 * Autopilot or has a proposal pending here, so the Next banner steps aside.
 */
export const keepGoingHidesNext = (status: GameKeepGoingStatus | null, threadId: string) =>
  status !== null &&
  liveHere(status, threadId) &&
  (status.mode === "autopilot" || status.proposal !== null);

type StepSource = NonNullable<Extract<GameBuildSource, { _tag: "turn" }>["step"]>;

/** PURE. What a step's verdict says, after "Step N · ". */
export const stepVerdictText = (step: StepSource): string => {
  switch (step.verdict) {
    case null:
      return "measuring before keeping it";
    case "kept":
      return `kept: ${step.reason || "no fact got worse"}`;
    case "undone":
      return step.reason === "" ? "undone" : `undone: ${step.reason}`;
    // The server's reason says why the undo left it: the game moved on, or
    // the restore itself failed. Only the first is the person's later change.
    case "kept-moved-on":
      return step.reason === "" ? "not undone" : `not undone: ${step.reason}`;
    case "no-change":
      return "changed no game files";
    case "not-measured":
      return step.reason === "" ? "kept: not measured" : `kept: not measured (${step.reason})`;
    case "stopped":
      return "stopped by you";
  }
};

/** PURE. The strip's line for a step turn: "Step 3 · undone: Random input now crashes at 12 s". */
export const stepLine = (step: StepSource): string => `Step ${step.n} · ${stepVerdictText(step)}`;
