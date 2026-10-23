import type { GodotRecipeReference } from "./reference.ts";

export const loopPuzzle: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. WASD moves one cell; pushing the crate into a wall or another crate is refused; Z undoes the last move exactly. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Puzzle loop: grid movement, a crate that moves one cell when the cell beyond is
## free, a refused blocked move, and undo. Undo restores the whole board, not
## just the player, or a solvable level starts to feel broken.

const CELL := 44
const ORIGIN := Vector2(144.0, 48.0)
const TARGET := Vector2i(4, 3)

var _player := Vector2i(1, 3)
var _boxes: Array = [Vector2i(3, 3)]
var _history: Array = []
var _pushes := 0
var _moves := 0
var _undos := 0
var _blocked := 0

func _ready() -> void:
	for action in [["move_up", KEY_W], ["move_down", KEY_S], ["move_left", KEY_A], ["move_right", KEY_D], ["undo", KEY_Z]]:
		if not InputMap.has_action(action[0]):
			InputMap.add_action(action[0])
			var event := InputEventKey.new()
			event.physical_keycode = action[1]
			InputMap.action_add_event(action[0], event)

func _is_wall(cell: Vector2i) -> bool:
	if cell.x <= 0 or cell.x >= 7 or cell.y <= 0 or cell.y >= 5:
		return true
	return cell in [Vector2i(2, 1), Vector2i(3, 1), Vector2i(4, 1), Vector2i(2, 2)]

func _box_at(cell: Vector2i) -> int:
	for index in _boxes.size():
		if _boxes[index] == cell:
			return index
	return -1

func _try_move(direction: Vector2i) -> void:
	var next := _player + direction
	if _is_wall(next):
		_blocked += 1
		return
	var box := _box_at(next)
	if box >= 0:
		var beyond := next + direction
		if _is_wall(beyond) or _box_at(beyond) >= 0:
			_blocked += 1
			return
		_history.append({"player": _player, "boxes": _boxes.duplicate()})
		_boxes[box] = beyond
		_player = next
		_pushes += 1
		return
	_history.append({"player": _player, "boxes": _boxes.duplicate()})
	_player = next
	_moves += 1

func _undo() -> void:
	if _history.is_empty():
		return
	var state: Dictionary = _history.pop_back()
	_player = state["player"]
	_boxes = state["boxes"]
	_undos += 1

func _physics_process(_delta: float) -> void:
	if Input.is_action_just_pressed("move_up"): _try_move(Vector2i.UP)
	if Input.is_action_just_pressed("move_down"): _try_move(Vector2i.DOWN)
	if Input.is_action_just_pressed("move_left"): _try_move(Vector2i.LEFT)
	if Input.is_action_just_pressed("move_right"): _try_move(Vector2i.RIGHT)
	if Input.is_action_just_pressed("undo"): _undo()
	queue_redraw()

func _cell_rect(cell: Vector2i) -> Rect2:
	return Rect2(ORIGIN + Vector2(cell) * CELL, Vector2(CELL, CELL))

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.11, 0.12, 0.15))
	for y in 6:
		for x in 8:
			var cell := Vector2i(x, y)
			var rect := _cell_rect(cell)
			if _is_wall(cell):
				draw_rect(rect.grow(-1.0), Color(0.32, 0.34, 0.4))
			else:
				draw_rect(rect.grow(-1.0), Color(0.16, 0.17, 0.21))
	draw_arc(_cell_rect(TARGET).get_center(), 13.0, 0.0, TAU, 24, Color(0.35, 0.9, 0.55), 3.0)
	for box in _boxes:
		var cell: Vector2i = box
		draw_rect(_cell_rect(cell).grow(-8.0), Color(0.72, 0.5, 0.28))
		draw_rect(_cell_rect(cell).grow(-8.0), Color(0.9, 0.68, 0.4), false, 2.0)
	draw_circle(_cell_rect(_player).get_center(), 13.0, Color(0.95, 0.78, 0.2))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "pushes %d  moves %d  undos %d  blocked %d  on target %d  (WASD move, Z undo)" % [_pushes, _moves, _undos, _blocked, 1 if _boxes[0] == TARGET else 0], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 336.0), "push the crate onto the ring", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.65, 0.65, 0.7))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_cell_rect(_player).get_center().x), "player_y": int(_cell_rect(_player).get_center().y),
		"player_cell_x": _player.x, "player_cell_y": _player.y,
		"box_x": _boxes[0].x, "box_y": _boxes[0].y,
		"pushes": _pushes, "undos": _undos, "blocked": _blocked,
		"boxes_on_target": 1 if _boxes[0] == TARGET else 0,
	}
`,
  tryInput: {
    // One step establishes the board as the baseline. The second right pushes
    // the crate onto the target, Z restores the exact board, and the final up
    // walks into a wall so the refused move is visible too.
    steps: [
      { waitMs: 300 },
      { key: "D", holdMs: 200 },
      { key: "D", holdMs: 200 },
      { screenshot: "pushed" },
      { key: "Z", holdMs: 200 },
      { screenshot: "undone" },
      { key: "W", holdMs: 200 },
      { waitMs: 100 },
      { screenshot: "blocked" },
    ],
    captureEveryMs: 200,
  },
};
