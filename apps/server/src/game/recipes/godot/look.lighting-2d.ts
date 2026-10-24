import type { GodotRecipeReference } from "./reference.ts";

export const lookLighting2d: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. L toggles the lamp on and off; stop and run again to reset. The demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Lighting: one cool CanvasModulate tints the world, one warm bounded
## PointLight2D lights the focal area, and the HUD lives in a CanvasLayer the tint never reaches.

const AMBIENT := Color(0.52, 0.58, 0.72)  # World tint; white leaves the art flat.
const LAMP_COLOR := Color(1.0, 0.78, 0.45)
const LAMP_ENERGY := 1.2
const LAMP_SCALE := 1.65  # A 256 px light texture at this scale spans ~420 px.
const FLOOR_Y := 286.0
const PLAYER_X := 250.0
const LAMP_AT := Vector2(360.0, 196.0)

var _lamp_on := true
var _toggles := 0
var _lamp_light: PointLight2D
var _lamp_label: Label

func _ready() -> void:
	if not InputMap.has_action("lamp"):
		InputMap.add_action("lamp")
		var event := InputEventKey.new()
		event.physical_keycode = KEY_L
		InputMap.action_add_event("lamp", event)
	var ambient := CanvasModulate.new()
	ambient.color = AMBIENT
	add_child(ambient)
	var glow := GradientTexture2D.new()
	glow.gradient = Gradient.new()
	glow.gradient.set_color(0, Color.WHITE)
	glow.gradient.set_color(1, Color(1.0, 1.0, 1.0, 0.0))
	glow.width = 256; glow.height = 256
	glow.fill = GradientTexture2D.FILL_RADIAL
	glow.fill_from = Vector2(0.5, 0.5); glow.fill_to = Vector2(1.0, 0.5)
	_lamp_light = PointLight2D.new()
	_lamp_light.position = LAMP_AT
	_lamp_light.texture = glow
	_lamp_light.color = LAMP_COLOR
	_lamp_light.energy = LAMP_ENERGY
	_lamp_light.texture_scale = LAMP_SCALE
	add_child(_lamp_light)
	_build_hud()
	_apply_lamp()

func _build_hud() -> void:
	# A CanvasLayer is its own canvas: neither the tint nor the lamp reaches it.
	var hud := CanvasLayer.new()
	hud.layer = 1
	_panel(hud, Vector2(16.0, 16.0), Vector2(198.0, 52.0))
	_panel(hud, Vector2(0.0, 318.0), Vector2(640.0, 42.0))
	_label(hud, "HP 3/3", Vector2(28.0, 20.0), 20)
	_lamp_label = _label(hud, "", Vector2(116.0, 26.0), 14)
	_label(hud, "L: lamp on/off   watch the world dim; HP and this line never do.", Vector2(20.0, 330.0), 14, Color(0.78, 0.82, 0.88))
	add_child(hud)

func _panel(parent: Node, at: Vector2, size: Vector2) -> void:
	var rect := ColorRect.new()
	rect.color = Color(0.04, 0.05, 0.07)
	rect.position = at; rect.size = size
	parent.add_child(rect)

func _label(parent: Node, text: String, at: Vector2, size: int, color := Color.WHITE) -> Label:
	var label := Label.new()
	label.text = text; label.position = at
	label.add_theme_font_size_override("font_size", size); label.add_theme_color_override("font_color", color)
	parent.add_child(label); return label

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("lamp"):
		_toggles += 1
		_lamp_on = not _lamp_on
		_apply_lamp()

func _apply_lamp() -> void:
	_lamp_light.enabled = _lamp_on
	_lamp_label.text = "LAMP ON" if _lamp_on else "LAMP OFF"
	_lamp_label.add_theme_color_override("font_color", LAMP_COLOR if _lamp_on else Color(0.55, 0.58, 0.64))
	queue_redraw()

func _draw() -> void:
	for band in 4:
		var shade := 0.58 + 0.02 * float(band)
		draw_rect(Rect2(0.0, float(band) * 72.0, 640.0, 72.0), Color(shade, shade + 0.04, shade + 0.10))
	for seam in 5:
		draw_rect(Rect2(96.0 * float(seam) + 40.0, 36.0, 4.0, 220.0), Color(0.47, 0.51, 0.58))
	draw_rect(Rect2(0.0, FLOOR_Y, 640.0, 360.0 - FLOOR_Y), Color(0.55, 0.59, 0.65))
	draw_rect(Rect2(0.0, FLOOR_Y, 640.0, 3.0), Color(0.82, 0.86, 0.92))
	for seam in 10:
		draw_rect(Rect2(float(seam) * 64.0, FLOOR_Y + 4.0, 2.0, 360.0 - FLOOR_Y), Color(0.48, 0.52, 0.58))
	_crate(Vector2(88.0, FLOOR_Y))
	_crate(Vector2(486.0, FLOOR_Y))
	draw_rect(Rect2(LAMP_AT.x - 3.0, LAMP_AT.y + 14.0, 6.0, FLOOR_Y - LAMP_AT.y - 14.0), Color(0.32, 0.34, 0.39))
	draw_rect(Rect2(LAMP_AT.x - 18.0, FLOOR_Y - 5.0, 36.0, 5.0), Color(0.32, 0.34, 0.39))
	draw_circle(LAMP_AT, 15.0, Color(1.0, 0.88, 0.62) if _lamp_on else Color(0.44, 0.46, 0.52))
	# Player: a bright body with a dark rim, so the figure reads inside the pool.
	draw_rect(Rect2(PLAYER_X - 14.0, FLOOR_Y - 42.0, 28.0, 42.0), Color(0.13, 0.15, 0.20))
	draw_rect(Rect2(PLAYER_X - 11.0, FLOOR_Y - 39.0, 22.0, 36.0), Color(0.88, 0.90, 0.94))
	draw_circle(Vector2(PLAYER_X, FLOOR_Y - 49.0), 10.0, Color(0.13, 0.15, 0.20))
	draw_circle(Vector2(PLAYER_X, FLOOR_Y - 49.0), 8.0, Color(0.88, 0.90, 0.94))

func _crate(at: Vector2) -> void:
	draw_rect(Rect2(at.x - 22.0, at.y - 36.0, 44.0, 36.0), Color(0.28, 0.22, 0.16))
	draw_rect(Rect2(at.x - 19.0, at.y - 33.0, 38.0, 30.0), Color(0.62, 0.48, 0.32))
	var edge := Color(0.36, 0.28, 0.20)
	draw_line(Vector2(at.x - 19.0, at.y - 33.0), Vector2(at.x + 19.0, at.y - 3.0), edge, 2.0)
	draw_line(Vector2(at.x + 19.0, at.y - 33.0), Vector2(at.x - 19.0, at.y - 3.0), edge, 2.0)

func snapshot() -> Dictionary:
	return {"player_x": int(PLAYER_X), "player_y": int(FLOOR_Y), "lamp_on": _lamp_on, "toggles": _toggles}
`,
  tryInput: {
    steps: [
      { waitMs: 350 },
      { screenshot: "lamp-lit" },
      { key: "L", holdMs: 60 },
      { waitMs: 250 },
      { screenshot: "lamp-off" },
      { key: "L", holdMs: 60 },
      { waitMs: 250 },
      { screenshot: "lamp-on-again" },
      { key: "L", holdMs: 60 },
      { waitMs: 250 },
      { screenshot: "lamp-off-again" },
    ],
    captureEveryMs: 150,
  },
};
