# Audio

Original to this studio, kept short.

1. Sound from files, from the start. Every answer a player action gets
   has a sound: move, jump, hit, pickup, win, lose, UI click.
2. One music loop as an audio file, mixed low enough to sit under effects.
3. Library first: `game_assets_search` with `kind` sfx or music finds CC0
   packs of clicks, hits, pickups, footsteps, jingles and chiptune loops with
   their lengths; `game_assets_add` copies the ones you pick and credits them
   in ASSETS.md. Keep one sound family per game: STYLE.json's `audio.packs`
   lists them (art-pipeline), and an add outside it is refused.
4. Synthesize what the library lacks with numpy and Python's `wave` module
   inside the live Blender (`game_blender_code`). Record each file as
   synthesized in ASSETS.md. Placeholders are silence, never engine beeps
   described as final.
5. Keep clips short and levels even. A loud UI click ruins a quiet scene.
   You cannot listen: `game_assets_add` measures each added clip against
   STYLE.json's targets (music around `musicLufs`, -23 LUFS by default;
   effects peaking under `sfxPeakDbtp`, -1 dBTP) and says which are off.
   Turn those down in the game's mix (the player's volume, the bus). For a
   clip you synthesize, print its length and peak and compare them.

The working directory is the game root; print every path you write. Sound
goes under your lane's asset folder: `godot/assets/sfx/`, `web/assets/sfx/`,
or `unity/Assets/Audio/` for Unity (capital A: Unity imports only
`unity/Assets/`):

```python
import numpy as np, wave, os
sr = 44100
t = np.arange(int(sr * 0.25)) / sr
phase = 2 * np.pi * np.cumsum(np.linspace(880, 220, t.size)) / sr
sig = (0.3 * np.sign(np.sin(phase)) + 0.2 * np.sin(phase)) * np.exp(-t * 12)
out = os.path.abspath("web/assets/sfx/hit.wav")  # your lane's sound folder, above
os.makedirs(os.path.dirname(out), exist_ok=True)
with wave.open(out, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes((np.clip(sig, -1, 1) * 32767).astype("<i2").tobytes())
print("WROTE", out, "seconds", t.size / sr, "peak", float(np.abs(sig).max()))
```

- Shape effects with pitch sweeps, noise (`np.random.uniform`) and short
  envelopes; a pickup rises, a hit falls, a click is a few milliseconds.
- Music: fix a tempo, sum note voices with attack and release envelopes,
  and make the length a whole number of bars so the loop has no click.
