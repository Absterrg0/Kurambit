## Win/lose panel: headline, run stats, the stored best result and the two ways out
## (run it again, or go back to the title screen).
class_name EndScreen
extends Control

signal restart_requested
signal main_menu_requested

@onready var title: Label = $Center/Panel/Box/Title
@onready var stats: Label = $Center/Panel/Box/Stats
@onready var best: Label = $Center/Panel/Box/Best
@onready var restart_button: Button = $Center/Panel/Box/Restart
@onready var main_menu_button: Button = $Center/Panel/Box/MainMenu

func _ready() -> void:
	hide()
	Audio.wire_ui(self)
	restart_button.pressed.connect(_on_restart)
	main_menu_button.pressed.connect(_on_main_menu)

func show_won(score: int, seconds: float, coins: int) -> void:
	title.text = "The Ridge Is Clear"
	stats.text = "Coins %d   ·   Time %s   ·   Lives left %d\nScore %d" % [
		coins,
		GameState.time_text(seconds),
		GameState.lives,
		score,
	]
	best.text = _best_text()
	show()
	restart_button.grab_focus()

func show_lost(reason: String) -> void:
	title.text = "Run Over"
	stats.text = "%s\nCoins %d   ·   Score %d" % [
		GameState.reason_text(reason),
		GameState.run_coins,
		GameState.score,
	]
	best.text = _best_text()
	show()
	restart_button.grab_focus()

func hide_screen() -> void:
	hide()

func _best_text() -> String:
	if GameState.best_score <= 0:
		return "Finish a run to set a best score"
	return "Best %d   ·   Fastest %s" % [
		GameState.best_score,
		GameState.time_text(GameState.best_seconds),
	]

func _on_restart() -> void:
	restart_requested.emit()

func _on_main_menu() -> void:
	main_menu_requested.emit()
