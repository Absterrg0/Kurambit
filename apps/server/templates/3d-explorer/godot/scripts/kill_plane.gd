## Sits far below the level. Anything that drops through it costs a life and is put
## back at the last checkpoint by the game scene.
class_name KillPlane
extends Area3D

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node3D) -> void:
	if not GameState.is_playing():
		return
	if body as Player == null:
		return
	GameState.lose_life("fell")
