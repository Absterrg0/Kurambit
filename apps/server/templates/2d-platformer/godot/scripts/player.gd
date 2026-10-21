## Side-scrolling character controller with the feel knobs a platformer lives on:
## acceleration and friction instead of instant velocity, coyote time, jump buffering,
## variable jump height, a shorter hop when the button is released early, extra gravity
## on the way down, a floaty apex, a capped fall speed, optional wall slide and wall
## jump, squash and stretch, landing dust and hazard knockback. Every number is an
## `@export`, so a game can be tuned from the inspector without touching this script.
class_name Player
extends CharacterBody2D

@export_group("Movement")
## Top speed on the ground, in pixels per second (16 = one tile per second).
@export var run_speed := 132.0
@export var sprint_speed := 196.0
## How fast the player reaches top speed, and how fast it stops on the ground.
@export var acceleration := 900.0
@export var friction := 1500.0
## Air control is deliberately weaker than the ground: jumps stay committed.
@export var air_acceleration := 620.0
@export var air_friction := 260.0

@export_group("Jump")
## gravity and jump_velocity are tuned together: 980 / 285 clears three tiles.
@export var jump_velocity := 285.0
@export var gravity := 980.0
## Extra gravity while falling, so a jump does not float.
@export var fall_gravity_multiplier := 1.45
## Multiplier applied to the upward velocity when the jump button is released early.
@export var jump_cut := 0.42
## Gravity is scaled down near the top of a jump, which reads as hang time.
@export var apex_gravity_multiplier := 0.62
## Vertical speed below which a jump counts as being at its apex.
@export var apex_threshold := 74.0
@export var max_fall_speed := 430.0
@export var coyote_time := 0.11
@export var jump_buffer_time := 0.12

@export_group("Wall")
## Off by default: a wall slide changes how every level has to be built.
@export var wall_slide_enabled := false
@export var wall_slide_speed := 46.0
@export var wall_jump_velocity := Vector2(180.0, 270.0)
@export var wall_stick_time := 0.12

@export_group("Survival")
@export var invulnerability_time := 1.4
@export var blink_interval := 0.08
@export var knockback_speed := 230.0
@export var knockback_lift := 200.0
## How long the tumble lasts before the game puts the player back on the checkpoint.
@export var hurt_time := 0.55

@export_group("Feedback")
@export var step_interval := 0.26
@export var shake_time := 0.16

@onready var body: AnimatedSprite2D = $Body
@onready var dust: CPUParticles2D = $Dust
@onready var camera: GameCamera = $Camera2D

var _coyote := 0.0
var _jump_buffer := 0.0
var _invulnerable := 0.0
var _hurt := 0.0
var _blink := 0.0
var _step := 0.0
var _facing := 1
var _wall_dir := 0
var _wall_stick := 0.0

func _ready() -> void:
	body.play("idle")

func _physics_process(delta: float) -> void:
	_tick_timers(delta)
	if _hurt > 0.0:
		# Tumbling: no control until the game respawns the player at a checkpoint.
		_apply_gravity(delta, false)
	else:
		_apply_gravity(delta, true)
		_check_wall(delta)
		_handle_jump(delta)
		_apply_horizontal(delta)
	var was_on_floor := is_on_floor()
	var impact := velocity.y
	move_and_slide()
	if is_on_floor() and not was_on_floor:
		_land(impact)
	_animate(delta)
	_footsteps(delta)

func is_invulnerable() -> bool:
	return _invulnerable > 0.0

## Which way the body is facing, for the camera's look-ahead.
func facing() -> int:
	return _facing

## Freezes or unfreezes the body for the win/lose screens and for a new run.
func set_active(active: bool) -> void:
	process_mode = Node.PROCESS_MODE_INHERIT if active else Node.PROCESS_MODE_DISABLED
	if not active:
		velocity = Vector2.ZERO
		body.visible = true
		body.play("idle")

## Moves the body to a checkpoint and clears everything that must not carry over.
func respawn(at: Vector2) -> void:
	global_position = at.snapped(Vector2.ONE)
	velocity = Vector2.ZERO
	_coyote = 0.0
	_jump_buffer = 0.0
	_hurt = 0.0
	_wall_stick = 0.0
	_invulnerable = invulnerability_time
	body.visible = true
	body.scale = Vector2.ONE
	body.play("idle")
	camera.reset()

## Damage plus knockback. The game listens for `GameState.life_lost` and puts the
## player back on the last checkpoint, so a hit is a tumble and then a fresh start.
## Ignored while invulnerable, which is what stops a hazard field hitting twice.
func hurt(from_position: Vector2, reason: String) -> void:
	if _invulnerable > 0.0 or _hurt > 0.0 or not GameState.is_playing():
		return
	_hurt = hurt_time
	_invulnerable = hurt_time + invulnerability_time
	_blink = blink_interval
	var away := global_position - from_position
	away.y = minf(away.y, -4.0)
	if absf(away.x) < 6.0:
		away.x = float(-_facing) * 6.0
	velocity = away.normalized() * knockback_speed
	velocity.y -= knockback_lift
	body.play("fall")
	Audio.play("hurt")
	if Settings.screen_shake:
		camera.shake(shake_time * 1.6, 2.6)
	GameState.lose_life(reason)

## The stomp bounce: a fixed hop that does not depend on the jump button. Stompable
## enemies pass their own `stomp_bounce` so a heavy one can bounce higher.
func bounce(strength := 0.82) -> void:
	_coyote = coyote_time
	velocity.y = -jump_velocity * strength
	_jump_buffer = 0.0
	body.scale = Vector2(0.86, 1.16)

## The camera reads these so the view never shows past the level's edge.
func set_camera_limits(bounds: Rect2) -> void:
	camera.set_limits(bounds)

func _tick_timers(delta: float) -> void:
	_hurt = maxf(_hurt - delta, 0.0)
	_invulnerable = maxf(_invulnerable - delta, 0.0)
	if _invulnerable <= 0.0:
		body.visible = true
		return
	_blink -= delta
	if _blink <= 0.0:
		_blink = blink_interval
		body.visible = not body.visible

## `with_apex` is off while tumbling, so a knockback falls at one steady rate.
func _apply_gravity(delta: float, with_apex: bool) -> void:
	if is_on_floor():
		return
	var multiplier := fall_gravity_multiplier
	if velocity.y < 0.0:
		# Rising: full gravity, softened near the top so the apex hangs.
		multiplier = 1.0
		if with_apex and absf(velocity.y) < apex_threshold:
			multiplier = apex_gravity_multiplier
	var fall_cap := wall_slide_speed if _is_wall_sliding() else max_fall_speed
	velocity.y = minf(velocity.y + gravity * multiplier * delta, fall_cap)

func _check_wall(delta: float) -> void:
	_wall_stick = maxf(_wall_stick - delta, 0.0)
	_wall_dir = 0
	if not wall_slide_enabled or is_on_floor() or not is_on_wall_only():
		return
	_wall_dir = int(signf(get_wall_normal().x))
	_wall_stick = wall_stick_time
	if velocity.y > 0.0:
		velocity.y = minf(velocity.y, wall_slide_speed)
		body.play("jump")

func _is_wall_sliding() -> bool:
	return wall_slide_enabled and _wall_dir != 0 and not is_on_floor() and velocity.y > 0.0

func _handle_jump(delta: float) -> void:
	if Input.is_action_just_pressed("jump"):
		_jump_buffer = jump_buffer_time
	_coyote = coyote_time if is_on_floor() else maxf(_coyote - delta, 0.0)
	_jump_buffer = maxf(_jump_buffer - delta, 0.0)
	if _jump_buffer > 0.0 and _coyote > 0.0:
		velocity.y = -jump_velocity
		GameState.jumps += 1
		_jump_buffer = 0.0
		_coyote = 0.0
		body.scale = Vector2(0.82, 1.2)
		body.play("jump")
		Audio.play("jump", randf_range(0.97, 1.05))
		return
	if _jump_buffer > 0.0 and _wall_dir != 0 and _wall_stick > 0.0:
		# The normal points out of the wall, so the impulse follows it: away from
		# the wall the player just kicked off.
		velocity = Vector2(float(_wall_dir) * wall_jump_velocity.x, -wall_jump_velocity.y)
		_jump_buffer = 0.0
		_wall_stick = 0.0
		_facing = _wall_dir
		body.flip_h = _facing < 0
		body.play("jump")
		Audio.play("jump", randf_range(0.97, 1.05))
		return
	# Variable jump height: releasing early clips the top off the jump.
	if Input.is_action_just_released("jump") and velocity.y < 0.0:
		velocity.y *= jump_cut

func _apply_horizontal(delta: float) -> void:
	var direction := Input.get_axis("move_left", "move_right")
	var rate := acceleration if is_on_floor() else air_acceleration
	if is_zero_approx(direction):
		rate = friction if is_on_floor() else air_friction
	velocity.x = move_toward(velocity.x, direction * _target_speed(), rate * delta)
	if not is_zero_approx(direction):
		_facing = int(signf(direction))
		body.flip_h = _facing < 0

func _target_speed() -> float:
	return sprint_speed if Input.is_action_pressed("sprint") else run_speed

## Frame-by-frame body language: the run cycle, a jump or fall frame, and squash and
## stretch driven by vertical speed. Add animations to
## `assets/sprites/player_frames.tres` and play them here to extend it.
func _animate(delta: float) -> void:
	var speed := absf(velocity.x)
	if _hurt > 0.0:
		body.play("fall")
	elif not is_on_floor():
		body.play("jump" if velocity.y < 0.0 else "fall")
	elif speed > 8.0:
		body.play("run")
		body.speed_scale = clampf(speed / run_speed, 0.75, 1.6)
	else:
		body.play("idle")
		body.speed_scale = 1.0
	var stretch := 1.0
	if not is_on_floor():
		stretch = clampf(1.0 + velocity.y * 0.0009, 0.9, 1.14)
	var target := Vector2(2.0 - stretch, stretch)
	body.scale = body.scale.lerp(target, 1.0 - exp(-14.0 * delta))

func _land(impact: float) -> void:
	body.scale = Vector2(1.22, 0.78)
	dust.restart()
	Audio.play("land", randf_range(0.94, 1.06))
	if Settings.screen_shake and absf(impact) > 250.0:
		camera.shake(shake_time * 0.7, 1.4)

func _footsteps(delta: float) -> void:
	if not is_on_floor() or _hurt > 0.0 or absf(velocity.x) < 24.0:
		_step = step_interval * 0.5
		return
	_step -= delta
	if _step <= 0.0:
		_step = step_interval * clampf(run_speed / absf(velocity.x), 0.6, 1.2)
		Audio.play("step", randf_range(0.9, 1.15))
