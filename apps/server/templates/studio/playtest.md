# Playtest

Adapted from OhMyGame's game-playtest skill (Apache-2.0) and Aura's
play rules (Apache-2.0, ramenvr/autopilot).

1. The code says what should happen, play shows what does, and play wins.
   Start with game_explore_start, play with game_explore_act, study each
   returned frame, and release the session with game_explore_close.
2. Passes: smoke (boots, menu, start, quit), feature (each system actually
   triggers), regression (the DO NOT REGRESS list still holds), visual
   (frames against the key art).
3. Native games pause between acts; browser games run in real time. Use
   held-key steps with durations chosen from observed control response.
   Observe between adjustments so a missed input or overshoot is visible.
4. Report separately what was verified and what was not. Name the steps
   you ran, what you saw, and what you never reached. Never claim a pass
   on a screen you did not see.
5. A session that did not play cannot judge. If you did not play, say so
   and judge nothing.
