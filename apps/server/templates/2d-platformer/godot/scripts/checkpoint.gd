## A checkpoint flag. Touching it lights the flag and makes it the respawn point for
## every later lost life; `reset()` puts it back to sleep for a fresh run.
class_name Checkpoint
extends Area2D

signal activated(checkpoint: Checkpoint)

## Where the player stands after respawning here, relative to the flag's base.
@export var respawn_offset := Vector2(-14.0, 0.0)
@export var banner := "Checkpoint"

@onready var sprite: AnimatedSprite2D = $Sprite

var _lit := false

func _ready() -> void:
	sprite.play("idle")
	body_entered.connect(_on_body_entered)

func is_lit() -> bool:
	return _lit

func respawn_position() -> Vector2:
	return global_position + respawn_offset

func light() -> void:
	if _lit:
		return
	_lit = true
	sprite.play("lit")
	Audio.play("checkpoint")
	GameState.notify(banner)
	activated.emit(self)

func reset() -> void:
	_lit = false
	sprite.play("idle")

func _on_body_entered(body: Node2D) -> void:
	if _lit or not GameState.is_playing():
		return
	if body is Player:
		light()
