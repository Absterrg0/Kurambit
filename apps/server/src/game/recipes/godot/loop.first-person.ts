import type { GodotRecipeReference } from "./reference.ts";

export const loopFirstPerson: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Click the view to capture the pointer; mouse look is the primary path, the arrow keys mirror it for keyboard or headless use, WASD walks and Escape releases the pointer. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## First-person loop: click to capture the pointer, look with relative mouse
## motion (the primary path), walk with WASD and press Escape to get the cursor
## back. The arrow keys mirror the look for keyboards and headless capture. The
## 3D world is primitives here, so the demo needs no scene, asset or input map.

const WALK_SPEED := 3.2  # m/s, a brisk walk.
const LOOK_SENSITIVITY := 0.0032  # Radians per pixel; 0.002-0.004 is typical.
const KEY_LOOK_SPEED := 1.8  # rad/s for the arrow keys, so look works without a mouse.
const CAPTURE_JUMP_PX := 400.0  # No hand can flick this far in one event.
const PITCH_LIMIT := 1.4  # Just under a right angle, so the view never flips.
const EYE_HEIGHT := 1.6

const CAPTURE_SETTLE_MS := 400  # Pointer-lock warp events land inside this window.
const SETTLE_MAX_STEP := 120.0  # Warp deltas are hundreds of px; real ones are not.

var _world: Node3D
var _pivot: Node3D
var _camera: Camera3D
var _yaw := 0.0
var _pitch := 0.0
var _captured := false
var _walked := 0.0
var _settle_until := 0
var _ignored := 0

func _ready() -> void:
	for action in [["move_left", KEY_A], ["move_right", KEY_D], ["move_forward", KEY_W], ["move_back", KEY_S], ["look_left", KEY_LEFT], ["look_right", KEY_RIGHT], ["look_up", KEY_UP], ["look_down", KEY_DOWN]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)
	_world = Node3D.new()
	add_child(_world)
	var light := DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-55.0, -35.0, 0.0)
	_world.add_child(light)
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.42, 0.56, 0.72)
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color(0.6, 0.65, 0.72)
	var world_environment := WorldEnvironment.new()
	world_environment.environment = environment
	_world.add_child(world_environment)
	_box(Vector3(0.0, -0.1, 0.0), Vector3(24.0, 0.2, 24.0), Color(0.3, 0.34, 0.3))
	# A ring of pillars at different heights: the view must change when you look.
	for index in 8:
		var angle := TAU * float(index) / 8.0
		var height := 2.0 + 2.0 * float(index % 3)
		_box(Vector3(cos(angle) * 9.0, height * 0.5, sin(angle) * 9.0), Vector3(1.2, height, 1.2), Color.from_hsv(float(index) / 8.0, 0.45, 0.75))
	_box(Vector3(0.0, 1.0, -6.0), Vector3(3.0, 2.0, 3.0), Color(0.85, 0.7, 0.3))
	_box(Vector3(4.0, 0.5, -2.0), Vector3(1.2, 1.0, 1.2), Color(0.35, 0.65, 0.8))
	_box(Vector3(-4.0, 0.7, -3.0), Vector3(1.6, 1.4, 1.6), Color(0.8, 0.45, 0.35))
	_pivot = Node3D.new()
	_pivot.position = Vector3(0.0, EYE_HEIGHT, 4.0)
	_world.add_child(_pivot)
	_camera = Camera3D.new()
	_camera.fov = 70.0
	_camera.current = true
	_pivot.add_child(_camera)

func _box(at: Vector3, size: Vector3, color: Color) -> void:
	var mesh := BoxMesh.new()
	mesh.size = size
	var instance := MeshInstance3D.new()
	instance.mesh = mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	instance.material_override = material
	instance.position = at
	_world.add_child(instance)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_captured = true
		_settle_until = Time.get_ticks_msec() + CAPTURE_SETTLE_MS
		Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	elif event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE and _captured:
		# Escape always exits: a capture with no way out traps the player.
		_captured = false
		Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	elif event is InputEventMouseMotion and _captured:
		# Pointer lock reports the cursor's warp into the locked position as huge
		# deltas just after capture. Only those settle events are ignored; once the
		# window closes every unscaled delta is consumed in full, with no clipping.
		var step: Vector2 = event.screen_relative
		if Time.get_ticks_msec() < _settle_until and step.length() > SETTLE_MAX_STEP:
			_ignored += 1
			return
		_yaw -= step.x * LOOK_SENSITIVITY
		_pitch = clampf(_pitch - step.y * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT)

func _process(delta: float) -> void:
	# Arrow keys mirror the mouse look, so the controller also works without a
	# pointer (accessibility, and headless capture cannot inject relative motion).
	_yaw -= Input.get_axis("look_left", "look_right") * KEY_LOOK_SPEED * delta
	_pitch = clampf(_pitch - Input.get_axis("look_up", "look_down") * KEY_LOOK_SPEED * delta, -PITCH_LIMIT, PITCH_LIMIT)
	_pivot.rotation.y = _yaw
	_camera.rotation.x = _pitch
	var move := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	if move != Vector2.ZERO:
		var direction := Vector3(move.x, 0.0, move.y).rotated(Vector3.UP, _yaw).normalized()
		_pivot.position += direction * WALK_SPEED * delta
		_walked += WALK_SPEED * delta
	queue_redraw()

func _draw() -> void:
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "captured %s  yaw %d  pitch %d  (click, look, WASD, Esc)" % ["yes" if _captured else "no", int(rad_to_deg(_yaw)), int(rad_to_deg(_pitch))], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.95, 0.95, 0.98))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_pivot.position.x * 100.0), "player_y": int(_pivot.position.z * 100.0),
		"yaw_deg": int(rad_to_deg(_yaw)), "pitch_deg": int(rad_to_deg(_pitch)),
		"captured": _captured, "walked": int(_walked * 100.0), "ignored_look": _ignored,
	}
`,
  tryInput: {
    // The click captures (and is the baseline). The mouse move is the real look
    // path; headless capture reports no relative motion, so the arrows turn the
    // camera for the frames. W proves walking and Escape proves release.
    steps: [
      { waitMs: 400 },
      { click: "left", x: 320, y: 180 },
      { mouseMove: { dx: 60, dy: 0 } },
      { key: "ArrowRight", holdMs: 500 },
      { key: "ArrowUp", holdMs: 150 },
      { key: "W", holdMs: 600 },
      { waitMs: 100 },
      { screenshot: "looked" },
      { key: "Escape", holdMs: 60 },
      { waitMs: 200 },
      { screenshot: "released" },
    ],
    captureEveryMs: 250,
  },
};
