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

/** PURE. A second of play as a clock reads it: "0:08", "2:14", "1:02:05". */
export const clockLabel = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const s = String(whole % 60).padStart(2, "0");
  const m = Math.floor(whole / 60);
  return m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
};

/** PURE. How long a run's play lasts, in seconds of play. */
export const playSeconds = (play: GamePlay): number => play.outcome.seconds;

/** PURE. The first second a replay stood elsewhere than the play, up to the second it stopped. */
const differsUpTo = (play: GamePlay, replay: ReadonlyArray<GamePlayMark>, seconds: number) =>
  firstPlayDifference(
    play.marks.filter((mark) => mark.t <= seconds + 1e-6),
    replay.filter((mark) => mark.t <= seconds + 1e-6),
  );

/**
 * PURE. A reload's resume, in words, when it is news: the run starting fresh and why, the run now
 * ending before the moment, or where the changed game first played differently. Null when it is
 * simply back where it was, which the person sees. `play` is the run the old page handed over;
 * `replayed` the new page's answer.
 */
export const resumeNotice = (play: GamePlay, replayed: StudioReplayed): string | null => {
  const when = clockLabel(playSeconds(play));
  if (replayed.missing !== undefined)
    return `This run pressed ${replayed.missing.join(", ")}, which the game no longer has, so it starts fresh`;
  if (replayed.slow !== undefined)
    return `Getting back to ${when} took over ${replayed.slow} s, so it starts fresh`;
  if (replayed.ended != null)
    return `With the change, this run now ends at ${clockLabel(replayed.ended.seconds)}${
      replayed.ended.text === "" ? "" : ` (${replayed.ended.text})`
    }`;
  const differs = differsUpTo(play, replayed.marks ?? [], replayed.seconds ?? playSeconds(play));
  return differs === null
    ? null
    : `Back where you were (${when}); with the change, play differs from ${clockLabel(differs.seconds)}: ${differs.what}`;
};

/** PURE. Whether a run can come back after a reload: a run in play, not too long to replay. */
export const resumable = (play: GamePlay | null): play is GamePlay =>
  play !== null && play.steps > 0 && playSeconds(play) <= RESUME_MAX_S;
