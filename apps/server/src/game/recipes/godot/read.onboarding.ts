import type { GodotRecipeReference } from "./reference.ts";

export const readOnboarding: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D walks to the gate; E opens it. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Contextual onboarding: the prompt is visible only while the body is in reach
## and the gate is still closed, and the same action that opens the gate clears
## it. The prompt never asks for an action that is already done.

const FLOOR_Y := 300.0
const WALK_SPEED := 200.0
const GATE_X := 500.0
const REACH := 70.0

var _x := 120.0
var _in_range := false
var _opened := false
var _prompt_shown := 0
var _prompt: Label

func _ready() -> void:
	for action in [["move_right", KEY_D], ["interact", KEY_E]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)
	_prompt = Label.new()
	_prompt.text = "E  Open the gate"
	_prompt.position = Vector2(GATE_X - 90.0, FLOOR_Y - 190.0)
	_prompt.add_theme_font_size_override("font_size", 16)
	_prompt.visible = false
	add_child(_prompt)

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		_x = minf(_x + WALK_SPEED * delta, 600.0 if _opened else GATE_X - 38.0)
	_in_range = _x > GATE_X - REACH
	if Input.is_action_just_pressed("interact") and _in_range and not _opened:
		# The action both changes the gate and removes the prompt's condition.
		_opened = true
	if _in_range and not _opened and not _prompt.visible:
		_prompt_shown += 1
	_prompt.visible = _in_range and not _opened
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(20.0, FLOOR_Y, 600.0, 30.0), Color(0.22, 0.24, 0.28))
	draw_rect(Rect2(GATE_X - 8.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4))
	draw_rect(Rect2(GATE_X + 56.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4))
	if not _opened:
		for i in 4:
			draw_rect(Rect2(GATE_X + 6.0 + i * 14.0, FLOOR_Y - 142.0, 8.0, 142.0), Color(0.55, 0.35, 0.25))
	draw_circle(Vector2(GATE_X + 30.0, FLOOR_Y - 160.0), 7.0, Color(0.9, 0.25, 0.2) if not _opened else Color(0.3, 0.9, 0.45))
	draw_rect(Rect2(_x - 12.0, FLOOR_Y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "prompt %s  opened %s  (D: walk, E: open)" % ["shown" if _prompt.visible else "hidden", "yes" if _opened else "no"], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": FLOOR_Y - 12,
		"in_range": _in_range, "prompt": _prompt.visible,
		"opened": _opened, "prompts_shown": _prompt_shown,
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 1700 },
      { waitMs: 200 },
      { screenshot: "prompt" },
      { key: "E", holdMs: 60 },
      { waitMs: 300 },
      { screenshot: "cleared" },
      { key: "D", holdMs: 700 },
    ],
    captureEveryMs: 250,
  },
};
