import type { GodotRecipeReference } from "./reference.ts";

export const feelShake: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Space hits once. The fixed white cross marks the resting camera centre. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Screen shake: a seeded random ride that decays back to the exact base camera
## offset. The fixed seed makes each impact repeatable, and the amplitude reaching
## zero guarantees the camera heals instead of drifting.

const BASE := Vector2(320.0, 180.0)
const STRENGTH := 16.0  # Peak offset in pixels. Try 4-24.
const DECAY := 48.0  # Pixels per second; a 16 px impact is gone in ~0.3 s.

var _camera: Camera2D
var _rng := RandomNumberGenerator.new()
var _amplitude := 0.0
var _offset := Vector2.ZERO
var _impacts := 0

func _ready() -> void:
	if not InputMap.has_action("impact"):
		InputMap.add_action("impact")
		var event := InputEventKey.new()
		event.physical_keycode = KEY_SPACE
		InputMap.action_add_event("impact", event)
	_rng.seed = 20261023
	_camera = Camera2D.new()
	_camera.position = BASE
	add_child(_camera)
	# A screen-space cross that never moves: the world shifting under it is the
	# proof that the camera is offset, and its return is the proof of the heal.
	var overlay := CanvasLayer.new()
	var cross := ColorRect.new()
	cross.color = Color(1.0, 1.0, 1.0, 0.35)
	cross.position = Vector2(318.0, 0.0)
	cross.size = Vector2(2.0, 360.0)
	overlay.add_child(cross)
	add_child(overlay)

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("impact"):
		_impacts += 1
		_rng.seed = 20261023 + _impacts  # Each impact gets its own repeatable ride.
		_amplitude = STRENGTH
	if _amplitude > 0.5:
		_amplitude = maxf(_amplitude - DECAY * delta, 0.0)
		_offset = Vector2(_rng.randf_range(-1.0, 1.0), _rng.randf_range(-1.0, 1.0)) * _amplitude
	else:
		_amplitude = 0.0
		_offset = Vector2.ZERO
	_camera.position = BASE + _offset
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.13, 0.14, 0.17), false, 2.0)
	draw_rect(Rect2(280.0, 140.0, 80.0, 80.0), Color(0.85, 0.7, 0.25))
	draw_rect(Rect2(40.0, 300.0, 560.0, 20.0), Color(0.28, 0.3, 0.34))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "impacts %d  offset %d,%d  peak %d px  (Space)" % [_impacts, int(_offset.x), int(_offset.y), int(_amplitude)], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": 320, "player_y": 180, "impacts": _impacts, "amplitude": int(_amplitude),
		"offset_x": int(_offset.x), "offset_y": int(_offset.y),
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { key: "Space", holdMs: 60 },
      { screenshot: "shaking" },
      { waitMs: 900 },
      { screenshot: "returned" },
    ],
    captureEveryMs: 150,
  },
};
