import {
  firstPlayDifference,
  type GamePlay,
  type GamePlayMark,
  type StudioReplayed,
} from "@kurambit/contracts";

/**
 * Runs longer than this many seconds of play start fresh after a reload instead of coming back:
 * getting back replays the whole run, which on a heavy game in software rendering takes long.
 */
export const RESUME_MAX_S = 600;
/** How many seconds after a fork Compare plays, each way. */
const COMPARE_SECONDS = 3;

/** PURE. A second of play as a clock reads it: "0:08", "2:14", "1:02:05". */
export const clockLabel = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const s = String(whole % 60).padStart(2, "0");
  const m = Math.floor(whole / 60);
  return m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
};

/** PURE. How long a run's play lasts, in seconds of play. */
export const playSeconds = (play: GamePlay): number => play.outcome.seconds;

/** What the timeline marks on a run: its losses that did not end it, and how it ended. */
export interface RunTimelineMark {
  readonly seconds: number;
  readonly kind: "loss" | "won" | "lost" | "left";
  readonly label: string;
}

/** Values whose drop is a life lost, in a game that counts them. */
const LIVES = /^(lives?|hearts?)$/i;

/**
 * PURE. The marks a run's timeline shows: each loss Can't lose kept from ending the run, each life
 * a lives-counting game lost (a value named lives or hearts going down between two seconds), and
 * the ending. A run left mid-play marks no ending.
 */
export const runTimelineMarks = (play: GamePlay): ReadonlyArray<RunTimelineMark> => {
  const marks: Array<RunTimelineMark> = [];
  const secondsAt = (step: number) => Math.min(playSeconds(play), step * play.dt);
  for (const event of play.events) {
    if (event[1] !== "loss" || typeof event[0] !== "number") continue;
    const text = typeof event[2] === "string" && event[2] !== "" ? event[2] : "a loss";
    marks.push({ seconds: secondsAt(event[0]), kind: "loss", label: `${text} (Can't lose)` });
  }
  for (let i = 1; i < play.marks.length; i += 1) {
    const before = play.marks[i - 1]!;
    const now = play.marks[i]!;
    for (const [key, value] of Object.entries(now.values)) {
      const was = before.values[key];
      if (LIVES.test(key) && typeof value === "number" && typeof was === "number" && value < was)
        marks.push({ seconds: now.t, kind: "loss", label: `${key} ${was} → ${value}` });
    }
  }
  const { outcome } = play;
  if (outcome.left !== true)
    marks.push({
      seconds: outcome.seconds,
      kind: outcome.won ? "won" : "lost",
      label: `${outcome.won ? "Won" : "Lost"}${outcome.text === "" ? "" : `: ${outcome.text}`}`,
    });
  return marks.toSorted((a, b) => a.seconds - b.seconds);
};

/** What the Stage says once a replay to a moment has answered. */
export interface RewindNotice {
  readonly text: string;
  /** The run on the Stage is handed over and frozen there: Play on goes on from it. */
  readonly handedOver: boolean;
  /** It ended before the moment: the ending is held, and playing on plays it out. */
  readonly ended: boolean;
}

/** PURE. The first second a replay stood elsewhere than the play, up to the second it stopped. */
const differsUpTo = (play: GamePlay, replay: ReadonlyArray<GamePlayMark>, seconds: number) =>
  firstPlayDifference(
    play.marks.filter((mark) => mark.t <= seconds + 1e-6),
    replay.filter((mark) => mark.t <= seconds + 1e-6),
  );

/**
 * PURE. A reload's resume, in words: back at the moment the old page stood at (with where the
 * changed game first played differently), the run now ending before it, or why it starts fresh.
 * `play` is the run the old page handed over; `replayed` the new page's answer.
 */
export const resumeNotice = (play: GamePlay, replayed: StudioReplayed): RewindNotice => {
  const when = clockLabel(playSeconds(play));
  if (replayed.missing !== undefined)
    return {
      text: `This run pressed ${replayed.missing.join(", ")}, which the game no longer has, so it starts fresh`,
      handedOver: true,
      ended: false,
    };
  if (replayed.slow !== undefined)
    return {
      text: `Getting back to ${when} took over ${replayed.slow} s, so it starts fresh`,
      handedOver: true,
      ended: false,
    };
  if (replayed.ended != null)
    return {
      text: `With the change, this run now ends at ${clockLabel(replayed.ended.seconds)}${
        replayed.ended.text === "" ? "" : ` (${replayed.ended.text})`
      }`,
      handedOver: false,
      ended: true,
    };
  const differs = differsUpTo(play, replayed.marks ?? [], replayed.seconds ?? playSeconds(play));
  return {
    text:
      differs === null
        ? `Back where you were (${when})`
        : `Back where you were (${when}); with the change, play differs from ${clockLabel(differs.seconds)}: ${differs.what}`,
    handedOver: true,
    ended: false,
  };
};

/**
 * PURE. A rewind on the same page, in words. The game has not changed, so a replay standing
 * elsewhere than the run did is the game not repeating itself (it reads time or chance outside
 * the run): said plainly, since the moment shown is then only close.
 */
export const rewindNotice = (play: GamePlay, replayed: StudioReplayed): RewindNotice => {
  if (replayed.missing !== undefined || replayed.slow !== undefined)
    return resumeNotice(play, replayed);
  const seconds = replayed.seconds ?? 0;
  const differs = differsUpTo(play, replayed.marks ?? [], seconds);
  const exactly =
    differs === null
      ? ""
      : `Couldn't get back exactly: ${differs.what} at ${clockLabel(differs.seconds)}. `;
  if (replayed.ended != null)
    return {
      text: `${exactly}The run ends at ${clockLabel(replayed.ended.seconds)}`,
      handedOver: false,
      ended: true,
    };
  return {
    text: `${exactly}At ${clockLabel(seconds)}: tune values, then play on from here`,
    handedOver: true,
    ended: false,
  };
};

/** Where a rewound run went on live: the run it came from, and the step it went on from. */
export interface RunFork {
  readonly origin: GamePlay;
  readonly step: number;
  readonly seconds: number;
}

/** PURE. The tuned values the person changed since the fork: the "change" Compare takes away. */
const forkChanges = (fork: RunFork, run: GamePlay) => {
  // The run's play holds the origin's changes up to the fork step, then its own.
  const before = fork.origin.events.filter(
    ([step]) => typeof step === "number" && step <= fork.step,
  );
  return run.events.slice(before.length).filter((event) => event[1] === "tune");
};

/** PURE. Whether Compare has something to compare: values tuned since the fork. */
export const canCompare = (fork: RunFork | null, run: GamePlay | null): boolean =>
  fork !== null &&
  run !== null &&
  run.seed === fork.origin.seed &&
  run.fork === fork.seconds &&
  forkChanges(fork, run).length > 0;

/**
 * PURE. The two plays Compare replays from the fork for COMPARE_SECONDS: the same input after it,
 * "as it was" without the values tuned since the fork and "with the change" with them. The input
 * is the run's own when it went on that long after the fork, else the origin's (what the person
 * played before rewinding). `stop` is the step both hold at; `pace` the step they slow to real
 * time from, so the seconds after the fork play at the game's own pace.
 */
export const compareReplays = (
  fork: RunFork,
  run: GamePlay,
): { readonly before: GamePlay; readonly after: GamePlay; readonly stop: number } => {
  const changes = forkChanges(fork, run);
  const span = Math.round(COMPARE_SECONDS / run.dt);
  const own = run.steps - fork.step >= span;
  const base = own ? run : fork.origin;
  const stop = Math.min(fork.step + span, base.steps);
  if (own)
    return {
      before: { ...run, events: run.events.filter((event) => !changes.includes(event)) },
      after: run,
      stop,
    };
  const upTo = fork.origin.events.filter(([step]) => typeof step === "number" && step <= fork.step);
  const later = fork.origin.events.slice(upTo.length);
  // Both start from the values as the run began, the ones first tuned at the fork included.
  const origin = run.tunes === undefined ? fork.origin : { ...fork.origin, tunes: run.tunes };
  return {
    before: origin,
    after: { ...origin, events: [...upTo, ...changes, ...later] },
    stop,
  };
};

/** PURE. Whether a run can come back after a reload: a run in play, not too long to replay. */
export const resumable = (play: GamePlay | null): play is GamePlay =>
  play !== null && play.steps > 0 && playSeconds(play) <= RESUME_MAX_S;
