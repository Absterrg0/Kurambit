import type { GodotRecipeReference } from "./reference.ts";

export const loopCard: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Drag a card from the hand onto the enemy to play it; the end-turn button refills energy and the empty slot. Meteor costs more than the turn can pay, so dragging it is refused. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Card loop: drag a card from the hand onto the enemy, pay its energy once, and
## end the turn to refill energy and redraw. A card the turn cannot afford is
## refused on release before anything changes, so the board and the counter
## can never disagree about what was played.

const MAX_ENERGY := 3
const HAND_Y := 220.0
const CARD_SIZE := Vector2(110.0, 120.0)
const ENEMY_POS := Vector2(470.0, 120.0)
const ENEMY_RADIUS := 46.0
const ENEMY_HEALTH := 10

var _hand: Array = []
var _deck: Array = []
var _energy := MAX_ENERGY
var _turn := 0
var _enemy_health := ENEMY_HEALTH
var _played := 0
var _rejected := 0
var _drag := -1
var _pointer := Vector2(320.0, 180.0)

func _ready() -> void:
	_deck = [
		{"name": "Strike", "cost": 1, "damage": 3},
		{"name": "Bolt", "cost": 2, "damage": 4},
		{"name": "Meteor", "cost": 4, "damage": 9},
		{"name": "Jab", "cost": 1, "damage": 2},
	]
	_hand = [_deck.pop_front(), _deck.pop_front(), _deck.pop_front()]

func _card_rect(slot: int) -> Rect2:
	return Rect2(Vector2(24.0 + slot * 126.0, HAND_Y), CARD_SIZE)

func _enemy_rect() -> Rect2:
	return Rect2(ENEMY_POS - Vector2.ONE * ENEMY_RADIUS, Vector2.ONE * ENEMY_RADIUS * 2.0)

func _end_turn_rect() -> Rect2:
	return Rect2(Vector2(500.0, 300.0), Vector2(120.0, 36.0))

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		_pointer = event.position
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		_pointer = event.position
		if event.pressed:
			if _end_turn_rect().has_point(event.position):
				_end_turn()
				return
			_drag = -1
			for slot in _hand.size():
				if _hand[slot] != null and _card_rect(slot).has_point(event.position):
					_drag = slot
		else:
			if _drag >= 0 and _enemy_rect().has_point(event.position):
				_play(_drag)
			_drag = -1
	queue_redraw()

func _play(slot: int) -> void:
	var card: Dictionary = _hand[slot]
	if card["cost"] > _energy:
		# Refuse before touching energy, health or the hand: an illegal play is a no-op.
		_rejected += 1
		return
	_energy -= card["cost"]
	_enemy_health = maxi(_enemy_health - card["damage"], 0)
	_hand[slot] = null
	_played += 1

func _end_turn() -> void:
	_turn += 1
	_energy = MAX_ENERGY
	for slot in _hand.size():
		if _hand[slot] == null and not _deck.is_empty():
			_hand[slot] = _deck.pop_front()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.12, 0.13, 0.16))
	draw_rect(Rect2(0.0, 196.0, 640.0, 164.0), Color(0.09, 0.1, 0.12))
	draw_circle(ENEMY_POS, ENEMY_RADIUS, Color(0.6, 0.22, 0.26))
	var bar := 120.0 * _enemy_health / ENEMY_HEALTH
	draw_rect(Rect2(ENEMY_POS.x - 60.0, ENEMY_POS.y - 62.0, 120.0, 8.0), Color(0.2, 0.2, 0.24))
	draw_rect(Rect2(ENEMY_POS.x - 60.0, ENEMY_POS.y - 62.0, bar, 8.0), Color(0.95, 0.4, 0.35))
	draw_string(ThemeDB.fallback_font, ENEMY_POS + Vector2(-38.0, 40.0), "ENEMY %d" % _enemy_health, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color.WHITE)
	for slot in _hand.size():
		var rect := _card_rect(slot)
		var card: Variant = _hand[slot]
		if card == null:
			draw_rect(rect, Color(0.12, 0.13, 0.16), false, 1.0)
			continue
		var affordable: bool = card["cost"] <= _energy
		draw_rect(rect, Color(0.2, 0.22, 0.28))
		draw_rect(rect, Color(0.95, 0.78, 0.2) if affordable else Color(0.35, 0.36, 0.4), false, 2.0)
		draw_string(ThemeDB.fallback_font, rect.position + Vector2(10.0, 26.0), card["name"], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color.WHITE)
		draw_string(ThemeDB.fallback_font, rect.position + Vector2(10.0, 54.0), "cost %d" % card["cost"], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.7, 0.75, 0.8) if affordable else Color(0.9, 0.5, 0.45))
		draw_string(ThemeDB.fallback_font, rect.position + Vector2(10.0, 78.0), "dmg %d" % card["damage"], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.7, 0.75, 0.8))
	if _drag >= 0 and _hand[_drag] != null:
		draw_rect(Rect2(_pointer - CARD_SIZE * 0.5, CARD_SIZE), Color(0.3, 0.33, 0.42))
	draw_rect(_end_turn_rect(), Color(0.2, 0.3, 0.24))
	draw_string(ThemeDB.fallback_font, _end_turn_rect().position + Vector2(16.0, 24.0), "END TURN", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color.WHITE)
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 26.0), "energy %d/%d  turn %d  played %d  rejected %d" % [_energy, MAX_ENERGY, _turn, _played, _rejected], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 50.0), "drag a card onto the enemy", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.65, 0.65, 0.7))

func snapshot() -> Dictionary:
	return {
		"player_x": int(_pointer.x), "player_y": int(_pointer.y),
		"energy": _energy, "turn": _turn, "enemy_hp": _enemy_health,
		"played": _played, "rejected": _rejected, "hand_size": _hand.size(),
	}
`,
  tryInput: {
    // The empty click establishes the untouched turn as the baseline. Then one
    // legal Strike, one unaffordable Meteor (the hand slot holds it at the same
    // coordinates) and the turn button that refills the spent slot.
    steps: [
      { waitMs: 300 },
      { click: "left", x: 320, y: 190 },
      { drag: { from: { x: 79, y: 280 }, to: { x: 470, y: 120 } }, holdMs: 400 },
      { screenshot: "legal-play" },
      { drag: { from: { x: 331, y: 280 }, to: { x: 470, y: 120 } }, holdMs: 400 },
      { screenshot: "illegal-play" },
      { click: "left", x: 560, y: 318 },
      { waitMs: 200 },
      { screenshot: "next-turn" },
    ],
    captureEveryMs: 250,
  },
};
