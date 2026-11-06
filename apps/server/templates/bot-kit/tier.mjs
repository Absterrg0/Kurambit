// Bot kit: the harness's bot tiers (idle.mjs, masher.mjs) share this. A tier
// starts a run from the title with Enter, plays it for a fixed span of game
// time, and reports how the run ended in the shell's own words
// (GameState.state "ended", GameState.result "won" or "lost"). The harness
// reads the ending from the game's state, not from this file; the times and
// the first response are this file's evidence.
//
// tier-bounds.mjs is written beside it by the harness for each measurement.
import { posOf, stateOf, factsOf } from "./sensors.mjs";
import { PLAY_SECONDS, START_SECONDS } from "./tier-bounds.mjs";

// A run that never ends must still report, so no stall cut ends it first.
export const stallSeconds = 3600;

/**
 * One tier: `drive(api, ctx)` plays each tick of a run in progress and
 * returns the keys to hold. `ctx` is {t, since, pos}: game seconds now,
 * since play began, and the player's position (null when the game reports none).
 */
export function makeTier(tier, drive) {
  const held = new Set();
  let firstT = null;
  let playingAt = null;
  let endedAt = null;
  let lastEnter = -1e9;
  let last = null;
  const hold = (api, keys) => {
    const want = new Set(keys);
    for (const key of [...held]) if (!want.has(key)) (api.release(key), held.delete(key));
    for (const key of want) if (!held.has(key)) (api.hold(key), held.add(key));
  };
  const observe = (api, raw) => {
    const t = typeof raw?.t === "number" ? raw.t : 0;
    if (firstT === null) firstT = t;
    const state = stateOf(raw);
    const pos = posOf(raw);
    if (state === "playing" && playingAt === null) playingAt = t;
    if (state === "ended" && endedAt === null && playingAt !== null) endedAt = t;
    if (playingAt === null) {
      hold(api, []);
      // The shells focus Play first, so Enter starts a run.
      if (state === "title" && t - lastEnter >= 1) {
        lastEnter = t;
        api.press("Enter");
      }
    } else if (endedAt === null && state === "playing") {
      hold(api, drive(api, { t, since: t - playingAt, pos }));
    } else hold(api, []);
    last = { t, state, result: factsOf(raw)?.result ?? null, pos };
    return last;
  };
  const evidence = (extra) => ({ tier, playingAt, endedAt, ...extra });
  return {
    goal: `${tier} tier: start a run and ${tier === "idle" ? "do nothing" : "press keys at random"} for ${PLAY_SECONDS[tier]} s of play`,
    observe,
    options: () => [{ name: "play", run: () => "running" }],
    status: (obs, extra = {}) => {
      if (obs === null || obs === undefined) return { state: "running" };
      if (playingAt === null && obs.t - (firstT ?? obs.t) > START_SECONDS)
        return {
          state: "never-started",
          note: `Enter at the title did not start a run in ${START_SECONDS} s (the game stayed at "${obs.state}")`,
          evidence: evidence(extra),
        };
      if (endedAt !== null)
        return {
          state: "done",
          note: `the run ended: ${String(obs.result)}`,
          evidence: evidence(extra),
        };
      if (playingAt !== null && obs.t - playingAt >= PLAY_SECONDS[tier])
        return {
          state: "done",
          note: `no ending in ${PLAY_SECONDS[tier]} s of play`,
          evidence: evidence(extra),
        };
      return { state: "running" };
    },
  };
}
