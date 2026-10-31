# Godot game

Adapted from OhMyGame's godot-game skill (Apache-2.0), plus local rules.

1. Godot 4.7, GL Compatibility renderer. Test on the same binary the
   harness names in PROJECT.md.
2. Never run Godot yourself with a display. Only the play CLI in
   PROJECT.md launches the game.
3. Keep the boot clean: no script errors, no parse errors. Engine shutdown
   noise after quit is not failure; anything while the game runs is.
4. Main scene set in project.godot. Input actions in the project settings,
   not hardcoded keys in gameplay code.
5. Export checklist before calling it done: web preset builds, Linux preset
   builds, the main scene boots headless with `--quit-after 180`.
6. Work in ./godot plus VISION.md, PLAN.md and NOTES.md. Never commit,
   never reset git, never use subagents.
