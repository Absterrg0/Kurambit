# Playtest

Adapted from OhMyGame's game-playtest skill (Apache-2.0) and Aura's
play rules (Apache-2.0, ramenvr/autopilot).

When to play: the game's AGENTS.md says. Where it has an "Every turn"
section, Kurambit plays and measures each turn's build, so a turn does not
explore to check its own work: explore when the person asks or a fact names
something the code cannot show. Without one, play your change before you
call it done.

1. The code says what should happen, play shows what does, and play wins.
   Start with game_explore_start, play with game_explore_act, study each
   returned frame, and release the session with game_explore_close.
2. Passes: smoke (boots, menu, start, quit), feature (each system actually
   triggers), regression (the DO NOT REGRESS list still holds), visual
   (frames against the key art).
3. Godot and Unity games play as native builds that pause between acts;
   three.js games play in a browser in real time. Use
   held-key steps with durations chosen from observed control response.
   Batch them: a session allows a limited number of act calls, steps and
   seconds of input, so one short step per call runs out of calls in the
   opening. Learn a control with one short hold, then send two or three
   held steps per call, keeping each call within its input-seconds limit
   (game_explore_act's description and your prompt give the numbers; a
   call past them is rejected). Study the frame after each batch so a
   missed input or overshoot is visible. Every lane's starter shell has
   Settings > Controls listing every action with its keys; read it there
   when the controls are unclear.
4. Report separately what was verified and what was not. Name the steps
   you ran, what you saw, and what you never reached. Never claim a pass
   on a screen you did not see.
5. A session that did not play cannot judge. If you did not play, say so
   and judge nothing.
6. A missing or broken title, pause, end or retry flow is a defect, and so
   is an action the game does not answer: judge the feel (shake, flash,
   sound, a pop) of every player action you tried.
