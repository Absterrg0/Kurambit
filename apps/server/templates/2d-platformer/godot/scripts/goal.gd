## The exit door. Walking in tells the level the run can move on; the glow pulses so
## the goal is findable from across the level.
class_name Goal
extends Area2D

const Palette := preload("res://assets/palette.tres")

signal entered

@export var banner := "This way on"

@onready var sprite: Sprite2D = $Sprite
@onready var glow: Sprite2D = $Glow

var _pulse := 0.0
var _used := false

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	glow.modulate = Color(Palette.goal, 0.45)
	# A restart can rebuild this level while the player still stands in the
	# previous door. Stay unarmed for the frame the level is assembled, then arm:
	# otherwise a stale physics pairing completes the fresh run immediately.
	monitoring = false
	await get_tree().physics_frame
	monitoring = true

func _process(delta: float) -> void:
	_pulse += delta
	sprite.modulate = Color(1.0, 1.0, 1.0, 0.92 + 0.08 * sin(_pulse * 2.2))
	# The landmark halo breathes with the door, so the exit draws the eye even when the
	# player is only crossing the screen.
	glow.modulate = Color(Palette.goal, 0.38 + 0.12 * sin(_pulse * 2.2))

func reset() -> void:
	_used = false
	_pulse = 0.0
	sprite.modulate = Color.WHITE

func _on_body_entered(body: Node2D) -> void:
	if _used or not GameState.is_playing():
		return
	if not (body is Player):
		return
	_used = true
	GameState.notify(banner)
	entered.emit()
