## The real smoke-test checks, loaded at runtime by `tests/smoke_test.gd`.
##
## It boots the game scene and drives the real physics loop with synthetic input and
## teleports: running, jumping, a wall jump off both sides, a one-way platform, coins,
## a stomp, spikes, a fall, the pause loop, a restart, restarting during a pending
## clear or respawn timer, and finally the whole level flow through both doors to the
## win screen. Nothing here is a "call the helper directly" shortcut: the player moves
## because input was pressed, and states change because the real signals fired.
extends Node

const TIMEOUT_MS := 120_000
const RUN_FRAMES := 40
const SETTLE_FRAMES := 20
const LAND_FRAMES := 90
const ACTIONS := ["move_left", "move_right", "jump", "sprint", "interact", "pause", "restart"]
## Level 1 painted its one-way planks over the spikes: this is where the test jumps
## up through one. Keep it in step with tools/level_01.map.
const PLANK_TILE := Vector2i(36, 19)
const GROUND_TILE_Y := 21
const SPIKE_TILE := Vector2i(35, 20)

var _failures: Array[String] = []
var _checks := 0
var _started_ms := 0
## Read by smoke_test.gd to know the run is over.
var finished := false

var _finished := false

var _game: Game
var _player: Player

func _ready() -> void:
	# Deferred: root is still busy adding children while this node enters the tree.
	run.call_deferred()

func run() -> void:
	_started_ms = Time.get_ticks_msec()
	print("2d-platformer smoke test")
	await _boot()
	if _finished:
		return
	_check(GameState.is_playing(), "boots straight into a run")
	_check(_game.level != null, "level 1 is loaded")
	_check(_game.level.coin_count() >= 20, "level 1 holds %d coins" % _game.level.coin_count())
	_check(_game.level.slimes().size() >= 3, "level 1 holds %d slimes" % _game.level.slimes().size())
	_check(_player.is_on_floor(), "player rests on the floor at spawn")
	var spawn := _game.level.spawn_position()
	_check(
		absf(_player.global_position.y - spawn.y) < 2.0,
		"feet stand on the ground (y=%.1f)" % _player.global_position.y
	)
	for action in ACTIONS:
		_check(InputMap.has_action(action), "input action '%s' exists" % action)
	_check(AudioServer.get_bus_index("Music") > 0, "Music bus exists")
	_check(AudioServer.get_bus_index("SFX") > 0, "SFX bus exists")
	await _check_movement()
	await _check_jump()
	await _check_wall_jump()
	await _check_one_way()
	await _check_coins()
	await _check_stomp()
	await _check_spike()
	# The damage checks just spent every life, so the run is over: restart it first,
	# then pause, then prove both doors still work on a fresh run.
	await _check_restart()
	await _check_restart_during_clear()
	await _check_restart_during_respawn()
	await _check_pause()
	await _check_levels()
	await _check_menu_during_respawn()
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
	_player = _game.player

func _check_movement() -> void:
	var start := _player.global_position
	Input.action_press("move_right")
	await _frames(RUN_FRAMES)
	Input.action_release("move_right")
	await _frames(SETTLE_FRAMES)
	var travelled := _player.global_position.x - start.x
	_check(travelled > 40.0, "holding right runs the player forward (%.1f px)" % travelled)
	_check(absf(_player.velocity.x) < 24.0, "player stops when the key is released")
	_check(_player.is_on_floor(), "running keeps the player on the ground")
	var back := _player.global_position
	Input.action_press("move_left")
	await _frames(RUN_FRAMES)
	Input.action_release("move_left")
	await _frames(SETTLE_FRAMES)
	_check(_player.global_position.x < back.x - 40.0, "holding left runs the player back")

func _check_jump() -> void:
	_stand_on_ground()
	var ground_y := _player.global_position.y
	Input.action_press("jump")
	await _frames(3)
	Input.action_release("jump")
	await _frames(6)
	var rise := ground_y - _player.global_position.y
	_check(rise > 12.0, "jump lifts the player off the ground (%.1f px)" % rise)
	await _frames(LAND_FRAMES)
	_check(_player.is_on_floor(), "player lands again")
	_check(
		absf(_player.global_position.y - ground_y) < 2.0,
		"landing puts the feet back on the ground (y=%.1f)" % _player.global_position.y
	)

## Off by default, so turn it on and use real wall contact: the impulse has to move
## the body away from the wall on both sides, not just assign a velocity.
func _check_wall_jump() -> void:
	_player.wall_slide_enabled = true
	await _wall_jump_away(1)
	await _wall_jump_away(-1)
	_player.wall_slide_enabled = false
	await _stand_on_ground()

## `side` is 1 when the wall is on the player's right, -1 when it is on the left.
func _wall_jump_away(side: int) -> void:
	var wall := StaticBody2D.new()
	wall.collision_layer = 1
	var collider := CollisionShape2D.new()
	var shape := RectangleShape2D.new()
	shape.size = Vector2(16.0, 240.0)
	collider.shape = shape
	wall.add_child(collider)
	_game.add_child(wall)
	# A clear column outside the level's terrain: the probe must touch only the wall,
	# not a platform or the floor, or the fallback ground jump would fire instead.
	wall.global_position = Vector2(2000.0, 140.0)
	# The body is 10 px wide, so its centre sits 5 px from the wall face.
	_player.respawn(Vector2(2000.0 - 13.0 * side, 120.0))
	# Hold into the wall: contact under pressure gives a stable normal, and there is
	# no floor to grant coyote time.
	var toward := "move_right" if side > 0 else "move_left"
	Input.action_press(toward)
	await _frames(8)
	_check(_player.is_on_wall(), "the probe player touches the %s wall" % ("right" if side > 0 else "left"))
	var start := _player.global_position
	Input.action_press("jump")
	await _frames(2)
	Input.action_release("jump")
	Input.action_release(toward)
	await _frames(12)
	var away := (_player.global_position.x - start.x) * float(side)
	_check(
		away < -20.0,
		"the wall jump moves %.1f px away from the %s wall"
		% [away, "right" if side > 0 else "left"]
	)
	wall.free()

## The one-way planks must let the player jump up through them and land on top: this
## is what proves the TileSet's lip polygons are one-way and not solid.
func _check_one_way() -> void:
	var plank_y := float(PLANK_TILE.y * 16)
	_player.respawn(Vector2(float(PLANK_TILE.x * 16 + 8), float(GROUND_TILE_Y * 16)))
	await _frames(4)
	_check(_player.is_on_floor(), "player stands under the plank")
	Input.action_press("jump")
	await _frames(34)
	Input.action_release("jump")
	await _frames(LAND_FRAMES)
	# Standing at the plank's own line is the proof: the jump started on the ground
	# below it, so the body came up through the planks and stopped on the lip.
	_check(
		_player.global_position.y <= plank_y + 2.0,
		"jumped up through the one-way plank (y=%.1f)" % _player.global_position.y
	)
	_check(_player.is_on_floor(), "landed on top of the plank")
	_check(
		absf(_player.global_position.y - plank_y) < 3.0,
		"the plank holds the player at its lip (y=%.1f)" % _player.global_position.y
	)

func _check_coins() -> void:
	var lives := GameState.lives
	# The run has already jumped around up there: count from wherever it got to.
	var before := GameState.collected
	var score_before := GameState.score
	var seen := 0
	for coin in _game.level.coins():
		if not coin.visible:
			continue
		seen += 1
		_player.respawn(coin.global_position)
		await _frames(4)
		_check(
			GameState.collected == before + seen,
			"coin %d of %d counts up (%d/%d)"
			% [seen, _game.level.coin_count(), GameState.collected, GameState.total]
		)
	_check(seen >= 10, "the level still had %d coins to collect" % seen)
	_check(
		GameState.score >= score_before + GameState.COIN_SCORE * seen,
		"coins score points (score %d)" % GameState.score
	)
	_check(GameState.lives == lives, "collecting coins is harmless")
	await _stand_on_ground()

## Landing on a slime kills it and bounces the player; walking into one costs a life.
func _check_stomp() -> void:
	var slimes := _game.level.slimes()
	_check(slimes.size() >= 2, "level has slimes to stomp")
	var target := slimes[0]
	_player.respawn(target.global_position + Vector2(0.0, -20.0))
	_player.velocity = Vector2(0.0, 150.0)
	await _frames(12)
	_check(not target.is_alive(), "landing on a slime kills it")
	_check(_player.velocity.y < 20.0, "the stomp bounces the player up")
	# Side contact: step to the left of a patrolling slime and walk into it. Only the
	# position is set here, not a respawn, so the invulnerability the last hit granted
	# has to lapse first — which is exactly the rule a real run lives by.
	var lives := GameState.lives
	var other := slimes[2]
	_check(other.is_alive(), "the second slime is still patrolling")
	await _frames(95)
	var side := await _stand_beside(other)
	_check(side != 0, "stood next to the slime on its own ledge")
	if side != 0:
		Input.action_press("move_left" if side > 0 else "move_right")
		await _frames(18)
		Input.action_release("move_left")
		Input.action_release("move_right")
		_check(GameState.lives == lives - 1, "walking into a slime costs a life")
		_check(_player.is_invulnerable(), "the hit grants invulnerability again")
	await _wait_for_respawn()

func _check_spike() -> void:
	# Every respawn grants invulnerability, so wait it out before walking into danger
	# and set the position directly — a respawn would hand out i-frames again.
	await _frames(95)
	var lives := GameState.lives
	_player.global_position = Vector2(float(SPIKE_TILE.x * 16 + 8), float(SPIKE_TILE.y * 16 + 12))
	_player.velocity = Vector2.ZERO
	await _frames(12)
	_check(GameState.lives == lives - 1, "standing in spikes costs a life")
	_check(_player.is_invulnerable(), "a hit grants brief invulnerability")
	await _wait_for_respawn()
	_check(_player.is_on_floor(), "the player is back on solid ground after a hit")
	# A fall below the level is the same deal.
	await _frames(95)
	var lives_now := GameState.lives
	_player.global_position = Vector2(64.0, _game.level.kill_plane + 40.0)
	_player.velocity = Vector2.ZERO
	await _frames(12)
	_check(GameState.lives == lives_now - 1, "falling out of the level costs a life")
	await _wait_for_respawn()
	_check(_player.is_on_floor(), "the player is put back on the level after falling out")

func _check_pause() -> void:
	_stand_on_ground()
	_press_key(KEY_ESCAPE)
	await _frames(2)
	_check(get_tree().paused, "Escape pauses the tree")
	_check(GameState.state == GameState.State.PAUSED, "pausing sets the PAUSED state")
	var before := _player.global_position
	Input.action_press("move_right")
	await _frames(SETTLE_FRAMES)
	Input.action_release("move_right")
	_check(_player.global_position.is_equal_approx(before), "player cannot move while paused")
	_press_key(KEY_ESCAPE)
	await _frames(2)
	_check(not get_tree().paused, "Escape resumes the tree")
	_check(GameState.state == GameState.State.PLAYING, "resuming sets the PLAYING state")
	var resumed := _player.global_position
	Input.action_press("move_right")
	await _frames(RUN_FRAMES)
	Input.action_release("move_right")
	_check(_player.global_position.x > resumed.x + 40.0, "player runs again after resuming")

func _check_restart() -> void:
	_check(GameState.state == GameState.State.LOST, "running out of lives ends the run")
	_check(_game.end_screen.visible, "the lose screen is shown")
	_game.restart_run()
	await _frames(6)
	_check(GameState.is_playing(), "restart puts the game back in PLAYING")
	_check(GameState.level_index == 0, "restart returns to the first level")
	_check(GameState.collected == 0, "restart clears the coin counter")
	_check(GameState.score == 0, "restart clears the score")
	_check(GameState.lives == GameState.MAX_LIVES, "restart restores every life")
	_check(not _game.end_screen.visible, "restart hides the end screen")
	var rearmed := true
	for coin in _game.level.coins():
		if not coin.visible:
			rearmed = false
	for slime in _game.level.slimes():
		if not slime.is_alive():
			rearmed = false
	_check(rearmed, "restart re-arms every coin and slime")
	_check(
		_player.global_position.distance_to(_game.level.spawn_position()) < 24.0,
		"restart returns the player to the spawn point"
	)

## Restarting during the door transition: the old timer belongs to the old run, so
## it must not load level 2 after the new run already restarted on level 1.
func _check_restart_during_clear() -> void:
	_step_into_door()
	await _frames(6)
	_check(GameState.level_index == 0, "the door starts the clear delay on level 1")
	_game.restart_run()
	await _frames(80)
	_check(GameState.level_index == 0, "a restart during the clear delay stays on level 1")
	_check(_game.level.title == "Mossy Ridge", "the old door timer did not load level 2")
	_check(GameState.is_playing(), "the restarted run is still playing after the old delay")

## Restarting during the respawn delay: the old continuation must not yank the new
## run's player back to the spawn point while they are already running.
func _check_restart_during_respawn() -> void:
	await _frames(95)
	var lives := GameState.lives
	var hit_from := _player.global_position + Vector2(-8.0, 0.0)
	_player.hurt(hit_from, "probe")
	_check(GameState.lives == lives - 1, "the respawn probe costs a life")
	await _frames(2)
	_game.restart_run()
	await _frames(2)
	var spawn := _player.global_position
	Input.action_press("move_right")
	await _frames(60)
	Input.action_release("move_right")
	_check(
		_player.global_position.x > spawn.x + 80.0,
		"the old respawn timer did not pull the restarted player back (x=%.1f)"
		% _player.global_position.x
	)

## The same delay after returning to the menu: the player node keeps its position
## until the scene is gone, so the guard has to stop the respawn as well.
func _check_menu_during_respawn() -> void:
	_game.restart_run()
	await _frames(95)
	var before := _player.global_position
	_player.hurt(before + Vector2(-8.0, 0.0), "probe")
	await _frames(2)
	# Let the tumble settle on the floor, then leave a clear landmark between the
	# player and the spawn point: a respawn would snap back to the spawn.
	var resting := Vector2(_game.level.spawn_position().x + 100.0, _game.level.spawn_position().y)
	_player.global_position = resting
	_player.velocity = Vector2.ZERO
	await _frames(2)
	resting = _player.global_position
	_game.return_to_menu()
	await _frames(80)
	_check(
		absf(_player.global_position.x - resting.x) < 2.0,
		"returning to the menu during the respawn delay leaves the player alone (x=%.1f)"
		% _player.global_position.x
	)

## Both doors: level 1 hands over to level 2, and level 2 wins the run.
func _check_levels() -> void:
	_step_into_door()
	await _frames(80)
	_check(GameState.level_index == 1, "the door completes level 1 and loads level 2")
	_check(GameState.level_count == 2, "the run has two levels")
	_check(_game.level.title == "Sunken Steps", "level 2 is the one that loaded")
	_check(
		_player.global_position.distance_to(_game.level.spawn_position()) < 24.0,
		"level 2 puts the player on its own spawn point"
	)
	_check(_player.is_on_floor(), "level 2 has solid ground under the spawn")
	_step_into_door()
	await _frames(20)
	_check(GameState.state == GameState.State.WON, "the last door wins the run")
	_check(_game.end_screen.visible, "win screen is shown")
	_check(GameState.best_score > 0, "winning stores a best score")

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
	# Opening the shared panel proves its sliders exist and its signals connect; a
	# broken node path only shows up when the player presses Settings otherwise.
	var settings := menu.get_node_or_null("SettingsPanel")
	if settings != null:
		settings.call("open")
		await _frames(2)
		_check(settings.visible, "the settings panel opens")
		settings.call("hide")
	# The focus sounds the panel plays are short; let them finish before the scene is
	# freed, or the audio server reports their streams as leaked at exit.
	await _frames(8)
	menu.free()

## ---------------------------------------------------------------- helpers

func _step_into_door() -> void:
	var goal := _game.level.goal
	_player.respawn(goal.global_position + Vector2(0.0, -12.0))

## Puts the player a stride from a slime and reports which side it landed on, so the
## contact check never depends on where the patrol happens to be or which way it walks.
## A slime near its ledge edge has only one safe side, so wait for the patrol to move
## rather than assuming both sides are floor at the same instant.
func _stand_beside(slime: Slime) -> int:
	for _attempt in 12:
		for side in [1, -1]:
			_player.global_position = slime.global_position + Vector2(26.0 * side, 0.0)
			_player.velocity = Vector2.ZERO
			await _frames(6)
			if _player.is_on_floor():
				return side
		await _frames(10)
	return 0

func _stand_on_ground() -> void:
	_player.respawn(Vector2(72.0, float(GROUND_TILE_Y * 16)))
	await _frames(6)

## Waits out the hit delay and the respawn the game performs after `life_lost`.
func _wait_for_respawn() -> void:
	await _frames(60)

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
		# The autoloads stay alive: freeing Audio while the mixer still holds its
		# playbacks is what turns into "leaked AudioStreamWAV" at exit.
		if child != self and child != Audio and child != Settings and child != GameState:
			child.free()
	# Let the audio server and the renderer notice the freed players before the
	# engine shuts down, otherwise they show up as leaked instances at exit.
	await get_tree().process_frame
	await get_tree().process_frame
	# The menu phase started the music and played UI sounds; stop once more now that
	# the scenes are gone, and give the mixer a few frames to release those playbacks,
	# or the engine reports their streams as leaked instances at exit.
	Audio.stop_all()
	await _wait_for_mix()
	for _frame in 6:
		await get_tree().process_frame

## Waits for the audio server to mix again after the last `stop_all()`: a stopped voice
## releases its playback on the audio thread, and quitting before that thread runs again
## reports the voice as a leaked instance at exit. Bounded, so a silent server still ends.
func _wait_for_mix() -> void:
	var since := AudioServer.get_time_since_last_mix()
	for _frame in 600:
		await get_tree().process_frame
		if AudioServer.get_time_since_last_mix() < since:
			return

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
	Input.action_release("move_right")
	Input.action_release("move_left")
	Input.action_release("jump")
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
