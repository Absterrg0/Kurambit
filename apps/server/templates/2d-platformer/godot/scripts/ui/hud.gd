## In-run overlay: the coin counter with the life hearts, the level name and timer, toast
## messages, the level banner and the control hint, which fades out on a timer and as soon
## as the player touches the controls. Everything here listens to `GameState`; nothing in
## it changes the run.
class_name Hud
extends Control

const HINT_SECONDS := 12.0
const HINT_FADE := 0.6
## The hint fades over the last few seconds of its timer, or in HINT_FADE once the
## player touches the controls.
const HINT_FADE_WINDOW := 3.0
const BANNER_IN := 0.25
const BANNER_HOLD := 1.4

const Palette := preload("res://assets/palette.tres")

const HEART_FULL := preload("res://assets/sprites/heart_full.png")
const HEART_EMPTY := preload("res://assets/sprites/heart_empty.png")

@onready var coin_value: Label = $Coins/Box/Count/Value
@onready var hearts: HBoxContainer = $Coins/Box/Lives
@onready var level_name: Label = $Level/Box/Name
@onready var time_label: Label = $Level/Box/Time
@onready var toast: Label = $Toast
@onready var banner: Label = $Banner
@onready var hint: PanelContainer = $Hint

var _hint_timer := HINT_SECONDS
var _hint_window := HINT_FADE_WINDOW
var _toast_tween: Tween
var _banner_tween: Tween

func _ready() -> void:
	GameState.collected_changed.connect(_on_collected)
	GameState.lives_changed.connect(_on_lives)
	GameState.level_started.connect(_on_level_started)
	GameState.state_changed.connect(_on_state_changed)
	GameState.toast.connect(_show_toast)
	_on_collected(GameState.collected, GameState.total, GameState.score)
	_on_lives(GameState.lives)
	level_name.text = GameState.level_name
	# The timer is the quietest label on screen: take its colour from the palette's UI
	# accent role instead of repeating an RGB literal in the scene.
	time_label.add_theme_color_override("font_color", Palette.ui_accent)

func _process(delta: float) -> void:
	time_label.text = GameState.time_text(GameState.run_seconds)
	if _hint_timer > 0.0:
		_hint_timer = maxf(_hint_timer - delta, 0.0)
		hint.modulate.a = clampf(_hint_timer / _hint_window, 0.0, 1.0)

## The hint sits over the level, so the first real input takes it away: the player who is
## already running does not need to be told how to run.
func _unhandled_input(event: InputEvent) -> void:
	if _hint_timer <= 0.0 or not event.is_pressed() or event.is_echo():
		return
	for action in ["move_left", "move_right", "jump", "sprint"]:
		if event.is_action_pressed(action):
			_hint_timer = minf(_hint_timer, HINT_FADE)
			_hint_window = HINT_FADE
			return

func refresh() -> void:
	_on_collected(GameState.collected, GameState.total, GameState.score)
	_on_lives(GameState.lives)
	level_name.text = GameState.level_name

func _on_level_started(_index: int, _total: int) -> void:
	refresh()
	_hint_timer = HINT_SECONDS
	_hint_window = HINT_FADE_WINDOW
	hint.modulate.a = 1.0
	level_name.text = GameState.level_name
	banner.text = "%d — %s" % [GameState.level_number(), GameState.level_name]
	banner.modulate.a = 0.0
	if _banner_tween != null and _banner_tween.is_valid():
		_banner_tween.kill()
	_banner_tween = create_tween()
	_banner_tween.tween_property(banner, "modulate:a", 1.0, BANNER_IN)
	_banner_tween.tween_interval(BANNER_HOLD)
	_banner_tween.tween_property(banner, "modulate:a", 0.0, 0.7)

func _on_collected(collected: int, total: int, _score: int) -> void:
	coin_value.text = "%d / %d" % [collected, total]

func _on_lives(lives: int) -> void:
	var index := 0
	for child in hearts.get_children():
		var heart := child as TextureRect
		if heart != null:
			heart.texture = HEART_FULL if index < lives else HEART_EMPTY
		index += 1

func _on_state_changed(_state: GameState.State) -> void:
	visible = GameState.state != GameState.State.MENU

func _show_toast(text: String) -> void:
	toast.text = text
	toast.modulate.a = 0.0
	if _toast_tween != null and _toast_tween.is_valid():
		_toast_tween.kill()
	_toast_tween = create_tween()
	_toast_tween.tween_property(toast, "modulate:a", 1.0, 0.15)
	_toast_tween.tween_interval(1.9)
	_toast_tween.tween_property(toast, "modulate:a", 0.0, 0.6)
