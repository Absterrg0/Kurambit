# The minimum sound set, and the mix

**When.** Every game, from its first playable build: a silent game "does not scream high
quality" (Mark Brown).

## Numbers

- Every game: UI click, start, pause, win sting, lose sting, a music loop, an ambience bed;
  every player action answers with a sound (judgement).
- By genre (judgement): duel: footsteps on stone, 2 to 3 swing whooshes, 3 hits, a block clang,
  a windup cue per boss attack, hurt, a roar at the phase change. Boat: an engine loop pitched
  by speed, hull and wave slap, wake hiss, horn, wind, gulls, a collision thud. Racing: engine
  by rpm, skid, boost, countdown, lap chime. Platformer: jump, land, collect, hurt, checkpoint.
- Vary a repeated sound's pitch by ±5 to 8% (judgement; `playSfx` takes `pitch`).
- Peaks at most **-1 dBTP** (Sony). Console mixes sit at -24 LKFS ±2, portable at -18 (Sony)
  or -16 (GANG); a browser game on laptop speakers aims the whole mix near -18 to -16 LUFS
  (judgement).
- Music about 10 to 12 dB under effect peaks, the bed about 15 dB under; duck music about 6 dB
  for 0.5 to 1 s on big moments (judgement).
- Integrated LUFS cannot measure a clip under 0.4 s (it reads -70): judge effects by peak.

## Steps

1. Library first: `game_assets` op `search` with `kind` sfx or music; op `add` copies and
   credits them and measures each clip against STYLE.json's targets (music near `musicLufs`,
   effects under `sfxPeakDbtp`). One family per kind of sound.
2. Synthesize what the library lacks with numpy and `wave` in the live Blender
   (`game_blender` op `code`), under `web/assets/sfx/`, and note it as synthesized in ASSETS.md:
   ```python
   import numpy as np, wave, os
   sr = 44100; t = np.arange(int(sr * 0.25)) / sr
   phase = 2 * np.pi * np.cumsum(np.linspace(880, 220, t.size)) / sr
   sig = (0.3 * np.sign(np.sin(phase)) + 0.2 * np.sin(phase)) * np.exp(-t * 12)
   out = os.path.abspath("web/assets/sfx/hit.wav"); os.makedirs(os.path.dirname(out), exist_ok=True)
   with wave.open(out, "wb") as w:
       w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
       w.writeframes((np.clip(sig, -1, 1) * 32767).astype("<i2").tobytes())
   print("WROTE", out, "peak", float(np.abs(sig).max()))
   ```
   A pickup rises, a hit falls, a click lasts milliseconds. Music: a fixed tempo, a whole
   number of bars, so the loop has no click.
3. Route music, effects and ambience through the runtime's buses; positional sound for an
   engine or a boss voice goes to the effects bus too.
4. Start the bed with play; play a sound on the first input the player makes.

## Pitfalls

- A loud UI click in a quiet scene; one sample for a sound that repeats.
- Measuring short effects with integrated LUFS; normalising each clip alone.
- Too many voices: give cues priority over ambience.
- Information carried by sound alone (GAG).

## Checks

```yaml
- probe: player.sound.firstInput
  label: sound on first input
  want: "== true"
- probe: player.sound.peakDb
  label: mix peak dBFS
  want: "<= -1"
- agent: "music or a bed starts within 5 s of play"
```

## Code

The runtime's `audio.js` (buses, `playSfx`); Web Audio. Kenney's Impact and Interface Sounds
(CC0) via the library.

## Sources

Mark Brown, "How to make a great Steam Next Fest demo" (read). Sony and GANG loudness targets
(read second-hand). Kenney sound packs (read). Game Accessibility Guidelines (read). The
LUFS-on-short-clips test: DESIGN-RECIPES §4.2 (run).
