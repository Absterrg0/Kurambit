## The demo shell around the gameplay scene: title, pause, settings, end and
## credits. The game plugs in at GAME_SCENE, which the shell instances under
## Main/Game on Play and Retry, and ends a run with GameState.win(text, stats)
## or GameState.lose(text, stats). It never builds these screens itself.
##
## Pause is SceneTree.paused (Esc, P or gamepad Start): gameplay freezes and
## these screens keep running. A run's end plays out in slow motion for a
## moment (the last hit's shake, flash and burst stay visible), then play
## freezes the same way and the end screen opens.
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
@onready var _screens: Array[CanvasLayer] = [_title, _pause, _end, _settings, _credits]

var _game: Node = null
var _settings_from: CanvasLayer = null
var _play_mouse_mode := Input.MOUSE_MODE_VISIBLE
var _end_serial := 0
var _config := ConfigFile.new()


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
	_on_press(_credits, "Center/Card/Box/Back", _show.bind(_title))
	for slider_name in VOLUME_BUSES:
		_slider(slider_name).value_changed.connect(_set_volume.bind(VOLUME_BUSES[slider_name]))
	_fullscreen_toggle().toggled.connect(_set_fullscreen)
	# Deferred: a game ends a run from physics callbacks, where pausing the
	# tree mid-flush is unsafe; the state already reads "ended" meanwhile.
	GameState.ended.connect(_on_ended, CONNECT_DEFERRED)
	_load_settings()
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
	if _settings.visible:
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


func _open_settings(from: CanvasLayer) -> void:
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


func _slider(slider_name: String) -> Range:
	return _settings.get_node("Center/Card/Box/Grid/" + slider_name)


func _fullscreen_toggle() -> BaseButton:
	return _settings.get_node("Center/Card/Box/Fullscreen")


func _on_press(screen: CanvasLayer, path: String, action: Callable) -> void:
	(screen.get_node(path) as BaseButton).pressed.connect(action)


func _click() -> void:
	if ResourceLoader.exists(CLICK_SOUND):
		Juice.sfx(CLICK_SOUND, -6.0, 0.03)
