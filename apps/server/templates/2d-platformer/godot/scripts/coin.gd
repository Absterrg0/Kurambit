## A coin. The player walks into it, the counter goes up and the coin pops: the scene
## is reactivated by `reset()` on a restart, so nothing has to be re-instanced.
class_name Coin
extends Area2D

@onready var sprite: AnimatedSprite2D = $Sprite

var _home := Vector2.ZERO
var _taken := false
var _bob := 0.0

func _ready() -> void:
	_home = sprite.position
	_bob = randf() * TAU
	body_entered.connect(_on_body_entered)

func _process(delta: float) -> void:
	if _taken:
		return
	# A slow bob, so a row of coins never looks like a static tile.
	_bob += delta * 3.4
	sprite.position = _home + Vector2(0.0, sin(_bob) * 1.2)

func collect() -> void:
	if _taken:
		return
	_taken = true
	set_deferred("monitoring", false)
	GameState.collect("Coin")
	Audio.play("coin", randf_range(0.98, 1.08))
	var tween := create_tween()
	tween.set_parallel()
	tween.tween_property(sprite, "position", sprite.position + Vector2(0.0, -12.0), 0.28)
	tween.tween_property(sprite, "modulate:a", 0.0, 0.28)
	tween.tween_property(sprite, "scale", Vector2(1.4, 1.4), 0.28)
	tween.chain().tween_callback(func() -> void: visible = false)

func reset() -> void:
	_taken = false
	visible = true
	monitoring = true
	sprite.position = _home
	sprite.scale = Vector2.ONE
	sprite.modulate = Color.WHITE
	sprite.play("spin")

func _on_body_entered(body: Node2D) -> void:
	if body is Player:
		collect()
