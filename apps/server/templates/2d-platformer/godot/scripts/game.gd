## One run: the current level, the player and the UI. Owns the run lifecycle — loading
## levels, lives, pause, restart, and the win/lose screens — and is the only node that
## talks to `GameState` on their behalf.
class_name Game
extends Node2D

const RESPAWN_DELAY := 0.12
const LEVEL_CLEAR_DELAY := 0.9

## The levels of this game, in order. The last one wins the run when its door is reached.
@export var levels: Array[PackedScene] = []

@onready var levels_root: Node2D = $Levels
@onready var player: Player = $Player
@onready var hud: Hud = $UI/Hud
@onready var pause_menu: PauseMenu = $UI/PauseMenu
@onready var end_screen: EndScreen = $UI/EndScreen

## The level currently loaded. Read by the smoke test and by the HUD.
var level: Level
var _changing_level := false
## Bumped whenever the run, level or scene changes. A delayed continuation captures
## it before waiting and drops out when it moved, so a restart or the menu during a
## clear or respawn delay cannot load a level or move the player in the new run.
var _generation := 0

func _ready() -> void:
	GameState.life_lost.connect(_on_life_lost)
	GameState.run_won.connect(_on_run_won)
	GameState.run_lost.connect(_on_run_lost)
	pause_menu.resume_requested.connect(_on_resume)
	pause_menu.restart_requested.connect(restart_run)
	pause_menu.main_menu_requested.connect(return_to_menu)
	end_screen.restart_requested.connect(restart_run)
	end_screen.main_menu_requested.connect(return_to_menu)
	start_run()

func _unhandled_input(event: InputEvent) -> void:
	if not GameState.is_playing():
		return
	if event.is_action_pressed("pause"):
		set_paused(true)
		get_viewport().set_input_as_handled()
		return
	if event.is_action_pressed("restart") and level != null:
		# Back to the last checkpoint, without paying for it. Handy for a level that
		# the player has already half finished.
		player.respawn(level.respawn_position())
		GameState.notify("Back to the checkpoint")

## Clears the run inside `GameState` first, so the level's own resets see fresh
## counters, then loads the first level and puts the player on its spawn point.
func start_run() -> void:
	_generation += 1
	GameState.start_run(levels.size())
	_changing_level = false
	load_level(0)
	end_screen.hide_screen()

func restart_run() -> void:
	set_paused(false)
	start_run()
	GameState.notify("Run restarted")
	Audio.play("ui_accept")

## Instances `levels[index]` under `Levels` and hands it to the player. Levels are
## swapped rather than reloaded by scene change, so the HUD, the audio and the settings
## survive the transition.
func load_level(index: int) -> void:
	_generation += 1
	# Park the body before the next level's Areas enter the tree. A restart taken
	# while standing in the door reloads this level; without the move the fresh
	# goal sees that stale overlap and completes the new run on its first frame.
	player.global_position = Vector2(-100000.0, -100000.0)
	if level != null:
		level.queue_free()
		level = null
	if index < 0 or index >= levels.size():
		return
	var scene := levels[index]
	level = scene.instantiate() as Level
	levels_root.add_child(level)
	level.reset()
	level.attach_player(player)
	level.completed.connect(_on_level_completed)
	GameState.level_name = level.title
	player.set_active(true)
	player.set_camera_limits(level.bounds())
	player.respawn(level.spawn_position())
	GameState.start_level(index, level.coin_count())

func set_paused(paused: bool) -> void:
	if paused == (GameState.state == GameState.State.PAUSED):
		return
	if paused:
		pause_menu.open()
		GameState.pause_game()
		return
	pause_menu.close()
	GameState.resume_game()

func return_to_menu() -> void:
	_generation += 1
	GameState.to_menu()
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")

func _on_resume() -> void:
	set_paused(false)

## A lost life puts the player back on the last checkpoint. The short delay lets the
## knockback read as a hit instead of a teleport.
func _on_life_lost(_reason: String) -> void:
	var generation := _generation
	await get_tree().create_timer(player.hurt_time + RESPAWN_DELAY, false).timeout
	if generation != _generation:
		return
	if GameState.is_playing() and level != null:
		player.respawn(level.respawn_position())

## The door was reached: next level, or the win screen on the last one.
func _on_level_completed() -> void:
	if _changing_level or level == null:
		return
	_changing_level = true
	var generation := _generation
	Audio.play("door")
	if GameState.level_index + 1 < GameState.level_count:
		player.set_active(false)
		await get_tree().create_timer(LEVEL_CLEAR_DELAY, false).timeout
		if generation != _generation:
			return
		load_level(GameState.level_index + 1)
		_changing_level = false
		GameState.notify("Level cleared")
		return
	GameState.reach_goal()

func _on_run_won(score: int, seconds: float, coins: int) -> void:
	_finish()
	end_screen.show_won(score, seconds, coins)
	Audio.play("win")

func _on_run_lost(reason: String) -> void:
	_finish()
	end_screen.show_lost(reason)
	Audio.play("lose")

func _finish() -> void:
	_changing_level = false
	player.set_active(false)
	set_paused(false)
