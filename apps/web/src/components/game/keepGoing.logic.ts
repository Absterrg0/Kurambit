import type {
  GameBuild,
  GameBuildSource,
  GameKeepGoingInput,
  GameKeepGoingMode,
  GameKeepGoingStatus,
} from "@kurambit/contracts";

/** Minutes; null is no limit. */
export const KEEP_GOING_BUDGETS: ReadonlyArray<{
  readonly minutes: number | null;
  readonly label: string;
}> = [
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
  { minutes: null, label: "No limit" },
];
const DEFAULT_BUDGET = 60;

/** A budget's minutes left, in the picker's words. */
const minutesLeft = (minutes: number): string =>
  minutes >= 60 && minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"} left`
    : `${minutes} min left`;

/** A radio group's value for a budget: radio values are strings. */
export const budgetValue = (minutes: number | null): string =>
  minutes === null ? "none" : String(minutes);
export const budgetFromValue = (value: string): number | null =>
  value === "none" ? null : Number(value);

const liveHere = (status: GameKeepGoingStatus, threadId: string) =>
  status.mode !== "off" && status.chat === threadId;

export interface KeepGoingControlView {
  /** Live in this chat. */
  readonly pressed: boolean;
  /** Why the whole control is disabled, or null. */
  readonly disabled: string | null;
  /** Why turning it on is disabled while Off stays enabled, or null. */
  readonly modesDisabled: string | null;
  readonly budget: number | null;
  readonly budgetDisabled: boolean;
  /** The budget group's label: "40 min left" while live here. */
  readonly budgetLabel: string;
}

/**
 * PURE. The run picker's Keep going choice from the run's status. Stopping is always
 * allowed, so a run live in another chat leaves Off enabled here; a budget
 * chosen while off is held for the next start or resume.
 */
export const keepGoingControlView = (input: {
  readonly status: GameKeepGoingStatus | null;
  readonly error: string | null;
  readonly threadId: string;
  readonly canOperate: boolean;
  readonly sending: boolean;
  /** The budget the person picked here; undefined keeps the run's own. */
  readonly chosenBudget: number | null | undefined;
}): KeepGoingControlView => {
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
  const left = here ? status.budgetLeftMinutes : null;
  return {
    pressed: here,
    disabled,
    modesDisabled,
    budget,
    budgetDisabled: live,
    budgetLabel: left !== null ? minutesLeft(left) : here ? "No limit" : "Keep going's budget",
  };
};

/**
 * PURE. What turning keep going on or off sends, or null when it changes
 * nothing: on while already on here, or Off with nothing live. A budget goes
 * only when the person picked one, so a resume keeps the run's own.
 */
export const keepGoingRequest = (
  status: GameKeepGoingStatus | null,
  threadId: string,
  mode: GameKeepGoingMode,
  chosenBudget: number | null | undefined,
): Pick<GameKeepGoingInput, "mode" | "budgetMinutes"> | null => {
  if (status === null) return null;
  if (mode === "off") return status.mode === "off" ? null : { mode };
  if (liveHere(status, threadId)) return null;
  return chosenBudget === undefined ? { mode } : { mode, budgetMinutes: chosenBudget };
};

export type KeepGoingBannerView =
  | {
      readonly kind: "live";
      readonly id: string;
      /** The tray's one slim line: "Keep going · step 3". */
      readonly line: string;
      /** What it is doing now, in full, for the line's tooltip. */
      readonly title: string;
    }
  | { readonly kind: "paused"; readonly id: string; readonly title: string }
  | { readonly kind: "ended"; readonly id: string; readonly title: string };

/**
 * PURE. The keep-going banner in the run's own chat, or null. A pause or an
 * end reads the server's one plain line until the person acts: a turn in the
 * chat after it (`lastTurnAt`, when the chat's newest turn was asked for)
 * retires it, as does turning keep going on again.
 */
export const keepGoingBannerView = (
  status: GameKeepGoingStatus | null,
  threadId: string,
  lastTurnAt: string | null = null,
): KeepGoingBannerView | null => {
  if (status === null || status.runId === null || status.chat !== threadId) return null;
  const runId = status.runId;
  if (status.mode === "off") {
    // Turned off by the person: the top bar's Keep going already says so.
    if (status.ending === null || status.ending === "stopped") return null;
    if (
      lastTurnAt !== null &&
      status.endedAt !== null &&
      Date.parse(lastTurnAt) > Date.parse(status.endedAt)
    )
      return null;
    const id = `keep-going-ended:${runId}:${status.ending}`;
    return status.resumable
      ? { kind: "paused", id, title: status.message }
      : { kind: "ended", id, title: status.message };
  }
  const n = status.step;
  const step = n === null ? "Keep going" : `Keep going · step ${n}`;
  const reason = status.steps.find((entry) => entry.n === n)?.reason ?? "";
  const left = status.budgetLeftMinutes;
  const title =
    status.phase === "waiting"
      ? `Keep going · waits for this turn to end${left === null ? "" : ` · ${minutesLeft(left)}`}`
      : status.phase === "turn"
        ? `${step} · your agent is working on it`
        : status.phase === "measuring"
          ? `${step} · measuring the build before keeping it`
          : status.phase === "undoing"
            ? `${n === null ? "Undoing the last step" : `Undoing step ${n}`}${reason === "" ? "" : `: ${reason}`}`
            : "Keep going · reading the current build's checks";
  const line =
    n === null
      ? "Keep going"
      : status.phase === "undoing"
        ? `Keep going · undoing step ${n}`
        : step;
  return { kind: "live", id: `keep-going:${runId}`, line, title };
};

/** PURE. Keep going takes the `Next:` line itself while it is live here, so the Next banner steps aside. */
export const keepGoingHidesNext = (status: GameKeepGoingStatus | null, threadId: string) =>
  status !== null && liveHere(status, threadId);

/**
 * PURE. What the composer's run picker says Send does: the person's own pick here, else Keep
 * going while it is on in this chat (after a restart, or from another window), else Once.
 */
export const runPick = (
  picked: "once" | "keep-going" | undefined,
  status: GameKeepGoingStatus | null,
  threadId: string,
): "once" | "keep-going" =>
  picked ?? (status !== null && liveHere(status, threadId) ? "keep-going" : "once");

type StepSource = NonNullable<Extract<GameBuildSource, { _tag: "turn" }>["step"]>;

/** PURE. What a step's verdict says, after "Step N · ". */
export const stepVerdictText = (step: StepSource): string => {
  switch (step.verdict) {
    // The server says what holds it: measuring, undoing, or a pause.
    case null:
      return step.reason || "measuring before keeping it";
    case "kept":
      return `kept: ${step.reason || "no check got worse"}`;
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

/** Without a run to scope it, the reel shows this many of Keep going's newest steps. */
const REEL_STEPS = 6;

const stepOf = (build: GameBuild) => (build.source._tag === "turn" ? build.source.step : null);

/**
 * PURE. The reel's steps, oldest first: the run's from its first step, else the newest few.
 * Each step's before is the build it was made from, else the build before it in the strip.
 */
export const reelSteps = (marks: ReadonlyArray<GameBuild>, firstStep: number | null) => {
  const steps = marks
    .map((build, index) => ({
      build,
      before:
        marks.find((entry) => entry.id === build.base) ??
        (index > 0 ? (marks[index - 1] ?? null) : null),
    }))
    .filter(({ build }) => {
      const step = stepOf(build);
      return step !== null && (firstStep === null || step.n >= firstStep);
    });
  return firstStep === null ? steps.slice(-REEL_STEPS) : steps;
};

/** PURE. The reel's heading: what the run's listed steps came to. */
export const reelHeading = (marks: ReadonlyArray<GameBuild>, firstStep: number | null) => {
  const steps = reelSteps(marks, firstStep).flatMap(({ build }) => stepOf(build) ?? []);
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined) return null;
  const undone = steps.filter((step) => step.verdict === "undone").length;
  const kept = steps.filter(
    (step) =>
      step.verdict === "kept" ||
      step.verdict === "kept-moved-on" ||
      step.verdict === "not-measured",
  ).length;
  const range = first.n === last.n ? `Step ${first.n}` : `Steps ${first.n}–${last.n}`;
  return `${range} · ${kept} kept · ${undone} undone`;
};
