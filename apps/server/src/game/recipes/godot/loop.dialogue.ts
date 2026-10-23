import type { GodotRecipeReference } from "./reference.ts";

export const loopDialogue: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. Keys 1-3 answer the speaker; the reward option is locked until you have helped once, and a locked answer leaves the node and its flags untouched. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Node2D
## Dialogue loop: a small choice graph where options move to a node, a flag can
## gate an option, and taking a choice writes its consequence. A locked option is
## drawn as locked and refused, so the player can see what their state opens.

const NODES := {
	"start": {
		"text": "The bridge is out. Will you help?",
		"choices": [
			{"text": "I'll help.", "next": "help", "trust": 1},
			{"text": "What's in it for me?", "next": "reward", "needs_trust": 1},
			{"text": "Not now.", "next": "end"},
		],
	},
	"help": {
		"text": "Take this rope. Bring the lantern from the far bank.",
		"choices": [
			{"text": "Take the rope.", "next": "end", "rope": true},
			{"text": "Ask about the bridge.", "next": "start"},
		],
	},
	"reward": {
		"text": "Fair. Help me and the lantern is yours.",
		"choices": [
			{"text": "Deal.", "next": "end", "lantern": true},
			{"text": "Let me think.", "next": "start"},
		],
	},
	"end": {"text": "Safe travels.", "choices": []},
}

var _node := "start"
var _trust := 0
var _rope := false
var _lantern := false
var _blocked := 0
var _choices := 0

func _ready() -> void:
	for index in 3:
		var action := "choice_%d" % (index + 1)
		if not InputMap.has_action(action):
			InputMap.add_action(action)
			var event := InputEventKey.new()
			event.keycode = KEY_1 + index
			InputMap.action_add_event(action, event)

func _choose(index: int) -> void:
	var choices: Array = NODES[_node]["choices"]
	if index >= choices.size():
		return
	var choice: Dictionary = choices[index]
	if choice.get("needs_trust", 0) > _trust:
		# Refused before any write: node, flags and trust stay exactly as they were.
		_blocked += 1
		return
	_trust += choice.get("trust", 0)
	_rope = _rope or choice.get("rope", false)
	_lantern = _lantern or choice.get("lantern", false)
	_node = choice["next"]
	_choices += 1

func _physics_process(_delta: float) -> void:
	for index in 3:
		if Input.is_action_just_pressed("choice_%d" % (index + 1)):
			_choose(index)
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.11, 0.12, 0.15))
	var node: Dictionary = NODES[_node]
	# Speaker and listener placeholders: neutral shapes, no character art.
	draw_circle(Vector2(320.0, 92.0), 22.0, Color(0.55, 0.6, 0.68))
	draw_rect(Rect2(310.0, 114.0, 20.0, 46.0), Color(0.55, 0.6, 0.68))
	draw_rect(Rect2(486.0, 132.0, 22.0, 28.0), Color(0.95, 0.78, 0.2))
	draw_rect(Rect2(40.0, 196.0, 560.0, 140.0), Color(0.08, 0.09, 0.11))
	draw_rect(Rect2(40.0, 196.0, 560.0, 140.0), Color(0.4, 0.42, 0.48), false, 2.0)
	draw_multiline_string(ThemeDB.fallback_font, Vector2(58.0, 224.0), str(node["text"]), HORIZONTAL_ALIGNMENT_LEFT, 520.0, 16, 2, Color(0.92, 0.92, 0.95))
	var y := 258.0
	var choices: Array = node["choices"]
	for index in choices.size():
		var choice: Dictionary = choices[index]
		var locked: bool = choice.get("needs_trust", 0) > _trust
		var label := "%d) %s" % [index + 1, choice["text"]]
		if locked:
			label += "   [locked: trust %d]" % choice["needs_trust"]
		draw_string(ThemeDB.fallback_font, Vector2(58.0, y), label, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 15, Color(0.35, 0.36, 0.4) if locked else Color(0.85, 0.88, 0.95))
		y += 24.0
	draw_string(ThemeDB.fallback_font, Vector2(40.0, 26.0), "node %s  trust %d  rope %s  lantern %s  blocked %d" % [_node, _trust, _rope, _lantern, _blocked], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.92, 0.92, 0.95))

func snapshot() -> Dictionary:
	return {
		"player_x": 486, "player_y": 146, "node": _node, "trust": _trust,
		"rope": _rope, "lantern": _lantern, "blocked": _blocked, "choices_taken": _choices,
	}
`,
  tryInput: {
    // The locked answer first proves the refusal, then helping opens the same
    // answer on the way back, and the last choice walks the graph to its end.
    steps: [
      { waitMs: 300 },
      { key: "2", holdMs: 80 },
      { key: "1", holdMs: 80 },
      { key: "2", holdMs: 80 },
      { key: "2", holdMs: 80 },
      { key: "1", holdMs: 80 },
      { waitMs: 200 },
      { screenshot: "ending" },
    ],
    captureEveryMs: 250,
  },
};
