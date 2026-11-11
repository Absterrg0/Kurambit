// PURE. How a measurement's raw results become facts: a bot tier's run
// becomes an ending or a reason it was not measured, winnable-without-skill
// is derived from the tiers, and a list row gets its few chips. Only a
// measurement is a fact: a tool or the machine that kept a tier from playing
// is "not measured", with whether waiting can clear it.
import {
  GAME_FACTS_BOUNDS,
  type GameBotRunResult,
  type GameBuildFacts,
  type GameBuildFactsSummary,
  type GameCheckResult,
  type GameFactTone,
  type GameOperationError,
  gameFactsView,
  gameOperationFault,
  isStandingFault,
} from "@kurambit/contracts";

type Facts = GameBuildFacts;
type TierFact = Facts["idle"];
/**
 * Not measured, and why. `retry`: waiting can clear it, so any measure tries
 * again. `standing`: a tool or the machine that waiting will not fix (a
 * missing program, a game too slow for the budget); a person's measure tries
 * again, since they may have fixed it. Neither: the build's own reason (it
 * reports no run state), measured again only by a new harness.
 */
type NotMeasured = {
  readonly status: "not-measured";
  readonly why: string;
  readonly retry: boolean;
  readonly standing?: true;
};

export const notMeasured = (why: string, retry: boolean, standing = false): NotMeasured => ({
  status: "not-measured",
  why: why.slice(0, 300),
  retry,
  ...(standing && !retry ? { standing: true as const } : {}),
});

/** Whether a stored reading is a standing fault a person's measure tries again. */
export const isStanding = (fact: unknown): boolean =>
  typeof fact === "object" && fact !== null && "standing" in fact && fact.standing === true;

/** A game operation that kept a fact from being measured; null when it is the build's own. */
export const faultOf = (error: GameOperationError): NotMeasured | null => {
  if (gameOperationFault(error.reason) === "build") return null;
  const retry = !isStandingFault(error.reason);
  return notMeasured(
    `${error.operation}: ${(error.detail ?? error.reason).split("\n")[0]}`,
    retry,
    !retry,
  );
};

/**
 * How busy the machine was over a bot's play, as the harness sees it:
 * `stalled` is the share of the window some task waited for a CPU (Linux's
 * CPU pressure), null where the OS has none; `load` the 1-minute load average
 * at its end, the fallback. Our own game and bot count in both, which the
 * thresholds leave room for.
 */
export interface MachineLoad {
  readonly cores: number;
  readonly stalled: number | null;
  readonly load: number;
  /** The harness's browser drew on the CPU (no GPU backend on this machine). */
  readonly software?: boolean;
}
/** Where the facts view reads these as bad (gameFactsView in contracts). */
const FIRST_RESPONSE_BAD = 0.5;
export const FREEZE_BAD = 3;
const BUSY_STALLED = 0.2;
const BUSY_LOAD_PER_CORE = 0.75;

/** Whether other work on the machine, not the game, can explain a slow run. */
export const machineBusy = (machine: MachineLoad | null): boolean =>
  machine !== null &&
  (machine.stalled !== null
    ? machine.stalled >= BUSY_STALLED
    : machine.load / Math.max(1, machine.cores) >= BUSY_LOAD_PER_CORE);

/**
 * A timing reading that looks bad but was taken while other work held the
 * machine: it says nothing about the game, so it is not stored as measured
 * (never compared, never a regression) and the next measure takes it again. A
 * good reading on a busy machine stands: other work cannot make a game faster.
 */
export const busyReading = (what: string, machine: MachineLoad | null): NotMeasured | null =>
  machineBusy(machine)
    ? notMeasured(
        `${what} while the machine was busy (load ${machine!.load.toFixed(1)} on ${machine!.cores} cores), so it says nothing about the game`,
        true,
      )
    : null;

const SOFTWARE_TOO_SLOW = "the harness renders in software here";
/** How the one standing fault that is the game's own begins: a step can make it faster. */
const SLOW_ON_IDLE = "the game ran at ";

/**
 * A tier this machine cannot measure until a person fixes the machine or its
 * tools (a missing program such as ffmpeg, a browser drawing in software).
 * The skilled tier plays the same way, so it would not be measured either.
 */
export const machineFault = (
  fact: TierFact,
): fact is Extract<TierFact, { status: "not-measured" }> =>
  fact.status === "not-measured" && isStanding(fact) && !fact.why.startsWith(SLOW_ON_IDLE);

/** The no-input or random-input tier that is a machine fault, if either is. */
export const unmeasurableTier = (facts: Pick<Facts, "idle" | "masher">) =>
  [facts.masher, facts.idle].find(machineFault);

/**
 * A run below real time: its span of play did not fit the wall budget. In a
 * browser drawing on the CPU it says nothing about the game; on a busy
 * machine neither, so it is retried; only a slow game on an idle machine,
 * drawing on its GPU, is standing (a person's measure tries again).
 */
const tooSlow = (result: GameBotRunResult, playSeconds: number, machine: MachineLoad | null) =>
  machine?.software === true
    ? notMeasured(
        `${SOFTWARE_TOO_SLOW}, so the game ran at ${result.timeRatio.toFixed(2)}× real time`,
        false,
        true,
      )
    : machineBusy(machine)
      ? notMeasured(
          `the machine was busy (load ${machine!.load.toFixed(1)} on ${machine!.cores} cores), so the game ran at ${result.timeRatio.toFixed(2)}× real time`,
          true,
        )
      : notMeasured(
          `${SLOW_ON_IDLE}${result.timeRatio.toFixed(2)}× real time on an idle machine, so ${playSeconds} s of play did not fit the run's wall budget`,
          false,
          true,
        );

/** What a tier bot reports in its status evidence (templates/bot-kit/tier.mjs). */
interface TierEvidence {
  readonly playingAt: number | null;
  readonly endedAt: number | null;
  readonly response?: {
    readonly positions: boolean;
    readonly seconds: number | null;
    readonly window: number;
  };
}

export const tierEvidenceOf = (value: unknown): TierEvidence | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const num = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : null);
  const response = record["response"] as Record<string, unknown> | undefined;
  return {
    playingAt: num("playingAt"),
    endedAt: num("endedAt"),
    ...(typeof response === "object" && response !== null
      ? {
          response: {
            positions: response["positions"] === true,
            seconds: typeof response["seconds"] === "number" ? response["seconds"] : null,
            window: typeof response["window"] === "number" ? response["window"] : 1,
          },
        }
      : {}),
  };
};

const round = (value: number) => Number(value.toFixed(1));

/**
 * One tier bot's run as a fact. The ending is read from the game's own run
 * state (`state` "ended", `result` "won" or "lost"), never from the bot's
 * word; the bot gives only the times. A crash, a game that stops answering
 * or never boots is measured about the build.
 */
export const tierFact = (
  result: GameBotRunResult,
  playSeconds: number,
  evidence: string | null,
  machine: MachineLoad | null = null,
): TierFact => {
  const status = result.status.state;
  const note = result.status.note.slice(0, 200);
  const times = tierEvidenceOf(result.status.evidence);
  const since = (t: number | null) =>
    t === null || times?.playingAt === null || times?.playingAt === undefined
      ? null
      : round(Math.max(0, t - times.playingAt));
  const measured = (
    ending: "won" | "lost" | "no-ending" | "crashed" | "unresponsive" | "did-not-boot",
    at: number | null,
  ): TierFact => ({
    status: "measured",
    value: {
      ending,
      at,
      played: round(Math.max(0, at ?? since(result.gameSeconds) ?? 0)),
      note,
      evidence,
    },
  });
  if (result.played === false) return notMeasured(`the tier bot did not play: ${note}`, false);
  switch (status) {
    case "crashed":
      return measured(status, since(result.gameSeconds));
    case "unresponsive":
      return (
        busyReading("the game stopped answering", machine) ??
        measured(status, since(result.gameSeconds))
      );
    case "not-booted":
      return measured("did-not-boot", null);
    case "stopped":
      return notMeasured("the measurement was stopped", true);
    case "never-started":
      return notMeasured(note, false);
    case "budget":
      return tooSlow(result, playSeconds, machine);
    case "done": {
      const final = result.finalState;
      if (typeof final["state"] !== "string")
        return notMeasured(
          "the game does not report the shell's run state (GameState.state and result)",
          false,
        );
      if (final["state"] === "ended") {
        const ending = final["result"];
        if (ending !== "won" && ending !== "lost")
          return notMeasured(
            `the run ended with result "${String(ending)}", neither won nor lost`,
            false,
          );
        if (times?.endedAt === null || times?.endedAt === undefined)
          return notMeasured("the bot and the game disagree on whether the run ended", true);
        return measured(ending, since(times.endedAt));
      }
      if (times?.endedAt !== null && times?.endedAt !== undefined)
        return notMeasured("the bot and the game disagree on whether the run ended", true);
      return {
        status: "measured",
        value: { ending: "no-ending", at: null, played: playSeconds, note, evidence },
      };
    }
    default:
      return notMeasured(`the tier bot ended "${status}": ${note}`, false);
  }
};

/** Rows whose reading follows how fast the machine ran the play (keep going's loop.ts leaves the scene ones unguarded for the same reason). */
const TIMING_ROWS: ReadonlySet<string> = new Set([
  "freeze",
  "motion",
  "first-response",
  "performance",
  "clipping",
  "fell",
  "camera",
  "sliding",
]);
/** Timing rows whose best reading is neutral, never good. */
const NEUTRAL_AT_BEST: ReadonlySet<string> = new Set(["motion"]);
/** A play beside another that kept at least this share of real time ran as it would alone. */
const SHARED_REAL_TIME = 0.9;
const UNREAD = notMeasured("not part of this play", false);

/**
 * Why a play that ran beside another may owe its reading to it, or null when
 * it cannot: the game ran below real time, a reading only waiting clears, or
 * a timing row reads worse than its best. Such a play is played again alone
 * before anything is stored. A good reading stands: sharing the machine never
 * made a game faster or smoother.
 */
export const sharedPlaySuspect = (
  result: GameBotRunResult | null,
  patch: Partial<Facts>,
): string | null => {
  if (result !== null && result.timeRatio < SHARED_REAL_TIME)
    return `it ran at ${result.timeRatio.toFixed(2)}× real time`;
  for (const fact of Object.values(patch))
    if (typeof fact === "object" && fact !== null && "status" in fact)
      if (fact.status === "not-measured" && fact.retry)
        return `a reading only waiting clears: ${fact.why}`;
  const facts: Facts = {
    build: "",
    key: "",
    harness: "",
    state: "measuring",
    measuredAt: null,
    renderer: null,
    message: "",
    boots: UNREAD,
    idle: UNREAD,
    masher: UNREAD,
    skilled: UNREAD,
    winnableWithoutSkill: UNREAD,
    liveness: UNREAD,
    firstResponse: UNREAD,
    assets: UNREAD,
    use: UNREAD,
    performance: UNREAD,
    scene: UNREAD,
    ...patch,
  } as Facts;
  const slow = gameFactsView(facts).find(
    (row) =>
      TIMING_ROWS.has(row.id) &&
      row.reading._tag === "measured" &&
      (row.reading.tone === "bad" ||
        (row.reading.tone === "neutral" && !NEUTRAL_AT_BEST.has(row.id))),
  );
  return slow === undefined || slow.reading._tag !== "measured"
    ? null
    : `its ${slow.id} reading is below its best (${slow.reading.text})`;
};

/** The masher's first-response probe as a fact. */
export const firstResponseOf = (
  result: GameBotRunResult,
  machine: MachineLoad | null = null,
): Facts["firstResponse"] => {
  const response = tierEvidenceOf(result.status.evidence)?.response;
  if (response === undefined) return notMeasured("the random-input run reported no probe", false);
  if (!response.positions)
    return notMeasured("the game reports no player position, so a response cannot be seen", false);
  const slow = response.seconds === null || response.seconds > FIRST_RESPONSE_BAD;
  return (
    (slow ? busyReading("movement answered slowly or not at all", machine) : null) ?? {
      status: "measured",
      value: { seconds: response.seconds, window: response.window, resolution: 0.1 },
    }
  );
};

const BROKE: ReadonlySet<string> = new Set(["crashed", "unresponsive", "did-not-boot"]);

/**
 * Won without skill: the idle or the random player won. False only when both
 * played to a loss or to no ending; a run that broke says nothing about skill.
 */
export const winnableOf = (idle: TierFact, masher: TierFact): Facts["winnableWithoutSkill"] => {
  const won = (fact: TierFact) => fact.status === "measured" && fact.value.ending === "won";
  if (won(idle) || won(masher)) return { status: "measured", value: true };
  if (idle.status === "pending" || masher.status === "pending") return { status: "pending" };
  if (idle.status === "measured" && masher.status === "measured") {
    if (BROKE.has(idle.value.ending) || BROKE.has(masher.value.ending))
      return notMeasured(
        "the no-input or random-input run broke (crashed, stopped answering or did not boot)",
        false,
      );
    return { status: "measured", value: false };
  }
  const missing = idle.status === "not-measured" ? idle : masher;
  return notMeasured(
    `needs both the no-input and the random-input run: ${missing.status === "not-measured" ? missing.why : "not measured"}`,
    missing.status === "not-measured" ? missing.retry : true,
  );
};

const TONE_ORDER: Readonly<Record<GameFactTone, number>> = { bad: 0, good: 1, neutral: 2 };

/** A list row's facts: its state, at most three worded chips (what is wrong first), and how many were not measured. */
export const summaryOf = (facts: Facts): GameBuildFactsSummary => {
  const rows = gameFactsView(facts);
  const chips = rows
    .flatMap((row) =>
      row.reading._tag === "measured" && row.reading.tone !== "neutral"
        ? [{ id: row.id, text: row.reading.text, tone: row.reading.tone }]
        : [],
    )
    .toSorted((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
    .slice(0, 3);
  const tone = (wanted: GameFactTone) =>
    rows.filter((row) => row.reading._tag === "measured" && row.reading.tone === wanted).length;
  return {
    state: facts.state,
    chips,
    notMeasured: rows.filter((row) => row.reading._tag === "not-measured").length,
    good: tone("good"),
    bad: tone("bad"),
  };
};

/** The wall budget a tier's bot run gets: the start, its span of play, and slack for boot and pacing. */
export const tierWallSeconds = (playSeconds: number) =>
  Math.min(600, GAME_FACTS_BOUNDS.startSeconds + playSeconds + 30);

/**
 * The engine check of a build's copy as a fact, worded as the run's boot check
 * words it; `source` names a check made elsewhere of the same files.
 */
export const bootsFact = (result: GameCheckResult, source?: string): Facts["boots"] => ({
  status: "measured",
  value: {
    ok: result.ok,
    detail: result.ok
      ? source === undefined
        ? "boot clean"
        : `boot clean (${source})`
      : `check failed: ${
          result.errors
            .slice(0, 3)
            .map((e) => `${e.file ? `${e.file}: ` : ""}${e.message}`.slice(0, 200))
            .join("; ") || "no error lines (see the check log)"
        }`,
  },
});

/**
 * The game's own play bot on a build. Its ending is the game's run state
 * when the game reports one; the bot's own end word is kept beside it, never
 * read as a win.
 */
export const skilledFact = (
  result: GameBotRunResult,
  bot: { readonly file: string; readonly hash: string; readonly decider: "policy" | "jev" },
  evidence: string | null,
  machine: MachineLoad | null = null,
): Facts["skilled"] => {
  const status = result.status.state;
  const note = result.status.note.slice(0, 200);
  const played = round(result.gameSeconds);
  const value = (
    ending: "won" | "lost" | "no-ending" | "crashed" | "unresponsive" | "did-not-boot",
    botWord: string | null,
  ): Facts["skilled"] => ({
    status: "measured",
    value: {
      ending,
      at: ending === "won" || ending === "lost" ? played : null,
      played,
      note,
      evidence,
      bot,
      botWord,
    },
  });
  if (result.played === false) return notMeasured(`the bot did not play: ${note}`, false);
  if (status === "crashed") return value(status, null);
  if (status === "unresponsive")
    return busyReading("the game stopped answering", machine) ?? value(status, null);
  if (status === "not-booted") return value("did-not-boot", null);
  if (status === "stopped") return notMeasured("the measurement was stopped", true);
  if (status === "bot-error") return notMeasured(`the bot itself failed: ${note}`, false);
  if (status === "budget") return tooSlow(result, GAME_FACTS_BOUNDS.skilledSeconds, machine);
  const final = result.finalState;
  if (final["state"] === "ended" && (final["result"] === "won" || final["result"] === "lost"))
    return value(final["result"], null);
  return value("no-ending", status);
};

/** A build captured before a turn began: a turn checkpoint (its thread and turn) or a run's build. */
export interface EarlierBuild {
  readonly id: string;
  readonly at: string;
  readonly thread: string | null;
  readonly turn: number | null;
}
/**
 * What a turn's changes are counted from, when T3's own list would be wrong:
 * the newest build of the game captured after the thread's previous turn and
 * before this turn began (the run's, another chat's). Null keeps T3's list,
 * which is exact for a thread's first turn (T3 captures its baseline as the
 * turn starts) and the best known when the previous turn is not among the
 * builds read (a page ends there): no base older than T3's proves anything.
 */
export const turnChangeBase = (
  turn: {
    readonly id: string;
    readonly startedAt: string;
    readonly thread: string;
    readonly turn: number;
  },
  earlier: ReadonlyArray<EarlierBuild>,
): string | null => {
  if (turn.turn <= 1) return null;
  // The thread's newest earlier capture, as T3's own diff base is: a run with
  // no checkpoint between them (a restart's continuation) takes a number too.
  const previous = earlier.reduce<EarlierBuild | null>(
    (best, e) =>
      e.thread === turn.thread &&
      e.turn !== null &&
      e.turn < turn.turn &&
      (best === null || e.turn > (best.turn ?? 0))
        ? e
        : best,
    null,
  );
  if (previous === null) return null;
  const base = earlier
    .filter((e) => e.id !== turn.id && e.at > previous.at && e.at <= turn.startedAt)
    .reduce<EarlierBuild | null>(
      (newest, e) => (newest === null || e.at > newest.at ? e : newest),
      null,
    );
  return base === null ? null : base.id;
};
