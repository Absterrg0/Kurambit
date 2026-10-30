## The real smoke-test checks, loaded at runtime by `tests/smoke_test.gd`.
##
## Reference-game assertions: relic totals and gate flow test the shipped level. A new
## game adapts this file to its DESIGN.md scope (rewrite counts, drop checks for cut
## mechanics) and keeps meaningful checks for everything retained and promised. The
## server only requires that the canonical suite exits 0; these numbers are not
## server-owned law.
## It boots the game scene and drives the real physics loop with synthetic input and
## teleports: movement, jumping, every relic, the gate, a death below the kill plane,
## pause/resume and restart. Nothing here is a "call the helper directly" shortcut:
## the player moves because input was pressed, and states change because the real
## signals fired.
extends Node

const TIMEOUT_MS := 120_000
const MOVE_FRAMES := 45
const LAND_FRAMES := 90
const TRACE_FRAMES := 30
const ACTIONS := [
	"move_forward",
	"move_back",
	"move_left",
	"move_right",
	"jump",
	"sprint",
	"interact",
	"pause",
	"look_left",
	"look_right",
	"look_up",
	"look_down",
]

var _failures: Array[String] = []
var _checks := 0
var _started_ms := 0
## Read by smoke_test.gd to know the run is over.
var finished := false

var _finished := false

var _game: Game
var _level: Level
var _player: Player

func _ready() -> void:
	# Deferred: root is still busy adding children while this node enters the tree.
	run.call_deferred()

func run() -> void:
	_started_ms = Time.get_ticks_msec()
	print("3d-explorer smoke test")
	await _boot()
	if _finished:
		return
	_check(GameState.is_playing(), "boots straight into a run")
	_check(
		GameState.total > 0 and _level.relic_count() == GameState.total,
		"level reports %d relics" % _level.relic_count(),
	)
	_check(_player.is_on_floor(), "player rests on the floor at spawn")
	_check(
		absf(_player.global_position.y - _level.spawn_transform().origin.y) < 0.12,
		"feet stand on the ground (y=%.3f)" % _player.global_position.y,
	)
	for action in ACTIONS:
		_check(InputMap.has_action(action), "input action '%s' exists" % action)
	_check(AudioServer.get_bus_index("Music") > 0, "Music bus exists")
	_check(AudioServer.get_bus_index("SFX") > 0, "SFX bus exists")
	await _check_movement()
	await _check_jump()
	await _check_relics()
	await _check_gate()
	await _check_restart()
	await _check_death()
	await _check_pause()
	await _check_hazard()
	await _check_menu()
	_finish()

func _boot() -> void:
	var scene := load("res://scenes/game.tscn") as PackedScene
	if scene == null:
		_fail("game.tscn loads")
		return
	_game = scene.instantiate() as Game
	if _game == null:
		_fail("game.tscn has the Game script")
		return
	get_tree().root.add_child(_game)
	# The player spawns just above the ground and settles within a few frames.
	await _frames(10)
	_level = _game.level
	_player = _game.player

func _check_movement() -> void:
	var start := _player.global_position
	Input.action_press("move_forward")
	await _frames(MOVE_FRAMES)
	Input.action_release("move_forward")
	await _frames(20)
	var travelled := _player.global_position.distance_to(start)
	_check(travelled > 1.5, "holding forward moves the player (%.2f m)" % travelled)
	_check(
		Vector2(_player.velocity.x, _player.velocity.z).length() < 0.6,
		"player stops when the key is released",
	)

func _check_jump() -> void:
	Input.action_press("jump")
	await _frames(2)
	Input.action_release("jump")
	await _frames(6)
	_check(_player.global_position.y > 0.25, "jump lifts the player off the ground")
	await _frames(LAND_FRAMES)
	_check(_player.is_on_floor(), "player lands again")
	_check(
		absf(_player.global_position.y) < 0.12,
		"landing puts the feet back on the ground (y=%.3f)" % _player.global_position.y,
	)

func _check_relics() -> void:
	_check(not _level.goal.unlocked, "gate starts locked")
	# A locked gate must not end the run: touch it before collecting anything.
	_player.global_position = _level.goal.global_position + Vector3(0.0, 0.4, 0.0)
	await _frames(4)
	_check(GameState.is_playing(), "the locked gate does not win the run")
	var relics := _level.relics()
	_check(relics.size() >= 5, "level has at least five relics")
	var expected := 0
	for relic in relics:
		expected += 1
		_player.global_position = relic.global_position
		await _frames(4)
		_check(
			GameState.collected == expected,
			"relic '%s' counts up (%d/%d)" % [relic.label, GameState.collected, GameState.total],
		)
	_check(GameState.score >= GameState.RELIC_SCORE * expected, "relics score points")
	_check(_level.goal.unlocked, "gate unlocks once every relic is collected")

func _check_gate() -> void:
	_player.global_position = _level.goal.global_position + Vector3(0.0, 0.4, 0.0)
	await _frames(4)
	_check(GameState.state == GameState.State.WON, "walking into the open gate wins the run")
	_check(_game.end_screen.visible, "win screen is shown")
	_check(GameState.best_score > 0, "winning stores a best score")

func _check_restart() -> void:
	_game.restart_run()
	await _frames(4)
	_check(GameState.is_playing(), "restart puts the game back in PLAYING")
	_check(GameState.collected == 0, "restart clears the relic counter")
	_check(GameState.score == 0, "restart clears the score")
	_check(GameState.lives == GameState.MAX_LIVES, "restart restores every life")
	_check(GameState.health == GameState.MAX_HEALTH, "restart restores health")
	_check(not _game.end_screen.visible, "restart hides the win screen")
	_check(not _level.goal.unlocked, "restart locks the gate again")
	var rearmed := true
	for relic in _level.relics():
		if relic.collected or not relic.visible:
			rearmed = false
	_check(rearmed, "restart re-arms every relic")
	_check(
		_player.global_position.distance_to(_level.spawn_transform().origin) < 2.5,
		"restart returns the player to the spawn point",
	)

func _check_death() -> void:
	var lives := GameState.lives
	_player.global_position = Vector3(0.0, -11.8, 0.0)
	await _frames(6)
	_check(GameState.lives == lives - 1, "falling below the kill plane costs a life")
	_check(_player.global_position.y > -1.0, "player respawns above the kill plane")
	_check(
		_player.global_position.distance_to(_level.spawn_transform().origin) < 2.5,
		"player respawns at the last checkpoint",
	)

func _check_pause() -> void:
	_press_key(KEY_ESCAPE)
	await _frames(2)
	_check(get_tree().paused, "Escape pauses the tree")
	_check(GameState.state == GameState.State.PAUSED, "pausing sets the PAUSED state")
	_check(not _player.can_process(), "paused run stops processing the player")
	var before := _player.global_position
	Input.action_press("move_forward")
	await _frames(TRACE_FRAMES)
	Input.action_release("move_forward")
	_check(_player.global_position.is_equal_approx(before), "player cannot move while paused")
	_press_key(KEY_ESCAPE)
	await _frames(2)
	_check(not get_tree().paused, "Escape resumes the tree")
	_check(GameState.state == GameState.State.PLAYING, "resuming sets the PLAYING state")
	_check(_player.can_process(), "resumed run processes the player again")
	var resumed := _player.global_position
	Input.action_press("move_forward")
	await _frames(TRACE_FRAMES)
	Input.action_release("move_forward")
	_check(
		_player.global_position.distance_to(resumed) > 0.5, "player moves again after resuming"
	)

## The lava pool damages whoever stands in it and knocks them back out.
func _check_hazard() -> void:
	var health := GameState.health
	# Clear of the bridge deck, so the player really stands in the lava.
	_player.global_position = Vector3(-10.0, -0.7, 5.6)
	# Long enough for the respawn invulnerability from the previous check to expire.
	await _frames(100)
	_check(GameState.health < health, "standing in lava costs health")
	_check(_player.is_invulnerable(), "hazard damage grants brief invulnerability")
	_player.global_position = _level.spawn_transform().origin
	await _frames(4)

## The title screen is a scene like any other: loading it here catches a broken menu
## (missing node, bad theme reference) without a browser.
func _check_menu() -> void:
	var scene := load("res://scenes/main_menu.tscn") as PackedScene
	if scene == null:
		_fail("main_menu.tscn loads")
		return
	var menu := scene.instantiate() as Control
	if menu == null:
		_fail("main_menu.tscn has the menu script")
		return
	get_tree().root.add_child(menu)
	await _frames(2)
	_check(menu.get_node_or_null("Menu/Panel/Box/Play") != null, "menu has a Play button")
	_check(menu.get_node_or_null("SettingsPanel") != null, "menu has a settings panel")
	_check(GameState.state == GameState.State.MENU, "menu puts the game state in MENU")
	menu.free()

func _frames(count: int) -> void:
	for _index in count:
		if _finished:
			return
		if Time.get_ticks_msec() - _started_ms > TIMEOUT_MS:
			_fail("test timed out after %d ms" % TIMEOUT_MS)
			return
		await get_tree().physics_frame

func _press_key(keycode: Key) -> void:
	var pressed := InputEventKey.new()
	pressed.physical_keycode = keycode
	pressed.pressed = true
	Input.parse_input_event(pressed)
	var released := InputEventKey.new()
	released.physical_keycode = keycode
	released.pressed = false
	Input.parse_input_event(released)

## Frees the scene tree before quitting: the engine prints RID leak warnings for
## anything still alive at exit, and those warnings look like a failed run.
func _teardown() -> void:
	Audio.stop_all()
	# Give the audio server a frame to release the playbacks it was mixing.
	await get_tree().process_frame
	await get_tree().process_frame
	for child in get_tree().root.get_children():
		if child != self:
			child.free()
	# Let the audio server and the renderer notice the freed players before the
	# engine shuts down, otherwise they show up as leaked instances at exit.
	await get_tree().process_frame
	await get_tree().process_frame

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
	Input.action_release("move_forward")
	if _failures.is_empty():
		await _teardown()
		print("SMOKE PASS: %d checks" % _checks)
		get_tree().quit(0)
		return
	printerr("SMOKE FAIL: %d of %d checks failed" % [_failures.size(), _checks])
	for failure in _failures:
		printerr("  failed: ", failure)
	# No teardown on failure: quitting here ends the loop and leaves the suspended
	# coroutine alone, instead of freeing nodes out from under it.
	get_tree().quit(1)
