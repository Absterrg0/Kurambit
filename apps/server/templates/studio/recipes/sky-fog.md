# Sky, sun-tinted fog and aerial perspective

**When.** Any outdoor scene with a horizon, or depth that should read far.

## Numbers

- Fog amount `1 - exp(-distance * b)`. Colour it toward the sun when looking at it:
  `fogColor = mix(vec3(0.5, 0.6, 0.7), vec3(1.0, 0.9, 0.7), pow(max(dot(viewDir, sunDir), 0.0), 8.0))`.
- Height fog: `(a / b) * exp(-camY * b) * (1 - exp(-t * dirY * b)) / dirY`.
- three's `Sky` example defaults: turbidity **10**, rayleigh **3**, mieCoefficient **0.005**,
  mieDirectionalG **0.7**. The runtime's `look` suggests turbidity 2 and rayleigh 1.2 for
  clearer air.
- Sun elevation: tropical midday 45 to 70 degrees, golden hour 2 to 8 (judgement).
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

## Checks

```yaml
- fact: scene.report.player.contrast
  label: player ΔE
  want: ">= 20"
- fact: scene.report.empty.share
  label: empty view
  want: "<= 0.25"
- probe: player.frame.median
  label: median light
  want: ">= 0.35"
- agent: "horizon colour equals the fog colour within ΔE 10"
```

## Code

three's `Sky`, `FogExp2` (MIT); the runtime's `look` has height fog and derives light from
its sky. `@takram/three-clouds` (MIT) only for volumetric clouds.

## Sources

Inigo Quilez, "Fog" (read). three.js r180 `webgl_shaders_sky` (code read). SpriteCook,
atmospheric perspective (read; numbers cited, prose not copied).
