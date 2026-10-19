## Player options, persisted to `user://settings.cfg` and pushed straight onto the
## audio buses. Autoloaded as `Settings`; the settings menu is the only writer.
extends Node

signal changed

const CONFIG_PATH := "user://settings.cfg"
const SAVE_DELAY := 0.6

var master_volume := 0.85
var music_volume := 0.6
var sfx_volume := 0.9
## Camera shake on landings and hits. Off is easier on motion-sensitive players.
var screen_shake := true

var _save_timer: Timer

func _ready() -> void:
	_save_timer = Timer.new()
	_save_timer.one_shot = true
	_save_timer.wait_time = SAVE_DELAY
	# Options are changed from the pause menu, which runs while the tree is paused.
	_save_timer.process_mode = Node.PROCESS_MODE_ALWAYS
	_save_timer.timeout.connect(save)
	add_child(_save_timer)
	_load()
	apply()

func set_master_volume(value: float) -> void:
	master_volume = clampf(value, 0.0, 1.0)
	apply()

func set_music_volume(value: float) -> void:
	music_volume = clampf(value, 0.0, 1.0)
	apply()

func set_sfx_volume(value: float) -> void:
	sfx_volume = clampf(value, 0.0, 1.0)
	apply()

func set_screen_shake(value: bool) -> void:
	screen_shake = value
	_queue_save()

## Writes the current values onto the Master/Music/SFX buses.
func apply() -> void:
	_apply_bus("Master", master_volume)
	_apply_bus("Music", music_volume)
	_apply_bus("SFX", sfx_volume)
	_queue_save()
	changed.emit()

func save() -> void:
	var config := ConfigFile.new()
	config.set_value("audio", "master", master_volume)
	config.set_value("audio", "music", music_volume)
	config.set_value("audio", "sfx", sfx_volume)
	config.set_value("video", "screen_shake", screen_shake)
	config.save(CONFIG_PATH)

func _apply_bus(bus_name: String, volume: float) -> void:
	var index := AudioServer.get_bus_index(bus_name)
	if index < 0:
		return
	if volume <= 0.0:
		AudioServer.set_bus_mute(index, true)
		return
	AudioServer.set_bus_mute(index, false)
	AudioServer.set_bus_volume_db(index, linear_to_db(volume))

func _queue_save() -> void:
	_save_timer.start()

func _load() -> void:
	var config := ConfigFile.new()
	if config.load(CONFIG_PATH) != OK:
		return
	master_volume = float(config.get_value("audio", "master", master_volume))
	music_volume = float(config.get_value("audio", "music", music_volume))
	sfx_volume = float(config.get_value("audio", "sfx", sfx_volume))
	screen_shake = bool(config.get_value("video", "screen_shake", screen_shake))
