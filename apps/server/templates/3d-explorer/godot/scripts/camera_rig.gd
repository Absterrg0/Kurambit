## Third-person camera: a yaw/pitch pivot that follows a target from behind through a
## SpringArm3D, so the camera never clips through walls. Mouse look needs a captured
## pointer (click to capture, Web included); the right stick works without capture.
class_name CameraRig
extends Node3D

@export var target: NodePath
## Height above the target's origin that the camera orbits and looks at.
@export var pivot_height := 1.7
@export var follow_speed := 16.0
@export var rest_distance := 5.6
@export var min_pitch := -1.05
@export var max_pitch := 0.55
## Right-stick look speed in radians per second.
@export var stick_speed := 2.6

@onready var _pitch_pivot: Node3D = $Pitch
@onready var _arm: SpringArm3D = $Pitch/SpringArm3D

var _yaw := 0.0
var _pitch := -0.3
var _target: Node3D

func _ready() -> void:
	# The rig keeps its own world transform, so the body it follows can rotate freely.
	top_level = true
	_arm.spring_length = rest_distance
	_target = get_node_or_null(target) as Node3D
	if _target != null:
		global_position = _target.global_position + Vector3.UP * pivot_height
	_apply()

func _process(delta: float) -> void:
	if _target != null and is_instance_valid(_target):
		var focus := _target.global_position + Vector3.UP * pivot_height
		global_position = global_position.lerp(focus, 1.0 - exp(-follow_speed * delta))
	var stick := Input.get_vector("look_left", "look_right", "look_up", "look_down")
	var invert := -1.0 if Settings.invert_y else 1.0
	_yaw -= stick.x * stick_speed * delta
	_pitch -= stick.y * stick_speed * delta * invert
	_apply()

## Yaw-only basis for turning player input into movement relative to the camera.
func movement_basis() -> Basis:
	return Basis(Vector3.UP, _yaw)

func _unhandled_input(event: InputEvent) -> void:
	if not GameState.is_playing():
		return
	var motion := event as InputEventMouseMotion
	if motion != null and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		var invert := -1.0 if Settings.invert_y else 1.0
		_yaw -= motion.relative.x * Settings.mouse_sensitivity
		_pitch -= motion.relative.y * Settings.mouse_sensitivity * invert
		_apply()
		return
	var button := event as InputEventMouseButton
	if button != null and button.pressed and button.button_index == MOUSE_BUTTON_LEFT:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _apply() -> void:
	_pitch = clampf(_pitch, min_pitch, max_pitch)
	rotation = Vector3(0.0, _yaw, 0.0)
	_pitch_pivot.rotation = Vector3(_pitch, 0.0, 0.0)
