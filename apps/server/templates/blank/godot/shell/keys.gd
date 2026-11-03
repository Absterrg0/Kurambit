## Forwards pause and back keys to the shell. Main pauses with the game, so
## this node is the one that keeps listening while play is paused.
extends Node


func _unhandled_input(event: InputEvent) -> void:
	get_parent()._on_key(event)
