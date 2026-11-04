## The game's run state, autoloaded as `GameState` so every scene and the
## StudioProbe read one object instead of walking a scene tree.
##
## The shell half lives in shell/run_state.gd: `state` ("title", "playing",
## "paused", "ended"), `result`, and the calls that end a run,
## `GameState.win(text, stats)` and `GameState.lose(text, stats)`.
##
## Add the public primitive values the game needs here; `StudioProbe` reports
## them, and a leading underscore keeps a helper out of that snapshot. Each
## Play and Retry puts every value declared here back to its starting value;
## list the ones that must outlive a run (a best score, an unlock) by name in
## KEEP_ACROSS_RUNS.
##
## The harness can jump the game to a named state (a check's setup, a bot's
## shortcut to late content). "game_state" and "player" are built in; add the
## game's own targets here and return true when the game is there:
##
##   func studio_set_state(target: String, values: Dictionary) -> bool:
##       if target == "boss_room":
##           get_tree().call_group("player", "teleport", Vector3(40, 1, 0))
##           return true
##       return false
extends "res://shell/run_state.gd"

const KEEP_ACROSS_RUNS := []
