## The follow camera: smoothed, with a look-ahead that opens up the direction the
## player is running in, hard limits at the level's edges and a short shake for
## landings and hits. Its own script, so the game's feel can be tuned without
## touching the player controller.
class_name GameCamera
extends Camera2D

@export_group("Follow")
## Vertical offset from the player's feet, so the view is not centred on the floor line.
@export var height_offset := -26.0
## How far ahead of the player the camera leads, in pixels, at full speed.
@export var look_ahead := 26.0
## How quickly the look-ahead catches up (exponential, per second).
@export var look_ahead_speed := 2.4

@export_group("Shake")
@export var shake_strength := 2.0
@export var shake_decay := 7.0

var _lead := 0.0
var _shake := 0.0
var _shake_time := 0.0
var _shake_strength := 0.0

func _ready() -> void:
	position_smoothing_enabled = true
	position_smoothing_speed = 8.0
	ignore_rotation = true

func _process(delta: float) -> void:
	var player := get_parent() as Player
	var target := 0.0
	if player != null:
		var speed := clampf(absf(player.velocity.x) / 132.0, 0.0, 1.6)
		target = float(player.facing()) * look_ahead * speed
	_lead = lerpf(_lead, target, 1.0 - exp(-look_ahead_speed * delta))
	var jitter := Vector2.ZERO
	if _shake > 0.0:
		_shake = maxf(_shake - delta, 0.0)
		var amount := _shake_strength * (_shake / maxf(_shake_time, 0.001))
		jitter = Vector2(randf_range(-amount, amount), randf_range(-amount, amount))
	offset = Vector2(_lead, height_offset) + jitter

## Offsets the view for a moment. `strength` scales the exported shake_strength.
func shake(duration: float, strength := 1.0) -> void:
	_shake = maxf(_shake, duration)
	_shake_time = maxf(_shake_time, duration)
	_shake_strength = maxf(_shake_strength, shake_strength * strength)

## Drops any shake and re-centres the look-ahead, for a respawn or a new level.
func reset() -> void:
	_shake = 0.0
	_shake_time = 0.0
	_shake_strength = 0.0
	_lead = 0.0
	offset = Vector2(0.0, height_offset)
	reset_smoothing()

## The level edges, in pixels.
func set_limits(bounds: Rect2) -> void:
	limit_left = int(bounds.position.x)
	limit_top = int(bounds.position.y)
	limit_right = int(bounds.position.x + bounds.size.x)
	limit_bottom = int(bounds.position.y + bounds.size.y)
