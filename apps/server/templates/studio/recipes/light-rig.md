# Light rig and tone mapping

**When.** Any lit 3D scene, before tuning a single material colour. Dusk, night, overcast and
lights that glow: `time-of-day`.

## Numbers

Inigo Quilez's three-light outdoor rig, in linear space:

- **Sun** about 1.25 to 1.5, warm, colour `(1.64, 1.27, 0.99)`, with shadows.
- **Sky** light from straight above about 0.2, blue, `(0.16, 0.20, 0.28)`, times AO.
- **Bounce** opposite the sun, horizontal, about 0.3, warm, `(0.40, 0.28, 0.20)`, times AO.
- Diffuse albedo **about 0.2**: brighten lights, not materials. A lit pixel is about 0.5 after
  gamma. No AO on the sun. Colour the penumbra: `pow(shadow, vec3(1.0, 1.2, 1.5))`.
- three.js: `DirectionalLight` for the sun, `HemisphereLight` (sky above, bounce below) or a
  weak second `DirectionalLight`; `renderer.toneMapping` `NeutralToneMapping` or
  `AgXToneMapping` at exposure **1.0** (three's tone-mapping example defaults to Neutral, 1.0).
  The runtime's `look` `day` preset is sun 2.6 `0xfff2de` with Neutral.
- r180 divides every light's diffuse by π, so a floor the sun barely reaches, under a
  `HemisphereLight` at 1, reads as mud: 1.5 by day, 2.6 at dusk (tested). Sun to hemisphere
  about 2:1 at noon, 1:1 with a low sun.
- Shadows: three's cascaded example uses 4 cascades of 1024², split mode `practical`. For one
  map: 2048², a shadow camera 30 to 60 m around the player, normal bias 0.02 to 0.05 (judgement).
- Post: one bloom, the `LOOK`'s or three's own composer, never both (`time-of-day`). Bloom
  only what emits, threshold at least 0.9 in linear HDR; vignette darkness at most
  0.5 (pmndrs defaults: bloom threshold 1, vignette 0.5); AO 1.5 to 3 at about a character's
  height (judgement).
- Median light of a play frame 0.35 to 0.6; under 2% of pixels clipped (judgement).

## Steps

1. Set tone mapping and exposure first; never fix brightness with gamma.
2. Place the sun for the brief's hour (side or back, 120 to 150° from the view), then sky, then
   bounce.
3. Set albedos near 0.2; check the player against the ground (`player ΔE` below).
4. Fit the shadow camera to the play area; add contact shadow under feet.
5. Add bloom and vignette last, lightly.

## Pitfalls

- Albedo near 1.0 washes everything out.
- AO darkening the sunlit side ("horribly CG looking", iq).
- An ambient so bright the shadows vanish; one so dim the ground is mud.
- A shadow frustum over the whole level: blurry. Bias too low: acne; too high: floating.
- Bloom on white UI or on the whole frame (three's UnrealBloom example is a showcase).

## Code

three.js lights, `CSM` addon and the runtime's `look` (MIT). pmndrs `postprocessing` (Zlib)
is vendored in the runtime.

## Sources

Inigo Quilez, "Outdoors lighting" (read). three.js r180 examples `webgl_tonemapping`,
`webgl_shadowmap_csm` (code read). pmndrs postprocessing and N8AO defaults (code read).
