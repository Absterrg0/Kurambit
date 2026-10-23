import type { GodotRecipeReference } from "./reference.ts";

export const readOnboarding: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D walks to the gate; hover or focus the prompt, then press and release E (or click the prompt) to open it. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Contextual onboarding: the prompt is visible only while the body is in reach
## and the gate is closed. It is a control: hover, keyboard focus and pressed
## each have their own treatment, and the action that opens the gate clears it.

const FLOOR_Y := 300.0
const WALK_SPEED := 200.0
const GATE_X := 500.0
const REACH := 70.0
const PROMPT_RECT := Rect2(400.0, 86.0, 200.0, 36.0)

var _x := 120.0
var _in_range := false
var _opened := false
var _state := "hidden"
var _prompt_shown := 0
var _prompt: Label

func _ready() -> void:
	for action in [["move_right", KEY_D], ["interact", KEY_E]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)
	_prompt = Label.new(); _prompt.text = "E  Open the gate"
	_prompt.position = Vector2(412.0, 96.0); _prompt.add_theme_font_size_override("font_size", 16)
	_prompt.visible = false; add_child(_prompt)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT and _in_range and not _opened and PROMPT_RECT.has_point(get_local_mouse_position()): _opened = true

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		_x = minf(_x + WALK_SPEED * delta, 600.0 if _opened else GATE_X - 38.0)
	_in_range = _x > GATE_X - REACH
	var hover := PROMPT_RECT.has_point(get_local_mouse_position())
	if Input.is_action_just_released("interact") and _in_range and not _opened:
		# The action both changes the gate and removes the prompt's condition.
		_opened = true
	_state = "hidden"
	if _in_range and not _opened: _state = "pressed" if Input.is_action_pressed("interact") else ("hover" if hover else "focus")
	if _state != "hidden" and not _prompt.visible:
		_prompt_shown += 1
	_prompt.visible = _state != "hidden"
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(20.0, FLOOR_Y, 600.0, 30.0), Color(0.22, 0.24, 0.28))
	draw_rect(Rect2(GATE_X - 8.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4)); draw_rect(Rect2(GATE_X + 56.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4))
	if not _opened:
		for i in 4:
			draw_rect(Rect2(GATE_X + 6.0 + i * 14.0, FLOOR_Y - 142.0, 8.0, 142.0), Color(0.55, 0.35, 0.25))
	draw_circle(Vector2(GATE_X + 30.0, FLOOR_Y - 160.0), 7.0, Color(0.9, 0.25, 0.2) if not _opened else Color(0.3, 0.9, 0.45))
	draw_rect(Rect2(_x - 12.0, FLOOR_Y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	# Prompt control states: hover lightens the fill, focus draws a cyan ring,
	# and a press fills it amber. Hidden, nothing is drawn.
	if _state != "hidden":
		var fill := Color(0.14, 0.16, 0.2) if _state != "hover" else Color(0.24, 0.28, 0.36)
		var edge := Color(0.95, 0.95, 0.95) if _state == "hover" else Color(0.3, 0.8, 1.0)
		if _state == "pressed": fill = Color(0.95, 0.8, 0.25); edge = Color(0.2, 0.2, 0.2)
		draw_rect(PROMPT_RECT, fill); draw_rect(PROMPT_RECT, edge, false, 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "prompt %s  (D: walk, E: press)" % _state, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": FLOOR_Y - 12,
		"in_range": _in_range, "prompt": _prompt.visible, "prompt_state": _state,
		"opened": _opened, "prompts_shown": _prompt_shown,
	}
`,
  tryInput: {
    // Walk into reach (focus), move the pointer onto the prompt (hover), then hold
    // E so the pressed state is captured; release opens the gate and clears it.
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 1700 },
      { waitMs: 200 },
      { screenshot: "focus" },
      { mouseMove: { dx: 180, dy: -68 } },
      { waitMs: 200 },
      { screenshot: "hover" },
      { key: "E", holdMs: 300 },
      { waitMs: 300 },
      { screenshot: "cleared" },
      { key: "D", holdMs: 700 },
    ],
    captureEveryMs: 250,
  },
};
