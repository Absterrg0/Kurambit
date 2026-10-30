## Procedural audio. The template ships no .wav files, so every effect and the music
## loop are synthesised once at startup into 16-bit mono streams on the SFX/Music buses.
## Replace the entries in `_build_library()` and `_music_loop()` with loaded streams
## (or generated .wav files) once real audio exists; nothing else in the project has to
## change.
extends Node

const MIX_RATE := 22050
const SFX_BUS := "SFX"
const MUSIC_BUS := "Music"
const VOICES := 6
const MUSIC_VOLUME_DB := -13.0
## Semitones relative to A4, so chords can be written as intervals.
const A4 := 440.0

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
	_music.stream = _music_loop()
	add_child(_music)

## Starts the music loop if it is not already running (the main menu calls this).
func start_music() -> void:
	if not _music.playing:
		_music.play()

func stop_music() -> void:
	_music.stop()

## Stops the music and every effect voice, and drops the stream references.
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
	_effects["jump"] = _sweep(360.0, 720.0, 0.13, 0.0, 0.16)
	_effects["land"] = _sweep(220.0, 90.0, 0.11, 0.35, 0.15)
	_effects["step"] = _sweep(150.0, 110.0, 0.05, 0.5, 0.07)
	_effects["coin"] = _chime(PackedFloat32Array([note(-9.0), note(-2.0)]), 0.07, 0.14)
	_effects["stomp"] = _sweep(420.0, 110.0, 0.16, 0.4, 0.18)
	_effects["hurt"] = _sweep(300.0, 80.0, 0.3, 0.25, 0.18)
	_effects["checkpoint"] = _chime(PackedFloat32Array([note(-9.0), note(-2.0), note(3.0)]), 0.09, 0.13)
	_effects["door"] = _chime(
		PackedFloat32Array([note(-12.0), note(-5.0), note(0.0), note(7.0)]), 0.11, 0.13
	)
	_effects["win"] = _chime(
		PackedFloat32Array([note(-5.0), note(0.0), note(3.0), note(7.0), note(12.0)]), 0.13, 0.14
	)
	_effects["lose"] = _chime(
		PackedFloat32Array([note(-2.0), note(-5.0), note(-9.0), note(-14.0)]), 0.18, 0.13
	)
	_effects["ui_move"] = _sweep(460.0, 560.0, 0.04, 0.0, 0.07)
	_effects["ui_accept"] = _sweep(520.0, 820.0, 0.07, 0.0, 0.09)

## Frequency of a note written as semitones from A4.
func note(semitones: float) -> float:
	return A4 * pow(2.0, semitones / 12.0)

## A rising or falling note with optional noise mixed in, so effects read as
## "metal", "wood" or "flesh" without any sample library.
func _sweep(
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
		var tone := sin(phase) * 0.6 + _pulse(phase) * 0.4
		var sample := lerpf(tone, randf() * 2.0 - 1.0, noise)
		frames[target] += sample * volume * _envelope(time, length)

## Square-ish wave for the chiptune parts: a soft pulse instead of a raw clipping sign.
func _pulse(phase: float) -> float:
	return clampf(sin(phase) * 3.0, -1.0, 1.0) * 0.5

## Short attack and a squared-off decay that reaches zero exactly at the end, so
## neither the start nor the end of an effect clicks.
func _envelope(time: float, length: float) -> float:
	var attack := 0.005
	var rise := clampf(time / attack, 0.0, 1.0)
	var fall := 1.0 - clampf((time - attack) / maxf(length - attack, 0.001), 0.0, 1.0)
	return rise * fall * fall

## The level theme: four bars of Am F C G at 120 BPM, bass on eighths, an arpeggio on
## sixteenths and a light kick/hat. Eight seconds long and seamless, because every
## note ends before the loop point.
const BAR := 2.0
const CHORDS := [
	{"bass": -24.0, "arp": [-12.0, -5.0, -2.0, 0.0, -2.0, -5.0]},
	{"bass": -28.0, "arp": [-16.0, -12.0, -9.0, -4.0, -9.0, -12.0]},
	{"bass": -33.0, "arp": [-9.0, -5.0, -2.0, 3.0, -2.0, -5.0]},
	{"bass": -26.0, "arp": [-14.0, -10.0, -7.0, -2.0, -7.0, -10.0]},
]

func _music_loop() -> AudioStreamWAV:
	var length := BAR * float(CHORDS.size())
	var frames := PackedFloat32Array()
	frames.resize(int(length * MIX_RATE))
	for bar in CHORDS.size():
		var chord: Dictionary = CHORDS[bar]
		var start := float(bar) * BAR
		for eighth in 8:
			var at := start + float(eighth) * BAR / 8.0
			_render_tone(frames, at, 0.19, note(chord["bass"]), 0.26)
			if eighth % 2 == 1:
				continue
			_render_noise(frames, at, 0.03, 0.05)
			if eighth % 4 == 0:
				_render_tone(frames, at, 0.1, note(chord["bass"] + 12.0), 0.12)
		for sixteenth in 16:
			var at := start + float(sixteenth) * BAR / 16.0
			var tones: Array = chord["arp"]
			_render_tone(frames, at, 0.11, note(tones[sixteenth % tones.size()] + 12.0), 0.07, true)
	for index in frames.size():
		frames[index] = clampf(frames[index], -1.0, 1.0)
	return _to_stream(frames, true)

func _render_tone(
	frames: PackedFloat32Array, start: float, length: float, hz: float, volume: float, pulse := false
) -> void:
	var first := int(start * MIX_RATE)
	var count := int(length * MIX_RATE)
	var phase := 0.0
	for index in count:
		var target := first + index
		if target < 0 or target >= frames.size():
			continue
		var time := float(index) / MIX_RATE
		phase += TAU * hz / MIX_RATE
		var tone := _pulse(phase) * 1.4 if pulse else sin(phase)
		frames[target] += tone * volume * _envelope(time, length)

func _render_noise(frames: PackedFloat32Array, start: float, length: float, volume: float) -> void:
	var first := int(start * MIX_RATE)
	var count := int(length * MIX_RATE)
	for index in count:
		var target := first + index
		if target < 0 or target >= frames.size():
			continue
		var time := float(index) / MIX_RATE
		frames[target] += (randf() * 2.0 - 1.0) * volume * _envelope(time, length)

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
