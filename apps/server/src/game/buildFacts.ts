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

/** A game below real time: its span of play did not fit the wall budget. Standing, never re-run in the background. */
const tooSlow = (result: GameBotRunResult, playSeconds: number) =>
  notMeasured(
    `the game ran at ${result.timeRatio.toFixed(2)}× real time, so ${playSeconds} s of play did not fit the run's wall budget`,
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
    case "unresponsive":
      return measured(status, since(result.gameSeconds));
    case "not-booted":
      return measured("did-not-boot", null);
    case "stopped":
      return notMeasured("the measurement was stopped", true);
    case "never-started":
      return notMeasured(note, false);
    case "budget":
      return tooSlow(result, playSeconds);
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

/** The masher's first-response probe as a fact. */
export const firstResponseOf = (result: GameBotRunResult): Facts["firstResponse"] => {
  const response = tierEvidenceOf(result.status.evidence)?.response;
  if (response === undefined) return notMeasured("the random-input run reported no probe", false);
  if (!response.positions)
    return notMeasured("the game reports no player position, so a response cannot be seen", false);
  return {
    status: "measured",
    value: { seconds: response.seconds, window: response.window, resolution: 0.1 },
  };
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
  return {
    state: facts.state,
    chips,
    notMeasured: rows.filter((row) => row.reading._tag === "not-measured").length,
  };
};

/** The wall budget a tier's bot run gets: the start, its span of play, and slack for boot and pacing. */
export const tierWallSeconds = (playSeconds: number) =>
  Math.min(600, GAME_FACTS_BOUNDS.startSeconds + playSeconds + 30);

/** The engine check of a build's copy as a fact, worded as the run's boot check words it. */
export const bootsFact = (result: GameCheckResult): Facts["boots"] => ({
  status: "measured",
  value: {
    ok: result.ok,
    detail: result.ok
      ? "boot clean"
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
  if (status === "crashed" || status === "unresponsive") return value(status, null);
  if (status === "not-booted") return value("did-not-boot", null);
  if (status === "stopped") return notMeasured("the measurement was stopped", true);
  if (status === "bot-error") return notMeasured(`the bot itself failed: ${note}`, false);
  if (status === "budget") return tooSlow(result, GAME_FACTS_BOUNDS.skilledSeconds);
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
  const previous = earlier.find((e) => e.thread === turn.thread && e.turn === turn.turn - 1);
  if (previous === undefined) return null;
  const base = earlier
    .filter((e) => e.id !== turn.id && e.at > previous.at && e.at <= turn.startedAt)
    .reduce<EarlierBuild | null>(
      (newest, e) => (newest === null || e.at > newest.at ? e : newest),
      null,
    );
  return base === null ? null : base.id;
};
