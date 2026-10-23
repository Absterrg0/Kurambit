import type { GodotRecipeReference } from "./reference.ts";

export const loopTower: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Click a pad to buy a tower for 40 gold; it fires at the creep nearest the exit, and the wave rolls over when the lane is clear. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Tower-defense loop: buy a tower on a pad, let it target the creep closest to
## the exit and fire, then start the next wave when the lane is empty. The loop
## is only readable when the purchase, the spend and the shot are all visible.

const LANE_Y := 110.0
const PADS := [Vector2(200.0, 220.0), Vector2(320.0, 220.0), Vector2(440.0, 220.0)]
const TOWER_COST := 40
const TOWER_RANGE := 220.0  # Distance from the pad to the creep it can reach.
const FIRE_INTERVAL := 0.45  # Seconds between shots; a real tower fires 0.3-1.0.
const SHOT_SPEED := 360.0
const SHOT_LIFE := 1.0
const CREEP_HEALTH := 3
const CREEP_SPEED := 90.0
const SPAWN_GAP := 1.0
const WAVE_BREAK := 0.9
const KILL_GOLD := 5
const START_GOLD := 60

var _creeps: Array = []
var _towers: Array = []
var _shots: Array = []
var _gold := START_GOLD
var _spent := 0
var _kills := 0
var _wave := 1
var _to_spawn := 0
var _spawn_timer := 0.0
var _break_timer := 0.0
var _shots_fired := 0
var _pointer := Vector2(320.0, 180.0)

func _ready() -> void:
	_start_wave()

func _start_wave() -> void:
	_to_spawn = 1 + _wave
	_spawn_timer = 0.6

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_pointer = event.position
		for pad in PADS.size():
			if PADS[pad].distance_to(event.position) > 30.0 or _tower_at(pad) != null:
				continue
			if _gold >= TOWER_COST:
				_gold -= TOWER_COST
				_spent += TOWER_COST
				_towers.append({"pad": pad, "pos": PADS[pad], "cooldown": 0.0, "aim": Vector2.UP})
			return

func _tower_at(pad: int) -> Variant:
	for tower in _towers:
		if tower["pad"] == pad:
			return tower
	return null

func _leading(from: Vector2) -> Variant:
	# Standard targeting: the creep closest to the exit reaches the player first,
	# so it is the one worth shooting.
	var best: Variant = null
	for creep in _creeps:
		var pos := Vector2(creep["x"], LANE_Y)
		if creep["hp"] <= 0 or from.distance_to(pos) > TOWER_RANGE:
			continue
		if best == null or creep["x"] > best["x"]:
			best = creep
	return best

func _creep_at(pos: Vector2) -> Variant:
	for creep in _creeps:
		if creep["hp"] > 0 and absf(creep["x"] - pos.x) < 12.0 and absf(LANE_Y - pos.y) < 14.0:
			return creep
	return null

func _lead(from: Vector2, target_x: float) -> Vector2:
	# Aim where the creep will be when the shot arrives, not where it is now;
	# a shot aimed at the current position trails a moving target forever.
	var point := Vector2(target_x, LANE_Y)
	for _iteration in 2:
		point = Vector2(target_x + CREEP_SPEED * from.distance_to(point) / SHOT_SPEED, LANE_Y)
	return point

func _physics_process(delta: float) -> void:
	if _break_timer > 0.0:
		_break_timer -= delta
		if _break_timer <= 0.0:
			_wave += 1
			_start_wave()
	elif _to_spawn > 0:
		_spawn_timer -= delta
		if _spawn_timer <= 0.0:
			_creeps.append({"x": -20.0, "hp": CREEP_HEALTH})
			_to_spawn -= 1
			_spawn_timer = SPAWN_GAP
	for creep in _creeps:
		creep["x"] = creep["x"] + CREEP_SPEED * delta
	_creeps = _creeps.filter(func(creep): return creep["hp"] > 0 and creep["x"] < 660.0)
	for tower in _towers:
		tower["cooldown"] = maxf(tower["cooldown"] - delta, 0.0)
		var target: Variant = _leading(tower["pos"])
		if target == null:
			continue
		tower["aim"] = (_lead(tower["pos"], target["x"]) - tower["pos"]).normalized()
		if tower["cooldown"] == 0.0:
			tower["cooldown"] = FIRE_INTERVAL
			_shots.append({"pos": tower["pos"], "vel": tower["aim"] * SHOT_SPEED, "life": SHOT_LIFE})
			_shots_fired += 1
	for shot in _shots:
		var pos: Vector2 = shot["pos"] + shot["vel"] * delta
		shot["pos"] = pos
		shot["life"] = shot["life"] - delta
		var hit: Variant = _creep_at(pos)
		if hit != null:
			hit["hp"] = hit["hp"] - 1
			shot["life"] = 0.0
			if hit["hp"] == 0:
				_kills += 1
				_gold += KILL_GOLD
	_shots = _shots.filter(func(shot): return shot["life"] > 0.0)
	if _to_spawn == 0 and _creeps.is_empty() and _break_timer == 0.0:
		_break_timer = WAVE_BREAK
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.12, 0.13, 0.16))
	draw_rect(Rect2(0.0, LANE_Y - 20.0, 640.0, 40.0), Color(0.2, 0.22, 0.27))
	draw_rect(Rect2(0.0, LANE_Y - 20.0, 640.0, 2.0), Color(0.35, 0.37, 0.42))
	draw_rect(Rect2(0.0, LANE_Y + 18.0, 640.0, 2.0), Color(0.35, 0.37, 0.42))
	for pad in PADS.size():
		draw_circle(PADS[pad], 26.0, Color(0.22, 0.24, 0.3))
		draw_arc(PADS[pad], 26.0, 0.0, TAU, 24, Color(0.5, 0.53, 0.6), 2.0)
	for tower in _towers:
		draw_rect(Rect2(tower["pos"] - Vector2(14.0, 14.0), Vector2(28.0, 28.0)), Color(0.3, 0.55, 0.85))
		draw_line(tower["pos"], tower["pos"] + tower["aim"] * 24.0, Color(0.85, 0.9, 1.0), 4.0)
	for creep in _creeps:
		if creep["hp"] <= 0:
			continue
		draw_circle(Vector2(creep["x"], LANE_Y), 12.0, Color(0.85, 0.35, 0.3))
		draw_rect(Rect2(creep["x"] - 12.0, LANE_Y - 24.0, 24.0 * creep["hp"] / CREEP_HEALTH, 3.0), Color(0.4, 0.95, 0.5))
	for shot in _shots:
		draw_circle(shot["pos"], 4.0, Color(1.0, 0.9, 0.5))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "gold %d  wave %d  kills %d  towers %d  (click a pad)" % [_gold, _wave, _kills, _towers.size()], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_pointer.x), "player_y": int(_pointer.y),
		"gold": _gold, "spent": _spent, "wave": _wave, "kills": _kills,
		"towers": _towers.size(), "shots_fired": _shots_fired, "shots_in_flight": _shots.size(),
	}
`,
  tryInput: {
    // The pad click is the purchase; the first long wait covers both kills and
    // the wave break, so the last frame shows the second wave starting.
    steps: [
      { waitMs: 300 },
      { click: "left", x: 320, y: 220 },
      { waitMs: 700 },
      { screenshot: "tower-built" },
      { waitMs: 1500 },
      { screenshot: "attacking" },
      { waitMs: 3700 },
      { screenshot: "wave-2" },
      { waitMs: 300 },
    ],
    captureEveryMs: 250,
  },
};
