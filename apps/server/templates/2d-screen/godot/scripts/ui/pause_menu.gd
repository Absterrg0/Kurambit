## Pause overlay: Resume, Restart shift and Main menu. It runs while the
## SceneTree is paused (`process_mode = ALWAYS`), which is what makes Escape resume.
class_name ShiftPauseMenu
extends Control

signal resume_requested
signal restart_requested
signal main_menu_requested

@onready var resume_button: Button = $Center/Panel/Box/Resume
@onready var restart_button: Button = $Center/Panel/Box/Restart
@onready var main_menu_button: Button = $Center/Panel/Box/MainMenu

func _ready() -> void:
	hide()
	Audio.wire_ui(self)
	resume_button.pressed.connect(_on_resume)
	restart_button.pressed.connect(_on_restart)
	main_menu_button.pressed.connect(_on_main_menu)

func _unhandled_input(event: InputEvent) -> void:
	if not visible:
		return
	if event.is_action_pressed("pause"):
		get_viewport().set_input_as_handled()
		resume_requested.emit()
	elif event.is_action_pressed("restart"):
		get_viewport().set_input_as_handled()
		restart_requested.emit()

func _on_resume() -> void:
	resume_requested.emit()

func _on_restart() -> void:
	restart_requested.emit()

func _on_main_menu() -> void:
	main_menu_requested.emit()

func open() -> void:
	show()
	resume_button.grab_focus()

func close() -> void:
	hide()
