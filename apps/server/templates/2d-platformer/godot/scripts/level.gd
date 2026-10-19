## The playable area. Owns the spawn point, the coin roster, the slimes, the
## checkpoints and the exit door, and exposes them to the game scene through this
## small API. Another level is a scene with the same containers: Spawn, Terrain,
## Pickups, Enemies, Checkpoints and Goal (see TEMPLATE.md).
class_name Level
extends Node2D

## Emitted when the player walks into the goal door. The game scene answers it by
## loading the next level, or by winning the run on the last one.
signal completed

@export var title := "Level"
## Level edges in pixels; the camera is clamped to this rectangle.
@export var camera_bounds := Rect2(0.0, 0.0, 640.0, 360.0)
## Where a life is lost without a checkpoint: a hidden volume below the level.
@export var kill_plane := 480.0

@onready var spawn: Marker2D = $Spawn
@onready var goal: Goal = $Goal

## The player, handed over by the game scene when this level is loaded: a level owns
## the world, the game scene owns the player. It stays null in the editor.
var player: Player

var _coins: Array[Coin] = []
var _slimes: Array[Slime] = []
var _checkpoints: Array[Checkpoint] = []
var _active_checkpoint: Checkpoint
var _completed := false

func _ready() -> void:
	for node in $Pickups.get_children():
		var coin := node as Coin
		if coin != null:
			_coins.append(coin)
	for node in $Enemies.get_children():
		var slime := node as Slime
		if slime != null:
			_slimes.append(slime)
	for node in $Checkpoints.get_children():
		var checkpoint := node as Checkpoint
		if checkpoint != null:
			_checkpoints.append(checkpoint)
			checkpoint.activated.connect(_on_checkpoint_activated)
	goal.entered.connect(_on_goal_entered)

## The coins in this level, in scene order. Treat the array as read-only.
func coins() -> Array[Coin]:
	return _coins

func coin_count() -> int:
	return _coins.size()

func slimes() -> Array[Slime]:
	return _slimes

func checkpoints() -> Array[Checkpoint]:
	return _checkpoints

func spawn_position() -> Vector2:
	return spawn.global_position

## Where a lost life puts the player back: the last checkpoint, or the spawn point.
func respawn_position() -> Vector2:
	if _active_checkpoint != null:
		return _active_checkpoint.respawn_position()
	return spawn.global_position

func bounds() -> Rect2:
	return camera_bounds

func is_completed() -> bool:
	return _completed

## Called by the game scene right after this level is instanced and reset.
func attach_player(target: Player) -> void:
	player = target

## Re-arms every coin, slime, checkpoint and the door. Called by the game scene on
## every start and restart, before the player is put on the spawn point.
func reset() -> void:
	_completed = false
	_active_checkpoint = null
	for coin in _coins:
		coin.reset()
	for slime in _slimes:
		slime.reset()
	for checkpoint in _checkpoints:
		checkpoint.reset()
	goal.reset()

## The bottomless pit: anything that falls past `kill_plane` costs a life.
func _physics_process(_delta: float) -> void:
	if player == null or not GameState.is_playing():
		return
	if player.global_position.y < kill_plane:
		return
	player.hurt(Vector2(player.global_position.x, kill_plane + 40.0), "fell")

func _on_checkpoint_activated(checkpoint: Checkpoint) -> void:
	_active_checkpoint = checkpoint

func _on_goal_entered() -> void:
	if _completed:
		return
	_completed = true
	completed.emit()
