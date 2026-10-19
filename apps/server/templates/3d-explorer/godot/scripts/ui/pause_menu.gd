## Pause overlay: Resume, Settings, Restart and Main menu. Runs while the tree is
## paused (`process_mode = ALWAYS`), which is what makes Escape resume again.
class_name PauseMenu
extends Control

signal resume_requested
signal restart_requested
signal main_menu_requested

@onready var box: VBoxContainer = $Center/Panel/Box
@onready var resume_button: Button = $Center/Panel/Box/Resume
@onready var settings_button: Button = $Center/Panel/Box/Settings
@onready var restart_button: Button = $Center/Panel/Box/Restart
@onready var main_menu_button: Button = $Center/Panel/Box/MainMenu
@onready var settings_panel: SettingsMenu = $SettingsPanel

func _ready() -> void:
	hide()
	Audio.wire_ui(self)
	resume_button.pressed.connect(_on_resume)
	settings_button.pressed.connect(_on_settings)
	restart_button.pressed.connect(_on_restart)
	main_menu_button.pressed.connect(_on_main_menu)
	settings_panel.closed.connect(_close_settings)

func _unhandled_input(event: InputEvent) -> void:
	if not visible or not event.is_action_pressed("pause"):
		return
	get_viewport().set_input_as_handled()
	if settings_panel.visible:
		_close_settings()
		return
	resume_requested.emit()

func open() -> void:
	settings_panel.hide()
	box.show()
	show()
	resume_button.grab_focus()

func close() -> void:
	hide()

func _on_resume() -> void:
	resume_requested.emit()

func _on_restart() -> void:
	restart_requested.emit()

func _on_main_menu() -> void:
	main_menu_requested.emit()

func _on_settings() -> void:
	box.hide()
	settings_panel.open()

func _close_settings() -> void:
	settings_panel.hide()
	box.show()
	settings_button.grab_focus()
