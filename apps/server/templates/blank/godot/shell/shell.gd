## The demo shell around the gameplay scene: title, pause, settings, end and
## credits. The game plugs in at GAME_SCENE, which the shell instances under
## Main/Game on Play and Retry, and ends a run with GameState.win(text, stats)
## or GameState.lose(text, stats). It never builds these screens itself.
##
## Pause is SceneTree.paused (Esc, P or gamepad Start): gameplay freezes and
## these screens keep running. A run's end plays out in slow motion for a
## moment (the last hit's shake, flash and burst stay visible), then play
## freezes the same way and the end screen opens.
## Controls are the named actions in project.godot [input]; Settings >
## Controls lists each with its keys and gamepad inputs, and rebinds keys
## (saved in SETTINGS_FILE). Gameplay reads actions, never raw keys.
## Restyle the screens in scenes/main.tscn and shell/theme.tres.
extends Node

## The gameplay scene.
const GAME_SCENE := "res://scenes/game.tscn"
## true boots straight into play, skipping the title (handy while building).
const BOOT_INTO_PLAY := false
## Played on every shell button press once the file exists.
const CLICK_SOUND := "res://assets/sfx/ui_click.wav"
const CREDITS_FILE := "res://credits.txt"
## Shown behind the title once the file exists (the game's key art fits);
## the gradient in scenes/main.tscn stays as the fallback.
const TITLE_ART := "res://assets/ui/title_bg.png"
const SETTINGS_FILE := "user://settings.cfg"
## Real seconds and time scale of the slow-motion beat before the end screen.
const END_BEAT_S := 0.6
const END_BEAT_SCALE := 0.3
## The end screen then ignores input this long, so a button mashed at the
## moment the run ends cannot skip it.
const END_GUARD_S := 0.4
## Actions the Controls screen lists but never rebinds: a player can always reach the menu.
const FIXED_ACTIONS := ["pause"]
const PAD_BUTTONS := {
	JOY_BUTTON_A: "A", JOY_BUTTON_B: "B", JOY_BUTTON_X: "X", JOY_BUTTON_Y: "Y",
	JOY_BUTTON_BACK: "Back", JOY_BUTTON_GUIDE: "Guide", JOY_BUTTON_START: "Start",
	JOY_BUTTON_LEFT_STICK: "L3", JOY_BUTTON_RIGHT_STICK: "R3",
	JOY_BUTTON_LEFT_SHOULDER: "LB", JOY_BUTTON_RIGHT_SHOULDER: "RB",
	JOY_BUTTON_DPAD_UP: "D-pad up", JOY_BUTTON_DPAD_DOWN: "D-pad down",
	JOY_BUTTON_DPAD_LEFT: "D-pad left", JOY_BUTTON_DPAD_RIGHT: "D-pad right",
}
const MOUSE_BUTTONS := {MOUSE_BUTTON_LEFT: "Left click", MOUSE_BUTTON_RIGHT: "Right click", MOUSE_BUTTON_MIDDLE: "Middle click"}
## Settings slider name -> audio bus.
const VOLUME_BUSES := {"Master": "Master", "Music": "Music", "Sfx": "SFX"}

@onready var _holder: Node = $Game
## Main pauses with the game, so a node a game adds to the current scene
## freezes too; the screens and this key listener keep running.
@onready var _keys: Node = $Keys
@onready var _title: CanvasLayer = $Title
@onready var _pause: CanvasLayer = $Pause
@onready var _end: CanvasLayer = $End
@onready var _settings: CanvasLayer = $Settings
@onready var _credits: CanvasLayer = $Credits
@onready var _controls: CanvasLayer = $Controls
@onready var _screens: Array[CanvasLayer] = [_title, _pause, _end, _settings, _credits, _controls]

var _game: Node = null
var _settings_from: CanvasLayer = null
var _play_mouse_mode := Input.MOUSE_MODE_VISIBLE
var _end_serial := 0
var _config := ConfigFile.new()
## The action the Controls screen waits on a key for, or "".
var _rebinding := ""


func _ready() -> void:
	(_title.get_node("Center/Name") as Label).text = str(ProjectSettings.get_setting("application/config/name", ""))
	# A file not yet imported (or a failed import) loads as null; the gradient stays.
	var art_texture: Texture2D = null
	if ResourceLoader.exists(TITLE_ART):
		art_texture = load(TITLE_ART) as Texture2D
	if art_texture != null:
		var art := _title.get_node("Background") as TextureRect
		art.texture = art_texture
		art.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
		# Dark enough that the plain buttons read over a bright sky.
		art.modulate = Color(0.45, 0.45, 0.5)
	_title.get_node("Center/Buttons/Quit").visible = not OS.has_feature("web")
	for button in find_children("*", "BaseButton", true, false):
		(button as BaseButton).pressed.connect(_click)
	_on_press(_title, "Center/Buttons/Play", start_run)
	_on_press(_title, "Center/Buttons/Settings", _open_settings.bind(_title))
	_on_press(_title, "Center/Buttons/Credits", _open_credits)
	_on_press(_title, "Center/Buttons/Quit", get_tree().quit)
	_on_press(_pause, "Center/Card/Box/Resume", resume)
	_on_press(_pause, "Center/Card/Box/Settings", _open_settings.bind(_pause))
	_on_press(_pause, "Center/Card/Box/MainMenu", show_title)
	_on_press(_end, "Center/Card/Box/Buttons/Retry", start_run)
	_on_press(_end, "Center/Card/Box/Buttons/MainMenu", show_title)
	_on_press(_settings, "Center/Card/Box/Back", _close_settings)
	_on_press(_settings, "Center/Card/Box/Controls", _open_controls)
	_on_press(_controls, "Center/Card/Box/Buttons/Reset", _reset_controls)
	_on_press(_controls, "Center/Card/Box/Buttons/Back", _show.bind(_settings))
	_on_press(_credits, "Center/Card/Box/Back", _show.bind(_title))
	for slider_name in VOLUME_BUSES:
		_slider(slider_name).value_changed.connect(_set_volume.bind(VOLUME_BUSES[slider_name]))
	_fullscreen_toggle().toggled.connect(_set_fullscreen)
	_reset_button().pressed.connect(_reset_progress)
	# Deferred: a game ends a run from physics callbacks, where pausing the
	# tree mid-flush is unsafe; the state already reads "ended" meanwhile.
	GameState.ended.connect(_on_ended, CONNECT_DEFERRED)
	_add_menu_pad_buttons()
	_load_settings()
	GameState.load_progress()
	if BOOT_INTO_PLAY:
		start_run()
	else:
		show_title()


func _on_key(event: InputEvent) -> void:
	if event.is_echo():
		return
	var pause_key := event.is_action_pressed("pause")
	if not pause_key and not event.is_action_pressed("ui_cancel"):
		return
	if _controls.visible:
		_show(_settings)
	elif _settings.visible:
		_close_settings()
	elif _credits.visible:
		_show(_title)
	elif GameState.state == "playing" and pause_key:
		pause()
	elif GameState.state == "paused":
		resume()
	else:
		return
	get_viewport().set_input_as_handled()


func start_run() -> void:
	var packed := load(GAME_SCENE) as PackedScene
	if packed == null:
		push_error("The shell cannot load the gameplay scene %s." % GAME_SCENE)
		return
	_clear_game()
	GameState.new_run()
	Engine.time_scale = 1.0
	get_tree().paused = false
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	_show(null)
	GameState.state = "playing"
	_game = packed.instantiate()
	_holder.add_child(_game)
	Juice.stage = _game


func pause() -> void:
	if GameState.state != "playing":
		return
	_play_mouse_mode = Input.mouse_mode
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	GameState.state = "paused"
	get_tree().paused = true
	_show(_pause)


func resume() -> void:
	if GameState.state != "paused":
		return
	_show(null)
	get_tree().paused = false
	GameState.state = "playing"
	Input.mouse_mode = _play_mouse_mode


func show_title() -> void:
	_clear_game()
	Engine.time_scale = 1.0
	get_tree().paused = false
	GameState.result = ""
	GameState.result_text = ""
	GameState.state = "title"
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	_show(_title)


func _on_ended(won: bool, text: String, stats: Dictionary) -> void:
	if GameState.state != "ended" or _game == null:
		return
	_end_serial += 1
	var serial := _end_serial
	var scale_before := Engine.time_scale
	Engine.time_scale = END_BEAT_SCALE
	# Counts only unpaused time: a hold (explore between acts, a hidden stage
	# tab) must not let the beat finish and pause underneath it.
	await get_tree().create_timer(END_BEAT_S, false, false, true).timeout
	Engine.time_scale = scale_before
	if serial != _end_serial:
		return
	get_tree().paused = true
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	var heading: Label = _end.get_node("Center/Card/Box/Heading")
	heading.text = text
	heading.theme_type_variation = &"WinHeading" if won else &"LoseHeading"
	var grid: GridContainer = _end.get_node("Center/Card/Box/Stats")
	for child in grid.get_children():
		grid.remove_child(child)
		child.queue_free()
	for key in stats:
		var stat_name := Label.new()
		stat_name.text = str(key)
		stat_name.theme_type_variation = &"StatName"
		var stat_value := Label.new()
		stat_value.text = str(stats[key])
		stat_value.theme_type_variation = &"StatValue"
		stat_value.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		grid.add_child(stat_name)
		grid.add_child(stat_value)
	grid.visible = not stats.is_empty()
	var buttons := _end.get_node("Center/Card/Box/Buttons").get_children()
	for button in buttons:
		(button as BaseButton).disabled = true
	_show(_end)
	await get_tree().create_timer(END_GUARD_S, true, false, true).timeout
	if serial != _end_serial or not _end.visible:
		return
	for button in buttons:
		(button as BaseButton).disabled = false
	_focus_first(_end)


func _clear_game() -> void:
	_end_serial += 1
	Hud.clear()
	if is_instance_valid(_game):
		_holder.remove_child(_game)
		_game.queue_free()
	_game = null
	# Nodes a game added to the current scene (Main) instead of its own.
	for child in get_children():
		if child != _holder and child != _keys and not (child is CanvasLayer and _screens.has(child)):
			remove_child(child)
			child.queue_free()


func _show(screen: CanvasLayer) -> void:
	if screen != _controls:
		_rebinding = ""
	for each in _screens:
		each.visible = each == screen
	# Settings and credits opened from the title keep its backdrop behind them.
	var at_title := GameState.state == "title" and screen != null
	_title.visible = at_title
	_title.get_node("Center").visible = screen == _title
	_title.get_node("Hint").visible = screen == _title
	if screen == null:
		get_viewport().gui_release_focus()
	else:
		_focus_first.call_deferred(screen)


func _focus_first(screen: CanvasLayer) -> void:
	if not screen.visible:
		return
	for node in screen.find_children("*", "Control", true, false):
		var control := node as Control
		if control.focus_mode == Control.FOCUS_NONE or not control.is_visible_in_tree():
			continue
		if control is BaseButton and (control as BaseButton).disabled:
			continue
		control.grab_focus()
		return


func _reset_button() -> Button:
	return _settings.get_node("Center/Card/Box/ResetProgress") as Button


## Two presses, so a stray click cannot wipe a best score.
func _reset_progress() -> void:
	var button := _reset_button()
	if button.text != "Press again to reset":
		button.text = "Press again to reset"
		return
	GameState.reset_progress()
	button.text = "Progress reset"
	button.disabled = true


func _open_settings(from: CanvasLayer) -> void:
	var reset := _reset_button()
	reset.visible = GameState.has_progress()
	reset.disabled = false
	reset.text = "Reset progress"
	# The browser or window manager can leave fullscreen without us.
	_fullscreen_toggle().set_pressed_no_signal(DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_FULLSCREEN)
	_settings_from = from
	_show(_settings)


func _close_settings() -> void:
	_config.save(SETTINGS_FILE)
	_show(_settings_from if _settings_from != null else _title)


func _open_credits() -> void:
	var lines: PackedStringArray = []
	var text := FileAccess.get_file_as_string(CREDITS_FILE)
	for line in text.split("\n"):
		if not line.strip_edges().begins_with("#"):
			lines.append(line.strip_edges())
	var credits := "\n".join(lines).strip_edges()
	(_credits.get_node("Center/Card/Box/Scroll/Text") as Label).text = credits if credits != "" else "Made with the Godot Engine"
	_show(_credits)


func _load_settings() -> void:
	_config.load(SETTINGS_FILE)
	if _config.has_section("controls"):
		for action in _config.get_section_keys("controls"):
			if InputMap.has_action(action) and not FIXED_ACTIONS.has(action):
				_set_keys(action, Array(_config.get_value("controls", action, [])))
	for slider_name in VOLUME_BUSES:
		var bus: String = VOLUME_BUSES[slider_name]
		var volume := float(_config.get_value("audio", bus, 1.0))
		_slider(slider_name).set_value_no_signal(volume)
		_set_volume(volume, bus)
	var fullscreen := bool(_config.get_value("video", "fullscreen", false))
	_fullscreen_toggle().set_pressed_no_signal(fullscreen)
	# A browser grants fullscreen only from a click, never at load.
	if fullscreen and not OS.has_feature("web"):
		_set_fullscreen(true)


func _set_volume(volume: float, bus: String) -> void:
	_config.set_value("audio", bus, volume)
	_config.save(SETTINGS_FILE)
	var index := AudioServer.get_bus_index(bus)
	if index >= 0:
		AudioServer.set_bus_volume_db(index, linear_to_db(maxf(volume, 0.0001)))


func _set_fullscreen(on: bool) -> void:
	_config.set_value("video", "fullscreen", on)
	_config.save(SETTINGS_FILE)
	DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_FULLSCREEN if on else DisplayServer.WINDOW_MODE_WINDOWED)


## Gamepad A presses the focused button and B backs out, like Enter and Esc:
## Godot's built-in ui_accept and ui_cancel carry no gamepad buttons.
func _add_menu_pad_buttons() -> void:
	for pair in [["ui_accept", JOY_BUTTON_A], ["ui_cancel", JOY_BUTTON_B]]:
		var button := InputEventJoypadButton.new()
		button.button_index = pair[1]
		if not InputMap.action_has_event(pair[0], button):
			InputMap.action_add_event(pair[0], button)


## Every action project.godot declares, in its order, pause last.
func _control_actions() -> Array[String]:
	var names: Array[String] = []
	for property in ProjectSettings.get_property_list():
		var key := str(property.name)
		if not key.begins_with("input/") or key.begins_with("input/ui_"):
			continue
		var action := key.trim_prefix("input/")
		if InputMap.has_action(action) and not FIXED_ACTIONS.has(action):
			names.append(action)
	for action in FIXED_ACTIONS:
		if InputMap.has_action(action):
			names.append(action)
	return names


func _controls_list() -> GridContainer:
	return _controls.get_node("Center/Card/Box/Scroll/List") as GridContainer


func _open_controls() -> void:
	_rebinding = ""
	var grid := _controls_list()
	for child in grid.get_children():
		grid.remove_child(child)
		child.queue_free()
	for head in ["Action", "Keyboard", "Gamepad"]:
		_controls_label(head).theme_type_variation = &"StatName"
	for action in _control_actions():
		_controls_label(_action_label(action))
		var button := Button.new()
		button.name = action
		button.disabled = FIXED_ACTIONS.has(action)
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		button.add_theme_font_size_override("font_size", 18)
		button.pressed.connect(_click)
		button.pressed.connect(_start_rebind.bind(action))
		grid.add_child(button)
		# The theme's button, tighter, so a full action list fits the card.
		for state in ["normal", "hover", "pressed", "hover_pressed", "disabled", "focus"]:
			var box := button.get_theme_stylebox(state).duplicate() as StyleBox
			box.content_margin_top = 1
			box.content_margin_bottom = 1
			box.content_margin_left = 12
			box.content_margin_right = 12
			button.add_theme_stylebox_override(state, box)
		var pad := _controls_label(_binding_text(action, false))
		pad.name = action + "_pad"
	_refresh_controls("Select a key binding, then press the new key")
	_show(_controls)
	_fit_controls_list.call_deferred()


## The list takes the height it needs up to what the card has room for, and
## scrolls past that (the focused row stays in view).
func _fit_controls_list() -> void:
	var scroll := _controls.get_node("Center/Card/Box/Scroll") as ScrollContainer
	scroll.custom_minimum_size.y = minf(_controls_list().get_combined_minimum_size().y, 320.0)


func _controls_label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 18)
	_controls_list().add_child(label)
	return label


func _refresh_controls(note: String) -> void:
	(_controls.get_node("Center/Card/Box/Note") as Label).text = note
	for action in _control_actions():
		var button := _controls_list().get_node_or_null(action) as Button
		if button != null:
			button.text = "Press a key" if _rebinding == action else _binding_text(action, true)


func _start_rebind(action: String) -> void:
	_rebinding = action
	_refresh_controls("Press a key for it · Esc cancels")


func _stop_rebind(note: String) -> void:
	_rebinding = ""
	_refresh_controls(note)


## The Keys node hands every input here first while a rebind waits, before
## the focused button or the menu keys can use it. Returns whether it was used.
func capture_rebind(event: InputEvent) -> bool:
	if _rebinding == "" or not _controls.visible:
		return false
	if event is InputEventKey:
		var key := event as InputEventKey
		if key.pressed and not key.echo:
			var code := key.physical_keycode if key.physical_keycode != KEY_NONE else key.keycode
			if code == KEY_ESCAPE:
				_stop_rebind("Not changed")
			else:
				_stop_rebind(_rebind(_rebinding, code))
				_save_controls()
		return true
	if event is InputEventJoypadButton and event.is_action_pressed("ui_cancel"):
		_stop_rebind("Not changed")
		return true
	return false


## Puts `code` first among the action's keys. A key another action holds
## moves over in exchange for this one's old key; a fixed action's key is
## refused. Returns the sentence the Controls screen shows.
func _rebind(action: String, code: int) -> String:
	var label := _action_label(action)
	var keys := _keys_of(action)
	var old: int = keys[0] if not keys.is_empty() else KEY_NONE
	if old == code:
		return "%s stays on %s" % [label, _key_name(code)]
	var other := ""
	for each in _control_actions():
		if _keys_of(each).has(code):
			other = each
	if FIXED_ACTIONS.has(other):
		return "%s stays on %s" % [_key_name(code), _action_label(other)]
	if other == action:
		keys[keys.find(code)] = old
		keys[0] = code
		_set_keys(action, keys)
		return "%s: %s first" % [label, _key_name(code)]
	if old == KEY_NONE:
		keys.append(code)
	else:
		keys[0] = code
	_set_keys(action, keys)
	if other == "":
		return "%s is now %s" % [label, _key_name(code)]
	var other_keys := _keys_of(other)
	if old == KEY_NONE:
		other_keys.erase(code)
		_set_keys(other, other_keys)
		return "%s is now %s, taken from %s" % [label, _key_name(code), _action_label(other)]
	other_keys[other_keys.find(code)] = old
	_set_keys(other, other_keys)
	return "%s is now %s; %s moved to %s" % [label, _key_name(code), _key_name(old), _action_label(other)]


func _reset_controls() -> void:
	InputMap.load_from_project_settings()
	_add_menu_pad_buttons()
	if _config.has_section("controls"):
		_config.erase_section("controls")
	_config.save(SETTINGS_FILE)
	_rebinding = ""
	_refresh_controls("Controls reset to defaults")


## Stores only the actions whose keys differ from project.godot's.
func _save_controls() -> void:
	for action in _control_actions():
		var defaults: Array = []
		var declared: Variant = ProjectSettings.get_setting("input/" + action)
		if declared is Dictionary:
			for event in (declared as Dictionary).get("events", []):
				if event is InputEventKey:
					defaults.append(_code_of(event))
		var keys := _keys_of(action)
		if keys == defaults:
			if _config.has_section_key("controls", action):
				_config.erase_section_key("controls", action)
		else:
			_config.set_value("controls", action, keys)
	_config.save(SETTINGS_FILE)


func _keys_of(action: String) -> Array:
	var keys: Array = []
	for event in InputMap.action_get_events(action):
		if event is InputEventKey:
			keys.append(_code_of(event))
	return keys


## Replaces the action's keyboard keys; its mouse and gamepad inputs stay.
func _set_keys(action: String, keys: Array) -> void:
	var rest: Array[InputEvent] = []
	for event in InputMap.action_get_events(action):
		if not event is InputEventKey:
			rest.append(event)
	InputMap.action_erase_events(action)
	for code in keys:
		var key := InputEventKey.new()
		key.device = -1
		key.physical_keycode = int(code)
		InputMap.action_add_event(action, key)
	for event in rest:
		InputMap.action_add_event(action, event)


## "move_left" -> "Move left".
static func _action_label(action: String) -> String:
	var words := action.replace("_", " ")
	return words.left(1).to_upper() + words.substr(1)


static func _code_of(key: InputEventKey) -> int:
	return key.physical_keycode if key.physical_keycode != KEY_NONE else key.keycode


static func _key_name(code: int) -> String:
	return OS.get_keycode_string(code)


## One action's keyboard (and mouse) or gamepad inputs as the screen shows them.
func _binding_text(action: String, keyboard: bool) -> String:
	var parts: PackedStringArray = []
	var mouse: PackedStringArray = []
	for event in InputMap.action_get_events(action):
		if keyboard and event is InputEventKey:
			parts.append(_key_name(_code_of(event)))
		elif keyboard and event is InputEventMouseButton:
			var index := (event as InputEventMouseButton).button_index
			mouse.append(MOUSE_BUTTONS.get(index, "Mouse %d" % index))
		elif not keyboard and event is InputEventJoypadButton:
			var index := (event as InputEventJoypadButton).button_index
			parts.append(PAD_BUTTONS.get(index, "Button %d" % index))
		elif not keyboard and event is InputEventJoypadMotion:
			parts.append(_axis_name(event as InputEventJoypadMotion))
	parts.append_array(mouse)
	return ", ".join(parts) if not parts.is_empty() else "None"


static func _axis_name(motion: InputEventJoypadMotion) -> String:
	var negative := motion.axis_value < 0.0
	match motion.axis:
		JOY_AXIS_LEFT_X:
			return "Stick left" if negative else "Stick right"
		JOY_AXIS_LEFT_Y:
			return "Stick up" if negative else "Stick down"
		JOY_AXIS_RIGHT_X:
			return "Right stick left" if negative else "Right stick right"
		JOY_AXIS_RIGHT_Y:
			return "Right stick up" if negative else "Right stick down"
		JOY_AXIS_TRIGGER_LEFT:
			return "LT"
		JOY_AXIS_TRIGGER_RIGHT:
			return "RT"
	return "Axis %d" % motion.axis


func _slider(slider_name: String) -> Range:
	return _settings.get_node("Center/Card/Box/Grid/" + slider_name)


func _fullscreen_toggle() -> BaseButton:
	return _settings.get_node("Center/Card/Box/Fullscreen")


func _on_press(screen: CanvasLayer, path: String, action: Callable) -> void:
	(screen.get_node(path) as BaseButton).pressed.connect(action)


func _click() -> void:
	if ResourceLoader.exists(CLICK_SOUND):
		Juice.sfx(CLICK_SOUND, -6.0, 0.03)
