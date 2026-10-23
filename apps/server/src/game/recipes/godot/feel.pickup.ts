import type { GodotRecipeReference } from "./reference.ts";

export const feelPickup: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D walks right into the gem. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Pickup feedback: the gem is collectable once. On contact the gem disappears, a
## "+1" popup rises and fades, and the effect count returns to zero when it ends.
## Boot has no feedback, so an emitted effect is visibly new.

const GEM_X := 380.0
const FLOOR_Y := 300.0
const WALK_SPEED := 180.0
const POPUP_MS := 700.0  # How long the confirmation lives. Try 300-900.
const PICKUP_RADIUS := 24.0

var _x := 180.0
var _collected := false
var _score := 0
var _popup_ms := 0.0
var _popup: Label

func _ready() -> void:
	if not InputMap.has_action("move_right"):
		InputMap.add_action("move_right")
		var event := InputEventKey.new()
		event.physical_keycode = KEY_D
		InputMap.action_add_event("move_right", event)
	_popup = Label.new()
	_popup.text = "+1"
	_popup.position = Vector2(GEM_X - 8.0, FLOOR_Y - 74.0)
	_popup.add_theme_font_size_override("font_size", 26)
	_popup.add_theme_color_override("font_color", Color(0.5, 1.0, 0.85))
	_popup.visible = false
	add_child(_popup)

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		_x = minf(_x + WALK_SPEED * delta, 560.0)
	if not _collected and absf(_x - GEM_X) < PICKUP_RADIUS:
		# The one-shot guard is the gem, not a repeated area signal.
		_collected = true
		_score += 1
		_popup_ms = POPUP_MS
		_popup.visible = true
	if _popup_ms > 0.0:
		_popup_ms = maxf(_popup_ms - delta * 1000.0, 0.0)
		_popup.position.y -= 30.0 * delta
		_popup.modulate.a = minf(1.0, _popup_ms / 250.0)  # Hold readable, then fade.
		if _popup_ms == 0.0:
			_popup.visible = false
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(40.0, FLOOR_Y, 560.0, 20.0), Color(0.2, 0.22, 0.26))
	draw_rect(Rect2(_x - 12.0, FLOOR_Y - 24.0, 24.0, 24.0), Color(0.95, 0.78, 0.2))
	if not _collected:
		draw_colored_polygon(PackedVector2Array([
			Vector2(GEM_X, FLOOR_Y - 46.0), Vector2(GEM_X + 14.0, FLOOR_Y - 30.0),
			Vector2(GEM_X, FLOOR_Y - 14.0), Vector2(GEM_X - 14.0, FLOOR_Y - 30.0),
		]), Color(0.3, 0.85, 0.95))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "collected %d  score %d  effects %d  (D: walk)" % [1 if _collected else 0, _score, 1 if _popup_ms > 0.0 else 0], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": FLOOR_Y - 12,
		"collected": 1 if _collected else 0, "score": _score,
		"gem_present": not _collected, "effects": 1 if _popup_ms > 0.0 else 0,
		"popup_ms": int(_popup_ms),
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 1400 },
      { screenshot: "popup" },
      { waitMs: 800 },
      { screenshot: "cleared" },
    ],
    captureEveryMs: 200,
  },
};
