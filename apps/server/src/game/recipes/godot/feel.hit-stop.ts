import type { GodotRecipeReference } from "./reference.ts";

export const feelHitStop: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Space swings the striker into the target. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Hit-stop: on contact, hold only the two bodies of the impact for a beat, then
## resume. The pause is a local countdown, never Engine.time_scale; a scenery
## marker outside it keeps moving in the same frames.

const START_X := 120.0; const TARGET_X := 520.0
const STRIKE_SPEED := 900.0
const HIT_PAUSE_MS := 140.0  # Held impact length. Try 50-200 ms.
const RECOIL := 10.0
const MARKER_SPEED := 60.0  # px/s on the scenery lane, outside the pause.

var _striker_x := START_X; var _striker_dir := 0.0
var _pause_ms := 0.0; var _flash := 0.0; var _recoil := 0.0
var _strikes := 0; var _hold_motion := 0.0
var _marker_x := 60.0

func _ready() -> void:
	if not InputMap.has_action("strike"):
		InputMap.add_action("strike")
		var key := InputEventKey.new(); key.physical_keycode = KEY_SPACE
		InputMap.action_add_event("strike", key)

func _physics_process(delta: float) -> void:
	# The marker moves first and always: the hold below cannot stop it.
	_marker_x = 60.0 + fmod(_marker_x - 60.0 + MARKER_SPEED * delta, 520.0)
	if _pause_ms > 0.0: _hold_motion += MARKER_SPEED * delta
	_flash = maxf(_flash - delta, 0.0); _recoil = maxf(_recoil - delta * 60.0, 0.0)
	if _pause_ms > 0.0:
		# The striker is held; this branch still ticks, and the target recoils
		# when the hold ends. Nothing else in the game is stopped.
		_pause_ms = maxf(_pause_ms - delta * 1000.0, 0.0)
		if _pause_ms == 0.0:
			_recoil = RECOIL
			_striker_dir = -1.0
		queue_redraw()
		return
	if Input.is_action_just_pressed("strike") and _striker_dir == 0.0:
		_striker_dir = 1.0
	if _striker_dir != 0.0:
		_striker_x += _striker_dir * STRIKE_SPEED * delta
		if _striker_x >= TARGET_X:
			_striker_x = TARGET_X; _striker_dir = 0.0
			_pause_ms = HIT_PAUSE_MS; _flash = 0.2; _strikes += 1
		elif _striker_x <= START_X: _striker_x = START_X; _striker_dir = 0.0
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(40.0, 160.0, 560.0, 84.0), Color(0.16, 0.17, 0.2)); draw_rect(Rect2(40.0, 244.0, 560.0, 16.0), Color(0.28, 0.3, 0.34))
	draw_rect(Rect2(_striker_x - 16.0, 196.0, 32.0, 40.0), Color(0.75, 0.78, 0.85))
	var target_color := Color(0.95, 0.95, 0.95) if _flash > 0.0 else Color(0.6, 0.25, 0.3)
	draw_rect(Rect2(TARGET_X + 16.0 + _recoil, 186.0, 44.0, 60.0), target_color)
	draw_circle(Vector2(_marker_x, 300.0), 6.0, Color(0.4, 0.85, 0.6))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "strikes %d  pause %d ms  marker %d px held %d  (Space)" % [_strikes, int(_pause_ms), int(_marker_x), int(_hold_motion)], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_striker_x), "player_y": 196, "strikes": _strikes, "marker_x": int(_marker_x),
		"pause_ms": int(_pause_ms), "flash": int(_flash * 1000.0), "recoil": int(_recoil), "hold_motion": int(_hold_motion),
	}
`,
  tryInput: {
    // Space starts the swing; contact lands during the long wait, so the 100 ms
    // captures show the hold. The marker keeps moving through those frames.
    steps: [
      { waitMs: 300 },
      { key: "Space", holdMs: 60 },
      { waitMs: 500 },
      { waitMs: 300 },
      { screenshot: "resumed" },
      { waitMs: 900 },
    ],
    captureEveryMs: 100,
  },
};
