## Title screen. Play starts a fresh shift, Quit is hidden on the Web where the
## page owns the window, and focus starts on Play so Enter works immediately.
extends Control

@onready var play_button: Button = $Safe/Center/Panel/Box/Play
@onready var quit_button: Button = $Safe/Center/Panel/Box/Quit

func _ready() -> void:
	get_tree().paused = false
	GameState.to_menu()
	Audio.wire_ui(self)
	Audio.start_music()
	play_button.pressed.connect(_on_play)
	quit_button.pressed.connect(_on_quit)
	quit_button.visible = not OS.has_feature("web")
	play_button.grab_focus()

func _on_play() -> void:
	get_tree().change_scene_to_file("res://scenes/game.tscn")

func _on_quit() -> void:
	get_tree().quit()
