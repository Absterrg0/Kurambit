# Game foundations

Adapted from OhMyGame's game-foundations skill (Apache-2.0).

1. Simulation apart from presentation: rules and state live in plain data
   and pure logic. Scenes, sprites and UI only show it, never own it.
2. One state owner: a single autoload (GameState) holds run state. Every
   screen reads it; nothing keeps a private copy of shared facts.
3. Later passes must be able to change rules without touching art, and art
   without touching rules. If an edit needs both, the seam is wrong.
4. Content as data: levels, waves, upgrades and dialogue are arrays and
   dictionaries in files, not branches in code. Add content, don't rewrite.
5. Fail states and win states are explicit values in the state, reachable
   from play, shown on screen. A run always ends and can always restart.
