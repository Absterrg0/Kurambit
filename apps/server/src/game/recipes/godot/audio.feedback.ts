import type { GodotRecipeReference } from "./reference.ts";

export const audioFeedback: GodotRecipeReference = {
  setup:
    "Create an empty Node2D scene, attach this script to the root and run it. J confirms, K takes damage, M mutes. The demo generates its own tiny samples at boot and writes nothing.",
  referenceCode: String.raw`extends Node2D
## Two short event cues from original samples generated once at boot: a rising
## confirmation and a falling damage buzz. Nothing plays until a real action,
## keyboard echo is ignored, mute stops a cue already sounding, and idle frames
## cost no process callback.

const RATE := 22050
const PEAK := 0.22  # Headroom: two voices may overlap well below clipping.
const VOLUME_DB := -6.0
const CONFIRM_SECONDS := 0.11
const DAMAGE_SECONDS := 0.40
const FLASH_MS := 220.0

var _confirm: AudioStreamPlayer
var _damage: AudioStreamPlayer
var _muted := false
var _cues := 0
var _last := "none"
var _flash_ms := 0.0

func _ready() -> void:
	if not InputMap.has_action("cue_confirm"):
		_add_key("cue_confirm", KEY_J)
		_add_key("cue_damage", KEY_K)
		_add_key("cue_mute", KEY_M)
	_confirm = _player(_tone(520.0, 880.0, CONFIRM_SECONDS, 0.0))
	_damage = _player(_tone(170.0, 70.0, DAMAGE_SECONDS, 1.2))
	set_process(false)  # Only a live flash needs frames.

func _add_key(action: StringName, key: Key) -> void:
	InputMap.add_action(action)
	var event := InputEventKey.new()
	event.physical_keycode = key
	InputMap.action_add_event(action, event)

func _player(stream: AudioStream) -> AudioStreamPlayer:
	var player := AudioStreamPlayer.new()
	player.stream = stream
	player.volume_db = VOLUME_DB
	add_child(player)
	return player

## One voice per cue: retriggering restarts that cue instead of stacking, so at
## most two short voices can ever mix.
func _cue(player: AudioStreamPlayer, name: String) -> void:
	if _muted: return  # Muting is a hard stop, not a queued cue.
	player.play()
	_cues += 1
	_last = name
	_flash()
	queue_redraw()

func _tone(start_hz: float, end_hz: float, seconds: float, harmonic: float) -> AudioStreamWAV:
	var count := int(RATE * seconds)
	var data := PackedByteArray()
	data.resize(count * 2)
	for i in count:
		var t := float(i) / RATE
		var phase := TAU * lerpf(start_hz, end_hz, t / seconds) * t
		var sample := sin(phase) + harmonic * sin(phase * 3.0)
		var fade := pow(1.0 - t / seconds, 1.5)
		data.encode_s16(i * 2, int(sample / (1.0 + harmonic) * PEAK * fade * 32767.0))
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS; wav.mix_rate = RATE; wav.stereo = false
	wav.data = data
	return wav

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.echo:
		return  # Holding a key must not machine-gun a cue.
	if event.is_action_pressed("cue_confirm"):
		_cue(_confirm, "confirm")
	elif event.is_action_pressed("cue_damage"):
		_cue(_damage, "damage")
	elif event.is_action_pressed("cue_mute"):
		_set_muted(not _muted)

func _set_muted(muted: bool) -> void:
	_muted = muted
	if muted:
		_confirm.stop()  # Mute must silence a cue already sounding.
		_damage.stop()
	_flash()
	queue_redraw()

func _flash() -> void:
	_flash_ms = FLASH_MS
	set_process(true)

func _process(delta: float) -> void:
	_flash_ms = maxf(_flash_ms - delta * 1000.0, 0.0)
	if _flash_ms == 0.0:
		set_process(false)
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(0.0, 0.0, 640.0, 360.0), Color(0.07, 0.08, 0.11))
	_pad(Vector2(110.0, 120.0), "J  confirm", Color(0.25, 0.85, 0.55), _last == "confirm")
	_pad(Vector2(370.0, 120.0), "K  damage", Color(0.95, 0.35, 0.3), _last == "damage")
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 30.0), "sound %s  cues %d  playing %d  last %s  (M: mute)" % ["OFF" if _muted else "ON", _cues, int(_confirm.playing) + int(_damage.playing), _last], HORIZONTAL_ALIGNMENT_LEFT, -1.0, 16, Color(0.9, 0.9, 0.9))
	draw_string(ThemeDB.fallback_font, Vector2(20.0, 340.0), "Each press plays one short original sample; holding does nothing.", HORIZONTAL_ALIGNMENT_LEFT, -1.0, 14, Color(0.6, 0.65, 0.72))

func _pad(at: Vector2, text: String, color: Color, lit: bool) -> void:
	var alpha := 0.30 if lit else 0.10  # The last cue stays marked; flash adds the thick edge.
	draw_rect(Rect2(at, Vector2(160.0, 84.0)), Color(color.r, color.g, color.b, alpha))
	draw_rect(Rect2(at, Vector2(160.0, 84.0)), color, false, 4.0 if lit and _flash_ms > 0.0 else 2.0)
	draw_string(ThemeDB.fallback_font, at + Vector2(18.0, 48.0), text, HORIZONTAL_ALIGNMENT_LEFT, -1.0, 18, color)

func snapshot() -> Dictionary:
	return {"player_x": 320, "player_y": 280, "muted": _muted, "cues": _cues, "playing": int(_confirm.playing) + int(_damage.playing), "last_cue": _last, "voices": 2}
`,
  tryInput: {
    steps: [
      { waitMs: 300 },
      { screenshot: "idle" },
      { key: "J", holdMs: 60 },
      { key: "K", holdMs: 60 },
      { key: "M", holdMs: 60 },
      { screenshot: "muted" },
      { key: "J", holdMs: 60 },
      { screenshot: "muted-action" },
      { key: "M", holdMs: 60 },
      { key: "J", holdMs: 60 },
      { waitMs: 150 },
      { screenshot: "unmuted" },
    ],
    captureEveryMs: 100,
  },
};
