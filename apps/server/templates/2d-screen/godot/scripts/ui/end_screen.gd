## Win/lose panel: the shift's result, the run values that produced it, and the
## two ways out. It stays above the screen and keeps focus on Work another shift.
class_name ShiftEndScreen
extends Control

signal restart_requested
signal main_menu_requested

@onready var title: Label = $Center/Panel/Box/Title
@onready var reason: Label = $Center/Panel/Box/Reason
@onready var stats: Label = $Center/Panel/Box/Stats
@onready var restart_button: Button = $Center/Panel/Box/Restart
@onready var main_menu_button: Button = $Center/Panel/Box/MainMenu

func _ready() -> void:
	hide()
	Audio.wire_ui(self)
	restart_button.pressed.connect(_on_restart)
	main_menu_button.pressed.connect(_on_main_menu)

func show_won(trust: int, cold: int, listened: int) -> void:
	title.text = "Shift held"
	reason.text = "The desk closes with the line still open."
	stats.text = "Trust %d   ·   Cold replies %d / %d   ·   Heard %d" % [
		trust,
		cold,
		GameState.MAX_COLD,
		listened,
	]
	_show()

func show_lost(lost_reason: String, trust: int, cold: int, listened: int) -> void:
	title.text = "Shift over"
	reason.text = lost_reason
	stats.text = "Trust %d   ·   Cold replies %d / %d   ·   Heard %d" % [
		trust,
		cold,
		GameState.MAX_COLD,
		listened,
	]
	_show()

func _show() -> void:
	show()
	restart_button.grab_focus()

func _unhandled_input(event: InputEvent) -> void:
	if visible and event.is_action_pressed("restart"):
		get_viewport().set_input_as_handled()
		restart_requested.emit()

func _on_restart() -> void:
	restart_requested.emit()

func _on_main_menu() -> void:
	main_menu_requested.emit()
