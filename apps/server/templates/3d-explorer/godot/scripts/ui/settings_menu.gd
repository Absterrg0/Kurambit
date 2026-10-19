## Volume, look sensitivity and invert-Y options, shared by the title screen and the
## pause menu. Writes through `Settings`, which applies and persists every change.
class_name SettingsMenu
extends PanelContainer

signal closed

@onready var master_slider: HSlider = $Box/Audio/Master/Slider
@onready var master_value: Label = $Box/Audio/Master/Value
@onready var music_slider: HSlider = $Box/Audio/Music/Slider
@onready var music_value: Label = $Box/Audio/Music/Value
@onready var sfx_slider: HSlider = $Box/Audio/Sfx/Slider
@onready var sfx_value: Label = $Box/Audio/Sfx/Value
@onready var sensitivity_slider: HSlider = $Box/Look/Sensitivity/Slider
@onready var sensitivity_value: Label = $Box/Look/Sensitivity/Value
@onready var invert_button: CheckButton = $Box/Look/Invert
@onready var back_button: Button = $Box/Back

func _ready() -> void:
	hide()
	Audio.wire_ui(self)
	master_slider.value = Settings.master_volume
	music_slider.value = Settings.music_volume
	sfx_slider.value = Settings.sfx_volume
	sensitivity_slider.value = Settings.mouse_sensitivity
	invert_button.button_pressed = Settings.invert_y
	master_slider.value_changed.connect(_on_master_changed)
	music_slider.value_changed.connect(_on_music_changed)
	sfx_slider.value_changed.connect(_on_sfx_changed)
	sensitivity_slider.value_changed.connect(_on_sensitivity_changed)
	invert_button.toggled.connect(_on_invert_toggled)
	back_button.pressed.connect(_on_back)
	_refresh_labels()

func open() -> void:
	show()
	back_button.grab_focus()

func _on_back() -> void:
	closed.emit()

func _on_master_changed(value: float) -> void:
	Settings.set_master_volume(value)
	_refresh_labels()

func _on_music_changed(value: float) -> void:
	Settings.set_music_volume(value)
	_refresh_labels()

func _on_sfx_changed(value: float) -> void:
	Settings.set_sfx_volume(value)
	_refresh_labels()

func _on_sensitivity_changed(value: float) -> void:
	Settings.set_mouse_sensitivity(value)
	_refresh_labels()

func _on_invert_toggled(pressed: bool) -> void:
	Settings.set_invert_y(pressed)

func _refresh_labels() -> void:
	master_value.text = _percent(Settings.master_volume)
	music_value.text = _percent(Settings.music_volume)
	sfx_value.text = _percent(Settings.sfx_volume)
	sensitivity_value.text = _percent(sensitivity_slider.value / sensitivity_slider.max_value)

func _percent(value: float) -> String:
	return "%d%%" % roundi(value * 100.0)
