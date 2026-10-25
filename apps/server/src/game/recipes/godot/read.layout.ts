import type { GodotRecipeReference } from "./reference.ts";

export const readLayout: GodotRecipeReference = {
  setup:
    "Create a scene with a Control root, attach this script, and set Display > Window > Stretch > Mode to Disabled (or Canvas Items with aspect Expand) so the root follows the window. Tab reaches every choice (the list scrolls with focus), Enter selects one, then Tab to Confirm and Enter. Resize the window: the status and Confirm stay inside it, and a short window scrolls the card instead of clipping it. Stop and run again to reset; the demo writes nothing.",
  referenceCode: String.raw`extends Control
## Viewport layout: a card and its choices share one scrolling column, while
## status and the primary action sit outside it in the footer. Anchors and
## containers take the room they are given, so long text wraps and a short
## window scrolls the content instead of pushing a control off-screen.

const TITLE := "The bridge at Low Tide"
const BODY := "The ferryman will not cross while the river is this high. His ledger lists three ways to settle the debt, but the last entry is written in a hand you do not recognise, and the ink is still wet. Choose what you are willing to promise before you speak."
const CHOICES := [
	{"label": "Offer the lantern", "detail": "He needs light more than coin, and the lantern is the only thing you own that still works after the storm."},
	{"label": "Read the ledger", "detail": "Ask who wrote the last entry. The ferryman's answer may cost more than the crossing itself."},
	{"label": "Pay in coin", "detail": "Count out the full fare now, keep the lantern, and leave the question of the wet ink for someone else."},
	{"label": "Walk away", "detail": "There is a road along the north bank. It is longer, unlit, and the bridge will still be closed tomorrow."},
]

var _scroll: ScrollContainer
var _list: VBoxContainer
var _buttons: Array[Button] = []
var _body: Label
var _status: Label
var _action: Button
var _selected := -1
var _confirmed := 0
var _last := "none"

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_build()
	_action.pressed.connect(_confirm)
	_refresh()

func _build() -> void:
	var background := ColorRect.new()
	background.color = Color(0.07, 0.08, 0.1)
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "top", "right", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 16)
	add_child(margin)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 10)
	margin.add_child(column)
	_scroll = ScrollContainer.new()
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.follow_focus = true  # Tab must reveal the focused choice, not scroll past it.
	column.add_child(_scroll)
	_list = VBoxContainer.new()
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_list.add_theme_constant_override("separation", 8)
	_scroll.add_child(_list)
	var card := PanelContainer.new()
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.14, 0.15, 0.19)
	style.set_corner_radius_all(6)
	style.set_content_margin_all(12)
	card.add_theme_stylebox_override("panel", style)
	_list.add_child(card)
	var card_column := VBoxContainer.new()
	card_column.add_theme_constant_override("separation", 6)
	card.add_child(card_column)
	var title := Label.new()
	title.text = TITLE
	title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title.add_theme_font_size_override("font_size", 20)
	card_column.add_child(title)
	_body = Label.new()
	_body.text = BODY
	_body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_body.add_theme_font_size_override("font_size", 14)
	card_column.add_child(_body)
	for index in CHOICES.size():
		var choice: Dictionary = CHOICES[index]
		var button := Button.new()
		button.text = "%d. %s\n%s" % [index + 1, choice["label"], choice["detail"]]
		button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.custom_minimum_size = Vector2(0, 54)
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		button.toggle_mode = true
		button.pressed.connect(_choose.bind(index))
		_list.add_child(button)
		_buttons.append(button)
	var footer := VBoxContainer.new()
	footer.add_theme_constant_override("separation", 6)
	column.add_child(footer)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_font_size_override("font_size", 13)
	footer.add_child(_status)
	var row := HBoxContainer.new()
	footer.add_child(row)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(spacer)
	_action = Button.new()
	_action.text = "Confirm choice"
	_action.custom_minimum_size = Vector2(0, 44)
	_action.disabled = true
	row.add_child(_action)

func _choose(index: int) -> void:
	_selected = index
	_last = CHOICES[index]["label"]
	for i in _buttons.size():
		_buttons[i].button_pressed = i == index
	_action.disabled = false
	_refresh()

func _confirm() -> void:
	if _selected < 0:
		return
	_confirmed += 1
	_refresh()

func _refresh() -> void:
	_status.text = "Selected: %s  |  Confirmed: %d" % [_last, _confirmed]

func snapshot() -> Dictionary:
	var view := get_viewport_rect().size
	var action := _action.get_global_rect()
	var scroll := _scroll.get_global_rect()
	var status := _status.get_global_rect()
	var card := (_list.get_child(0) as Control).get_global_rect()
	var last_button := _list.get_child(_list.get_child_count() - 1) as Control
	var last := last_button.get_global_rect()
	var bar := _scroll.get_v_scroll_bar()
	return {
		"player_x": int(action.get_center().x), "player_y": int(action.get_center().y),
		"viewport_w": int(view.x), "viewport_h": int(view.y),
		"selected": _selected, "last_choice": _last, "confirmed": _confirmed,
		"body_lines": _body.get_line_count(),
		"scroll_vertical": int(_scroll.scroll_vertical),
		"scroll_max": int(bar.max_value - bar.page),
		"scroll_top": int(scroll.position.y), "scroll_bottom": int(scroll.end.y),
		"scroll_left": int(scroll.position.x), "scroll_right": int(scroll.end.x),
		"status_top": int(status.position.y), "status_bottom": int(status.end.y),
		"status_left": int(status.position.x), "status_right": int(status.end.x),
		"card_left": int(card.position.x), "card_right": int(card.end.x),
		"action_left": int(action.position.x), "action_top": int(action.position.y),
		"action_right": int(action.end.x), "action_bottom": int(action.end.y),
		"last_left": int(last.position.x), "last_right": int(last.end.x),
		"last_top": int(last.position.y), "last_bottom": int(last.end.y),
		"last_choice_visible": last_button.is_visible_in_tree() and scroll.encloses(last),
		"action_visible": _action.is_visible_in_tree(),
	}
`,
  tryInput: {
    // The four Tabs move focus to the last choice; follow_focus scrolls it into
    // view. Enter selects it, then Tab reaches the footer action and Enter
    // confirms it, so the counters prove both the reach and the press.
    steps: [
      { waitMs: 300 },
      { key: "Tab", holdMs: 60 },
      { key: "Tab", holdMs: 60 },
      { key: "Tab", holdMs: 60 },
      { key: "Tab", holdMs: 60 },
      { key: "Enter", holdMs: 60 },
      { screenshot: "last-choice" },
      { key: "Tab", holdMs: 60 },
      { key: "Enter", holdMs: 60 },
      { screenshot: "confirmed" },
      { waitMs: 200 },
    ],
    captureEveryMs: 250,
  },
};
