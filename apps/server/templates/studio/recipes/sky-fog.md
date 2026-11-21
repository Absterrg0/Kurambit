# Sky, sun-tinted fog and aerial perspective

**When.** Any outdoor scene with a horizon, or depth that should read far. Colours per hour:
`time-of-day`; rain, snow, mist: `weather-fx`.

## Numbers

- Fog amount `1 - exp(-distance * b)`. Colour it toward the sun when looking at it:
  `fogColor = mix(vec3(0.5, 0.6, 0.7), vec3(1.0, 0.9, 0.7), pow(max(dot(viewDir, sunDir), 0.0), 8.0))`.
- Height fog: `(a / b) * exp(-camY * b) * (1 - exp(-t * dirY * b)) / dirY`.
- three's `Sky` example defaults: turbidity **10**, rayleigh **3**, mieCoefficient **0.005**,
  mieDirectionalG **0.7**. The runtime's `look` suggests turbidity 2 and rayleigh 1.2 for
  clearer air.
- Sun elevation: midday 45 to 70 degrees, golden hour 6 to 10, dusk 3 to 5 (judgement).
- three's `FogExp2` density = 1.98 / V, V where things are gone (Koschmieder's 3.912 / V,
  square-rooted): V at 1.5 to 3 times the far edge of play, so 200 m gives 0.01. Keep the
  subject inside V/4.
- A drawn sky without `Sky`: a back-side sphere, horizon to top over the lowest 0.3 of its
  height, `fog: false`, `depthWrite` false; fog colour = its horizon colour.
- The sky's horizon matches the fog colour within ΔE 10 (judgement).
- 2D parallax by scroll factor: far peaks 0.80, hills 0.28, trees just behind the player
  0.04, the play layer 0 (SpriteCook).

## Steps

1. Pick the hour from the brief; set the sun's direction and the `Sky` from it.
2. Derive the sky light and the fog colour from the same sun, never a separate guess.
3. Fog far things toward the horizon colour; keep the play space clear.
4. Check distant objects fade with distance and the player still stands out.

## Pitfalls

- One flat haze colour for everything; fading far things by opacity; multiplying (it only
  darkens).
- Hazing the play layer: the player must read at full contrast.
- A sky light that disagrees with the drawn sky; the sun at the horizon at noon.

## Code

three's `Sky`, `FogExp2` (MIT); the runtime's `look` has height fog and derives light from
its sky. `@takram/three-clouds` (MIT) only for volumetric clouds.

## Sources

Inigo Quilez, "Fog" (read). three.js r180 `webgl_shaders_sky` (code read). SpriteCook,
atmospheric perspective (read; numbers cited, prose not copied). EL4CTEO's blender-skills (MIT),
`blender-time-of-day` (fog from visibility).
