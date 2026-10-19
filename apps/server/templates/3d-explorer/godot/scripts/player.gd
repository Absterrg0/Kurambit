## Third-person character controller: camera-relative movement, acceleration and
## friction, air control, coyote time, jump buffering, variable jump height, sprint,
## smooth turning, hazard knockback and the placeholder body animation. Every number
## in the exported groups is meant to be tuned per game.
class_name Player
extends CharacterBody3D

@export_group("Movement")
## Walking speed in metres per second.
@export var walk_speed := 5.0
@export var sprint_speed := 8.0
@export var acceleration := 16.0
@export var friction := 20.0
@export var air_acceleration := 6.0
## How quickly the body swings around to face the direction of travel (radians/second, exponential).
@export var turn_speed := 13.0

@export_group("Jump")
@export var jump_velocity := 7.0
@export var gravity := 20.0
## Extra gravity while falling, so jumps do not float.
@export var fall_gravity_multiplier := 1.6
## Upward velocity kept when the jump button is released early.
@export var jump_cut_multiplier := 0.45
@export var coyote_time := 0.12
@export var jump_buffer_time := 0.12

@export_group("Survival")
@export var invulnerability_time := 1.2
@export var blink_interval := 0.09
@export var knockback_speed := 6.0
@export var knockback_lift := 5.0

@export_group("Feedback")
@export var step_interval := 0.32
@export var bob_height := 0.06
@export var lean_angle := 0.14

@onready var visual: Node3D = $Visual
@onready var rig: CameraRig = $CameraRig

var _coyote := 0.0
var _jump_buffer := 0.0
var _invulnerable := 0.0
var _blink := 0.0
var _step := 0.0
var _bob_time := 0.0
var _base_scale := Vector3.ONE

func _ready() -> void:
	_base_scale = visual.scale

func _physics_process(delta: float) -> void:
	_tick_timers(delta)
	_apply_gravity(delta)
	_handle_jump(delta)
	_apply_horizontal(delta)
	var was_on_floor := is_on_floor()
	move_and_slide()
	if is_on_floor() and not was_on_floor:
		_on_land()
	_animate(delta)
	_footsteps(delta)

func is_invulnerable() -> bool:
	return _invulnerable > 0.0

## Damage plus knockback from a hazard. Ignored while invulnerable, so a hazard that
## keeps overlapping the body only hits once per invulnerability window.
func apply_hit(from_position: Vector3, damage: float, reason: String) -> void:
	if _invulnerable > 0.0 or not GameState.is_playing():
		return
	_invulnerable = invulnerability_time
	_blink = blink_interval
	var away := global_position - from_position
	away.y = 0.0
	away = away.normalized() if away.length_squared() > 0.001 else Vector3.BACK
	velocity = away * knockback_speed + Vector3.UP * knockback_lift
	GameState.apply_damage(damage, reason)

## Moves the body to a checkpoint and resets everything that must not carry over.
func respawn(at: Transform3D) -> void:
	velocity = Vector3.ZERO
	global_transform = at
	_coyote = 0.0
	_jump_buffer = 0.0
	_invulnerable = invulnerability_time
	visual.visible = true
	visual.position = Vector3.ZERO
	visual.scale = _base_scale

## Freezes the body for the win/lose screens and unfreezes it for a new run.
func set_active(active: bool) -> void:
	process_mode = (
		Node.PROCESS_MODE_INHERIT if active else Node.PROCESS_MODE_DISABLED
	)
	if not active:
		velocity = Vector3.ZERO
		visual.visible = true

func _tick_timers(delta: float) -> void:
	_invulnerable = maxf(_invulnerable - delta, 0.0)
	if _invulnerable <= 0.0:
		visual.visible = true
		return
	_blink -= delta
	if _blink <= 0.0:
		_blink = blink_interval
		visual.visible = not visual.visible

func _apply_gravity(delta: float) -> void:
	if is_on_floor():
		return
	var multiplier := fall_gravity_multiplier if velocity.y < 0.0 else 1.0
	velocity.y -= gravity * multiplier * delta

func _handle_jump(delta: float) -> void:
	if Input.is_action_just_pressed("jump"):
		_jump_buffer = jump_buffer_time
	_coyote = coyote_time if is_on_floor() else maxf(_coyote - delta, 0.0)
	_jump_buffer = maxf(_jump_buffer - delta, 0.0)
	if _jump_buffer > 0.0 and _coyote > 0.0:
		velocity.y = jump_velocity
		_jump_buffer = 0.0
		_coyote = 0.0
		Audio.play("jump")
	if Input.is_action_just_released("jump") and velocity.y > 0.0:
		velocity.y *= jump_cut_multiplier

func _apply_horizontal(delta: float) -> void:
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var basis := rig.movement_basis()
	var wish := (basis.x * input.x + basis.z * input.y).normalized()
	var moving := wish.length_squared() > 0.001
	var rate := acceleration if is_on_floor() else air_acceleration
	if not moving:
		rate = friction if is_on_floor() else air_acceleration * 0.5
	var target := wish * _target_speed()
	velocity.x = move_toward(velocity.x, target.x, rate * delta)
	velocity.z = move_toward(velocity.z, target.z, rate * delta)
	if moving:
		# -Z is forward, so this yaw makes the body face the wish direction.
		var target_yaw := atan2(-wish.x, -wish.z)
		rotation.y = lerp_angle(rotation.y, target_yaw, 1.0 - exp(-turn_speed * delta))

func _target_speed() -> float:
	return sprint_speed if Input.is_action_pressed("sprint") else walk_speed

## Placeholder body language: a walk bob, a stretch in the air and a lean into the
## run. Swap in an AnimationPlayer (or an animated GLB) when the character gets a
## real rig and delete this method.
func _animate(delta: float) -> void:
	var speed := Vector2(velocity.x, velocity.z).length()
	var blend := 1.0 - exp(-16.0 * delta)
	var lift := 0.0
	if is_on_floor() and speed > 0.3:
		_bob_time += delta * speed
		lift = absf(sin(_bob_time * 2.4)) * bob_height
	visual.position.y = lerpf(visual.position.y, lift, blend)
	var stretch := 1.0
	if not is_on_floor():
		stretch = clampf(1.0 + velocity.y * 0.02, 0.88, 1.14)
	var squash := 2.0 - stretch
	var target_scale := _base_scale * Vector3(squash, stretch, squash)
	visual.scale = visual.scale.lerp(target_scale, blend)
	var lean := clampf(speed * 0.02, 0.0, lean_angle)
	visual.rotation.x = lerpf(visual.rotation.x, lean, blend)

func _on_land() -> void:
	Audio.play("land", randf_range(0.94, 1.06))
	visual.scale = _base_scale * Vector3(1.18, 0.76, 1.18)

func _footsteps(delta: float) -> void:
	if not is_on_floor():
		return
	var speed := Vector2(velocity.x, velocity.z).length()
	if speed < 0.8:
		_step = step_interval * 0.5
		return
	_step -= delta
	if _step <= 0.0:
		_step = step_interval * clampf(4.0 / speed, 0.5, 1.2)
		Audio.play("step", randf_range(0.9, 1.15))
