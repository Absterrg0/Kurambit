## A damaging volume: lava, spikes, a pit. Every body that stays inside takes damage
## and knockback, so the player has to leave instead of taking a single hit.
class_name Hazard
extends Area3D

@export var damage := 34.0
## Passed to `GameState.apply_damage` so the message can name the cause.
@export var reason := "lava"

func _physics_process(_delta: float) -> void:
	if not GameState.is_playing():
		return
	for body in get_overlapping_bodies():
		var player := body as Player
		if player != null:
			player.apply_hit(global_position, damage, reason)
