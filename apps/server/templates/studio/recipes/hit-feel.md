# Hit feel: hit stop, flash, knockback, shake

**When.** Any hit a player lands or takes: melee, a projectile, a crash.

## Numbers

- Smash Ultimate's hitlag freezes attacker and victim `floor(damage × 0.65 + 6)` frames, at
  most 30: 5% → 9 frames, 10% → 12, 20% → 19. Particles keep moving during it.
- SpriteCook, at 60 ticks/s: hit stop **5 ticks** (9 on a kill); flash pure white **2 frames**;
  knockback 12 px over 8 ticks, easing `1 - (1 - t)³`; shake 3 px for 10 ticks as
  `3 × (1 - k/10)²`; **10 particles** in a 140° fan away from the attacker, 0.26 s life; a kill
  slows time to 0.3 for 12 ticks.
- For a weighty sword duel, a freeze of **80 to 200 ms** by damage (judgement, from Smash's
  curve).
- Screen shake by trauma (Eiserloh): trauma 0 to 1 added per hit, decaying **0.8/s**; shake
  = trauma²; roll at most **0.1 rad**; smooth noise, never per-frame random. In 3D an offset of
  0.1 to 0.3 m and roll up to 2° (judgement).
- The runtime's `juice.js`: hit pause 0.06 s at time scale 0.05, flash 0.12 s, trauma 0.4.

## Steps

1. On a hit: freeze both fighters (not the world's particles) for the damage's time.
2. Flash the target white for 2 frames: an emissive or additive white, not a tint.
3. Knock it back away from the attacker with an ease-out, stopped by walls.
4. Add trauma; shake only the drawn camera; let it return exactly to rest.
5. Sparks in a fan away from the attacker; a sound for every hit (`sound-set-mix`).

## Pitfalls

- A global time scale of 0 also freezes the timers that end the freeze.
- A multiply tint cannot flash white.
- Overwriting the camera's offset instead of adding to it.
- Knockback through walls; two hits in one freeze need a counter per fighter.
- No feedback at all: the duel on bench 4 lost on it.

## Code

The runtime's `juice.js` (`hitPause`, `shake`, `flash`). SpriteCook pages state no licence:
numbers cited, prose not copied.

## Sources

SmashWiki, "Hitlag" (read; arithmetic checked). SpriteCook, "Hit stop, hit flash, knockback"
(read). KidsCanCode's implementation of Squirrel Eiserloh's trauma shake, GDC 2016 (read).
