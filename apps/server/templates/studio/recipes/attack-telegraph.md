# Attack telegraph and windows

**When.** Any enemy that attacks the player, and any player attack with a cost.

## Numbers

- Dark Souls 3 analysis: human perceive, think and act take about **100, 70 and 70 ms**. A new
  attack's signal plus the attack lasts **at least 340 ms** to be fair; a bait hold at least
  **240 ms**; a return at least **170 ms**. Input response 60 to 100 ms; DS3's hitbox is live
  2 to 4 frames. Its medium roll's invincibility is 433 ms.
- Fighting games name the same phases startup, active, recovery.
- Player light attack: anticipation 6 to 10 frames at 60 fps (100 to 170 ms), active 2 to 4,
  recovery 15 to 25; a cancel into dodge in the last 30 to 40% of recovery (judgement).
- Boss: windup **0.4 to 0.8 s**, slower for heavies; a punish window of **0.6 to 1.2 s** after
  each attack (judgement).

## Steps

1. Give each attack three phases in code: windup, active, recovery, with their times in
   `ctx.tune` so the person can tune them.
2. Windup: a distinct pose held for its time, plus a sound and a light (a glint, a glow).
3. Active: sweep the hitbox over the frames, or keep the weapon's trail, so a fast swing
   never skips the target.
4. Recovery: visibly vulnerable; the player's hits land here.
5. Put the phase on `GameState` (`bossPhase: "windup"`) so a bot and `eval` can read it.

## Pitfalls

- A telegraph shorter than reaction time.
- No anticipation pose; recovery the player cannot see.
- Active frames so short the hitbox misses between steps.
- Restarting invincibility on every touch.

## Code

None.

## Sources

"Anatomy of an Enemy Attack in Dark Souls 3" (Game Developer, read). critpoints, "Frame data
patterns" (read). Enemy attack and telegraphing write-ups (read second-hand).
