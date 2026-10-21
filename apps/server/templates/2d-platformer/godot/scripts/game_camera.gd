## The follow camera: a look-ahead that opens up the direction the player is running in,
## a vertical deadzone wide enough to swallow a whole jump, a view that opens downwards
## during a long fall, and hard limits at the level's edges.
##
## It owns the framing outright rather than leaning on `Camera2D`'s own smoothing and
## limits, because `Camera2D.offset` is applied *after* those limits: an offset big enough
## to lift the ground line to where a platformer wants it also lifts the view past the
## level's bottom edge. So the view is driven as one focus point (in world coordinates)
## which is clamped to the level here, and the offset is simply the difference between
## that point and the player.
class_name GameCamera
extends Camera2D

@export_group("Follow")
## How far above the player's feet the view is centred. At -96 the ground line sits at
## 77% of a 360px viewport: enough soil to plant the hero, but the visible dirt stays
## under a quarter of the screen instead of turning the foreground into a brick wall.
@export var height_offset := -96.0
## How far ahead of the player the camera leads, in pixels, at full speed.
@export var look_ahead := 26.0
## How quickly the look-ahead catches up (exponential, per second).
@export var look_ahead_speed := 2.4
## How quickly the view follows the player at all (exponential, per second).
@export var follow_speed := 9.0

@export_group("Vertical deadzone")
## How far the player may rise before the view follows. Wider than a full jump (about
## 44px at the default gravity), so jumping in place never moves the camera.
@export var deadzone_up := 52.0
## How far the player may drop before the view follows, when not falling fast.
@export var deadzone_down := 20.0
## How far below the player the view opens up during a fall, in pixels, and the fall
## speed at which it is fully open. Both stay inside the deadzone on purpose: a jump's
## descent should not shift the view, a fall off a ledge should.
@export var fall_look_ahead := 18.0
@export var fall_look_ahead_speed := 320.0

@export_group("Shake")
@export var shake_strength := 2.0
@export var shake_decay := 7.0

var _focus := Vector2.ZERO
var _bounds := Rect2()
var _lead := 0.0
var _shake := 0.0
var _shake_time := 0.0
var _shake_strength := 0.0

func _ready() -> void:
	# The focus is already smoothed below, and the built-in limits would clamp the
	# player's position rather than the view this script builds from it.
	position_smoothing_enabled = false
	ignore_rotation = true

func _process(delta: float) -> void:
	var player := get_parent() as Player
	if player == null:
		return
	var feet := player.global_position
	var speed := clampf(absf(player.velocity.x) / 132.0, 0.0, 1.6)
	_lead = lerpf(
		_lead, float(player.facing()) * look_ahead * speed, 1.0 - exp(-look_ahead_speed * delta)
	)
	var target := Vector2(feet.x + _lead, feet.y + height_offset)
	var desired := target
	if not player.is_on_floor():
		# A long fall opens the view up below the player; a jump's descent stays inside
		# the deadzone, so the camera does not bob along with every hop.
		var fall := clampf(player.velocity.y / fall_look_ahead_speed, 0.0, 1.0)
		var want := target.y + fall * fall_look_ahead
		if want < _focus.y - deadzone_up:
			desired.y = want + deadzone_up
		elif want > _focus.y + deadzone_down:
			desired.y = want - deadzone_down
		else:
			desired.y = _focus.y
	_focus = _focus.lerp(desired, 1.0 - exp(-follow_speed * delta))
	_clamp_focus()
	var jitter := Vector2.ZERO
	if _shake > 0.0:
		_shake = maxf(_shake - delta, 0.0)
		var amount := _shake_strength * (_shake / maxf(_shake_time, 0.001))
		jitter = Vector2(randf_range(-amount, amount), randf_range(-amount, amount))
	offset = _focus - feet + jitter

## Keeps the view inside the level, so no edge of the world is ever on screen. The sky
## above the level's top edge is the same gradient the background draws behind it, so the
## view may look above the level; the bottom and the sides are real edges.
func _clamp_focus() -> void:
	if _bounds.size.x <= 0.0 or _bounds.size.y <= 0.0:
		return
	var half := get_viewport_rect().size * 0.5
	_focus.x = clampf(_focus.x, _bounds.position.x + half.x, _bounds.end.x - half.x)
	_focus.y = minf(_focus.y, _bounds.end.y - half.y)

## Offsets the view for a moment. `strength` scales the exported shake_strength.
func shake(duration: float, strength := 1.0) -> void:
	_shake = maxf(_shake, duration)
	_shake_time = maxf(_shake_time, duration)
	_shake_strength = maxf(_shake_strength, shake_strength * strength)

## Drops any shake and puts the view straight back on the player, for a respawn or a
## new level: easing back from wherever the last run left the camera looks like a bug.
func reset() -> void:
	_shake = 0.0
	_shake_time = 0.0
	_shake_strength = 0.0
	_lead = 0.0
	var player := get_parent() as Player
	if player == null:
		offset = Vector2(0.0, height_offset)
		return
	_focus = player.global_position + Vector2(0.0, height_offset)
	_clamp_focus()
	offset = _focus - player.global_position

## The level edges, in pixels.
func set_limits(bounds: Rect2) -> void:
	_bounds = bounds
