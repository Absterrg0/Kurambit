## Run rules and progress for the whole game: relics, score, health, lives and the
## state machine. Autoloaded as `GameState`, it is the single source of truth, so a
## restart only has to reset this object and the world's own `reset()` methods.
extends Node

enum State {
	MENU,
	PLAYING,
	PAUSED,
	WON,
	LOST,
}

signal state_changed(state: State)
signal run_started(total: int)
signal collected_changed(collected: int, total: int, score: int)
signal health_changed(health: float, max_health: float)
signal lives_changed(lives: int)
signal life_lost(reason: String)
signal all_collected()
signal run_won(score: int, seconds: float, lives: int)
signal run_lost(reason: String)
signal toast(text: String)

const MAX_LIVES := 3
const MAX_HEALTH := 100.0
const RELIC_SCORE := 100
const LIFE_BONUS := 150
const TIME_BONUS_WINDOW := 300.0
const PROGRESS_PATH := "user://progress.cfg"

var state: State = State.MENU
var collected := 0
var total := 0
## Jumps started this run; a control claim can observe a player-caused counter
## instead of a boot constant. Reset by every start and restart.
var jumps := 0
var score := 0
var lives := MAX_LIVES
var health := MAX_HEALTH
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

## Clears every run counter and puts the game back in PLAYING. Called by the game
## scene on its first frame and by every restart, before the world resets itself.
func start_run(relic_total: int) -> void:
	total = relic_total
	collected = 0
	jumps = 0
	score = 0
	lives = MAX_LIVES
	health = MAX_HEALTH
	run_seconds = 0.0
	won = false
	set_state(State.PLAYING)
	run_started.emit(total)
	collected_changed.emit(collected, total, score)
	health_changed.emit(health, MAX_HEALTH)
	lives_changed.emit(lives)

func collect(label: String) -> void:
	if state != State.PLAYING:
		return
	collected += 1
	score += RELIC_SCORE
	collected_changed.emit(collected, total, score)
	toast.emit("%s secured · %d/%d" % [label, collected, total])
	if collected >= total:
		all_collected.emit()

func apply_damage(amount: float, reason: String = "hazard") -> void:
	if state != State.PLAYING:
		return
	health = maxf(health - amount, 0.0)
	health_changed.emit(health, MAX_HEALTH)
	if health <= 0.0:
		lose_life(reason)

## Costs one life and restores health. The game scene listens for `life_lost` and
## respawns the player at the last checkpoint; running out of lives ends the run.
func lose_life(reason: String) -> void:
	if state != State.PLAYING:
		return
	lives -= 1
	lives_changed.emit(lives)
	if lives <= 0:
		_finish_run(reason)
		return
	health = MAX_HEALTH
	health_changed.emit(health, MAX_HEALTH)
	life_lost.emit(reason)
	toast.emit("%s · %d %s left" % [reason_text(reason), lives, "life" if lives == 1 else "lives"])

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
			return "You fell out of the world"
		"lava":
			return "The lava got you"
		_:
			return "That hurt"

func time_text(seconds: float) -> String:
	return "%02d:%02d" % [floori(seconds / 60.0), int(seconds) % 60]

func _finish_run(reason: String) -> void:
	if reason.is_empty():
		# Winning pays for the lives left and for every second under the target time.
		score += lives * LIFE_BONUS + maxi(int(TIME_BONUS_WINDOW - run_seconds), 0)
		if score > best_score:
			best_score = score
		if best_seconds <= 0.0 or run_seconds < best_seconds:
			best_seconds = run_seconds
		_save_progress()
		won = true
		set_state(State.WON)
		run_won.emit(score, run_seconds, lives)
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
