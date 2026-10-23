import type { GodotRecipeReference } from "./reference.ts";

export const stateWorld: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D walks to the lever; E pulls it and unlocks the gate. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## World state drives the drawing. The gate's bars, lamp and collision all read
## _locked, so the picture cannot disagree with the state the lever wrote. No
## separate open animation can leave a locked-looking gate over an open state.

const FLOOR_Y := 300.0
const WALK_SPEED := 180.0
const LEVER_X := 350.0
const GATE_X := 500.0
const REACH := 46.0

var _x := 120.0
var _locked := true
var _lever_pulled := false

func _ready() -> void:
	for action in [["move_right", KEY_D], ["interact", KEY_E]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		_x = minf(_x + WALK_SPEED * delta, 600.0 if not _locked else GATE_X - 40.0)
	if Input.is_action_just_pressed("interact") and absf(_x - LEVER_X) < REACH:
		# The state changes once; the drawing follows it in the same frame.
		_locked = false
		_lever_pulled = true
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(20.0, FLOOR_Y, 600.0, 30.0), Color(0.22, 0.24, 0.28))
	# Lever: a stalk and a handle that visibly tips when pulled.
	draw_rect(Rect2(LEVER_X - 3.0, FLOOR_Y - 46.0, 6.0, 46.0), Color(0.5, 0.52, 0.58))
	draw_circle(Vector2(LEVER_X, FLOOR_Y - 48.0), 9.0, Color(0.95, 0.8, 0.2) if not _locked else Color(0.6, 0.62, 0.68))
	# Gate frame, then bars only while the state says locked.
	draw_rect(Rect2(GATE_X - 8.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4))
	draw_rect(Rect2(GATE_X + 56.0, FLOOR_Y - 150.0, 12.0, 150.0), Color(0.34, 0.36, 0.4))
	if _locked:
		for i in 4:
			draw_rect(Rect2(GATE_X + 6.0 + i * 14.0, FLOOR_Y - 142.0, 8.0, 142.0), Color(0.55, 0.35, 0.25))
	draw_circle(Vector2(GATE_X + 30.0, FLOOR_Y - 160.0), 7.0, Color(0.9, 0.25, 0.2) if _locked else Color(0.3, 0.9, 0.45))
	# Player: drawn last so it is never hidden behind the gate.
	draw_rect(Rect2(_x - 12.0, FLOOR_Y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "gate %s  lever %s  (D: walk, E: pull)" % ["LOCKED" if _locked else "OPEN", "pulled" if _lever_pulled else "idle"], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": FLOOR_Y - 12,
		"locked": _locked, "gate_open": not _locked, "lever_pulled": _lever_pulled,
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { screenshot: "locked" },
      { key: "D", holdMs: 1100 },
      { key: "E", holdMs: 60 },
      { waitMs: 200 },
      { screenshot: "unlocked" },
      { key: "D", holdMs: 1400 },
    ],
    captureEveryMs: 250,
  },
};
