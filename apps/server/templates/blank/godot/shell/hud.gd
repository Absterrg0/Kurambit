## The HUD kit (autoload Hud). Every widget is found by its name, so call these
## every frame from _process; text is written only when it changes. The shell
## clears it on every Play, Retry and Main menu, and it pauses with the game.
## Its labels are what the studio probe reads, the same HUD the player sees.
##
##   Hud.counter("Gems", gems, 5)               # "Gems 3 / 5", pops when it changes
##   Hud.counter("Score", score)                # "Score 1200"
##   Hud.bar("Health", hp, 3)                   # hearts up to 10, a bar above that
##   Hud.timer("Time", seconds_left)            # "Time 1:05"
##   Hud.objective("Light all five shrines")    # top centre; "" hides it
##   Hud.toast("Gate opened!")                  # on the event: centre, queued, ~2 s each
##   Hud.hint("Press {jump} to jump", func(): return jumped)  # {action} becomes its key
##
## A hint shows once per launch, until its condition is true or `seconds` pass
## (default 6). Give a counter an icon texture for a picture.
extends CanvasLayer

const TOAST_S := 1.8
const FADE_S := 0.25

var _root: Control
var _stats: VBoxContainer
var _objective: PanelContainer
var _toast: Label
var _hint: PanelContainer
var _widgets := {}
var _toasts: Array = []
var _hints: Array = []
var _toast_left := 0.0
var _toast_on := false
var _hint_now: Dictionary = {}
var _shown_hints := {}
## Toast text that ended a moment ago, with the seconds until it may show again.
var _recent := {}
const TOAST_AGAIN_S := 4.0
const MAX_TOASTS := 3
## A value that changes every frame (a ticking score) pops at most this often.
const POP_GAP_S := 0.3
var _now := 0.0


class Hearts extends Control:
	const HEART := Color(1.0, 0.48, 0.42)
	var value := 0
	var max_value := 3

	func _draw() -> void:
		var r := _height() * 0.27
		for i in max_value:
			var x := i * (r * 4.6)
			var colour := HEART if i < value else Color(1, 1, 1, 0.28)
			draw_circle(Vector2(x + r, r * 1.1), r, colour)
			draw_circle(Vector2(x + r * 3, r * 1.1), r, colour)
			draw_colored_polygon(PackedVector2Array([Vector2(x + r * 0.08, r * 1.45), Vector2(x + r * 3.92, r * 1.45), Vector2(x + r * 2, r * 3.6)]), colour)

	func _get_minimum_size() -> Vector2:
		return Vector2(max_value * _height() * 0.27 * 4.6, _height())

	# Before layout size is zero; the minimum height stands in.
	func _height() -> float:
		return maxf(size.y, custom_minimum_size.y)


func _ready() -> void:
	layer = 10
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_root)
	_stats = VBoxContainer.new()
	_stats.position = Vector2(16, 12)
	_stats.add_theme_constant_override("separation", 2)
	_stats.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(_stats)
	_objective = _panel(Control.PRESET_CENTER_TOP, 14.0)
	_toast = _label(34)
	_toast.set_anchors_preset(Control.PRESET_CENTER_TOP)
	_toast.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_toast.anchor_top = 0.26
	_toast.anchor_bottom = 0.26
	_root.add_child(_toast)
	_hint = _panel(Control.PRESET_CENTER_BOTTOM, -0.08)
	clear()


## The shell's: empties the HUD for a new run or the title.
func clear() -> void:
	for name in _widgets:
		(_widgets[name]["node"] as Node).queue_free()
	_widgets.clear()
	_toasts.clear()
	_recent.clear()
	_hints.clear()
	_hint_now = {}
	_toast_on = false
	_objective.visible = false
	_toast.visible = false
	_hint.visible = false


func counter(name: String, value: Variant, max_value: Variant = null, icon: Texture2D = null) -> void:
	var entry := _widget(name, "counter", icon)
	var text := "%s %s" % [name, value] if max_value == null else "%s %s / %s" % [name, value, max_value]
	if entry.has("value") and entry["value"] != value:
		_pop(entry, 0.18)
	entry["value"] = value
	_write(entry["label"], text)


func bar(name: String, value: float, max_value: float) -> void:
	var hearts := max_value <= 10.0
	var entry := _widget(name, "hearts" if hearts else "bar", null)
	var clamped := clampf(value, 0.0, max_value)
	_write(entry["label"], "%s %d / %d" % [name, roundi(clamped), roundi(max_value)])
	if hearts:
		var pips: Hearts = entry["pips"]
		if pips.value != roundi(clamped) or pips.max_value != roundi(max_value):
			pips.value = roundi(clamped)
			pips.max_value = roundi(max_value)
			pips.update_minimum_size()
			pips.queue_redraw()
	else:
		var track: ProgressBar = entry["track"]
		track.max_value = max_value
		track.value = clamped
	if entry.has("value") and clamped < float(entry["value"]):
		_pop(entry, 0.15)
	entry["value"] = clamped


func timer(name: String, seconds: float) -> void:
	var entry := _widget(name, "timer", null)
	var whole := maxi(0, ceili(seconds))
	_write(entry["label"], "%s %d:%02d" % [name, whole / 60, whole % 60])


func objective(text: String) -> void:
	_write(_objective.get_child(0) as Label, text)
	_objective.visible = text != ""


func toast(text: String, seconds := TOAST_S) -> void:
	# Called from a condition every frame, the same text would show forever:
	# it waits while it shows or queues, and a call within a few seconds of it
	# ending restarts that wait, so it shows again only after a real gap.
	if _recent.has(text):
		_recent[text] = TOAST_AGAIN_S
		return
	if (_toast_on and _toast.text == text) or _toasts.any(func(t): return t["text"] == text):
		return
	# Text that changes every frame would queue without end: keep the newest few.
	if _toasts.size() >= MAX_TOASTS:
		_toasts.pop_front()
	_toasts.append({"text": text, "seconds": seconds})


func hint(text: String, until := Callable(), seconds := 6.0) -> void:
	if _shown_hints.has(text) or _hints.any(func(h): return h["text"] == text) or _hint_now.get("text", "") == text:
		return
	_hints.append({"text": text, "until": until, "seconds": seconds})


func _process(delta: float) -> void:
	_now += delta
	for text in _recent.keys():
		_recent[text] -= delta
		if _recent[text] <= 0.0:
			_recent.erase(text)
	if not _toast_on and not _toasts.is_empty():
		var next: Dictionary = _toasts.pop_front()
		_write(_toast, next["text"])
		_toast.modulate.a = 1.0
		_toast.visible = true
		_toast_on = true
		_toast_left = next["seconds"]
	elif _toast_on:
		_toast_left -= delta
		_toast.modulate.a = clampf(1.0 + _toast_left / FADE_S, 0.0, 1.0)
		if _toast_left <= -FADE_S:
			# Hidden, not only transparent: the probe reads visible labels.
			_toast.visible = false
			_toast_on = false
			_recent[_toast.text] = TOAST_AGAIN_S
	if _hint_now.is_empty() and not _hints.is_empty():
		_hint_now = _hints.pop_front()
		# Shown counts from here: a hint queued when the run ended comes back next run.
		_shown_hints[_hint_now["text"]] = true
		_write(_hint.get_child(0) as Label, _labelled(_hint_now["text"]))
		_hint.modulate.a = 1.0
		_hint.visible = true
	elif not _hint_now.is_empty():
		_hint_now["seconds"] -= delta
		var until: Callable = _hint_now["until"]
		if _hint_now["seconds"] > 0.0 and until.is_valid() and until.call() == true:
			_hint_now["seconds"] = 0.0
		_hint.modulate.a = clampf(1.0 + _hint_now["seconds"] / FADE_S, 0.0, 1.0)
		if _hint_now["seconds"] <= -FADE_S:
			_hint.visible = false
			_hint_now = {}


func _widget(name: String, kind: String, icon: Texture2D) -> Dictionary:
	if _widgets.has(name) and _widgets[name]["kind"] == kind:
		return _widgets[name]
	if _widgets.has(name):
		(_widgets[name]["node"] as Node).queue_free()
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var entry := {"kind": kind, "node": row}
	if icon != null:
		var picture := TextureRect.new()
		picture.mouse_filter = Control.MOUSE_FILTER_IGNORE
		picture.texture = icon
		picture.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		picture.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		picture.custom_minimum_size = Vector2(30, 30)
		row.add_child(picture)
	var label := _label(22)
	row.add_child(label)
	entry["label"] = label
	if kind == "hearts":
		var pips := Hearts.new()
		pips.custom_minimum_size = Vector2(0, 26)
		pips.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		pips.mouse_filter = Control.MOUSE_FILTER_IGNORE
		row.add_child(pips)
		entry["pips"] = pips
	elif kind == "bar":
		var track := ProgressBar.new()
		track.show_percentage = false
		track.mouse_filter = Control.MOUSE_FILTER_IGNORE
		track.custom_minimum_size = Vector2(150, 8)
		track.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		var fill := StyleBoxFlat.new()
		fill.bg_color = Color(1.0, 0.79, 0.3)
		fill.set_corner_radius_all(3)
		var back := StyleBoxFlat.new()
		back.bg_color = Color(1, 1, 1, 0.14)
		back.set_corner_radius_all(3)
		track.add_theme_stylebox_override("fill", fill)
		track.add_theme_stylebox_override("background", back)
		row.add_child(track)
		entry["track"] = track
	_stats.add_child(row)
	_widgets[name] = entry
	return entry


func _label(font_size: int) -> Label:
	var label := Label.new()
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_constant_override("outline_size", 6)
	label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _panel(preset: int, offset: float) -> PanelContainer:
	var panel := PanelContainer.new()
	var box := StyleBoxFlat.new()
	box.bg_color = Color(0, 0, 0, 0.42)
	box.set_corner_radius_all(6)
	box.content_margin_left = 14
	box.content_margin_right = 14
	box.content_margin_top = 5
	box.content_margin_bottom = 5
	panel.add_theme_stylebox_override("panel", box)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(_label(22))
	panel.set_anchors_preset(preset)
	panel.grow_horizontal = Control.GROW_DIRECTION_BOTH
	if offset >= 0.0:
		panel.offset_top = offset
	else:
		panel.anchor_top = 1.0 + offset
		panel.anchor_bottom = 1.0 + offset
		panel.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_root.add_child(panel)
	return panel


func _labelled(text: String) -> String:
	var out := text
	var found := RegEx.create_from_string("\\{([a-z_]+)\\}").search_all(text)
	for match in found:
		var key := GameState.key_label(match.get_string(1))
		if key != "":
			out = out.replace(match.get_string(), key)
	return out


func _write(label: Label, text: String) -> void:
	if label.text != text:
		label.text = text


func _pop(entry: Dictionary, amount: float) -> void:
	if _now - float(entry.get("popped_at", -INF)) < POP_GAP_S:
		return
	entry["popped_at"] = _now
	Juice.pop(entry["node"], amount, amount)
