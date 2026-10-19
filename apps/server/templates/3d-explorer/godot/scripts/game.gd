## One run: level + player + UI. Owns the run lifecycle (spawn, lives, pause, restart,
## win/lose screens) and is the only node that talks to `GameState` on their behalf.
class_name Game
extends Node3D

@onready var level: Level = $Level
@onready var player: Player = $Player
@onready var hud: Hud = $UI/Hud
@onready var pause_menu: PauseMenu = $UI/PauseMenu
@onready var end_screen: EndScreen = $UI/EndScreen

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
	if event.is_action_pressed("pause") and GameState.is_playing():
		set_paused(true)
		get_viewport().set_input_as_handled()

## Clears the run inside `GameState` first, so the world's own resets see fresh
## counters, then rebuilds the level and puts the player on the spawn point.
func start_run() -> void:
	GameState.start_run(level.relic_count())
	level.reset()
	player.set_active(true)
	player.respawn(level.spawn_transform())
	end_screen.hide_screen()

func restart_run() -> void:
	set_paused(false)
	start_run()
	GameState.notify("Run restarted")
	Audio.play("ui_accept")

func set_paused(paused: bool) -> void:
	if paused == (GameState.state == GameState.State.PAUSED):
		return
	if paused:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		pause_menu.open()
		GameState.pause_game()
		return
	pause_menu.close()
	GameState.resume_game()

func return_to_menu() -> void:
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	GameState.to_menu()
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")

func _on_resume() -> void:
	set_paused(false)

func _on_life_lost(_reason: String) -> void:
	player.respawn(level.respawn_transform())

func _on_run_won(score: int, seconds: float, lives: int) -> void:
	_finish()
	end_screen.show_won(score, seconds, lives)
	Audio.play("win")

func _on_run_lost(reason: String) -> void:
	_finish()
	end_screen.show_lost(reason)
	Audio.play("lose")

func _finish() -> void:
	player.set_active(false)
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
