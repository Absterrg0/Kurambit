# The pack look: one gradient-swatch atlas, hue-shifted ramps, painted cells

**When.** The person chose the KayKit and Kenney look: STYLE.json holds a hex `palette` (op
`lock` with `finish: "flat"`). Without one, models keep their own materials; a face or emblem
as paint (step 2) works on both.

## Numbers

- **1 material, 1 texture** per model (plus Glow when something glows). KayKit and Kenney ship
  exactly this.
- **3 to 5 hue families** per object, each with a light and a dark value.
- The export ramps each swatch: lighter on top (`shading.gradient` 0.16), warmer at the top and
  cooler at the bottom (`shading.hue` 10° each way). Painters shift 15 to 25° across a ramp;
  about 20° per step is the most they go.
- Saturation peaks mid-ramp; very bright, very saturated ends burn.
- Keep swatch values between about sRGB 30 and 240 (`#1e1e1e` to `#f0f0f0`), glow aside: pure
  black and white lose the ramp.
- Light and shadow that survive one atlas: bevel faces one step lighter, recesses one step darker,
  in the same hue (`art-prop`).
- A painted cell is a 64 x 64 picture in the same atlas: eyes, brows, a mouth, an emblem.

## Steps

1. Give each part a flat colour: `kurambit.material("#RRGGBB", name="Tunic")`. The export
   snaps every colour to the palette's nearest, on one atlas of vertical-gradient swatches, and
   Art lists and edits each swatch by its name, so name them for what they colour.
2. A face or emblem as paint: draw it in code and make it a decal.
   ```python
   import numpy as np
   px = np.ones((64, 64, 3)) * skin_rgb          # the surface's own colour as background
   yy, xx = np.mgrid[0:64, 0:64]
   for cx in (20, 44):                            # two tall eyes with a glint
       px[((xx - cx) / 5.5) ** 2 + ((yy - 30) / 9) ** 2 <= 1] = (0.1, 0.07, 0.09)
       px[((xx - cx - 2) / 2) ** 2 + ((yy - 26) / 2.5) ** 2 <= 1] = (1, 1, 1)
   face = kurambit.decal("hero_face", px, axis="-y")
   head.data.materials.append(face)
   for p in head.data.polygons:                   # the front faces it covers
       if p.normal.y < -0.55 and lo < p.center.z < hi:
           p.material_index = len(head.data.materials) - 1
   ```
   The picture stretches over the bounds of the faces that use it, seen along `axis` (`-y` is the
   front), top row first: a cell of the atlas, or its own texture without one. Decals are
   never snapped.
3. Review: read materials, textures, hue families in the review's Look line.

## Pitfalls

- A second material or an image texture per part breaks the one draw call.
- Value-only ramps do not harmonise across hues; the export already shifts hue, so do not paint
  shading into the colours.
- Colour by separate parts (a bib, a jaw, a cuff), never by testing each face's position.
- A decal whose background differs from the surface shows as a patch.
- Only a material's base colour and glow ship: metallic, roughness, procedural nodes and vertex
  colours do not (the atlas is matte, `shading.roughness` 0.62). Metal is a light, cool swatch
  beside a dark one; grain and relief are a baked `kurambit.surface`.
- A textured or see-through material snaps too, face by face, by the texture under each face.

## Code

Kit only: `kurambit.material`, `kurambit.decal`; the export's style pass builds the atlas when
STYLE.json has a hex palette.

## Sources

Pack measurements (ART-RESEARCH §3: KayKit 1024² and Kenney 512² gradient atlases, one material);
Slynyrd Pixelblog 1 on hue-shifted ramps (read); 80.lv on gradient texturing (read); EL4CTEO's
blender-skills (MIT) `blender-pbr-materials` (albedo range) and `blender-texturing` (edge wear and
grime as light and dark), read.
