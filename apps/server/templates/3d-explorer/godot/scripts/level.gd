## The playable area. Owns the spawn point, the relic roster, the checkpoints and the
## exit gate, and exposes them to the game scene through this small API. Another
## level is a scene with the same containers (Spawn, Relics, Checkpoints, Goal).
class_name Level
extends Node3D

@onready var spawn: Marker3D = $Spawn
@onready var goal: Goal = $Goal

var _relics: Array[Collectible] = []
var _checkpoints: Array[Checkpoint] = []
var _active_checkpoint: Checkpoint

func _ready() -> void:
	for node in $Relics.get_children():
		var relic := node as Collectible
		if relic != null:
			_relics.append(relic)
	for node in $Checkpoints.get_children():
		var checkpoint := node as Checkpoint
		if checkpoint != null:
			_checkpoints.append(checkpoint)
			checkpoint.activated.connect(_on_checkpoint_activated)

## The relics in this level, in scene order. Treat the array as read-only.
func relics() -> Array[Collectible]:
	return _relics

func relic_count() -> int:
	return _relics.size()

func spawn_transform() -> Transform3D:
	return spawn.global_transform

## Where a lost life puts the player back: the last checkpoint, or the spawn point.
func respawn_transform() -> Transform3D:
	if _active_checkpoint != null:
		return _active_checkpoint.respawn_transform()
	return spawn.global_transform

## Re-arms every relic, beacon and the gate, and forgets the active checkpoint.
func reset() -> void:
	_active_checkpoint = null
	for relic in _relics:
		relic.reset()
	for checkpoint in _checkpoints:
		checkpoint.reset()
	goal.reset()

func _on_checkpoint_activated(checkpoint: Checkpoint) -> void:
	_active_checkpoint = checkpoint
