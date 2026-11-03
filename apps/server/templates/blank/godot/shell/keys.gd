## Forwards pause and back keys to the shell, and every input to a waiting
## Controls rebind first. Main pauses with the game, so this node is the one
## that keeps listening while play is paused.
extends Node


func _input(event: InputEvent) -> void:
	if get_parent().capture_rebind(event):
		get_viewport().set_input_as_handled()


func _unhandled_input(event: InputEvent) -> void:
	get_parent()._on_key(event)
