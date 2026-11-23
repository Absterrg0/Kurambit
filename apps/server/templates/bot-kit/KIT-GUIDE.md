// Bot kit guidance: how testers write bots with this kit.
// Adapted from Aura's autopilot KIT.md + harness.py + agents/session.py
// SYSTEM (Apache-2.0, ramenvr/autopilot): the doctrine (facts/options vs
// script, plans, reflexes in code) is theirs; this file is ours.

# Bot kit: write decisions, not navigation

## Stepped bots: start here

A bot file that exports `decide(obs)` plays inside the game's page on the
run's own clock, as fast as the page allows, instead of in real time:

```js
export const goal = "Reach the reeds";
// obs: { t, step, state (GameState), player ([x, y, z] or null), keys, ctx }
export function decide(obs) {
  return obs.player && obs.player[0] < 14 ? ["move_right"] : ["jump"];
}
```

`decide` runs every fixed step and returns the names of the ACTIONS held
during it (main.js's `ACTIONS`, as `ctx.input` reads them). The run ends with
the game's own `GameState.win`/`lose`, or after `seconds` of play. Its run is
a play with one id: `game_play` op `replay` `{run: <id>, at: <s>}` shows any
second of it, `{save: <name>, run: <id>}` keeps it as a test play. `obs.keys`
maps a key code (`"KeyD"`) to the action it presses, for a bot that plays by
keys. An exported `report()` returns the bot's own evidence, kept with the
run. Keep `decide` plain JavaScript with no imports. The kit's format below still runs
(in real time) for files that export `observe` instead.

The kit (`kit/*.mjs`) drives keys and reads the game. Your bot file
(`.studio/bot/<name>.mjs`) decides. The split:

- **Code computes facts and legal options.** `observe(api, last)` reads the
  tick and returns facts in the player's terms (distances, counts, what is
  held, what is in danger). `options(obs)` lists what is legal _now_, each
  with its own facts. Few options (2-8), each a whole meaningful step.
- **Your policy decides.** `policy(obs, opts)` picks among the options at
  tempo; without one, the first option on offer runs.
- **A fixed route is a script, not a bot.** Waypoint lists with one legal
  option at a time leave nothing to choose between. Offer real alternatives:
  flank vs frontal, fight vs retreat, wait vs push, which target, heal now
  or later. Executors do the fast part in code every tick (steer, time a
  press); the policy chooses what to do.

## What a run is for

A bot is a win bot: its goal is to finish the game or reach the ending, and
it answers "can this be finished, and does it hold together?". Options are
the sensible plays toward the goal; `policy` encodes the best route you
know. Score it on the ending.

## Shape

```js
import { posOf, stateOf, hudHas } from "./kit/sensors.mjs";
import { makeHolds } from "./kit/steer.mjs";
import { makeWalkTo, driveWalk } from "./kit/walk.mjs";

export const goal = "Win a run: clear both floors and take the stair.";
export const tempo = 4;          // decisions/second (reflex play: 4-8)
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
export function policy(obs, opts) { /* pick one of opts by name */ }
```

## Option outcomes and run context

An option's `run` must return `"done"` when it arrived or has nothing left
to do, `"failed"` when it cannot work from here, else `"running"`. The
child then stops offering a done option until the option set changes (a
failed one rests 30 s), so the policy cannot re-pick an arrived option
hundreds of times. Options that always return `"running"` stay on offer: a
walker that reached its target but never says so is how runs collapse onto
one spot. Give options their own facts: the policy reads them, and the
trace lists what was offered.

Every observation carries `runContext`: `{seed, runIndex, runTotal,
priorRuns}` where each prior run is `{topOptions, cells, ending}`. Use it
so runs of one call differ: seed the first choice from `seed`, and avoid
opening with what earlier runs already covered. Tell the truth about it in
`status` notes.

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

Read the game's code for its rules and verbs (which key does what, what a
pickup needs, how a run is won), then take everything about where things are
and how fast they go from what the game reports while it plays: its state
values, the player's position and body, the HUD. Never copy a position, a
layout, a speed or a timing from the game's code into the bot. A later step
that moves a platform or tunes a jump then breaks the bot, and the skilled
fact reads the game as unwinnable when it is not. When the game reports nothing the bot needs, play
from what it does report (progress, the player's position and whether it is
on the ground) rather than a route. Every option gets its own facts. Reflexes (dodge a telegraphed
hit) go in executor code every tick, never in a policy decision: a decision
waits for the next tempo beat, too slow for a fast hit.

## Reach (what the runner gives you)

- Keys W/A/S/D, arrows, Space, Shift, E, Enter, F-keys; clicks on listed UI
  controls or at screen points; `setState` writes (reported, never the
  player's position in play: teleports don't count as play).
- Observations at 10 Hz: game state values, player position, HUD text, body
  (on-ground, velocity), visible landmarks, wall/drop clearance (3D), shape
  overlap, engine errors. 2D games have no room rays: steer by position.
- Not every engine reports everything. Browser (three.js) games give game
  state, player position, HUD text and page errors only, and skip id-clicks
  (click at screen points). A missing field reads as unknown, so guard for it.

## The harness's random-input play (masher)

`kit/masher.mjs` is the stepped bot the harness plays every build with for
its facts; `game_check` plays a run with no input besides. Run the masher
yourself with `game_play` op `bot` (`file: ".studio/bot/kit/masher.mjs"`).
It starts a fresh run, holds each direction for a second (its
first-response probe) and then presses the shell's keys at random with a
fixed seed, until the run ends or after its span of play. Its ending is the
game's own `win`/`lose`. If the masher wins in seconds, the game has no
challenge; if no input wins, it plays itself.

## Proving the game can be won

Every build's measure plays `.studio/bot/play.mjs` when the game has one.
Write it when the person asks you to prove the game can be won: a win bot
with a `policy` whose goal is to win one run of the core loop with the
game's own verbs. Run it with `game_play` op `bot` and fix it until it plays
a full run. Keep it general to the game's verbs and goal
rather than one level's layout: it reads the game's state as it plays,
never numbers copied from the code. Update it when the game's rules change.
