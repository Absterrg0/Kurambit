## The whole run lives here, so a restart is one reset. The screen reads these
## values; it never keeps its own copy of trust or progress. Public members are
## what StudioProbe exposes to the web playtest.
##
## A shift is MENU → PLAYING → (PAUSED) → WON | LOST. Five callers, three replies
## each. Warm replies raise trust, steady replies hold it, cold replies lower it
## and add a cold mark. Three cold replies end the shift early; otherwise the
## shift ends after the last caller and wins only when trust is at least three.
extends Node

enum State {
	MENU,
	PLAYING,
	PAUSED,
	WON,
	LOST,
}

signal state_changed(state: State)
signal run_started(call_total: int)
signal call_started(index: int, call_total: int)
signal answered(index: int, trust_delta: int, cold_delta: int)
signal listened_changed(listened: int)
signal run_won(trust: int, cold: int, listened: int)
signal run_lost(reason: String, trust: int, cold: int)

const CALL_COUNT := 5
const START_TRUST := 2
const WIN_TRUST := 3
const MAX_COLD := 3

var state: State = State.MENU
var call_index := 0
var call_count := CALL_COUNT
## Calls that have reached their "next caller" or "end shift" beat.
var calls := 0
## Replies chosen, including the one on the current call.
var choices := 0
var trust := START_TRUST
var cold := 0
## Calls the player held L (or pressed Hear them out) for.
var listened := 0
var won := false
var loss_reason := ""

func is_playing() -> bool:
	return state == State.PLAYING

func is_finished() -> bool:
	return state == State.WON or state == State.LOST

## Clears the run and announces the first call. The screen scene calls this on
## every entry, including a reload after Restart.
func start_run(count: int = CALL_COUNT) -> void:
	call_count = maxi(count, 1)
	call_index = 0
	calls = 0
	choices = 0
	trust = START_TRUST
	cold = 0
	listened = 0
	won = false
	loss_reason = ""
	get_tree().paused = false
	set_state(State.PLAYING)
	run_started.emit(call_count)
	call_started.emit(call_index, call_count)

## One reply. The screen passes the choice's authored deltas; GameState owns the
## resulting run values so a restart or a probe read never disagrees with them.
func answer(trust_delta: int, cold_delta: int) -> void:
	if state != State.PLAYING:
		return
	choices += 1
	trust += trust_delta
	if cold_delta > 0:
		cold += cold_delta
	answered.emit(call_index, trust_delta, cold_delta)

## Once per caller. Listening is optional: it reveals the detail and gives the
## player context, but it never changes trust by itself.
func mark_listened() -> void:
	if state != State.PLAYING:
		return
	listened += 1
	listened_changed.emit(listened)

## The player pressed Next caller or End shift. The third cold reply ends the
## shift immediately; otherwise the last call decides by trust.
func finish_call() -> void:
	if state != State.PLAYING:
		return
	calls += 1
	if cold >= MAX_COLD:
		_finish(false, "Three cold replies ended the shift.")
		return
	if calls >= call_count:
		if trust >= WIN_TRUST:
			_finish(true, "")
		else:
			_finish(false, "Trust fell below three before the shift ended.")
		return
	call_index += 1
	call_started.emit(call_index, call_count)

func pause_game() -> void:
	if state != State.PLAYING:
		return
	set_state(State.PAUSED)
	get_tree().paused = true

func resume_game() -> void:
	if state != State.PAUSED:
		return
	get_tree().paused = false
	set_state(State.PLAYING)

## Every route back to the title screen leaves the run behind, not paused.
func to_menu() -> void:
	get_tree().paused = false
	set_state(State.MENU)

func set_state(next: State) -> void:
	if state == next:
		return
	state = next
	state_changed.emit(state)

func _finish(did_win: bool, reason: String) -> void:
	won = did_win
	loss_reason = reason
	if did_win:
		set_state(State.WON)
		run_won.emit(trust, cold, listened)
		return
	set_state(State.LOST)
	run_lost.emit(reason, trust, cold)
