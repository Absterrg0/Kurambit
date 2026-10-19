## A respawn beacon. The first one the player touches becomes the spot they return to
## after losing a life; `Level` owns which one is active.
class_name Checkpoint
extends Area3D

signal activated(checkpoint: Checkpoint)

@export var label := "Checkpoint"

@onready var lit: Node3D = $Lit
@onready var idle: Node3D = $Idle

var active := false

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	_refresh()

func reset() -> void:
	active = false
	_refresh()

## Where the player is put back on the ground in front of this beacon.
func respawn_transform() -> Transform3D:
	return $Respawn.global_transform

func _on_body_entered(body: Node3D) -> void:
	if active or not GameState.is_playing():
		return
	if body as Player == null:
		return
	activate()
	activated.emit(self)

func activate() -> void:
	if active:
		return
	active = true
	_refresh()
	GameState.notify("%s reached" % label)
	Audio.play("unlock", 0.82)

func _refresh() -> void:
	lit.visible = active
	idle.visible = not active
