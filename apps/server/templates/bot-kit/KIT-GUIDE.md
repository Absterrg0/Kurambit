// Bot kit guidance: how testers write bots with this kit.
// Adapted from Aura's autopilot KIT.md + harness.py + agents/session.py
// SYSTEM (Apache-2.0, ramenvr/autopilot): the doctrine (facts/options vs
// script, plans, reflexes in code) is theirs; this file is ours.

# Bot kit: write decisions, not navigation

The kit (`kit/*.mjs`) drives keys and reads the game. Your bot file
(`.studio/bot/<name>.mjs`) decides. The split:

- **Code computes facts and legal options.** `observe(api, last)` reads the
  tick and returns facts in the player's terms (distances, counts, what is
  held, what is in danger). `options(obs)` lists what is legal _now_, each
  with its own facts. Few options (2-8), each a whole meaningful step.
- **Jev decides.** With decider `jev`, Jev picks among the options at tempo;
  with `policy`, your `policy(obs, opts)` picks. The kit works with both.
- **A fixed route is a script, not a bot.** Waypoint lists with one legal
  option at a time give Jev nothing to choose between and do not count as a
  Jev run (needs 3+ decisions among 2+ options). Offer real alternatives:
  flank vs frontal, fight vs retreat, wait vs push, which target, heal now
  or later. Executors do the fast part in code every tick (steer, time a
  press); Jev chooses what to do.

## Run types: what each run is for

- **Win bot (`mode: "play"`).** Goal: finish the game or reach the ending.
  Answers "can this be finished, and does it hold together?". Options are
  the sensible plays toward the goal; `policy` encodes the best route you
  know. Score it on the ending.
- **Exploration bot (`mode: "explore"`).** Goal: try everything. Never try
  to win. Options cover the mechanics broadly (every verb, every direction,
  every usable thing, edge cases, limits), preferring what hasn't been tried
  yet — Aura's rule for "an exploration". Do not score it on wins: a run
  that never finishes still reports where play dies, stalls, or goes
  untried. Several runs (`runs: 3+`) feed one player report.
- **Jev vs randomised policy.** With decider `jev` and a key, Jev picks.
  Without a key the service says so plainly (`policyNote`) and an
  exploration bot picks uniformly at random instead — which is still useful
  coverage, but it is not Jev and must never be reported as Jev. A win bot
  without a key falls back to your `policy`.
- **Player report.** After exploration runs the service writes
  `.studio/player-report.md` from the run traces: endings, pick counts,
  offered-but-never-picked options, first-action times, death/stall clusters
  with positions and times, sampled areas, detector findings, explicit state
  writes. Code states facts and interprets nothing. Reviewers read it as
  facts; your notes say what you felt.

## Shape

```js
import { posOf, stateOf, hudHas } from "./kit/sensors.mjs";
import { makeHolds } from "./kit/steer.mjs";
import { makeWalkTo, driveWalk } from "./kit/walk.mjs";

export const goal = "Win a run: clear both floors and take the stair.";
export const tempo = 4;          // decisions/second (reflex play: 4-8)
export const switchMargin = 0.25;
export const stallSeconds = 60;

const holds = makeHolds();
let walkToGate = null;

export function observe(api, last) {
  const obs = { state: stateOf(last), pos: posOf(last), facts: factsOf(last) };
  // Per-tick steering runs here, every tick, not just on decisions.
  ...
  return obs;
}
export function options(obs) { /* 2+ legal options with facts */ }
export function status(obs) { /* running | done | failed + note */ }
export function policy(obs, opts) { /* fallback pick */ }
// Optional: plan(obs) -> {done: [...], now: {step, what} | null, next: [...]}
// The runtime offers Jev only the current step's options and tells it the
// plan's standing, so play can't wander back to steps already done.
```

## Option outcomes and run context (the exploration contract)

An option's `run` must return `"done"` when it arrived or has nothing left
to do, `"failed"` when it cannot work from here, else `"running"`. The
child then stops offering a done option until the option set changes (a
failed one rests 30 s), so Jev cannot re-pick an arrived option hundreds of
times. Options that always return `"running"` stay on offer: a walker that
reached its target but never says so is how runs collapse onto one spot.
Every decide request carries the child's tried counts per option (picks,
ok, fail), and the service adds visited-area coverage plus whether one pick
is stuck without moving — write options with their own facts anyway, for
the policy fallback and the report.

Every observation carries `runContext`: `{seed, runIndex, runTotal,
priorRuns}` where each prior run is `{topOptions, cells, ending}`. Use it
so runs of one call differ: seed the first choice from `seed`, and avoid
opening with what earlier runs already covered. Tell the truth about it in
`status` notes; the report states which run did what.

## Controllers

- `makeWalkTo(target, {mode: "xz"|"xy", within, timeoutS, jumpWhenStuck,
avoidDrops, avoidWalls, keyMap})` + `driveWalk(holds, walker, api, raw,
t)`: walk to a point (or () => point, re-read every tick: follows moving
  things). Steers round sensed walls, hops (Space) when stuck, stops at
  sensed drops. `mode: "xy"` for top-down 2D with the game's own keyMap.
- `faceKeys(mode, pos, goal, keyMap)`: steering toward a target. The runner
  has no mouse-look: attacks land by standing close, not by aiming a camera.
- `makeAttack(target, {key, reach, cooldownS, ...})`: close in and strike.
- `makeRetreat(threat, {seconds})`, `makeKeepAway(threat, {dist})`,
  `makeStrikeAndRetreat(...)`: hit and run for fights a plain attack loses.
- `makeTapper(key, cooldownS)`, `makeHoldFor(key, seconds)`,
  `makeHolds()`: press and hold helpers.

## Facts that play well

Read the game's code for exact rules (ranges, cooldowns, what a pickup
needs) and check them in play before relying on them. Put the numbers into
executors. Every option gets its own facts. Reflexes (dodge a telegraphed
hit) go in executor code every tick, never in a Jev decision: a decision
takes ~0.3s from sight to action, too slow for a fast hit.

## Reach (what the runner gives you)

- Keys W/A/S/D, arrows, Space, Shift, E, Enter, F-keys; clicks on listed UI
  controls or at screen points; `setState` writes (reported, never the
  player's position in play: teleports don't count as play).
- Observations at 10 Hz: game state values, player position, HUD text, body
  (on-ground, velocity), visible landmarks, wall/drop clearance (3D), shape
  overlap, engine errors. 2D games have no room rays: steer by position.
- Not every engine reports everything. Browser (three.js) games give game
  state, player position, HUD text and page errors only, and skip id-clicks
  (click at screen points). Unity games give no shape overlap and take no
  `setState` writes. A missing field reads as unknown, so guard for it.

## The harness's tiers (idle and masher)

`kit/idle.mjs` and `kit/masher.mjs` are the bots the harness plays every
build with for its facts; you can run them yourself with `game_bot_run`
(`file: ".studio/bot/kit/idle.mjs"`). Both press Enter at the title until a
run starts, then: idle sends nothing, masher holds each direction for a
second (its first-response probe) and then presses the shell's keys at
random with a fixed seed. Both stop when the run ends or after their span of
play. They read only the shell's run state (`GameState.state` and
`result`), so a game that keeps those and starts on Enter gets its facts.
If the masher wins in seconds, the game has no challenge; if idle wins, it
plays itself.

## A keep-going bot step

The harness's third tier, `skilled`, plays the game's latest play-mode bot
(the newest `game_bot_run` with `mode: "play"`). A game with none gets one
from a keep-going step, once: write `.studio/bot/play.mjs`, a win bot with a
`policy` whose goal is to win one run of the core loop with the game's own
verbs, run it with `game_bot_run` (decider `policy`) and fix it until it
plays a full run. Change no game files in that step: its build is the game
as it was, so only `skilled` is measured again. From then on every build is
played with it, so keep it general to the game's verbs and goal rather than
one level's layout, and update it when the game's rules change.
