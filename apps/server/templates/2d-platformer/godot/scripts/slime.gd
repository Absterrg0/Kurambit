## A patrolling slime. It walks until it meets a wall or the edge of a platform, then
## turns around. Landing on its head kills it and bounces the player; any other contact
## hurts the player. It never decides what damage means — that stays in `Player.hurt()`.
class_name Slime
extends CharacterBody2D

@export_group("Patrol")
@export var speed := 26.0
@export var gravity := 900.0
@export var turns_at_edges := true
@export var turn_pause := 0.12

@export_group("Reaction")
## Bounce the player gets when this slime is stomped, as a fraction of the jump.
@export var stomp_bounce := 0.82
## How far above the slime's middle the player's feet must be to count as a stomp.
@export var stomp_height := 4.0

@onready var sprite: AnimatedSprite2D = $Sprite
@onready var touch: Area2D = $Touch
@onready var wall_ray: RayCast2D = $WallRay
@onready var floor_ray: RayCast2D = $FloorRay

var _home := Vector2.ZERO
var _direction := -1.0
var _alive := true
var _pause := 0.0

func _ready() -> void:
	_home = global_position
	touch.body_entered.connect(_on_body_entered)
	_aim_rays()

func _physics_process(delta: float) -> void:
	if not _alive:
		return
	if _pause > 0.0:
		_pause = maxf(_pause - delta, 0.0)
		return
	_aim_rays()
	velocity.x = _direction * speed
	velocity.y = minf(velocity.y + gravity * delta, 400.0)
	move_and_slide()
	if is_on_wall() or (turns_at_edges and is_on_floor() and not floor_ray.is_colliding()):
		_turn()

## Killed by a stomp: squash, fade, and stop touching anything until `reset()`.
func squash() -> void:
	if not _alive:
		return
	_alive = false
	velocity = Vector2.ZERO
	touch.set_deferred("monitoring", false)
	var tween := create_tween()
	tween.set_parallel()
	tween.tween_property(sprite, "scale", Vector2(1.5, 0.15), 0.22)
	tween.tween_property(sprite, "modulate:a", 0.0, 0.3)
	tween.chain().tween_callback(func() -> void: visible = false)
	Audio.play("stomp", randf_range(0.95, 1.05))

func reset() -> void:
	_alive = true
	_pause = 0.0
	visible = true
	touch.monitoring = true
	global_position = _home
	velocity = Vector2.ZERO
	sprite.scale = Vector2.ONE
	sprite.modulate = Color.WHITE
	sprite.play("move")
	_direction = -1.0

func is_alive() -> bool:
	return _alive

## The rays look where the slime is walking, so it stops at ledges and walls.
func _aim_rays() -> void:
	wall_ray.position = Vector2(0.0, -5.0)
	wall_ray.target_position = Vector2(_direction * 11.0, 0.0)
	floor_ray.position = Vector2(_direction * 7.0, -2.0)
	floor_ray.target_position = Vector2(0.0, 12.0)

func _turn() -> void:
	_direction = -_direction
	_pause = turn_pause

func _on_body_entered(body: Node2D) -> void:
	if not _alive:
		return
	var player := body as Player
	if player == null:
		return
	var from_above := player.global_position.y <= global_position.y - stomp_height
	if from_above and player.velocity.y > 20.0:
		player.bounce(stomp_bounce)
		squash()
		return
	player.hurt(global_position, "slime")
