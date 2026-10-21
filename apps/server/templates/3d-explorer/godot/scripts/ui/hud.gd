## In-run overlay: relic counter, vitality bar, life pips, toast messages, the control
## hint and the "click to look" prompt that the Web export needs before the pointer is
## captured.
class_name Hud
extends Control

const HINT_SECONDS := 15.0
const Palette := preload("res://materials/palette.tres")

@onready var relic_value: Label = $Status/Box/Relics/Value
@onready var vitality_value: Label = $Status/Box/Vitality/Value
@onready var vitality_bar: ProgressBar = $Status/Box/Vitality/Bar
@onready var pips: LifePips = $Status/Box/Lives/Pips
@onready var toast: Label = $Toast
@onready var hint: Label = $Hint
@onready var click_prompt: Label = $ClickPrompt

var _hint_timer := HINT_SECONDS
var _toast_tween: Tween
var _looked_once := false

func _ready() -> void:
	GameState.collected_changed.connect(_on_collected)
	GameState.health_changed.connect(_on_health)
	GameState.lives_changed.connect(_on_lives)
	GameState.run_started.connect(_on_run_started)
	GameState.toast.connect(_show_toast)
	_on_run_started(GameState.total)
	_on_collected(GameState.collected, GameState.total, GameState.score)
	_on_health(GameState.health, GameState.MAX_HEALTH)
	_on_lives(GameState.lives)

func _process(delta: float) -> void:
	if _hint_timer > 0.0:
		_hint_timer = maxf(_hint_timer - delta, 0.0)
		hint.modulate.a = clampf(_hint_timer / 3.0, 0.0, 1.0)
	var captured := Input.mouse_mode == Input.MOUSE_MODE_CAPTURED
	# The prompt is only useful until the player has looked around once.
	if captured:
		_looked_once = true
	click_prompt.visible = GameState.is_playing() and not captured and not _looked_once

func _on_run_started(_total: int) -> void:
	_hint_timer = HINT_SECONDS
	hint.modulate.a = 1.0

func _on_collected(collected: int, total: int, _score: int) -> void:
	relic_value.text = "%d / %d" % [collected, total]

func _on_health(health: float, maximum: float) -> void:
	vitality_bar.max_value = maximum
	vitality_bar.value = health
	vitality_value.text = "%d%%" % roundi(health / maximum * 100.0)
	vitality_bar.modulate = Palette.hazard if health <= maximum * 0.34 else Color.WHITE

func _on_lives(lives: int) -> void:
	pips.refresh(lives, GameState.MAX_LIVES)

func _show_toast(text: String) -> void:
	toast.text = text
	toast.modulate.a = 0.0
	if _toast_tween != null and _toast_tween.is_valid():
		_toast_tween.kill()
	_toast_tween = create_tween()
	_toast_tween.tween_property(toast, "modulate:a", 1.0, 0.15)
	_toast_tween.tween_interval(2.1)
	_toast_tween.tween_property(toast, "modulate:a", 0.0, 0.6)
