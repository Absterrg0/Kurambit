import type { GodotRecipeReference } from "./reference.ts";

export const loopPlatformer: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D/A run, Space jumps; the gem is collected on the way and any pit respawns the body with the score kept. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Platformer loop: run, a forgiving jump over a gap, a pickup, and a retry that
## keeps the score. The demo's ledges and pits are disposable geometry; the
## mechanism is the forgiving press and the retry.

const FLOOR_Y := 300.0
const START_X := 80.0
const WALK_SPEED := 220.0
const GRAVITY := 1400.0
const JUMP_SPEED := -560.0  # 112 px apex and 0.8 s of air at this gravity.
const COYOTE_MS := 120.0  # A press this soon after a ledge still jumps.
const BUFFER_MS := 120.0  # A press this soon before landing is spent on landing.
const LEDGE_A_END := 330.0
const LEDGE_B_START := 430.0
const LEDGE_B_END := 590.0
const LEDGE_HOLE_START := 500.0
const LEDGE_HOLE_END := 530.0
const GEM_X := 250.0
const GEM_REACH := 20.0

var _x := START_X
var _y := FLOOR_Y
var _vy := 0.0
var _grounded := true
var _coyote_ms := 0.0
var _buffer_ms := 0.0
var _score := 0
var _jumps := 0
var _retries := 0
var _gem_taken := false
var _under_ledge := false

func _ready() -> void:
	for action in [["move_right", KEY_D], ["move_left", KEY_A], ["jump", KEY_SPACE]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _over_floor(at_x: float) -> bool:
	if at_x >= 40.0 and at_x <= LEDGE_A_END:
		return true
	return at_x >= LEDGE_B_START and at_x <= LEDGE_B_END and (at_x <= LEDGE_HOLE_START or at_x >= LEDGE_HOLE_END)

func _physics_process(delta: float) -> void:
	_x = clampf(_x + Input.get_axis("move_left", "move_right") * WALK_SPEED * delta, 20.0, 620.0)
	if not _gem_taken and absf(_x - GEM_X) < GEM_REACH and absf(_y - FLOOR_Y) < 40.0:
		_gem_taken = true  # The gem itself is the one-shot guard.
		_score += 1
	# Age both windows before reading them, so a stale press is never spent.
	_coyote_ms = maxf(_coyote_ms - delta * 1000.0, 0.0)
	_buffer_ms = maxf(_buffer_ms - delta * 1000.0, 0.0)
	if Input.is_action_just_pressed("jump"):
		_buffer_ms = BUFFER_MS
	if _buffer_ms > 0.0 and (_grounded or _coyote_ms > 0.0):
		_buffer_ms = 0.0
		_coyote_ms = 0.0
		_grounded = false
		_vy = JUMP_SPEED
		_jumps += 1
	if _grounded and not _over_floor(_x):
		# Leaving a ledge starts the grace; it must not cancel a jump already held.
		_grounded = false
		_vy = 0.0
		_coyote_ms = COYOTE_MS
	if not _grounded:
		var was_above := _y <= FLOOR_Y
		_vy += GRAVITY * delta
		_y += _vy * delta
		# Landing needs a downward crossing of the floor from above. Walking
		# beneath a ledge and falling past it must never snap the body onto it.
		if _vy > 0.0 and was_above and _y >= FLOOR_Y and _over_floor(_x):
			_y = FLOOR_Y
			_vy = 0.0
			_grounded = true
		# Evidence for that rule: still falling while horizontally over a ledge and
		# below its top, instead of standing on it.
		if _vy > 0.0 and not _grounded and _y > FLOOR_Y + 8.0 and _over_floor(_x):
			_under_ledge = true
	if _y > FLOOR_Y + 60.0:
		# The retry is part of the loop: same spawn, score kept, attempt counted.
		_x = START_X
		_y = FLOOR_Y
		_vy = 0.0
		_grounded = true
		_retries += 1
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(40.0, FLOOR_Y, LEDGE_A_END - 40.0, 20.0), Color(0.22, 0.24, 0.3))
	draw_rect(Rect2(LEDGE_B_START, FLOOR_Y, LEDGE_HOLE_START - LEDGE_B_START, 20.0), Color(0.22, 0.24, 0.3))
	draw_rect(Rect2(LEDGE_HOLE_END, FLOOR_Y, LEDGE_B_END - LEDGE_HOLE_END, 20.0), Color(0.22, 0.24, 0.3))
	if not _gem_taken:
		draw_colored_polygon(PackedVector2Array([
			Vector2(GEM_X, FLOOR_Y - 44.0), Vector2(GEM_X + 14.0, FLOOR_Y - 28.0),
			Vector2(GEM_X, FLOOR_Y - 12.0), Vector2(GEM_X - 14.0, FLOOR_Y - 28.0),
		]), Color(0.3, 0.9, 0.95))
	draw_rect(Rect2(_x - 12.0, _y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "score %d  jumps %d  retries %d  (D/A run, Space jump)" % [_score, _jumps, _retries], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": int(_y), "on_floor": _grounded,
		"score": _score, "gem_present": not _gem_taken, "jumps": _jumps, "retries": _retries,
		"under_ledge": _under_ledge,
	}
`,
  tryInput: {
    // Small step first so the baseline is still "no pickup, no jump". The jump
    // clears the 100 px gap; the walk off the far ledge drops through its hole
    // while still holding right, so the retry must follow a fall, not a snap.
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 150 },
      { key: "D", holdMs: 800 },
      { screenshot: "pickup" },
      { keys: ["D", "Space"], holdMs: 800 },
      { screenshot: "gap-crossed" },
      { key: "D", holdMs: 550 },
      { waitMs: 300 },
      { screenshot: "under-ledge" },
      { key: "D", holdMs: 400 },
      { screenshot: "retried" },
    ],
    captureEveryMs: 250,
  },
};
