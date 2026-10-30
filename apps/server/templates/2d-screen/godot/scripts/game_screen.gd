## One shift at the desk. The screen owns presentation and the current call; the
## rules and every run value stay in GameState. Buttons and the 1/2/3 actions call
## the same `_choose`, and holding L and pressing Hear them out call the same
## `_reveal_detail`, so pointer and keyboard cannot drift apart.
class_name ShiftScreen
extends Control

const CallBook = preload("res://scripts/call_book.gd")
## Long enough to feel deliberate, short enough to stay out of the way.
const LISTEN_SECONDS := 0.7

@onready var status_call: Label = $Safe/Layout/TopBar/StatusCall
@onready var status_trust: Label = $Safe/Layout/TopBar/StatusTrust
@onready var status_cold: Label = $Safe/Layout/TopBar/StatusCold
@onready var status_heard: Label = $Safe/Layout/TopBar/StatusHeard
@onready var pause_button: Button = $Safe/Layout/TopBar/PauseButton
@onready var scroll: ScrollContainer = $Safe/Layout/MainScroll
@onready var portrait: Label = $Safe/Layout/MainScroll/Content/CallerPanel/CallerBox/CallerRow/Portrait/Initials
@onready var caller_name: Label = $Safe/Layout/MainScroll/Content/CallerPanel/CallerBox/CallerRow/NameBox/CallerName
@onready var caller_role: Label = $Safe/Layout/MainScroll/Content/CallerPanel/CallerBox/CallerRow/NameBox/CallerRole
@onready var caller_line: Label = $Safe/Layout/MainScroll/Content/CallerPanel/CallerBox/CallerLine
@onready var caller_detail: Label = $Safe/Layout/MainScroll/Content/CallerPanel/CallerBox/CallerDetail
@onready var choices_panel: PanelContainer = $Safe/Layout/MainScroll/Content/ChoicesPanel
@onready var choice_1: Button = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/Choice1
@onready var choice_2: Button = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/Choice2
@onready var choice_3: Button = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/Choice3
@onready var listen_button: Button = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/ListenFlow/ListenButton
@onready var listen_meter: ProgressBar = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/ListenFlow/ListenMeter
@onready var listen_hint: Label = $Safe/Layout/MainScroll/Content/ChoicesPanel/ChoicesBox/ListenFlow/ListenHint
@onready var reply_panel: PanelContainer = $Safe/Layout/MainScroll/Content/ReplyPanel
@onready var reply_label: Label = $Safe/Layout/MainScroll/Content/ReplyPanel/ReplyBox/ReplyLabel
@onready var effect_label: Label = $Safe/Layout/MainScroll/Content/ReplyPanel/ReplyBox/EffectLabel
@onready var continue_button: Button = $Safe/Layout/MainScroll/Content/ReplyPanel/ReplyBox/ContinueButton
@onready var pause_menu: ShiftPauseMenu = $PauseMenu
@onready var end_screen: ShiftEndScreen = $EndScreen

var current_call: Dictionary = {}
## "choice", "reply", "waiting" (between finish and the next call) or "end".
var phase := "choice"
var heard_this_call := false
var listen_elapsed := 0.0
var choice_buttons: Array[Button] = []

func _ready() -> void:
	choice_buttons = [choice_1, choice_2, choice_3]
	Audio.wire_ui(self)
	Audio.start_music()
	for index in choice_buttons.size():
		choice_buttons[index].pressed.connect(_choose.bind(index))
		choice_buttons[index].gui_input.connect(
			_on_choice_gui_input.bind(choice_buttons[index])
		)
	listen_button.pressed.connect(_on_listen_pressed)
	continue_button.pressed.connect(_continue)
	pause_button.pressed.connect(_pause)
	pause_menu.resume_requested.connect(_on_resume_requested)
	pause_menu.restart_requested.connect(_restart)
	pause_menu.main_menu_requested.connect(_to_menu)
	end_screen.restart_requested.connect(_restart)
	end_screen.main_menu_requested.connect(_to_menu)
	GameState.call_started.connect(_on_call_started)
	GameState.answered.connect(_on_answered)
	GameState.listened_changed.connect(_on_listened_changed)
	GameState.run_won.connect(_on_run_won)
	GameState.run_lost.connect(_on_run_lost)
	GameState.start_run(CallBook.CALLS.size())

func _show_call(index: int) -> void:
	if index < 0 or index >= CallBook.CALLS.size():
		return
	current_call = CallBook.CALLS[index]
	phase = "choice"
	heard_this_call = false
	listen_elapsed = 0.0
	listen_meter.value = 0.0
	listen_button.disabled = false
	listen_button.text = "Hear them out (L)"
	listen_hint.text = "Hold L or press the button to hear the rest."
	portrait.text = str(current_call["caller"]).left(1)
	caller_name.text = str(current_call["caller"])
	caller_role.text = str(current_call["role"])
	caller_line.text = str(current_call["line"])
	caller_detail.text = str(current_call.get("detail", ""))
	caller_detail.hide()
	var choices: Array = current_call.get("choices", [])
	for index_in_call in choice_buttons.size():
		var button := choice_buttons[index_in_call]
		var available := index_in_call < choices.size()
		button.visible = available
		if available:
			var choice: Dictionary = choices[index_in_call]
			button.text = "%d.  %s" % [index_in_call + 1, choice["text"]]
	choices_panel.show()
	reply_panel.hide()
	scroll.scroll_vertical = 0
	_refresh_status()
	choice_1.grab_focus()

func _process(delta: float) -> void:
	if GameState.state != GameState.State.PLAYING or phase != "choice" or heard_this_call:
		return
	if Input.is_action_pressed("listen"):
		listen_elapsed = minf(listen_elapsed + delta, LISTEN_SECONDS)
		listen_meter.value = listen_elapsed / LISTEN_SECONDS * 100.0
		if listen_elapsed >= LISTEN_SECONDS:
			_reveal_detail()
		return
	# Releasing early resets the hold; the button click still reveals at once.
	if listen_elapsed > 0.0:
		listen_elapsed = 0.0
		listen_meter.value = 0.0

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("pause") and GameState.is_playing():
		get_viewport().set_input_as_handled()
		_pause()
		return
	if event.is_action_pressed("restart") and GameState.is_playing():
		get_viewport().set_input_as_handled()
		_restart()
		return
	if not GameState.is_playing() or phase != "choice":
		return
	for index in choice_buttons.size():
		if event.is_action_pressed("choose_%d" % (index + 1)):
			get_viewport().set_input_as_handled()
			_choose(index)
			return

func _choose(index: int) -> void:
	if phase != "choice" or not GameState.is_playing():
		return
	var choices: Array = current_call.get("choices", [])
	if index < 0 or index >= choices.size():
		return
	var choice: Dictionary = choices[index]
	var trust_delta := int(choice.get("trust", 0))
	var cold_delta := int(choice.get("cold", 0))
	GameState.answer(trust_delta, cold_delta)
	reply_label.text = "%s: %s" % [current_call["caller"], choice["reply"]]
	if cold_delta > 0:
		effect_label.text = "Cold reply · trust %d" % trust_delta
		effect_label.add_theme_color_override("font_color", Color(0.88, 0.48, 0.42))
	elif trust_delta > 0:
		effect_label.text = "Warm reply · trust +%d" % trust_delta
		effect_label.add_theme_color_override("font_color", Color(0.44, 0.83, 0.78))
	else:
		effect_label.text = "Steady reply · trust unchanged"
		effect_label.add_theme_color_override("font_color", Color(0.95, 0.71, 0.36))
	phase = "reply"
	choices_panel.hide()
	reply_panel.show()
	continue_button.text = (
		"End shift (Enter)"
		if GameState.call_index + 1 >= GameState.call_count
		else "Next caller (Enter)"
	)
	scroll.scroll_vertical = 0
	continue_button.grab_focus()
	_refresh_status()

func _continue() -> void:
	if phase != "reply":
		return
	phase = "waiting"
	GameState.finish_call()

func _on_listen_pressed() -> void:
	_reveal_detail()

## A double click on Next caller or the title's Play can land its second press on
## a choice the next screen puts under the cursor. Godot flags that press; accept
## it so the gesture cannot answer the new call by accident.
func _on_choice_gui_input(event: InputEvent, button: Button) -> void:
	if event is InputEventMouseButton and event.double_click and event.pressed:
		button.accept_event()

func _reveal_detail() -> void:
	if phase != "choice" or heard_this_call:
		return
	heard_this_call = true
	caller_detail.show()
	listen_meter.value = 100.0
	listen_button.disabled = true
	listen_button.text = "Heard"
	listen_hint.text = "You gave them room to finish."
	GameState.mark_listened()
	Audio.play("checkpoint")
	# Disabling the button can drop focus; put a choice back under the keyboard.
	var focused := get_viewport().gui_get_focus_owner()
	if focused == null or focused == listen_button:
		choice_1.grab_focus()

func _on_call_started(index: int, _call_total: int) -> void:
	_show_call(index)

func _on_answered(_index: int, _trust_delta: int, _cold_delta: int) -> void:
	_refresh_status()

func _on_listened_changed(_listened: int) -> void:
	_refresh_status()

func _refresh_status() -> void:
	status_call.text = "CALL %d / %d" % [
		mini(GameState.call_index + 1, GameState.call_count),
		GameState.call_count,
	]
	status_trust.text = "TRUST %d · KEEP %d+" % [GameState.trust, GameState.WIN_TRUST]
	status_cold.text = "COLD %d / %d" % [GameState.cold, GameState.MAX_COLD]
	status_heard.text = "HEARD %d" % GameState.listened
	status_trust.add_theme_color_override(
		"font_color",
		Color(0.44, 0.83, 0.78) if GameState.trust >= GameState.WIN_TRUST else Color(0.88, 0.48, 0.42),
	)
	status_cold.add_theme_color_override(
		"font_color",
		Color(0.88, 0.48, 0.42) if GameState.cold > 0 else Color(0.62, 0.68, 0.8),
	)

func _pause() -> void:
	if not GameState.is_playing():
		return
	GameState.pause_game()
	pause_menu.open()

func _on_resume_requested() -> void:
	pause_menu.close()
	GameState.resume_game()
	# The Resume button is hidden now; return focus to the live screen so Enter
	# continues to work for a keyboard player.
	if phase == "choice":
		choice_1.grab_focus()
	elif phase == "reply":
		continue_button.grab_focus()

func _restart() -> void:
	get_tree().paused = false
	get_tree().reload_current_scene()

func _to_menu() -> void:
	get_tree().paused = false
	GameState.to_menu()
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")

func _on_run_won(trust: int, cold: int, listened: int) -> void:
	phase = "end"
	choices_panel.hide()
	reply_panel.hide()
	pause_menu.close()
	Audio.play("win")
	end_screen.show_won(trust, cold, listened)

func _on_run_lost(reason: String, trust: int, cold: int) -> void:
	phase = "end"
	choices_panel.hide()
	reply_panel.hide()
	pause_menu.close()
	Audio.play("lose")
	end_screen.show_lost(reason, trust, cold, GameState.listened)
