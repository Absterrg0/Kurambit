## A field of spikes, baked into the level as one area with one collision shape per
## run of spike tiles (see TEMPLATE.md). Contact hurts through `Player.hurt()`, which
## both knocks the player out and spends a life, so a spike costs the same as any other
## hit. The area keeps checking every body inside it, because a player who stands still
## in the spikes must be pushed out rather than sit there safely.
class_name SpikeField
extends Area2D

func _physics_process(_delta: float) -> void:
	if not GameState.is_playing():
		return
	for body in get_overlapping_bodies():
		var player := body as Player
		if player == null or player.is_invulnerable():
			continue
		player.hurt(global_position, "spikes")
