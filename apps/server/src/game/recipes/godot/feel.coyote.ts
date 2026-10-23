import type { GodotRecipeReference } from "./reference.ts";

export const feelCoyote: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D starts a walk off the ledge; Space jumps inside the grace window and is ignored after it. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Coyote time: a body that just left a ledge still accepts a jump for COYOTE_MS.
## The grace is per body, refreshed on every leave and spent once.

const LEDGE_END := 240.0; const LEDGE_Y := 180.0
const WALK_SPEED := 90.0; const GRAVITY := 900.0
const JUMP_SPEED := -520.0; const COYOTE_MS := 500.0  # 100-200 ms is typical.

var _x := 80.0
var _y := LEDGE_Y
var _vy := 0.0
var _walking := false
var _grounded := true
var _grace_ms := 0.0
var _jumps := 0
var _coyote_jumps := 0
var _ignored := 0

func _ready() -> void:
	for action in [["move_right", KEY_D], ["jump", KEY_SPACE]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("move_right"): _walking = true
	if _walking: _x += WALK_SPEED * delta
	if _grounded and _x > LEDGE_END: _grounded = false; _grace_ms = COYOTE_MS
	if not _grounded:
		_grace_ms = maxf(_grace_ms - delta * 1000.0, 0.0)
		_vy += GRAVITY * delta; _y += _vy * delta
	if Input.is_action_just_pressed("jump"):
		if _grounded or _grace_ms > 0.0:
			# A grace jump still jumps; coyote_jumps proves the window, not luck.
			_coyote_jumps += 1 if not _grounded else 0
			_grounded = false
			_grace_ms = 0.0
			_vy = JUMP_SPEED
			_jumps += 1
		else:
			_ignored += 1
	if _y > 420.0:
		_x = 80.0; _y = LEDGE_Y; _vy = 0.0
		_grounded = true; _walking = false
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(40.0, LEDGE_Y, LEDGE_END - 40.0, 16.0), Color(0.2, 0.22, 0.26))
	draw_rect(Rect2(_x - 12.0, _y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	draw_rect(Rect2(_x - 12.0, _y - 40.0, _grace_ms / COYOTE_MS * 24.0, 3.0), Color(0.4, 0.9, 0.5))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "jumps %d  grace jumps %d  ignored %d  (D then Space)" % [_jumps, _coyote_jumps, _ignored], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": int(_y), "on_floor": _grounded,
		"grace_ms": int(_grace_ms), "jumps": _jumps, "coyote_jumps": _coyote_jumps, "ignored": _ignored,
	}
`,
  tryInput: {
    steps: [
      { key: "D", holdMs: 50 },
      { waitMs: 1750 },
      { key: "Space", holdMs: 60 },
      { waitMs: 100 },
      { screenshot: "grace-jump" },
      { key: "Space", holdMs: 60 },
      { waitMs: 800 },
    ],
    captureEveryMs: 250,
  },
};
