import type { GodotRecipeReference } from "./reference.ts";

export const feelBuffer: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Space jumps; press it again during the arc to queue the next jump. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Jump buffering: a jump pressed before the feet touch down is remembered for
## BUFFER_MS and spent on the landing frame, so a hurried press is not dropped.
## The queue belongs to this body; no global input or time state changes.

const FLOOR_Y := 280.0
const GRAVITY := 950.0
const JUMP_SPEED := -520.0
const BUFFER_MS := 200.0  # Top of the usual 100-200 ms; longer eats a late press.

var _y := FLOOR_Y
var _vy := 0.0
var _queued_ms := 0.0
var _jumps := 0
var _buffered_jumps := 0

func _ready() -> void:
	if not InputMap.has_action("jump"):
		InputMap.add_action("jump")
		var event := InputEventKey.new()
		event.physical_keycode = KEY_SPACE
		InputMap.action_add_event("jump", event)

func _physics_process(delta: float) -> void:
	# Age the queue first: a press older than the window is stale when we land.
	_queued_ms = maxf(_queued_ms - delta * 1000.0, 0.0)
	var grounded := _y >= FLOOR_Y
	if Input.is_action_just_pressed("jump"):
		if grounded:
			_jumps += 1
			_vy = JUMP_SPEED
		else:
			_queued_ms = BUFFER_MS
	_vy += GRAVITY * delta
	_y = minf(_y + _vy * delta, FLOOR_Y)
	if _y >= FLOOR_Y:
		_vy = 0.0
		if _queued_ms > 0.0:
			# Spend the queued press once, on the landing frame.
			_queued_ms = 0.0
			_jumps += 1
			_buffered_jumps += 1
			_vy = JUMP_SPEED
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(40.0, FLOOR_Y, 560.0, 20.0), Color(0.2, 0.22, 0.26))
	draw_rect(Rect2(308.0, _y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	draw_line(Vector2(308.0, _y - 24.0), Vector2(332.0, _y - 24.0), Color.WHITE, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "jumps %d  queued %d ms" % [_jumps, int(_queued_ms)], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 52.0), "Space: jump, press again before landing", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.65, 0.65, 0.7))

func snapshot() -> Dictionary:
	return {
		"player_x": 320, "player_y": int(_y),
		"on_floor": _y >= FLOOR_Y, "queued_ms": int(_queued_ms), "jumps": _jumps, "buffered_jumps": _buffered_jumps,
	}
`,
  tryInput: {
    // The arc lasts ~1.1 s at this gravity. The second press lands just over
    // 100 ms before touchdown, inside the 200 ms window, so the jump is spent on
    // the landing frame without a third press after landing.
    steps: [
      { key: "Space", holdMs: 60 },
      { waitMs: 900 },
      { key: "Space", holdMs: 60 },
      { waitMs: 900 },
      { screenshot: "buffered-jump" },
    ],
    captureEveryMs: 200,
  },
};
