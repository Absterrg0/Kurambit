import type { GodotRecipeReference } from "./reference.ts";

export const spriteAnimation: GodotRecipeReference = {
  setup:
    "Import the pinned character sheet first: game_art_import id kenney-pixel-platformer, then game_godot_import. It writes res://assets/art/kits/kenney-pixel-platformer/tilemap-characters_packed.png (216x72, 9x3 cells of 24 px). Create an empty Node2D scene, attach this script to the root and run: A/D runs, Space jumps, and stop/run again resets. The demo builds a CharacterBody2D with a 16x30 collision shape and an AnimatedSprite2D visual child. Its SpriteFrames regions are this recipe's authored suggestion, not upstream animation names: idle holds cell (0,0), run alternates (0,0) and (1,0) at 6 fps, and air holds (1,0). Only the visual child flips or carries the offset; the body and its shape do not.\n\nOptional kit guide: for your own sheet, change SHEET and the regions in _cell(); keep idle, run and air regions at a whole-number scale with nearest filtering. The mechanism does not depend on this kit.",
  referenceCode: String.raw`extends Node2D
## Sprite animation: actual input and the body's grounded state choose the pose;
## the visual child carries the flip and offset, so the collision body never does.

const SHEET := preload("res://assets/art/kits/kenney-pixel-platformer/tilemap-characters_packed.png")
const CELL := 24
const PIXEL_SCALE := 3
const WALK_SPEED := 160.0
const JUMP_SPEED := -480.0
const GRAVITY := 1500.0
const FLOOR_Y := 288.0
const START_X := 140.0
const BODY_SIZE := Vector2(16.0, 30.0)

var _body: CharacterBody2D
var _visual: AnimatedSprite2D
var _fall_speed := 0.0
var _grounded := true
var _facing := 1
var _animation := "idle"

func _ready() -> void:
	_body = CharacterBody2D.new()
	_body.position = Vector2(START_X, FLOOR_Y)
	add_child(_body)
	var collision := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = BODY_SIZE
	collision.shape = shape
	collision.position = Vector2(0.0, -BODY_SIZE.y * 0.5)
	_body.add_child(collision)
	_visual = AnimatedSprite2D.new()
	_visual.sprite_frames = _frames()
	_visual.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_visual.scale = Vector2(PIXEL_SCALE, PIXEL_SCALE)
	_visual.position = Vector2(0.0, -CELL * PIXEL_SCALE * 0.5)
	_body.add_child(_visual)
	_visual.play(_animation)
	for binding in [["move_left", KEY_A], ["move_right", KEY_D], ["jump", KEY_SPACE]]:
		if InputMap.has_action(binding[0]): continue
		InputMap.add_action(binding[0])
		var key := InputEventKey.new()
		key.physical_keycode = binding[1]
		InputMap.action_add_event(binding[0], key)

## The kit authors one two-frame green explorer pair and no named idle/run/air
## clips. This suggestion holds col 0 for idle, alternates 0-1 for run at 6 fps,
## and holds col 1 in the air. Point _cell() at your own sheet's regions instead.
func _frames() -> SpriteFrames:
	var frames := SpriteFrames.new()
	frames.clear_all()
	for state in ["idle", "run", "air"]:
		frames.add_animation(state)
	frames.set_animation_speed("run", 6.0)
	frames.add_frame("idle", _cell(0))
	frames.add_frame("run", _cell(0))
	frames.add_frame("run", _cell(1))
	frames.add_frame("air", _cell(1))
	return frames

func _cell(column: int) -> AtlasTexture:
	var frame := AtlasTexture.new()
	frame.atlas = SHEET
	frame.region = Rect2(column * CELL, 0, CELL, CELL)
	return frame

func _physics_process(delta: float) -> void:
	var move := Input.get_axis("move_left", "move_right")
	if not is_zero_approx(move):
		_body.position.x = clampf(_body.position.x + move * WALK_SPEED * delta, 40.0, 600.0)
		var facing := 1 if move > 0.0 else -1
		if facing != _facing:
			_facing = facing
			_visual.flip_h = _facing < 0
	if _grounded and Input.is_action_just_pressed("jump"):
		_grounded = false
		_fall_speed = JUMP_SPEED
	if not _grounded:
		_fall_speed += GRAVITY * delta
		_body.position.y += _fall_speed * delta
		if _body.position.y >= FLOOR_Y:
			_body.position.y = FLOOR_Y
			_fall_speed = 0.0
			_grounded = true
	var next := "air" if not _grounded else ("run" if not is_zero_approx(move) else "idle")
	if next != _animation:
		_animation = next
		_visual.play(_animation)
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.42, 0.68, 0.86))
	draw_rect(Rect2(0.0, FLOOR_Y, 640.0, 360.0 - FLOOR_Y), Color(0.22, 0.46, 0.28))
	draw_rect(Rect2(0.0, FLOOR_Y, 640.0, 4.0), Color(0.38, 0.68, 0.36))
	var facing_text := "right" if _facing > 0 else "left"
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 28.0), "A/D run   Space jump   pose %s   facing %s" % [_animation, facing_text], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.95, 0.97, 1.0))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 340.0), "The body is a 16x30 collision shape; only the visual child flips.", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.82, 0.9, 0.86))

func snapshot() -> Dictionary:
	return {
		"player_x": roundi(_body.position.x), "player_y": roundi(_body.position.y),
		"anim": _animation, "frame": _visual.frame, "facing": _facing,
		"visual_flip": _visual.flip_h, "grounded": _grounded,
		"body_width": int(BODY_SIZE.x), "body_height": int(BODY_SIZE.y),
		"body_scale_x": _body.scale.x, "visual_scale_x": _visual.scale.x,
		"visual_offset_y": roundi(_visual.position.y),
	}
`,
  tryInput: {
    // D moves and the periodic captures show the run pair; the release keeps
    // the right facing. A tap reverses it, Space shows the air pose, and the
    // last wait lands the same body with the left facing still held.
    steps: [
      { waitMs: 300 },
      { screenshot: "idle" },
      { key: "D", holdMs: 500 },
      { screenshot: "released" },
      { key: "A", holdMs: 140 },
      { waitMs: 200 },
      { screenshot: "facing-left" },
      { key: "Space", holdMs: 120 },
      { waitMs: 120 },
      { screenshot: "air" },
      { waitMs: 700 },
      { screenshot: "landed" },
    ],
    captureEveryMs: 120,
  },
};
