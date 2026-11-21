# Time of day, mood and lights that glow

**When.** Golden hour, dusk, night, overcast, or anything that should glow: windows, lamps,
fires, fireflies. Day rig: `light-rig`; sky and height fog: `sky-fog`.

## Numbers

ACES at exposure 1 unless noted. Dusk and night tuned on a screenshot of a block-out village;
the rest judgement from the measured sun colours.

| Hour     | Sun: elevation, colour, intensity          | Hemisphere: sky / ground, intensity | FogExp2: colour, density       |
| -------- | ------------------------------------------ | ----------------------------------- | ------------------------------ |
| Noon     | 60°, `0xffefd7`, 3                         | `0x9ec5ff` / `0x5a4e3e`, 1.5        | `0xc2d8ee`, 0.004              |
| Golden   | 6–10°, `0xffc46f`, 2.6                     | `0x8aa6d8` / `0x6a4a30`, 1.8        | `0xeeb07e`, 0.006              |
| Dusk     | 3–5°, `0xff9a5c`, 2.4                      | `0x8a7fc0` / `0x5a4030`, 2.6        | `0xe0806a`, 0.01               |
| Night    | moon 40°, `0x9fb4ff`, 0.5                  | `0x6a7aa0` / `0x1a1c22`, 2.6        | `0x34405a`, 0.03; exposure 1.2 |
| Overcast | 45°, `0xe8eef5`, 1, `shadow.intensity` 0.4 | `0xc8d0dc` / `0x5a5a50`, 2.4        | `0xb8c0c8`, 0.012              |

- Measured sun colour (linear, for `color.setRGB`): `[1, .86, .68]` at 60°, `[1, .55, .16]` at
  6°, `[1, .22, 0]` at 1°. The sky's share goes from 12% at noon to half at 6°: lower the sun,
  raise the hemisphere.
- Sky gradient: dusk top `0x3a2a6e` to horizon `0xe0806a` over the lowest 0.3 of the view's
  height; night `0x0e1224` to `0x34405a`. Fog colour is the horizon colour.
- FogExp2 density = 1.98 / V, V where things are gone (`sky-fog`): 200 m gives 0.01.
- Colour temperature: candle 1900 K `0xff8400`, sodium lamp 2000 K `0xff890e`, tungsten
  2700 K `0xffa757`, warm LED 3000 K `0xffb16e`, lightning 8000 K `0xdde6ff`. Moonlight is 4100 K; draw it cool, `0x9fb4ff`.
- Glow: window `emissive 0xff8a30`, `emissiveIntensity` 4; lamp bulb `0xffc070` at 8; `color`
  black. Bloom threshold 1.0 (linear HDR), strength 0.8, radius 0.5: emitters sit at 2× the
  threshold or more, lit walls below it.
- PointLights: intensity 6 (candela), distance 9, decay 2, no shadow, at most 4 to 8 in view.
  Other lamps get a light pool: a 5 m plane at y 0.02 with a radial gradient, `AdditiveBlending`, opacity 0.35, `depthWrite` false.
- Fireflies or motes: 150 `Points`, size 0.12, a soft round map, colour `0xd8ff6a` × 3 (over 1,
  so it blooms), additive, `depthWrite` false. Smoke: 20 to 40 soft sprites per chimney,
  rising 0.5 m/s, fading over 4 s (judgement).
- Tone mapping: ACES for warm moods, AgX for faithful colour, Neutral for bright stylised days.
- Median light measured: dusk 0.25, rainy night 0.13.

## Steps

1. One bloom only. With a `LOOK` export, use its `preset` (`golden`, `night`) and
   `bloom: { strength: 0.8, threshold: 1 }`, and add no composer. Without `LOOK`, run three's
   EffectComposer from `render(ctx, dt)` (Code). Both skip bloom where the browser draws in
   software.
2. Light direction first: sun 120 to 150° from the view (side or back light), then its row.
3. Sky gradient and fog from one horizon colour.
4. Practicals: emissive windows and bulbs; a PointLight for the 2 to 4 near the player; pools
   for the rest.
5. Fireflies, motes, smoke. Screenshot; fix brightness with exposure, never albedo.

## Pitfalls

- Emissive without bloom is flat paint; a threshold under 0.8 blooms walls and sky: milky.
- Windows at 2 under hemisphere 2.6 read as pale panels; pale emissive goes white under ACES.
- Fog that hides the subject: 0.018 at dusk hazed a house 15 m away. Keep the subject inside V/4.
- Night as a dark blue tint: keep contrast, warm pools against a cool world.
- Adding or removing a light recompiles every material: make lights once, change `intensity`.
- One colour family everywhere ("one shade of brown"): warm key, cool fill.

## Code

Three's own chain, for a game without `LOOK`:

```js
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
let composer,
  pass,
  ratio = 0;
// in start(ctx):
ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping;
composer = new EffectComposer(ctx.renderer);
composer.addPass((pass = new RenderPass(ctx.scene, ctx.camera)));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.5, 1));
composer.addPass(new OutputPass()); // tone mapping and sRGB, always last
export function render(ctx) {
  if (ctx.look.settings.quality === "low") return ctx.renderer.render(ctx.scene, ctx.camera);
  pass.camera = ctx.camera; // the Stage's free camera swaps it
  const r = ctx.renderer.getPixelRatio(); // the runtime's adaptive scale moves it
  if (r !== ratio) composer.setPixelRatio((ratio = r));
  composer.render();
}
export const resize = () => composer?.setSize(innerWidth, innerHeight);
// in stop(ctx): composer.dispose();
```

## Sources

EL4CTEO's blender-skills (MIT): `blender-time-of-day` (sun colour and sky share by elevation,
colour temperatures, Koschmieder fog, night's contrast and warm/cool split) and
`blender-rendering` (view transforms), translated to three.js. three.js r180
`webgl_postprocessing_unreal_bloom` (code read). Numbers checked in a headless r180 block-out.
