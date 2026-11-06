# Art pipeline

Adapted from OhMyGame's sprite-pipeline and game-ui-frontend skills (Apache-2.0).
The live Blender behind the `game_blender_*` tools is your renderer and your
modeller for props; you have no local Blender, Godot or image tools.
`<assets>` is your lane's asset folder: `godot/assets/`, `web/assets/`, or
`unity/Assets/` for Unity (capital A: Unity imports nothing else, and
`unity/assets/` is a different folder it never reads; Unity art goes under
`unity/Assets/Art/`).

1. Key art first: one image the finished game must live up to.
2. Every in-game visual is a file: characters, objects, tiles, backgrounds, UI
   pieces, effects, animation frames. No code-drawn shapes, flat color
   rectangles or default UI skin on the played path. Dynamic text stays code.
3. One look, locked in `STYLE.json` before the first asset (below). The art
   tools hold the game to it.
4. Characters and creatures come from the lock's packs: rigged models on its
   rig when it names one, or the packs' own sprite characters in a 2D game
   whose lock names none. Blender builds props, set pieces, backgrounds and
   key art, never a character from boxes or primitives.
5. One palette, one silhouette language, one ground line. Movement, hurt, win
   and lose read at a glance. Put the set in one contact-sheet PNG, look at
   it, and redo the weak ones.
6. Record every file's source and licence in ASSETS.md; unknown-source files
   do not ship. Never scrape websites.

## Lock the look: STYLE.json

`game_assets_search` with no words lists the library by style family: one
look each (KayKit, Kenney low-poly, Kenney pixel, ...), its packs, each
character pack's rig, and a pixel palette where the family has one. Look at
a pack's contact sheet (pass `pack`) before choosing. Pick one family whose
look fits the key art and write `STYLE.json` at the game root:

```json
{
  "version": 1,
  "family": "kaykit",
  "mode": "smooth",
  "view": "perspective",
  "rig": "kaykit-1",
  "packs": [
    "kaykit-adventurers",
    "kaykit-skeletons",
    "kaykit-dungeon-remastered",
    "kenney-ui-pack"
  ],
  "audio": {
    "packs": ["kenney-rpg-audio", "juhani-chiptune-adventures"],
    "musicLufs": -23,
    "sfxPeakDbtp": -1
  }
}
```

- `mode`: `smooth`, or `pixel` with `tile` (source pixels per tile, 16 for a
  16 px pack) and `palette` (a pack id, or a PNG or folder in the game). A
  pack-id palette may be added without listing it in `packs`; add it with
  `game_assets_add` (any one image of it) before the first render, which
  reads its colours from the game. `outline` (true or `#rrggbb`) outlines
  pixel sprites.
- `view`: `side`, `top-down`, `isometric` or `perspective` (3D).
- `rig`: the skeleton every character shares, so every clip fits every
  character. Leave it out when nothing is rigged (a 2D game drawn from sprite
  packs); then no armature enters the game.
- `packs`: where the game's visuals come from. UI, icons and fonts packs go
  in it too.
- `audio.packs`: where its sounds come from: one effects family and one music
  source. Sound is not locked until the list exists; name it with the look.
- `imports`: outside sources the live Blender may import from (`polyhaven`,
  `sketchfab`, `polypizza`); none when left out. Realistic Poly Haven models
  sit only in a realistic look.

What the tools do with it: `game_assets_add` refuses a pack outside the lists
and characters on another rig (an FBX or other model whose clips cannot be
read counts as a character), and measures each added clip's loudness against
`musicLufs` (music) and `sfxPeakDbtp` (effects);
`game_blender_render_sprites` fills the palette, outline, size and views from
the lock and refuses a palette or mode it does not hold;
`game_blender_assets_import` refuses a source `imports` does not list;
`game_blender_assets_import` and `game_blender_export` refuse an armature not
on the lock's rig, or any armature when it names none; `game_assets_search`
shows the lock's packs first. A refusal says what to change. Changing
direction is an edit to STYLE.json made on purpose, never a drift: when the
look changes, change the lock first, then the art. STYLE.json is the person's
to read and edit too.

## Characters from the lock

- 2D sprite packs (a lock with no rig): take the characters the packs draw,
  with their own frames.

- 3D: `game_assets_add` the character models from the lock's rig family (for
  `kaykit-1`: `kaykit-adventurers` heroes, `kaykit-skeletons` enemies, 76-95
  clips each). Play their clips by state with the engine's character
  animator (`CharacterAnimator` in Godot and Unity, `animate` in three.js;
  TEMPLATE.md): it finds "Idle", "Walking_A", "1H_Melee_Attack_Chop" by
  their words, and any clip plays by a word of its name.
- 2D: render the family's character into strips. Import the added GLB into
  the live Blender and list its clips:

  ```python
  import bpy, os
  bpy.ops.import_scene.gltf(filepath=os.path.abspath("godot/assets/library/kaykit-adventurers/Characters/gltf/Knight.glb"))
  rig = next(o for o in bpy.context.selected_objects if o.type == "ARMATURE")
  print(rig.name, [c.name for c in rig.children], [a.name for a in bpy.data.actions])
  ```

  Hide what this character should not carry (`ob.hide_render = True` on
  extra weapons), then `game_blender_render_sprites` with
  `"objects": ["<rig name>"], "action": "Walking_A"`, once per clip. With a
  pixel lock, leave out `pixelArt`, `size` and `views`: the lock fills them.

- No character in the family fits: recolour one. A family's characters share
  one small colormap texture; edit a copy of that PNG (hue, palette) and point
  the copy's material at it. Never model a character from cubes or
  primitives; a hand-made rig with sine-wave limbs reads as programmer art.
- Creatures off the humanoid rig (monsters, animals) come from a pack in the
  lock that carries their own clips.

## 2D sprites from 3D

Render every sprite, animation strip and icon with `game_blender_render_sprites`,
never with your own camera, light or render code. It fits a fixed orthographic
camera to the objects across every frame, so nothing is cut off, the scale is
the same in every frame and view, the feet stand on the same row in every
frame, and studio lights keep small sprites readable. It writes
`<output>_0.png ... <output>_N.png` and `<output>.sprite.json` (frame size,
fps, anchor per view), records them in ASSETS.md and returns a contact sheet:
look at it. Its `output` is a path prefix under `<assets>`: `godot/assets/sprites/hero_walk`,
`web/assets/sprites/hero_walk` or `unity/Assets/Art/Sprites/hero_walk`. In Godot,
`SpriteStrips.apply` loads strips from the `.sprite.json`; elsewhere use the
anchor offset it gives.

- Pixel-art game: STYLE.json's palette, outline and tile size apply (the
  canvas defaults to two tiles); the engine scales sprites and tiles up
  together with nearest filtering and must not recolour them: a Godot 2D
  scene has no WorldEnvironment, and a three.js game draws sprites through an
  orthographic camera, which skips tone mapping unless `LOOK` names one.
  Smooth game: render at the size the game draws.
- One character, one scale: leave out `pixelsPerUnit` for its first strip,
  then pass the value that strip reports to every other strip of the same
  character (idle, walk, attack), or an attack renders smaller than the idle.
  If a bigger clip no longer fits, the tool says which `size` it needs.
- Render in-place clips. A clip that moves the character across the ground
  (root motion) is refused; the game moves the sprite.
- Views: side-scroller `right` (flip it for left); top-down `front`, `back`,
  `left`, `right` with `elevation` 35, or `top`; `isometric`. STYLE.json's
  view sets them when you leave `views` out.
- Props and pickups render the same way, from a library model or one you
  build in Blender. The model faces -Y, like imported glTF models; `right`
  shows it facing screen right.

## Props, set pieces and 3D models

Library pieces from the lock's packs come first. What no pack has, build in
the live Blender: `game_blender_code` to model, `game_blender_look` to see,
`game_blender_scene` to measure, `game_blender_export` for a GLB, then
`game_import` and `game_check`. Match the family's look: its proportions,
its flat or colormap colours, its bevel. Realistic models and textures
(`game_blender_assets_search` and `_import`: Poly Haven is CC0, no key;
Sketchfab and Poly Pizza need the user's keys) belong only in a realistic
lock.

## Key art

A perspective camera at 1280x720 over the game's real assets, rendered in a
throwaway scene that is removed in `finally`, so a failed run leaves nothing in
the live .blend:

```python
import bpy, os, math
sc = bpy.data.scenes.new("keyart_tmp"); made = []
try:
    sc.render.engine = "BLENDER_EEVEE_NEXT"; sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.view_settings.view_transform = "Standard"  # material colors render as set
    for o in bpy.context.scene.objects:
        if o.type in {"MESH", "LIGHT"} and o.visible_get(): sc.collection.objects.link(o)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); cam.location = (0, -9, 5)
    cam.rotation_euler = (math.radians(62), 0, 0)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.rotation_euler = (0.8, 0.2, 0.5)
    for o in (cam, sun): sc.collection.objects.link(o); made.append(o)
    sc.camera = cam; sc.render.filepath = os.path.abspath("art/key-art.png")
    bpy.ops.render.render(write_still=True, scene=sc.name); print("WROTE", sc.render.filepath)
finally:
    for o in made: bpy.data.objects.remove(o)
    bpy.data.scenes.remove(sc)
```

Open every PNG you render.

## Backgrounds

Never a flat fill. Render a ground plane (`bmesh.ops.create_grid`) at the
game's resolution from the game's own view, with this material, a low sun
(`rotation_euler = (1.1, 0.3, 0)`, `energy = 3`) and a dark `sc.world`, then
place the game's props on it:

```python
mat = bpy.data.materials.new("ground"); mat.use_nodes = True; N, L = mat.node_tree.nodes, mat.node_tree.links
noise, ramp, bump, bsdf = N.new("ShaderNodeTexNoise"), N.new("ShaderNodeValToRGB"), N.new("ShaderNodeBump"), N["Principled BSDF"]
noise.inputs["Scale"].default_value, noise.inputs["Detail"].default_value = 5, 12
e0, e1 = ramp.color_ramp.elements; e0.position, e1.position = 0.4, 0.65
e0.color, e1.color = (0.01, 0.03, 0.02, 1), (0.08, 0.2, 0.06, 1)  # two palette colors, linear
L.new(noise.outputs["Fac"], ramp.inputs["Fac"]); L.new(noise.outputs["Fac"], bump.inputs["Height"])
L.new(ramp.outputs["Color"], bsdf.inputs["Base Color"]); L.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
```
