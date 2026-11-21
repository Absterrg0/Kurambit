# Tension and release

**When.** Any game with threats over time: waves, a boss, a storm, a chase.

## Numbers

Mike Booth, _The AI Systems of Left 4 Dead_ (Valve, 2009):

- "Constant, unchanging combat is fatiguing; long periods of inactivity are boring."
- An intensity value rises with damage taken and nearby kills, and decays over time, but not
  while the player is engaged.
- States: **build up** (full threat until intensity peaks), **sustain the peak 3 to 5 s**,
  peak fade, then **relax 30 to 45 s** with minimal threat, or until the players have moved on.
- Mobs every 90 to 180 s on Normal.

For a first demo (judgement): 20 to 45 s of relax after a peak, with a reward or a view; in a
duel the boss backs off and circles for **2 to 4 s** after a combo.

## Steps

1. Keep one `intensity` number on `GameState`, raised by damage and danger, decayed by time.
2. Spawn or attack only while building up; hold the peak a few seconds; then release.
3. Fill each release with something to look at or pick up, never empty waiting.
4. Put each duration in `ctx.tune` so the person can tune the pace.

## Pitfalls

- Constant pressure; peaks with no release; release with nothing in it.
- Intensity that never decays while the player hides.

## Code

Booth's director is about 40 lines; nothing to import.

## Sources

Mike Booth, "The AI Systems of Left 4 Dead", Valve 2009 (read, slides PDF).
