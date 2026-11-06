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
type NotMeasured = {
  readonly status: "not-measured";
  readonly why: string;
  readonly retry: boolean;
};

export const notMeasured = (why: string, retry: boolean): NotMeasured => ({
  status: "not-measured",
  why: why.slice(0, 300),
  retry,
});

/** A game operation that kept a fact from being measured; null when it is the build's own. */
export const faultOf = (error: GameOperationError): NotMeasured | null =>
  gameOperationFault(error.reason) === "build"
    ? null
    : notMeasured(
        `${error.operation}: ${(error.detail ?? error.reason).split("\n")[0]}`,
        !isStandingFault(error.reason),
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
      return notMeasured(
        "the game ran slower than real time, so the span of play did not fit the run's wall budget",
        true,
      );
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

/** Won without skill: either the idle or the random player won; false only when both were measured. */
export const winnableOf = (idle: TierFact, masher: TierFact): Facts["winnableWithoutSkill"] => {
  const won = (fact: TierFact) => fact.status === "measured" && fact.value.ending === "won";
  if (won(idle) || won(masher)) return { status: "measured", value: true };
  if (idle.status === "pending" || masher.status === "pending") return { status: "pending" };
  if (idle.status === "measured" && masher.status === "measured")
    return { status: "measured", value: false };
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
  const final = result.finalState;
  if (final["state"] === "ended" && (final["result"] === "won" || final["result"] === "lost"))
    return value(final["result"], null);
  return value("no-ending", status);
};
