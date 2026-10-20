## Run rules and progress for the whole game: coins, score, lives, the current level
## and the state machine. Autoloaded as `GameState`, it is the single source of truth,
## so a restart only has to reset this object and the level's own `reset()`.
##
## A run is `MENU → PLAYING → (PAUSED) → WON | LOST`, walked through one level at a
## time. Touching a hazard or a slime costs a life and puts the player back on the last
## checkpoint; running out of lives ends the run.
extends Node

enum State {
	MENU,
	PLAYING,
	PAUSED,
	WON,
	LOST,
}

signal state_changed(state: State)
signal run_started(level_count: int)
signal level_started(index: int, coin_total: int)
signal collected_changed(collected: int, total: int, score: int)
signal lives_changed(lives: int)
signal life_lost(reason: String)
signal run_won(score: int, seconds: float, coins: int)
signal run_lost(reason: String)
signal toast(text: String)

const MAX_LIVES := 3
const COIN_SCORE := 100
const LIFE_BONUS := 250
const TIME_BONUS_WINDOW := 240.0
const PROGRESS_PATH := "user://progress.cfg"

var state: State = State.MENU
## Zero-based index of the level being played.
var level_index := 0
var level_count := 0
## Display name of the loaded level, set by the game scene.
var level_name := ""
var collected := 0
var total := 0
## Coins picked up over the whole run, for the win screen.
var run_coins := 0
var score := 0
var lives := MAX_LIVES
var run_seconds := 0.0
var best_score := 0
var best_seconds := 0.0
## True once this run reached the win screen, for state-based acceptance.
var won := false

func _ready() -> void:
	_load_progress()

func _process(delta: float) -> void:
	if state == State.PLAYING:
		run_seconds += delta

func is_playing() -> bool:
	return state == State.PLAYING

## Posts a short message to the HUD. Signals are emitted by their owner, so scenes
## call this instead of reaching for `GameState.toast` directly.
func notify(text: String) -> void:
	toast.emit(text)

## Clears every run counter and puts the game in PLAYING. The game scene calls this
## before it loads the first level, and again on every restart.
func start_run(levels: int) -> void:
	level_count = levels
	level_index = 0
	run_coins = 0
	score = 0
	lives = MAX_LIVES
	run_seconds = 0.0
	won = false
	set_state(State.PLAYING)
	run_started.emit(level_count)
	lives_changed.emit(lives)

## Announces the level that is now loaded; the HUD resets its coin counter from this.
func start_level(index: int, coin_total: int) -> void:
	level_index = index
	total = coin_total
	collected = 0
	level_started.emit(index, total)
	collected_changed.emit(collected, total, score)

func collect(label: String) -> void:
	if state != State.PLAYING:
		return
	collected += 1
	run_coins += 1
	score += COIN_SCORE
	collected_changed.emit(collected, total, score)
	if collected >= total:
		toast.emit("Every coin on %s!" % level_name)

## Costs one life. The game scene listens for life_lost and respawns the player at
## the last checkpoint; running out of lives ends the run.
func lose_life(reason: String) -> void:
	if state != State.PLAYING:
		return
	lives -= 1
	lives_changed.emit(lives)
	if lives <= 0:
		_finish_run(reason)
		return
	life_lost.emit(reason)
	toast.emit("%s · %d %s left" % [reason_text(reason), lives, "life" if lives == 1 else "lives"])

## The last level's door was reached: that wins the run.
func reach_goal() -> void:
	if state != State.PLAYING:
		return
	_finish_run("")

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

## Leaves a run behind without ending it, for every route back to the title screen.
func to_menu() -> void:
	get_tree().paused = false
	set_state(State.MENU)

func set_state(next: State) -> void:
	if state == next:
		return
	state = next
	state_changed.emit(state)

func reason_text(reason: String) -> String:
	match reason:
		"fell":
			return "You fell into the dark"
		"spikes":
			return "The spikes got you"
		"slime":
			return "A slime got you"
		_:
			return "That hurt"

func time_text(seconds: float) -> String:
	return "%02d:%02d" % [floori(seconds / 60.0), int(seconds) % 60]

## "1", "2"… for the HUD, so the counter never has to know about level order.
func level_number() -> int:
	return level_index + 1

func _finish_run(reason: String) -> void:
	if reason.is_empty():
		# Winning pays for the lives left and for every second under the target time.
		# Coins already scored as they were picked up.
		score += lives * LIFE_BONUS + maxi(int(TIME_BONUS_WINDOW - run_seconds), 0)
		if score > best_score:
			best_score = score
		if best_seconds <= 0.0 or run_seconds < best_seconds:
			best_seconds = run_seconds
		_save_progress()
		won = true
		set_state(State.WON)
		run_won.emit(score, run_seconds, run_coins)
		return
	set_state(State.LOST)
	run_lost.emit(reason)

func _load_progress() -> void:
	var config := ConfigFile.new()
	if config.load(PROGRESS_PATH) != OK:
		return
	best_score = int(config.get_value("progress", "best_score", 0))
	best_seconds = float(config.get_value("progress", "best_seconds", 0.0))

func _save_progress() -> void:
	var config := ConfigFile.new()
	config.set_value("progress", "best_score", best_score)
	config.set_value("progress", "best_seconds", best_seconds)
	config.save(PROGRESS_PATH)
