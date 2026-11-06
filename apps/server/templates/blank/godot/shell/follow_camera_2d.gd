## A 2D follow camera on Camera2D's own smoothing, drag margins (the dead zone)
## and limits, plus a look-ahead in the moving direction. Juice.shake still
## applies on top (it moves `offset`, which this leaves alone).
##
##   var cam := FollowCamera2D.new()
##   cam.bounds = Rect2(0, 0, 3200, 720)     # level edges in pixels; the view stays inside
##   player.add_child(cam)                   # follows its parent
##
## Or add a Camera2D under the player in the scene and give it this script;
## the exported values show in the inspector.
class_name FollowCamera2D
extends Camera2D

## Pixels ahead in the moving direction.
@export var look_ahead := 80.0
## The dead zone, as a fraction of half the screen (0 follows at once).
@export var dead_zone := Vector2(0.15, 0.2)
## Higher catches up faster.
@export var smoothing := 6.0
## The level's edges; a zero size means no limits.
@export var bounds := Rect2():
	set(value):
		bounds = value
		_apply_bounds()

var _last := Vector2.ZERO
var _ahead := Vector2.ZERO


func _ready() -> void:
	# Physics interpolation draws bodies between ticks; a camera that follows on
	# the idle clock would step against them on a fast display.
	process_callback = Camera2D.CAMERA2D_PROCESS_PHYSICS
	position_smoothing_enabled = true
	position_smoothing_speed = smoothing
	drag_horizontal_enabled = dead_zone.x > 0.0
	drag_vertical_enabled = dead_zone.y > 0.0
	drag_left_margin = dead_zone.x
	drag_right_margin = dead_zone.x
	drag_top_margin = dead_zone.y
	drag_bottom_margin = dead_zone.y
	limit_smoothed = true
	_apply_bounds()
	_last = _followed()
	make_current()
	reset_smoothing()


func _physics_process(delta: float) -> void:
	if delta <= 0.0:
		return
	var at := _followed()
	var moved := (at - _last) / delta
	_last = at
	var want := Vector2.ZERO
	if moved.length() > 20.0:
		var dir := moved.normalized()
		# Drag holds the camera a margin behind a moving target; reach past it to lead.
		var margin := get_viewport_rect().size / zoom * 0.5 * dead_zone
		want = dir * look_ahead + Vector2(signf(dir.x) * margin.x if absf(dir.x) > 0.3 else 0.0, signf(dir.y) * margin.y if absf(dir.y) > 0.3 else 0.0)
	_ahead = _ahead.lerp(want, 1.0 - exp(-2.5 * delta))
	# The ahead shift moves the camera itself, so drag, smoothing and limits act on it.
	position = _ahead


func _followed() -> Vector2:
	var parent := get_parent()
	return (parent as Node2D).global_position if parent is Node2D else global_position


func _apply_bounds() -> void:
	if bounds.size == Vector2.ZERO:
		limit_left = -10000000
		limit_top = -10000000
		limit_right = 10000000
		limit_bottom = 10000000
		return
	limit_left = int(bounds.position.x)
	limit_top = int(bounds.position.y)
	limit_right = int(bounds.end.x)
	limit_bottom = int(bounds.end.y)
