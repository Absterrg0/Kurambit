# Light, sky, time of day and weather

**When.** Any lit 3D scene, before tuning a single material colour; an hour, a mood, things that
glow, rain, snow or mist.

## Technique

- Tone mapping and exposure first (`NeutralToneMapping`, `AgXToneMapping` or ACES at exposure
  about 1); fix brightness with lights and exposure, never with albedo or gamma.
- Three lights outdoors: a warm sun with shadows, a blue sky light from above, a warm bounce
  opposite the sun (`DirectionalLight` plus `HemisphereLight`). Albedos near 0.2; light from the
  side or behind, 120-150° from the view. r180 divides every light's diffuse by π: a
  `HemisphereLight` near 1 leaves the shade as mud, about 1.5 by day and more at dusk.
- Derive everything from one sun: its colour and the sky's share change with its height (warm and
  low at golden hour, the sky's share rising as it drops); the fog colour is the sky's horizon
  colour. `FogExp2` density = 1.98 / V, V where things vanish; keep the subject inside V / 4.
- Shadows: one map of 2048² with a camera 30-60 m round the player, or three's CSM; normal bias
  0.02-0.05.
- Glow: emissive colour on a black base, intensity 2x the bloom threshold or more; one bloom pass
  (three's EffectComposer with UnrealBloomPass, OutputPass last), threshold about 1 in linear HDR,
  so walls and sky never bloom. A few PointLights near the player; additive light pools for the
  rest.
- Rain: thousands of streaks (speed x 1/30 s long, never dots) in one `LineSegments` moved in its
  vertex shader inside a box that follows the camera, additive. Snow: `Points` falling 0.5-1.5 m/s
  with sway. Wet ground: darker and much smoother; puddles 2 mm above the ground. Lightning: 3-4
  strokes 40-60 ms apart, each snapping to peak and decaying over 2 frames, on `ctx.after` timers.
- Mist: fog first, then a few large soft camera-facing cards kept clear of geometry.

## Pitfalls

- AO darkening the sunlit side; an ambient so bright the shadows vanish.
- A shadow frustum over the whole level: blurry. Bias too low: acne; too high: floating.
- Bloom on white UI or the whole frame; two bloom passes.
- Adding or removing a light recompiles every material: make lights once, change `intensity`.
- Hazing the play layer: the player must read at full contrast.
- Front-lit rain vanishes; wet ground with nothing to reflect reads as dark.
- Updating thousands of particles on the CPU each frame: move them in the shader.

## Sources

Inigo Quilez, "Outdoors lighting" and "Fog"; three.js r180 examples (`webgl_tonemapping`,
`webgl_shadowmap_csm`, `webgl_shaders_sky`, `webgl_postprocessing_unreal_bloom`); EL4CTEO's
blender-skills (MIT): `blender-time-of-day` and `blender-weather-fx`, translated to three.js.
