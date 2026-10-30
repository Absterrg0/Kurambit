## The real smoke checks, loaded at runtime by tests/smoke_test.gd.
##
## Reference-shift assertions: five calls, the 0.7s hold tuning and win/loss counts
## test the shipped shift. A new game adapts this file to its DESIGN.md scope and keeps
## meaningful checks for everything retained and promised. The server only requires
## that the canonical suite exits 0; these numbers are not server-owned law.
## It boots the shipped title scene like the engine does, presses Enter through
## the menu, then drives the real Controls with key and pointer input: a pointer
## choice, a pointer Next caller, a held L, pause/resume, restart, a five-call win
## and a three-cold loss. Nothing here calls a game method to change run values or
## writes GameState.
extends Node

const MENU_SCENE := "res://scenes/main_menu.tscn"
const GAME_SCENE := "res://scenes/game.tscn"
## A scene change lands on the idle pass, so this is a generous bound on idle
## frames, not the frame budget the checks rely on.
const SCENE_WAIT_FRAMES := 240
const LISTEN_HOLD_SECONDS := 0.95

var _failures: Array[String] = []
var _checks := 0
var _finished := false
var _game: ShiftScreen

## Read by smoke_test.gd to know the run is over.
var finished := false

func _ready() -> void:
	run.call_deferred()

func run() -> void:
	print("2d-screen smoke test")
	# Headless Godot starts with a 64px dummy window; exercise the real design size.
	if DisplayServer.get_name() == "headless":
		get_tree().root.size = Vector2i(
			ProjectSettings.get_setting("display/window/size/viewport_width", 960),
			ProjectSettings.get_setting("display/window/size/viewport_height", 540))
	await _check_menu()
	if _finished:
		return
	await _start_shift()
	if _finished:
		return
	await _check_pointer_choice()
	if _finished:
		return
	await _check_hold_to_listen()
	if _finished:
		return
	await _check_keyboard_choice()
	if _finished:
		return
	await _check_pause()
	if _finished:
		return
	await _check_restart()
	if _finished:
		return
	await _check_win()
	if _finished:
		return
	await _check_loss()
	if _finished:
		return
	await _check_end_to_menu()
	_finish()

func _check_menu() -> void:
	var packed := load(MENU_SCENE) as PackedScene
	_check(packed != null, "the title screen scene loads")
	if packed == null:
		return
	var menu := packed.instantiate()
	_check(menu != null, "the title screen instantiates")
	if menu == null:
		return
	# Boot the main scene the way the engine and the scenario runner do. Calling
	# change_scene_to_file here would leave the change pending until the idle
	# pass, which is the frame-order trap this suite now waits out explicitly.
	get_tree().root.add_child(menu)
	get_tree().current_scene = menu
	await _process_frames(2)
	_check(get_tree().current_scene == menu, "the title screen is current")
	_check(GameState.state == GameState.State.MENU, "the game boots on the menu")
	var play := menu.get_node_or_null("Safe/Center/Panel/Box/Play") as Button
	var quit := menu.get_node_or_null("Safe/Center/Panel/Box/Quit") as Button
	_check(play != null, "the menu has a Play button")
	_check(quit != null, "the menu has a Quit button")
	if play != null:
		_check(play.has_focus(), "Play has keyboard focus")
	if quit != null:
		_check(quit.visible == not OS.has_feature("web"), "Quit follows the Web rule")
	if play != null:
		await _check_narrow_control(play, menu.get_node("Safe/Center/Panel"))
	await _press_key(KEY_ENTER)

func _start_shift() -> void:
	var scene: Node = await _wait_for_scene(GAME_SCENE)
	_game = scene as ShiftScreen
	_check(_game != null, "Play enters the shift screen")
	if _game == null:
		return
	_check(GameState.is_playing(), "GameState marks the shift as playing")
	_check(GameState.call_index == 0, "the first call is active")
	_check(GameState.call_count == 5, "the shift has five calls")
	_check(GameState.trust == GameState.START_TRUST, "trust starts at two")
	_check(GameState.choices == 0, "no reply has been chosen")
	_check(_game.choice_buttons[0].has_focus(), "the first choice has keyboard focus")
	await _check_narrow_control(_game.choice_buttons[0], _game.get_node("Safe"))
	_check(_game.current_call.get("caller") == "Mara", "the first caller is loaded")
	var probe: Variant = StudioProbe.snapshot()
	if probe is Dictionary:
		var values := probe as Dictionary
		var state_values: Variant = values.get("gameState")
		_check(
			state_values is Dictionary and int((state_values as Dictionary).get("state", -1)) == 1,
			"StudioProbe reads the playing state",
		)
		_check(
			str(values.get("hudText", "")).contains("Mara"),
			"StudioProbe sees the caller on screen",
		)
	else:
		_fail("StudioProbe.snapshot() returns a Dictionary")

func _check_pointer_choice() -> void:
	var steady := _game.choice_buttons[1]
	await _click_control(steady)
	_check(_game.reply_panel.visible, "a pointer click on a choice shows its reply")
	_check(GameState.choices == 1, "the pointer choice counts")
	_check(GameState.trust == GameState.START_TRUST, "a steady reply leaves trust unchanged")
	_check(str(_game.reply_label.text).contains("fourteen"), "the chosen reply is on screen")
	await _click_control(_game.continue_button)
	_check(_game.phase == "choice", "a pointer Next caller advances the shift")
	_check(GameState.call_index == 1, "the second call is active")
	_check(GameState.calls == 1, "one call is complete")
	# The second press of a double click on Next caller lands after the next
	# call's choices replace that button under the cursor. It is not a choice.
	await _click_control(_game.choice_buttons[0], true)
	_check(GameState.choices == 1, "a double click does not answer the next call")

func _check_hold_to_listen() -> void:
	Input.action_press("listen")
	await get_tree().create_timer(LISTEN_HOLD_SECONDS).timeout
	Input.action_release("listen")
	await _frames(2)
	_check(GameState.listened == 1, "holding L counts as hearing the caller out")
	_check(_game.caller_detail.visible, "hearing them out reveals the detail")
	_check(_game.listen_button.disabled, "the listen button settles into Heard")

func _check_keyboard_choice() -> void:
	await _press_key(KEY_1)
	_check(GameState.choices == 2, "a number key chooses a reply")
	_check(GameState.trust == GameState.START_TRUST + 1, "a warm reply raises trust")
	await _press_key(KEY_ENTER)
	await _frames(2)
	_check(GameState.calls == 2, "Enter advances from the reply")
	_check(GameState.call_index == 2, "the third call is active")

func _check_pause() -> void:
	await _press_key(KEY_ESCAPE)
	await _frames(2)
	_check(GameState.state == GameState.State.PAUSED, "Escape pauses the shift")
	_check(_game.pause_menu.visible, "the pause overlay is visible")
	await _press_key(KEY_ESCAPE)
	await _frames(2)
	_check(GameState.is_playing(), "Escape resumes the shift")
	_check(not _game.pause_menu.visible, "the pause overlay closes")

func _check_restart() -> void:
	var previous_id := _game.get_instance_id()
	await _press_key(KEY_R)
	var scene: Node = await _wait_for_scene(GAME_SCENE, previous_id)
	_game = scene as ShiftScreen
	_check(_game != null, "Restart reloads the shift screen")
	if _game == null:
		return
	_check(GameState.is_playing(), "Restart leaves the game playing")
	_check(GameState.call_index == 0, "Restart returns to the first call")
	_check(GameState.choices == 0, "Restart clears replies")
	_check(GameState.trust == GameState.START_TRUST, "Restart restores the starting trust")

func _check_win() -> void:
	await _click_control(_game.listen_button)
	_check(GameState.listened == 1, "Hear them out works by pointer too")
	_check(_game.caller_detail.visible, "the pointer path reveals the detail")
	for _call in 5:
		await _press_key(KEY_1)
		await _frames(2)
		_check(_game.reply_panel.visible, "the warm reply resolves")
		await _press_key(KEY_ENTER)
		await _frames(3)
	_check(GameState.state == GameState.State.WON, "five warm replies win the shift")
	_check(GameState.won, "the won flag is set")
	_check(GameState.calls == 5, "all five calls are complete")
	_check(GameState.cold == 0, "the winning run takes no cold replies")
	_check(GameState.trust >= GameState.WIN_TRUST, "the winning run keeps trust")
	_check(_game.end_screen.visible, "the win screen is visible")
	_check(_game.end_screen.title.text == "Shift held", "the win screen names the result")
	var previous_id := _game.get_instance_id()
	await _press_key(KEY_ENTER)
	var scene: Node = await _wait_for_scene(GAME_SCENE, previous_id)
	_game = scene as ShiftScreen
	_check(_game != null and GameState.is_playing(), "Play again starts a fresh shift")
	if _game == null:
		return

func _check_loss() -> void:
	if _game == null:
		return
	for _call in 3:
		await _press_key(KEY_3)
		await _frames(2)
		_check(_game.reply_panel.visible, "the cold reply resolves")
		await _press_key(KEY_ENTER)
		await _frames(3)
	_check(GameState.state == GameState.State.LOST, "three cold replies lose the shift")
	_check(GameState.cold == 3, "the losing run records three cold replies")
	_check(not GameState.won, "the losing run is not marked won")
	_check(not GameState.loss_reason.is_empty(), "the losing run records its reason")
	_check(_game.end_screen.visible, "the loss screen is visible")
	_check(_game.end_screen.title.text == "Shift over", "the loss screen names the result")

func _check_end_to_menu() -> void:
	if _game == null:
		return
	var previous_id := _game.get_instance_id()
	await _click_control(_game.end_screen.main_menu_button)
	var menu: Node = await _wait_for_scene(MENU_SCENE, previous_id)
	_check(menu != null, "the end screen returns to a scene")
	_check(GameState.state == GameState.State.MENU, "Main menu returns to the title state")
	if menu == null:
		return
	var play := menu.get_node_or_null("Safe/Center/Panel/Box/Play") as Button
	_check(play != null and play.has_focus(), "the returned menu focuses Play")

func _press_key(keycode: int) -> void:
	var down := InputEventKey.new()
	down.keycode = keycode
	down.physical_keycode = keycode
	down.pressed = true
	Input.parse_input_event(down)
	await get_tree().physics_frame
	var up := InputEventKey.new()
	up.keycode = keycode
	up.physical_keycode = keycode
	up.pressed = false
	Input.parse_input_event(up)
	await get_tree().physics_frame

func _click_control(control: Control, double_click := false) -> void:
	var centre := control.get_global_rect().get_center()
	var motion := InputEventMouseMotion.new()
	motion.position = centre
	motion.global_position = centre
	get_viewport().push_input(motion, true)
	await get_tree().process_frame
	var down := InputEventMouseButton.new()
	down.button_index = MOUSE_BUTTON_LEFT
	down.button_mask = MOUSE_BUTTON_MASK_LEFT
	down.pressed = true
	down.double_click = double_click
	down.position = centre
	down.global_position = centre
	get_viewport().push_input(down, true)
	await get_tree().process_frame
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.pressed = false
	up.position = centre
	up.global_position = centre
	get_viewport().push_input(up, true)
	await get_tree().process_frame

func _check_narrow_control(button: Button, panel: Control) -> void:
	var window := get_tree().root
	var previous_size := window.size
	window.size = Vector2i(480, 800)
	await _process_frames(4)
	var scale := window.get_final_transform().get_scale()
	_check(button.get_theme_font_size("font_size") * scale.y >= 14.0,
		"480px layout keeps primary control text readable")
	_check(button.size.y * scale.y >= 44.0,
		"480px layout keeps primary controls at least 44px high")
	var bounds := panel.get_global_rect()
	var available := window.get_visible_rect()
	_check(bounds.position.x >= available.position.x and bounds.end.x <= available.end.x,
		"480px layout keeps the panel inside the viewport")
	window.size = previous_size
	await _process_frames(4)

func _frames(count: int) -> void:
	for _frame in count:
		await get_tree().physics_frame

func _process_frames(count: int) -> void:
	for _frame in count:
		await get_tree().process_frame

## Scene changes are applied on the idle pass, after the frame's physics steps.
## Waiting a fixed number of physics frames can check `current_scene` before the
## change lands (the first engine frame runs several physics steps at once), so
## wait for the real scene at `path`. A reload must produce a new instance, hence
## `previous_id`. One more idle frame lets the new layout sort before a pointer
## click reads a Control's rect. Null means the change never arrived.
func _wait_for_scene(path: String, previous_id: int = 0) -> Node:
	var tree := get_tree()
	for _frame in SCENE_WAIT_FRAMES:
		var scene := tree.current_scene
		if (
			scene != null
			and scene.scene_file_path == path
			and scene.get_instance_id() != previous_id
		):
			await tree.process_frame
			return scene
		await tree.process_frame
	return null

func _check(condition: bool, label: String) -> void:
	_checks += 1
	if _finished:
		return
	if condition:
		print("  ok    ", label)
		return
	_fail(label)

func _fail(label: String) -> void:
	if _finished:
		return
	_failures.append(label)
	_finish()

func _finish() -> void:
	if _finished:
		return
	_finished = true
	finished = true
	Input.action_release("listen")
	if _failures.is_empty():
		await _teardown()
		print("SMOKE PASS: %d checks" % _checks)
		get_tree().quit(0)
		return
	printerr("SMOKE FAIL: %d of %d checks failed" % [_failures.size(), _checks])
	for failure in _failures:
		printerr("  failed: ", failure)
	get_tree().quit(1)

## The audio autoload starts the music and UI voices; release them before quitting
## so the engine does not report their streams as leaked instances at exit.
func _teardown() -> void:
	for child in get_tree().root.get_children():
		if child != self and child != Audio and child != GameState:
			child.free()
	await get_tree().process_frame
	await get_tree().process_frame
	Audio.stop_all()
	await _wait_for_mix()
	for _frame in 6:
		await get_tree().process_frame

func _wait_for_mix() -> void:
	var since := AudioServer.get_time_since_last_mix()
	for _frame in 600:
		await get_tree().process_frame
		if AudioServer.get_time_since_last_mix() < since:
			return
