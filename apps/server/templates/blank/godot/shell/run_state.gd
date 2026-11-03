## The shell's half of GameState: the run state the shell, the probe and bots
## read, and the two calls that end a run. scripts/game_state.gd extends this
## file; the game's own values belong there, not here.
##
##   GameState.win("You escaped!", {"Time": "1:42", "Coins": 12})
##   GameState.lose("Out of fuel", {"Distance": "340 m"})
##
## Either call freezes play and opens the end screen with the message and the
## stats (shown in the order given) plus Retry and Main menu.
extends Node

## Emitted once when win() or lose() ends a run.
signal ended(won: bool, text: String, stats: Dictionary)
## Emitted on every change of `state`.
signal state_changed(state: String)

## "title", "playing", "paused" or "ended". The shell sets it; games read it.
var state := "title":
	set(value):
		if state == value:
			return
		state = value
		state_changed.emit(value)
## "won" or "lost" once the run ended, "" while it runs.
var result := ""
## The message the end screen shows.
var result_text := ""

const _SHELL_VALUES := ["state", "result", "result_text"]
var _defaults: Variant = null


func win(text := "You win!", stats := {}) -> void:
	_end(true, text, stats)


func lose(text := "Game over", stats := {}) -> void:
	_end(false, text, stats)


func is_playing() -> bool:
	return state == "playing"


## The shell calls this before every Play and Retry, before the gameplay scene
## exists. Every value game_state.gd declares returns to what it was when the
## first run began, except the names in its KEEP_ACROSS_RUNS constant, so a
## retry never inherits the last run's score, health or timers.
func new_run() -> void:
	if _defaults == null:
		_defaults = {}
		for key in _declared_values():
			_defaults[key] = _copy(get(key))
	var keep: Array = get_script().get_script_constant_map().get(
		"KEEP_ACROSS_RUNS", get("KEEP_ACROSS_RUNS") if "KEEP_ACROSS_RUNS" in self else []
	)
	for key in _defaults:
		if not keep.has(key):
			set(key, _copy(_defaults[key]))
	result = ""
	result_text = ""


func _end(won: bool, text: String, stats: Dictionary) -> void:
	if state == "ended":
		return
	result = "won" if won else "lost"
	result_text = text
	state = "ended"
	ended.emit(won, text, stats)


func _declared_values() -> Array[String]:
	var names: Array[String] = []
	for property in get_property_list():
		if not (int(property.usage) & PROPERTY_USAGE_SCRIPT_VARIABLE):
			continue
		var key := str(property.name)
		if key.begins_with("_") or _SHELL_VALUES.has(key) or key == "KEEP_ACROSS_RUNS":
			continue
		names.append(key)
	return names


static func _copy(value: Variant) -> Variant:
	if value is Resource:
		return (value as Resource).duplicate(true)
	if value is Array or value is Dictionary:
		return value.duplicate(true)
	return value
