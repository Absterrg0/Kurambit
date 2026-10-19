## Procedural audio. The template ships no .wav files, so every effect and the ambient
## loop are synthesised once at startup into 16-bit mono streams on the SFX/Music buses.
## Replace the entries in `_build_library()` with loaded streams (or generated .wav
## files) once real audio exists; nothing else in the project has to change.
extends Node

const MIX_RATE := 22050
const SFX_BUS := "SFX"
const MUSIC_BUS := "Music"
const VOICES := 6
const MUSIC_VOLUME_DB := -11.0

var _effects: Dictionary[String, AudioStreamWAV] = {}
var _voices: Array[AudioStreamPlayer] = []
var _next_voice := 0
var _music: AudioStreamPlayer

func _ready() -> void:
	_build_library()
	for index in VOICES:
		var player := AudioStreamPlayer.new()
		player.bus = SFX_BUS
		# Pause menus play UI sounds, so audio must keep running while the tree is paused.
		player.process_mode = Node.PROCESS_MODE_ALWAYS
		add_child(player)
		_voices.append(player)
	_music = AudioStreamPlayer.new()
	_music.bus = MUSIC_BUS
	_music.process_mode = Node.PROCESS_MODE_ALWAYS
	_music.volume_db = MUSIC_VOLUME_DB
	_music.stream = _ambient_loop()
	add_child(_music)

## Starts the ambient loop if it is not already running (the main menu calls this).
func start_music() -> void:
	if not _music.playing:
		_music.play()

func stop_music() -> void:
	_music.stop()

## Stops the ambient loop and every effect voice, and drops the stream references.
## The smoke test calls this while tearing the tree down: a stream still assigned to
## a player when the audio server shuts down is reported as a leaked instance.
func stop_all() -> void:
	stop_music()
	_music.stream = null
	for voice in _voices:
		voice.stop()
		voice.stream = null

## Plays a named effect. Unknown names are ignored so a typo never breaks a run.
func play(effect: String, pitch := 1.0) -> void:
	var stream: AudioStreamWAV = _effects.get(effect)
	if stream == null or _voices.is_empty():
		return
	var voice := _voices[_next_voice]
	_next_voice = (_next_voice + 1) % _voices.size()
	voice.stream = stream
	voice.pitch_scale = pitch
	voice.play()

## Adds click and focus sounds to every button under `root`; call it from a UI scene.
## Shared panels are instanced by several screens, so connections are idempotent.
func wire_ui(root: Node) -> void:
	for child in root.get_children():
		var button := child as BaseButton
		if button != null:
			if not button.pressed.is_connected(_on_ui_pressed):
				button.pressed.connect(_on_ui_pressed)
			if not button.focus_entered.is_connected(_on_ui_focus):
				button.focus_entered.connect(_on_ui_focus)
		wire_ui(child)

func _on_ui_pressed() -> void:
	play("ui_accept")

func _on_ui_focus() -> void:
	play("ui_move")

func _build_library() -> void:
	_effects["jump"] = _effect(340.0, 640.0, 0.15, 0.0, 0.11)
	_effects["land"] = _effect(190.0, 95.0, 0.13, 0.35, 0.1)
	_effects["step"] = _effect(150.0, 110.0, 0.06, 0.5, 0.06)
	_effects["pickup"] = _chime(PackedFloat32Array([660.0, 990.0]), 0.08, 0.11)
	_effects["hurt"] = _effect(300.0, 120.0, 0.26, 0.3, 0.13)
	_effects["unlock"] = _chime(PackedFloat32Array([523.25, 659.25, 783.99]), 0.09, 0.11)
	_effects["win"] = _chime(PackedFloat32Array([523.25, 659.25, 783.99, 1046.5]), 0.13, 0.12)
	_effects["lose"] = _chime(PackedFloat32Array([392.0, 311.13, 233.08]), 0.17, 0.12)
	_effects["ui_move"] = _effect(460.0, 540.0, 0.045, 0.0, 0.05)
	_effects["ui_accept"] = _effect(520.0, 800.0, 0.075, 0.0, 0.07)

## A rising or falling note with optional noise mixed in, so effects read as
## "metal", "wood" or "flesh" without any sample library.
func _effect(
	from_hz: float, to_hz: float, length: float, noise: float, volume: float
) -> AudioStreamWAV:
	var frames := PackedFloat32Array()
	frames.resize(int(length * MIX_RATE))
	_render_note(frames, 0, from_hz, to_hz, length, noise, volume)
	return _to_stream(frames)

## An arpeggio: every note is a little longer than the step between them, which
## makes the notes ring into each other.
func _chime(frequencies: PackedFloat32Array, step: float, volume: float) -> AudioStreamWAV:
	var tail := step * 1.8
	var length := step * float(frequencies.size()) + tail
	var frames := PackedFloat32Array()
	frames.resize(int(length * MIX_RATE))
	for index in frequencies.size():
		_render_note(
			frames,
			int(index * step * MIX_RATE),
			frequencies[index],
			frequencies[index],
			step + tail,
			0.0,
			volume
		)
	return _to_stream(frames)

func _render_note(
	frames: PackedFloat32Array,
	start: int,
	from_hz: float,
	to_hz: float,
	length: float,
	noise: float,
	volume: float
) -> void:
	var phase := 0.0
	var count := int(length * MIX_RATE)
	for index in count:
		var target := start + index
		if target >= frames.size():
			return
		var time := float(index) / MIX_RATE
		var hz := lerpf(from_hz, to_hz, time / length)
		phase += TAU * hz / MIX_RATE
		var tone := sin(phase) * 0.75 + sin(phase * 2.03) * 0.25
		var sample := lerpf(tone, randf() * 2.0 - 1.0, noise)
		frames[target] += sample * volume * _envelope(time, length)

## Short attack and a squared-off decay that reaches zero exactly at the end, so
## neither the start nor the end of an effect clicks.
func _envelope(time: float, length: float) -> float:
	var attack := 0.005
	var rise := clampf(time / attack, 0.0, 1.0)
	var fall := 1.0 - clampf((time - attack) / maxf(length - attack, 0.001), 0.0, 1.0)
	return rise * fall * fall

## A soft pad plus wind, looped. Every pad frequency is a whole number of cycles
## over the loop length and the wind fades out at both ends, so the loop point is
## inaudible.
func _ambient_loop() -> AudioStreamWAV:
	var length := 8.0
	var frames := PackedFloat32Array()
	frames.resize(int(length * MIX_RATE))
	var wind := 0.0
	for index in frames.size():
		var time := float(index) / MIX_RATE
		var pad := sin(TAU * 110.0 * time) * 0.5
		pad += sin(TAU * 165.0 * time) * 0.3
		pad += sin(TAU * 220.0 * time) * 0.16
		pad *= 0.6 + 0.4 * sin(TAU * time / length)
		wind = lerpf(wind, randf() * 2.0 - 1.0, 0.015)
		frames[index] = (pad * 0.35 + wind * 0.25 * sin(PI * time / length)) * 0.6
	return _to_stream(frames, true)

func _to_stream(frames: PackedFloat32Array, looped := false) -> AudioStreamWAV:
	var bytes := PackedByteArray()
	bytes.resize(frames.size() * 2)
	for index in frames.size():
		bytes.encode_s16(index * 2, int(clampf(frames[index], -1.0, 1.0) * 32767.0))
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = MIX_RATE
	stream.stereo = false
	stream.data = bytes
	if looped:
		stream.loop_mode = AudioStreamWAV.LOOP_FORWARD
		stream.loop_begin = 0
		stream.loop_end = frames.size()
	return stream
