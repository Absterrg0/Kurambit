# A readable boss

**When.** A duel, a boss fight, or any one foe the game is about.

## Numbers

- 3 to 4 attacks, each with its own windup pose and sound; windup 0.4 to 0.8 s; a recovery
  window of 0.6 to 1.2 s after each (judgement; `attack-telegraph` has the sourced floors).
- Phase 2 at **50% health**: one new attack and a faster version of an old one, never only
  more damage (judgement from boss-design write-ups).
- The player dies in **5 to 8** unblocked hits; the boss falls in **20 to 40** player hits
  (judgement).
- Knobs worth exposing in `ctx.tune` (default and range, judgement, meant to be swept by a
  bot): player health 100 (60 to 200), boss health 400 (200 to 1000), boss damage 12 (6 to 25),
  windup 0.6 s (0.3 to 1.0), recovery 0.9 s (0.4 to 1.5), stamina per swing 15 (5 to 30), dodge
  invincibility 0.25 s (0.1 to 0.4), phase-2 threshold 0.5 (0.3 to 0.7).
- HUD: the boss's **name and bar at top centre, 40 to 60% of the screen wide**; the player's
  health and stamina at bottom left (judgement). Bench 3's one duel win had a named boss with
  health and stamina.
- A skilled bot wins 60 to 90% of seeds; random input wins under 5% (judgement).

## Steps

1. Name the boss on screen; draw its bar and the player's (`hud-that-reads`).
2. Build each attack's three phases (`attack-telegraph`), each with a pose, a sound and a
   light cue.
3. After each attack, a visible punish window; between combos a 2 to 4 s breath where it
   circles (`tension-release`).
4. At half health: a roar, a new attack, a faster old one.
5. Win and lose screens with the result and Retry (`retry-one-press`).
6. Write a play bot that wins by reading the windup, and save its winning play.

## Pitfalls

- A phase that only scales health or damage.
- Windups that cannot be read: punish poor timing, not poor visual design.
- All foes attacking at once; at most one or two melee attackers at a time.

## Code

None.

## Sources

Boss phases and telegraph write-ups (molbv.github.io; Game Developer, read second-hand).
Bench 3's duel-1 win (Kurambit's loop report). Duel knobs: DESIGN-RECIPES §6.1 (judgement).
