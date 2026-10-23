import type { GodotRecipeReference } from "./reference.ts";

export const readSilhouette: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. D walks the actor into the hazard. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Silhouette readability: the actor and the hazard must separate from each other
## and from a busy mid-value background by shape and value before colour or detail
## is read. The placeholder values below are the mechanism, not a house palette.

const FLOOR_Y := 300.0
const WALK_SPEED := 200.0
const HAZARD_X := 470.0
const ACTOR_VALUE := 0.95  # Light and outlined.
const BACKGROUND_VALUE := 0.48  # Busy mid value: neither light nor dark.
const HAZARD_VALUE := 0.18  # Dark, with a red edge and a spiked contour.

var _x := 140.0
var _contacts := 0
var _in_contact := false

func _ready() -> void:
	if not InputMap.has_action("move_right"):
		InputMap.add_action("move_right")
		var event := InputEventKey.new()
		event.physical_keycode = KEY_D
		InputMap.action_add_event("move_right", event)

func _physics_process(delta: float) -> void:
	if Input.is_action_pressed("move_right"):
		_x = minf(_x + WALK_SPEED * delta, 600.0)
	var was_in_contact := _in_contact
	_in_contact = absf(_x - HAZARD_X) < 26.0
	if _in_contact and not was_in_contact:
		_contacts += 1
	queue_redraw()

func _draw() -> void:
	# A busy field of mid-value squares: the actor must survive this noise.
	for i in 14:
		var shade := BACKGROUND_VALUE + 0.02 * float(i % 5)
		draw_rect(Rect2(40.0 + float((i * 83) % 520), 40.0 + float((i * 47) % 200), 52.0, 52.0), Color(shade, shade, shade + 0.02))
	draw_rect(Rect2(20.0, FLOOR_Y, 600.0, 30.0), Color(0.3, 0.31, 0.34))
	# Actor: light, rounded head and a hard white outline.
	draw_rect(Rect2(_x - 13.0, FLOOR_Y - 26.0, 26.0, 26.0), Color(0.98, 0.84, 0.35))
	draw_rect(Rect2(_x - 13.0, FLOOR_Y - 26.0, 26.0, 3.0), Color.WHITE)
	draw_circle(Vector2(_x, FLOOR_Y - 30.0), 7.0, Color(0.98, 0.84, 0.35))
	# Hazard: dark, spiked and red-edged, a contour the actor's square never has.
	var spikes := PackedVector2Array([
		Vector2(HAZARD_X - 26.0, FLOOR_Y), Vector2(HAZARD_X - 18.0, FLOOR_Y - 30.0),
		Vector2(HAZARD_X - 10.0, FLOOR_Y - 8.0), Vector2(HAZARD_X, FLOOR_Y - 44.0),
		Vector2(HAZARD_X + 10.0, FLOOR_Y - 8.0), Vector2(HAZARD_X + 18.0, FLOOR_Y - 30.0),
		Vector2(HAZARD_X + 26.0, FLOOR_Y),
	])
	draw_colored_polygon(spikes, Color(HAZARD_VALUE, 0.05, 0.07))
	draw_polyline(spikes, Color(0.95, 0.25, 0.2), 2.0)
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "actor %.2f  background %.2f  hazard %.2f  (D: walk)" % [ACTOR_VALUE, BACKGROUND_VALUE, HAZARD_VALUE], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_x), "player_y": FLOOR_Y - 13,
		"in_contact": _in_contact, "contacts": _contacts,
		"actor_value": int(ACTOR_VALUE * 100.0), "background_value": int(BACKGROUND_VALUE * 100.0), "hazard_value": int(HAZARD_VALUE * 100.0),
	}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { screenshot: "identify" },
      { key: "D", holdMs: 1700 },
      { waitMs: 200 },
      { screenshot: "contact" },
    ],
    captureEveryMs: 250,
  },
};
