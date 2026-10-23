import type { GodotRecipeReference } from "./reference.ts";

export const readHud: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Space takes a hit. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## HUD priority: the state the player acts on (health, goal) sits in a fixed
## top-left band above the full-screen damage flash; transient feedback stays in
## a middle band, and the instruction line is measured to fit the bottom band
## instead of running off the viewport.

const MAX_HEALTH := 3
const FEEDBACK_MS := 900.0  # Flash and toast lifetime.
const GOAL := 2
const HINT := "Space: take a hit. Health and the goal stay in the fixed top band; this line stays inside the bottom band, clear of the toast."

var _health := MAX_HEALTH
var _feedback_ms := 0.0
var _hits := 0
var _hint_size := 15
var _hint_box := Vector2.ZERO
var _flash: ColorRect
var _health_label: Label
var _goal_label: Label
var _toast: Label

func _label(text: String, at: Vector2, size: int, color := Color.WHITE) -> Label:
	var label := Label.new()
	label.text = text; label.position = at; label.add_theme_font_size_override("font_size", size); label.add_theme_color_override("font_color", color)
	return label

func _fit_hint() -> void:
	while _hint_size > 9:
		_hint_box = ThemeDB.fallback_font.get_multiline_string_size(HINT, HORIZONTAL_ALIGNMENT_LEFT, 600.0, _hint_size)
		if _hint_box.y <= 40.0: return
		_hint_size -= 1

func _ready() -> void:
	if not InputMap.has_action("hurt"):
		InputMap.add_action("hurt")
		var event := InputEventKey.new(); event.physical_keycode = KEY_SPACE
		InputMap.action_add_event("hurt", event)
	var feedback := CanvasLayer.new(); feedback.layer = 1
	_flash = ColorRect.new()
	_flash.color = Color(0.8, 0.1, 0.1, 0.0); _flash.size = Vector2(640.0, 360.0)
	feedback.add_child(_flash); add_child(feedback)
	var hud := CanvasLayer.new(); hud.layer = 2
	var panel := ColorRect.new()
	panel.color = Color(0.05, 0.06, 0.08, 0.92); panel.position = Vector2(20.0, 20.0); panel.size = Vector2(240.0, 84.0)
	hud.add_child(panel)
	_health_label = _label("", Vector2(34.0, 26.0), 24); _goal_label = _label("", Vector2(34.0, 62.0), 15, Color(0.7, 0.75, 0.8))
	_toast = _label("", Vector2(40.0, 286.0), 18, Color(1.0, 0.55, 0.5))
	hud.add_child(_health_label); hud.add_child(_goal_label); hud.add_child(_toast); add_child(hud)
	_fit_hint()

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("hurt") and _health > 0:
		_health -= 1
		_hits += 1
		_feedback_ms = FEEDBACK_MS
	_feedback_ms = maxf(_feedback_ms - delta * 1000.0, 0.0)
	_flash.color.a = 0.32 * (_feedback_ms / FEEDBACK_MS)
	_health_label.text = "HP %d/%d" % [_health, MAX_HEALTH]
	_goal_label.text = "GOAL %d LEFT" % GOAL
	_toast.text = "OUCH -1" if _feedback_ms > 0.0 else ""; _toast.modulate.a = _feedback_ms / FEEDBACK_MS

func _draw() -> void:
	draw_rect(Rect2(0.0, 300.0, 640.0, 60.0), Color(0.2, 0.22, 0.26)); draw_rect(Rect2(300.0, 244.0, 44.0, 56.0), Color(0.4, 0.42, 0.48))
	draw_multiline_string(ThemeDB.fallback_font, Vector2(20.0, 316.0), HINT, HORIZONTAL_ALIGNMENT_LEFT, 600.0, _hint_size, 2, Color(0.65, 0.65, 0.7))

func snapshot() -> Dictionary:
	return {
		"player_x": 320, "player_y": 272, "health": _health, "goal": GOAL, "hits": _hits,
		"feedback_ms": int(_feedback_ms), "hint_font_size": _hint_size, "hint_height": int(_hint_box.y),
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { key: "Space", holdMs: 60 },
      { waitMs: 250 },
      { screenshot: "feedback" },
      { waitMs: 700 },
      { screenshot: "cleared" },
    ],
    captureEveryMs: 150,
  },
};
