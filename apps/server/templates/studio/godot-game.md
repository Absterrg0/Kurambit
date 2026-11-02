# Godot game

Adapted from OhMyGame's godot-game skill (Apache-2.0), plus local rules.

1. Godot 4.7, GL Compatibility renderer.
2. You have no local Godot binary: never look for one or run it. Check
   with `game_check`, re-import after asset changes with `game_import`,
   play with `game_explore_*`, build with `game_export`.
3. Keep the boot clean: no script errors, no parse errors. Engine shutdown
   noise after quit is not failure; anything while the game runs is.
4. Main scene set in project.godot. Input actions in the project settings,
   not hardcoded keys in gameplay code.
5. Export checklist before calling it done: `game_export` succeeds for Web
   and Linux, and `game_check` reports every entry clean.
6. Work in ./godot plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.
