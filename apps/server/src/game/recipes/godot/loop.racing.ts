import type { GodotRecipeReference } from "./reference.ts";

export const loopRacing: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. W drives, A/D steer; the highlighted gate is the only one that advances. The first finish crossing has no checkpoints and is refused; the next full lap counts. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Racing loop: the car steers around a ring and the checkpoints must be taken in
## order. Only the expected gate advances; a finish crossed with a gate missing
## is out of order and leaves the lap count alone. That is what makes a lap a lap
## instead of a shortcut.

const CENTER := Vector2(320.0, 180.0)
const RADIUS := 128.0
const TRACK_WIDTH := 64.0
const CRUISE_SPEED := 160.0  # px/s while W is held; this demo has no ramp.
const TURN_RATE := 1.25  # rad/s; radius = speed / turn rate = 128 px.
const GATE_ANGLES := [3.0 * PI / 2.0, 0.0, PI / 2.0, PI]  # top, right, bottom, finish
const START_ANGLE := PI - 0.15  # Just before the finish line, heading clockwise.

var _pos := CENTER + Vector2(cos(START_ANGLE), sin(START_ANGLE)) * RADIUS
var _heading := START_ANGLE + PI / 2.0
var _angle := START_ANGLE
var _prev_angle := START_ANGLE
var _speed := 0.0
var _laps := 0
var _next := 0
var _checkpoints := 0
var _out_of_order := 0

func _ready() -> void:
	for action in [["drive", KEY_W], ["turn_left", KEY_A], ["turn_right", KEY_D]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _crossed(gate: float, step: float) -> bool:
	var offset := wrapf(gate - _prev_angle, -PI, PI)
	if absf(step) < 0.00001 or signf(offset) != signf(step):
		return false
	return absf(offset) <= absf(step)

func _gate(index: int) -> void:
	if index == 3:
		if _next == 3:
			_laps += 1
			_next = 0
		else:
			_out_of_order += 1  # A finish without its checkpoints is not a lap.
	elif index == _next:
		_next += 1
		_checkpoints += 1
	else:
		_out_of_order += 1

func _physics_process(delta: float) -> void:
	_speed = CRUISE_SPEED if Input.is_action_pressed("drive") else 0.0
	if _speed > 0.0:
		_heading = wrapf(_heading + Input.get_axis("turn_left", "turn_right") * TURN_RATE * delta, -PI, PI)
		_pos += Vector2(cos(_heading), sin(_heading)) * _speed * delta
	_angle = atan2(_pos.y - CENTER.y, _pos.x - CENTER.x)
	var step := wrapf(_angle - _prev_angle, -PI, PI)
	# A gate only counts on the track: cutting the infield must not collect it.
	if absf(_pos.distance_to(CENTER) - RADIUS) <= TRACK_WIDTH * 0.5:
		for index in GATE_ANGLES.size():
			if _crossed(GATE_ANGLES[index], step):
				_gate(index)
	_prev_angle = _angle
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.1, 0.13, 0.1))
	draw_arc(CENTER, RADIUS, 0.0, TAU, 96, Color(0.2, 0.21, 0.25), TRACK_WIDTH)
	draw_arc(CENTER, RADIUS, 0.0, TAU, 96, Color(0.33, 0.35, 0.4), 2.0)
	for index in GATE_ANGLES.size():
		var angle: float = GATE_ANGLES[index]
		var direction := Vector2(cos(angle), sin(angle))
		var inner := CENTER + direction * (RADIUS - TRACK_WIDTH * 0.5)
		var outer := CENTER + direction * (RADIUS + TRACK_WIDTH * 0.5)
		var color := Color(0.35, 0.95, 0.5) if index == _next else Color(0.6, 0.62, 0.68)
		if index == 3:
			color = Color(0.95, 0.9, 0.5)
		draw_line(inner, outer, color, 5.0)
		var label := "FINISH" if index == 3 else str(index + 1)
		draw_string(ThemeDB.fallback_font, outer + direction * 10.0 - Vector2(14.0, 0.0), label, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 13, color)
	var forward := Vector2(cos(_heading), sin(_heading))
	var side := Vector2(-forward.y, forward.x)
	draw_colored_polygon(PackedVector2Array([
		_pos + forward * 12.0, _pos - forward * 7.0 + side * 7.0, _pos - forward * 7.0 - side * 7.0,
	]), Color(0.95, 0.78, 0.2))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "laps %d  next gate %d  checkpoints %d  out of order %d  (W drive, A/D steer)" % [_laps, _next + 1, _checkpoints, _out_of_order], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_pos.x), "player_y": int(_pos.y), "laps": _laps,
		"next_checkpoint": _next, "checkpoints": _checkpoints,
		"out_of_order": _out_of_order, "speed": int(_speed),
	}
`,
  tryInput: {
    // The first press drives across the finish with no checkpoints taken: out of
    // order, no lap. The same drive then takes top, right and bottom before the
    // finish, so the second crossing is the lap.
    steps: [
      { keys: ["W", "D"], holdMs: 500 },
      { screenshot: "finish-refused" },
      { keys: ["W", "D"], holdMs: 4900 },
      { waitMs: 300 },
      { screenshot: "lap" },
    ],
    captureEveryMs: 250,
  },
};
