## A third-person follow camera: behind and above the target, lagging, looking
## a little ahead, on a SpringArm3D so it pulls in when level collision is
## between it and the target and never ends inside a wall. Drag with the right
## mouse button (or with the mouse captured) or the right stick to orbit;
## untouched while the target moves, it settles behind the target's facing.
## Juice.shake still applies on top (it moves the camera's h/v offset).
##
##   var cam := FollowCamera3D.new()
##   cam.target = player                     # a Node3D; the player is never a blocker
##   add_child(cam)                          # in the game scene, not under the player
##   # move relative to the view: var dir := cam.flat_basis() * Vector3(input.x, 0, input.y)
##
## Walls block it through their collision shapes on `collision_mask` (StaticBody3D
## on layer 1 by default); put see-through things on another layer.
class_name FollowCamera3D
extends Node3D

@export var target: Node3D
@export var distance := 6.0
## The point looked at, above the target's origin.
@export var height := 1.6
## Higher catches up faster.
@export var lag := 10.0
@export var look_ahead := 1.5
@export var orbit := true
@export var sensitivity := 0.004
@export var pitch := -0.3
@export var min_pitch := -1.1
@export var max_pitch := 0.35
@export_flags_3d_physics var collision_mask := 1

## The view's heading around y.
var yaw := 0.0
var arm := SpringArm3D.new()
var camera := Camera3D.new()

var _last := Vector3.ZERO
var _ahead := Vector3.ZERO
var _idle := 0.0
var _turn := Vector2.ZERO


func _ready() -> void:
	top_level = true
	var sphere := SphereShape3D.new()
	sphere.radius = 0.25
	arm.shape = sphere
	arm.spring_length = distance
	arm.margin = 0.1
	arm.collision_mask = collision_mask
	add_child(arm)
	arm.add_child(camera)
	camera.position = Vector3(0, 0, distance)
	camera.current = true
	if target != null:
		yaw = target.global_rotation.y
		global_position = target.global_position + Vector3.UP * height
		_last = target.global_position
		_exclude(target)


## The view's facing on the ground, for camera-relative movement: forward is -z.
func flat_basis() -> Basis:
	return Basis(Vector3.UP, yaw)


func _unhandled_input(event: InputEvent) -> void:
	if not orbit or not event is InputEventMouseMotion:
		return
	var motion := event as InputEventMouseMotion
	if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED or motion.button_mask & MOUSE_BUTTON_MASK_RIGHT:
		_turn += motion.relative * sensitivity


func _physics_process(delta: float) -> void:
	if target == null or not is_instance_valid(target):
		return
	var turn := _turn
	_turn = Vector2.ZERO
	if orbit:
		var stick := Vector2(Input.get_joy_axis(0, JOY_AXIS_RIGHT_X), Input.get_joy_axis(0, JOY_AXIS_RIGHT_Y))
		if stick.length() > 0.15:
			turn += stick * Vector2(2.5, 1.5) * delta
	yaw -= turn.x
	pitch = clampf(pitch - turn.y, min_pitch, max_pitch)
	var at := target.global_position
	var moved := (at - _last) / delta
	_last = at
	moved.y = 0.0
	_idle = 0.0 if turn != Vector2.ZERO else _idle + delta
	# Untouched for a moment and moving: swing behind the target's facing (-z, Godot's forward).
	if _idle > 1.0 and moved.length() > 0.7:
		yaw = lerp_angle(yaw, target.global_rotation.y, 1.0 - exp(-1.5 * delta))
	var want := moved.normalized() * look_ahead if moved.length() > 0.5 else Vector3.ZERO
	_ahead = _ahead.lerp(want, 1.0 - exp(-2.5 * delta))
	var look := at + Vector3.UP * height + _ahead
	global_position = global_position.lerp(look, 1.0 - exp(-lag * delta))
	global_rotation = Vector3(pitch, yaw, 0.0)
	arm.spring_length = distance


func _exclude(node: Node) -> void:
	if node is CollisionObject3D:
		arm.add_excluded_object((node as CollisionObject3D).get_rid())
	for child in node.get_children():
		_exclude(child)
