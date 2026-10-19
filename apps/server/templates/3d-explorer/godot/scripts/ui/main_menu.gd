## Title screen. Play starts a run, Settings opens the shared settings panel, and Quit
## is hidden on the Web where the page owns the window. Focus starts on Play, so the
## keyboard and a gamepad can drive the whole menu.
extends Control

@onready var menu: CenterContainer = $Menu
@onready var play_button: Button = $Menu/Panel/Box/Play
@onready var settings_button: Button = $Menu/Panel/Box/Settings
@onready var quit_button: Button = $Menu/Panel/Box/Quit
@onready var settings_panel: SettingsMenu = $SettingsPanel

func _ready() -> void:
	GameState.to_menu()
	Audio.wire_ui(self)
	Audio.start_music()
	play_button.pressed.connect(_on_play)
	settings_button.pressed.connect(_on_settings)
	quit_button.pressed.connect(_on_quit)
	settings_panel.closed.connect(_on_settings_closed)
	settings_panel.hide()
	quit_button.visible = not OS.has_feature("web")
	play_button.grab_focus()

func _on_play() -> void:
	get_tree().change_scene_to_file("res://scenes/game.tscn")

func _on_settings() -> void:
	menu.hide()
	settings_panel.open()

func _on_settings_closed() -> void:
	settings_panel.hide()
	menu.show()
	settings_button.grab_focus()

func _on_quit() -> void:
	get_tree().quit()
