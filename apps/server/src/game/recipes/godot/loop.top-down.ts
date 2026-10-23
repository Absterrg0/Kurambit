import type { GodotRecipeReference } from "./reference.ts";

export const loopTopDown: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. WASD moves, the mouse aims and Space fires; the target loses health per hit and falls after three. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Top-down action loop: eight-way movement, an aim that follows the pointer and
## a shot that has to travel to the target. A hit drains the target's health and
## flashes it, so aiming and firing are judged from what the target does.

const ARENA := Rect2(40.0, 60.0, 560.0, 260.0)
const MOVE_SPEED := 200.0
const SHOT_SPEED := 520.0
const FIRE_COOLDOWN := 0.25  # Seconds between shots; a real weapon runs 0.1-0.5.
const SHOT_LIFE := 1.6
const TARGET_POS := Vector2(320.0, 108.0)
const TARGET_RADIUS := 26.0
const TARGET_HEALTH := 3

var _player := Vector2(320.0, 300.0)
var _aim := Vector2.UP
var _shots: Array = []
var _cooldown := 0.0
var _target_health := TARGET_HEALTH
var _flash := 0.0
var _shots_fired := 0
var _hits := 0
var _score := 0

func _ready() -> void:
	for action in [["move_left", KEY_A], ["move_right", KEY_D], ["move_up", KEY_W], ["move_down", KEY_S], ["fire", KEY_SPACE]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _physics_process(delta: float) -> void:
	var move := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	_player = (_player + move * MOVE_SPEED * delta).clamp(ARENA.position, ARENA.end)
	# There is no camera here, so the pointer is already in arena space.
	var to_pointer := get_global_mouse_position() - _player
	if to_pointer.length() > 5.0:
		_aim = to_pointer.normalized()
	_cooldown = maxf(_cooldown - delta, 0.0)
	_flash = maxf(_flash - delta, 0.0)
	if Input.is_action_just_pressed("fire") and _cooldown == 0.0:
		_shots.append({"pos": _player + _aim * 18.0, "vel": _aim * SHOT_SPEED, "life": SHOT_LIFE})
		_cooldown = FIRE_COOLDOWN
		_shots_fired += 1
	for shot in _shots:
		var pos: Vector2 = shot["pos"] + shot["vel"] * delta
		shot["pos"] = pos
		shot["life"] = shot["life"] - delta
		if _target_health > 0 and pos.distance_to(TARGET_POS) < TARGET_RADIUS:
			shot["life"] = 0.0
			_target_health -= 1
			_hits += 1
			_flash = 0.18
			if _target_health == 0:
				_score += 1
	_shots = _shots.filter(func(shot): return shot["life"] > 0.0)
	queue_redraw()

func _draw() -> void:
	draw_rect(ARENA, Color(0.15, 0.17, 0.2), false, 2.0)
	var damage := float(_target_health) / TARGET_HEALTH
	var target_color := Color(0.95, 0.95, 0.95) if _flash > 0.0 else Color(0.2 + 0.7 * damage, 0.25, 0.3)
	if _target_health > 0:
		draw_circle(TARGET_POS, TARGET_RADIUS, target_color)
		draw_arc(TARGET_POS, TARGET_RADIUS + 5.0, 0.0, TAU * damage, 32, Color(0.95, 0.35, 0.3), 4.0)
	draw_rect(Rect2(_player - Vector2(14.0, 14.0), Vector2(28.0, 28.0)), Color(0.95, 0.78, 0.2))
	draw_line(_player, _player + _aim * 34.0, Color(0.95, 0.78, 0.2), 3.0)
	for shot in _shots:
		draw_circle(shot["pos"], 5.0, Color(1.0, 0.85, 0.4))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "target hp %d  hits %d  shots %d  score %d  (WASD move, Space fire)" % [_target_health, _hits, _shots_fired, _score], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_player.x), "player_y": int(_player.y),
		"aim_x": int(_aim.x * 100.0), "aim_y": int(_aim.y * 100.0),
		"target_hp": _target_health, "target_down": _target_health == 0,
		"hits": _hits, "shots": _shots_fired, "shots_in_flight": _shots.size(), "score": _score,
	}
`,
  tryInput: {
    // A short step establishes the untouched target as the baseline. The pointer
    // moves above the body, then three shots follow the same line to the target.
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 150 },
      { mouseMove: { dx: 0, dy: -40 } },
      { key: "Space", holdMs: 60 },
      { waitMs: 600 },
      { screenshot: "hit" },
      { key: "Space", holdMs: 60 },
      { waitMs: 500 },
      { key: "Space", holdMs: 60 },
      { waitMs: 900 },
      { screenshot: "target-down" },
    ],
    captureEveryMs: 200,
  },
};
